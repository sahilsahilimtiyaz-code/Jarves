package com.jarvis.local;

import android.Manifest;
import android.app.Activity;
import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Base64;
import android.util.Log;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * JarvisNative — the Android capability bridge.
 *
 * Everything here maps to a documented Android API. The plugin never invents
 * data: when a sensor, intent or engine is unavailable it resolves an explicit
 * failure that the UI displays.
 *
 *  • SpeechRecognizer  → live recognition, partials, RMS level for the core
 *  • TextToSpeech      → spoken replies, real playback progress events
 *  • BatteryManager / ActivityManager / Build → genuine device telemetry
 *  • PackageManager + intents → installed apps, settings shortcuts
 *  • ClipboardManager, NotificationManager, SAF/FileProvider → real actions
 */
@CapacitorPlugin(
    name = "JarvisNative",
    permissions = {
        @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone"),
        @Permission(strings = { Manifest.permission.CAMERA }, alias = "camera"),
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
public class JarvisNativePlugin extends Plugin {

    private static final String TAG = "JarvisNative";
    private static final String CHANNEL_ID = "jarvis_alerts";
    private static final String PLUGIN_VERSION = "1.1.0";
    private static final int MAX_IMAGE_DIMENSION = 1600;
    private static final long MAX_FILE_BYTES = 8L * 1024L * 1024L;

    private SpeechRecognizer recognizer;
    private boolean listening = false;

    private TextToSpeech tts;
    private boolean ttsReady = false;
    private int ttsInitAttempts = 0;
    private String pendingUtterance;
    private String lastSpeakText;

    private String pendingCapturePath;

    private final Handler main = new Handler(Looper.getMainLooper());
    // SQLite and Android Keystore can block for seconds on a cold start or a
    // locked database. Running them on the WebView/UI thread froze JavaScript,
    // so the JS timeout could never fire and "Saving…" stayed on screen
    // forever. All storage work now runs on this single background thread.
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private JarvisDb database;

    // ── Lifecycle ──────────────────────────────────────────────────────────

    /** Receives state/wake broadcasts from the microphone foreground service. */
    private final BroadcastReceiver wakeReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null) return;
            if ("wake".equals(intent.getStringExtra("type"))) {
                JSObject data = new JSObject();
                data.put("text", intent.getStringExtra("text"));
                data.put("phrase", intent.getStringExtra("phrase"));
                data.put("at", intent.getLongExtra("at", System.currentTimeMillis()));
                notifyListeners("wakeWord", data);
            } else {
                JSObject data = new JSObject();
                data.put("state", intent.getStringExtra("state"));
                data.put("message", intent.getStringExtra("message"));
                notifyListeners("wakeState", data);
            }
        }
    };

    @Override
    public void load() {
        initTts();
        ensureChannel();
        try {
            IntentFilter filter = new IntentFilter(JarvisWakeService.ACTION_WAKE_EVENT);
            ContextCompat.registerReceiver(
                getContext(),
                wakeReceiver,
                filter,
                ContextCompat.RECEIVER_NOT_EXPORTED
            );
        } catch (Exception e) {
            Log.w(TAG, "wake receiver could not be registered", e);
        }
    }

    @Override
    protected void handleOnDestroy() {
        try {
            getContext().unregisterReceiver(wakeReceiver);
        } catch (Exception ignored) {
        }
        destroyRecognizer();
        if (tts != null) {
            try {
                tts.stop();
                tts.shutdown();
            } catch (Exception ignored) {
            }
            tts = null;
            ttsReady = false;
        }
        io.shutdownNow();
        super.handleOnDestroy();
    }

    // ── Capabilities ───────────────────────────────────────────────────────

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        JSObject out = new JSObject();
        out.put("native", true);
        out.put("sdkInt", Build.VERSION.SDK_INT);
        out.put("androidRelease", Build.VERSION.RELEASE);
        out.put("speechRecognition", SpeechRecognizer.isRecognitionAvailable(getContext()));
        out.put("tts", tts != null);
        out.put("ttsReady", ttsReady);
        out.put("camera", getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY));
        out.put("microphonePermission", permissionLabel("microphone"));
        out.put("cameraPermission", permissionLabel("camera"));
        out.put("notificationPermission", permissionLabel("notifications"));
        out.put("plugin", PLUGIN_VERSION);
        out.put("apps", true);
        out.put("files", true);
        call.resolve(out);
    }

    // ── Permissions ────────────────────────────────────────────────────────

    /**
     * Capacitor's Java PermissionState renders as "GRANTED"/"PROMPT_WITH_RATIONALE".
     * The web layer compares against lower-case values, so an un-normalised
     * state used to read as "not granted" forever. This is the single place
     * that converts it.
     */
    private String permissionLabel(String alias) {
        PermissionState state = getPermissionState(alias);
        if (state == null) return "unknown";
        return state.name().toLowerCase(java.util.Locale.ROOT).replace('-', '_');
    }

    @PluginMethod
    public void checkMicPermission(PluginCall call) {
        JSObject out = new JSObject();
        out.put("state", permissionLabel("microphone"));
        call.resolve(out);
    }

    /**
     * One honest snapshot of every runtime permission plus the speech engines.
     * The Settings screen renders exactly these values; nothing is inferred.
     */
    @PluginMethod
    public void checkPermissions(PluginCall call) {
        JSObject out = new JSObject();
        out.put("microphone", permissionLabel("microphone"));
        out.put("camera", permissionLabel("camera"));
        out.put("notifications", permissionLabel("notifications"));
        out.put("speechRecognition", SpeechRecognizer.isRecognitionAvailable(getContext()));
        out.put("tts", tts != null);
        out.put("ttsReady", ttsReady);
        out.put("files", true);
        out.put("plugin", PLUGIN_VERSION);
        call.resolve(out);
    }

    @PluginMethod
    public void requestMicPermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            JSObject out = new JSObject();
            out.put("granted", true);
            call.resolve(out);
            return;
        }
        requestPermissionForAlias("microphone", call, "micPermissionCallback");
    }

    @PermissionCallback
    private void micPermissionCallback(PluginCall call) {
        boolean granted = getPermissionState("microphone") == PermissionState.GRANTED;
        JSObject out = new JSObject();
        out.put("granted", granted);
        if (!granted) {
            out.put(
                "reason",
                "Microphone permission denied. Open Android Settings → Apps → J.A.R.V.I.S. → Permissions → Microphone."
            );
        }
        call.resolve(out);
    }

    @PluginMethod
    public void requestCameraPermission(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            JSObject out = new JSObject();
            out.put("granted", true);
            call.resolve(out);
            return;
        }
        requestPermissionForAlias("camera", call, "cameraPermissionCallback");
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        JSObject out = new JSObject();
        out.put("granted", getPermissionState("camera") == PermissionState.GRANTED);
        call.resolve(out);
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject out = new JSObject();
            out.put("granted", true);
            call.resolve(out);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        JSObject out = new JSObject();
        out.put("granted", getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(out);
    }

    // ── Speech recognition ─────────────────────────────────────────────────

    @PluginMethod
    public void startListening(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "startListeningPermissionCallback");
            return;
        }
        startRecognition(call);
    }

    @PermissionCallback
    private void startListeningPermissionCallback(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            JSObject out = new JSObject();
            out.put("granted", false);
            out.put(
                "reason",
                "Microphone permission denied. Enable it in Android Settings → Apps → J.A.R.V.I.S. → Permissions."
            );
            call.resolve(out);
            return;
        }
        startRecognition(call);
    }

    private void startRecognition(final PluginCall call) {
        final String language = call.getString("language", "en-US");
        final Context context = getContext();
        final Activity activity = getActivity();

        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            JSObject out = new JSObject();
            out.put("granted", false);
            out.put(
                "reason",
                "No Android speech-recognition service is available. Install/enable Google app speech services, or use a backend with Whisper."
            );
            call.resolve(out);
            return;
        }

        activity.runOnUiThread(() -> {
            try {
                destroyRecognizer();
                recognizer = SpeechRecognizer.createSpeechRecognizer(context);
                recognizer.setRecognitionListener(new RecognitionListener() {
                    @Override
                    public void onReadyForSpeech(Bundle params) {
                        emitSpeechState("ready");
                    }

                    @Override
                    public void onBeginningOfSpeech() {
                        emitSpeechState("speech");
                    }

                    @Override
                    public void onRmsChanged(float rmsdB) {
                        // Android reports roughly -2..10 dBFS for speech.
                        float level = (rmsdB + 2f) / 12f;
                        if (level < 0f) level = 0f;
                        if (level > 1f) level = 1f;
                        JSObject data = new JSObject();
                        data.put("level", (double) level);
                        notifyListeners("level", data);
                    }

                    @Override
                    public void onBufferReceived(byte[] buffer) {}

                    @Override
                    public void onEndOfSpeech() {
                        listening = false;
                        emitSpeechState("processing");
                    }

                    @Override
                    public void onError(int error) {
                        listening = false;
                        String message = speechErrorMessage(error);
                        JSObject data = new JSObject();
                        data.put("code", error);
                        data.put("message", message);
                        notifyListeners("speechError", data);
                        destroyRecognizer();
                    }

                    @Override
                    public void onResults(Bundle results) {
                        listening = false;
                        String text = firstResult(results);
                        destroyRecognizer();
                        JSObject data = new JSObject();
                        data.put("text", text == null ? "" : text);
                        notifyListeners("speechResult", data);
                    }

                    @Override
                    public void onPartialResults(Bundle partialResults) {
                        String text = firstResult(partialResults);
                        if (text == null || text.isEmpty()) return;
                        JSObject data = new JSObject();
                        data.put("text", text);
                        notifyListeners("speechPartial", data);
                    }

                    @Override
                    public void onEvent(int eventType, Bundle params) {}
                });

                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language);
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
                intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.getPackageName());
                intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, false);

                recognizer.startListening(intent);
                listening = true;

                JSObject out = new JSObject();
                out.put("granted", true);
                out.put("language", language);
                call.resolve(out);
            } catch (Exception e) {
                Log.w(TAG, "startListening failed", e);
                destroyRecognizer();
                JSObject out = new JSObject();
                out.put("granted", false);
                out.put("reason", "Speech recognition could not start: " + safeMessage(e));
                call.resolve(out);
            }
        });
    }

    @PluginMethod
    public void stopListening(final PluginCall call) {
        final Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            try {
                if (recognizer != null && listening) {
                    recognizer.stopListening();
                }
            } catch (Exception e) {
                Log.w(TAG, "stopListening failed", e);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void cancelListening(final PluginCall call) {
        final Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            listening = false;
            destroyRecognizer();
            call.resolve();
        });
    }

    private void emitSpeechState(String state) {
        JSObject data = new JSObject();
        data.put("state", state);
        notifyListeners("speechState", data);
    }

    private String firstResult(Bundle bundle) {
        if (bundle == null) return null;
        ArrayList<String> matches = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (matches == null || matches.isEmpty()) return null;
        return matches.get(0);
    }

    private String speechErrorMessage(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_AUDIO:
                return "Microphone audio error. Another app may be using the microphone.";
            case SpeechRecognizer.ERROR_CLIENT:
                return "Speech recognizer client error. Try again.";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "Speech recognition is missing the microphone permission.";
            case SpeechRecognizer.ERROR_NETWORK:
                return "Speech recognition network error. Check the phone's connection.";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "Speech recognition timed out. Try again.";
            case SpeechRecognizer.ERROR_NO_MATCH:
                return "No speech was recognized. Tap the microphone and speak clearly.";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "The speech recognizer is busy. Wait a moment and try again.";
            case SpeechRecognizer.ERROR_SERVER:
                return "The speech-recognition service reported an error.";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "No speech was detected. Try again.";
            default:
                return "Speech recognition failed (code " + error + ").";
        }
    }

    private void destroyRecognizer() {
        if (recognizer != null) {
            try {
                recognizer.cancel();
                recognizer.destroy();
            } catch (Exception ignored) {
            }
            recognizer = null;
        }
        listening = false;
    }

    // ── Text to speech ─────────────────────────────────────────────────────

    private void initTts() {
        if (tts != null) return;
        try {
            tts = new TextToSpeech(getContext().getApplicationContext(), status -> main.post(() -> {
                if (status == TextToSpeech.SUCCESS) {
                    ttsReady = true;
                    int lang = tts.setLanguage(Locale.UK);
                    if (lang == TextToSpeech.LANG_MISSING_DATA || lang == TextToSpeech.LANG_NOT_SUPPORTED) {
                        lang = tts.setLanguage(Locale.getDefault());
                        if (lang == TextToSpeech.LANG_MISSING_DATA || lang == TextToSpeech.LANG_NOT_SUPPORTED) {
                            Log.w(TAG, "No usable TTS language installed");
                        }
                    }
                    tts.setPitch(0.82f);
                    tts.setSpeechRate(0.94f);
                    if (pendingUtterance != null) {
                        String queued = pendingUtterance;
                        pendingUtterance = null;
                        doSpeak(queued);
                    }
                } else {
                    ttsReady = false;
                    ttsInitAttempts++;
                    Log.w(TAG, "TTS init failed, status=" + status);
                    if (ttsInitAttempts < 2) {
                        tts.shutdown();
                        tts = null;
                        main.postDelayed(JarvisNativePlugin.this::initTts, 800);
                    } else {
                        JSObject data = new JSObject();
                        data.put("message", "Android text-to-speech engine is not available on this device.");
                        notifyListeners("ttsError", data);
                    }
                }
            }));
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String utteranceId) {
                    JSObject data = new JSObject();
                    data.put("utteranceId", utteranceId);
                    notifyListeners("ttsStart", data);
                }

                @Override
                public void onDone(String utteranceId) {
                    JSObject data = new JSObject();
                    data.put("utteranceId", utteranceId);
                    notifyListeners("ttsDone", data);
                }

                @Override
                public void onError(String utteranceId) {
                    notifyTtsError("Text-to-speech playback failed.");
                }

                @Override
                public void onRangeStart(String utteranceId, int start, int end, int frame) {
                    // Real speech progress → pulse the core with the spoken span.
                    float level = Math.min(1f, 0.45f + (end - start) * 0.06f);
                    JSObject data = new JSObject();
                    data.put("level", (double) level);
                    notifyListeners("ttsRange", data);
                }
            });
        } catch (Exception e) {
            Log.w(TAG, "TTS unavailable", e);
            JSObject data = new JSObject();
            data.put("message", "Android text-to-speech could not be initialised: " + safeMessage(e));
            notifyListeners("ttsError", data);
        }
    }

    private void notifyTtsError(String message) {
        JSObject data = new JSObject();
        data.put("message", message);
        notifyListeners("ttsError", data);
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        if (text == null || text.trim().isEmpty()) {
            JSObject out = new JSObject();
            out.put("ok", false);
            out.put("reason", "Nothing to speak.");
            call.resolve(out);
            return;
        }
        initTts();
        if (tts == null) {
            JSObject out = new JSObject();
            out.put("ok", false);
            out.put("reason", "Android text-to-speech engine is not available on this device.");
            call.resolve(out);
            return;
        }
        if (!ttsReady) {
            pendingUtterance = text;
            JSObject out = new JSObject();
            out.put("ok", true);
            out.put("queued", true);
            call.resolve(out);
            return;
        }
        String voice = call.getString("voice", "");
        boolean ok = doSpeak(text, voice);
        JSObject out = new JSObject();
        out.put("ok", ok);
        if (!ok) out.put("reason", "The text-to-speech engine rejected the utterance.");
        call.resolve(out);
    }

    private boolean doSpeak(String text) {
        return doSpeak(text, "");
    }

    private boolean doSpeak(String text, String voiceName) {
        if (tts == null) return false;
        try {
            tts.stop();
            if (voiceName != null && !voiceName.isEmpty() && tts.getVoices() != null) {
                for (Voice voice : tts.getVoices()) {
                    if (voice.getName().equals(voiceName)) {
                        tts.setVoice(voice);
                        break;
                    }
                }
            }
            lastSpeakText = text;
            String utteranceId = "jarvis-" + SystemClock.uptimeMillis();
            int result = tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId);
            return result == TextToSpeech.SUCCESS;
        } catch (Exception e) {
            Log.w(TAG, "speak failed", e);
            return false;
        }
    }

    @PluginMethod
    public void stopSpeaking(PluginCall call) {
        pendingUtterance = null;
        if (tts != null) {
            try {
                tts.stop();
            } catch (Exception ignored) {
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void getVoices(PluginCall call) {
        initTts();
        JSArray voices = new JSArray();
        JSObject out = new JSObject();
        try {
            if (tts != null && tts.getVoices() != null) {
                for (Voice voice : tts.getVoices()) {
                    voices.put(voice.getName());
                }
            }
            if (tts != null) {
                out.put("language", tts.getLanguage() == null ? JSONObject.NULL : tts.getLanguage().toLanguageTag());
            }
        } catch (Exception e) {
            Log.w(TAG, "getVoices failed", e);
        }
        out.put("voices", voices);
        out.put("ready", ttsReady);
        call.resolve(out);
    }

    // ── Device telemetry ───────────────────────────────────────────────────

    @PluginMethod
    public void getDeviceInfo(PluginCall call) {
        JSObject out = new JSObject();
        try {
            out.put("manufacturer", Build.MANUFACTURER == null ? "unknown" : Build.MANUFACTURER);
            out.put("brand", Build.BRAND == null ? "unknown" : Build.BRAND);
            out.put("model", Build.MODEL == null ? "unknown" : Build.MODEL);
            out.put("device", Build.DEVICE == null ? "unknown" : Build.DEVICE);
            out.put("androidRelease", Build.VERSION.RELEASE == null ? "unknown" : Build.VERSION.RELEASE);
            out.put("sdkInt", Build.VERSION.SDK_INT);
            out.put("cpuCores", Runtime.getRuntime().availableProcessors());

            BatteryManager bm = (BatteryManager) getContext().getSystemService(Context.BATTERY_SERVICE);
            if (bm != null) {
                out.put("batteryPercent", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY));
            } else {
                out.put("batteryPercent", -1);
            }

            Intent battery = getContext().registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            boolean charging = false;
            double tempC = Double.NaN;
            if (battery != null) {
                int status = battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
                charging =
                    status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL;
                int tempTenths = battery.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE);
                if (tempTenths != Integer.MIN_VALUE) tempC = tempTenths / 10.0;
            }
            out.put("charging", charging);
            if (!Double.isNaN(tempC)) out.put("batteryTemperatureC", tempC);

            ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
            if (am != null) {
                ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
                am.getMemoryInfo(mi);
                out.put("totalRamMb", mi.totalMem / (1024 * 1024));
                out.put("availRamMb", mi.availMem / (1024 * 1024));
            }

            double load1 = readLoadAverage();
            if (!Double.isNaN(load1)) out.put("load1", load1);

            try {
                out.put(
                    "appVersion",
                    getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName
                );
            } catch (Exception ignored) {
            }
        } catch (Exception e) {
            Log.w(TAG, "getDeviceInfo failed", e);
            call.reject("Device information could not be read: " + safeMessage(e));
            return;
        }
        call.resolve(out);
    }

    /** Real 1-minute load average from procfs (no fabricated CPU figure). */
    private double readLoadAverage() {
        InputStream in = null;
        try {
            in = new java.io.FileInputStream("/proc/loadavg");
            byte[] buf = new byte[64];
            int read = in.read(buf);
            if (read <= 0) return Double.NaN;
            String text = new String(buf, 0, read).trim();
            String first = text.split("\\s+")[0];
            return Double.parseDouble(first);
        } catch (Exception e) {
            return Double.NaN;
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Exception ignored) {
                }
            }
        }
    }

    // ── Installed apps / intents ───────────────────────────────────────────

    @PluginMethod
    public void listApps(PluginCall call) {
        JSArray apps = new JSArray();
        try {
            PackageManager pm = getContext().getPackageManager();
            Intent main = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
            List<ResolveInfo> resolved;
            if (Build.VERSION.SDK_INT >= 33) {
                resolved = pm.queryIntentActivities(main, PackageManager.ResolveInfoFlags.of(0));
            } else {
                resolved = pm.queryIntentActivities(main, 0);
            }
            Set<String> seen = new HashSet<>();
            List<JSObject> entries = new ArrayList<>();
            for (ResolveInfo info : resolved) {
                if (info.activityInfo == null || info.activityInfo.packageName == null) continue;
                String pkg = info.activityInfo.packageName;
                if (!seen.add(pkg)) continue;
                CharSequence label;
                try {
                    label = info.loadLabel(pm);
                } catch (Exception e) {
                    label = pkg;
                }
                JSObject app = new JSObject();
                app.put("label", label == null ? pkg : label.toString());
                app.put("packageName", pkg);
                entries.add(app);
            }
            Collections.sort(entries, (a, b) -> {
                String la = a.optString("label", "").toLowerCase(Locale.ROOT);
                String lb = b.optString("label", "").toLowerCase(Locale.ROOT);
                return la.compareTo(lb);
            });
            for (JSObject entry : entries) apps.put(entry);
        } catch (Exception e) {
            Log.w(TAG, "listApps failed", e);
            call.reject("Installed apps could not be listed: " + safeMessage(e));
            return;
        }
        JSObject out = new JSObject();
        out.put("apps", apps);
        call.resolve(out);
    }

    @PluginMethod
    public void openApp(PluginCall call) {
        String query = call.getString("query", "");
        if (query == null) query = "";
        String needle = query.trim().toLowerCase(Locale.ROOT);
        JSObject out = new JSObject();

        try {
            PackageManager pm = getContext().getPackageManager();
            Intent main = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
            List<ResolveInfo> resolved;
            if (Build.VERSION.SDK_INT >= 33) {
                resolved = pm.queryIntentActivities(main, PackageManager.ResolveInfoFlags.of(0));
            } else {
                resolved = pm.queryIntentActivities(main, 0);
            }

            List<JSObject> exact = new ArrayList<>();
            List<JSObject> partial = new ArrayList<>();
            Set<String> seen = new HashSet<>();

            for (ResolveInfo info : resolved) {
                if (info.activityInfo == null || info.activityInfo.packageName == null) continue;
                String pkg = info.activityInfo.packageName;
                if (!seen.add(pkg)) continue;
                CharSequence cs = info.loadLabel(pm);
                String label = cs == null ? pkg : cs.toString();
                String lcLabel = label.toLowerCase(Locale.ROOT);
                String lcPkg = pkg.toLowerCase(Locale.ROOT);
                JSObject entry = new JSObject();
                entry.put("label", label);
                entry.put("packageName", pkg);

                if (!needle.isEmpty() && (lcLabel.equals(needle) || lcPkg.equals(needle) || lcPkg.endsWith("." + needle))) {
                    exact.add(entry);
                } else if (!needle.isEmpty() && (lcLabel.contains(needle) || lcPkg.contains(needle))) {
                    partial.add(entry);
                }
            }

            List<JSObject> candidates = !exact.isEmpty() ? exact : partial;
            if (candidates.isEmpty()) {
                out.put("launched", false);
                out.put("message", "No installed app matched \"" + query + "\".");
                call.resolve(out);
                return;
            }
            if (candidates.size() > 1) {
                JSArray matches = new JSArray();
                for (int i = 0; i < Math.min(candidates.size(), 10); i++) matches.put(candidates.get(i));
                out.put("launched", false);
                out.put("message", "Several installed apps match \"" + query + "\".");
                out.put("matches", matches);
                call.resolve(out);
                return;
            }

            JSObject chosen = candidates.get(0);
            String pkg = chosen.getString("packageName", "");
            Intent launch = pm.getLaunchIntentForPackage(pkg);
            if (launch == null) {
                out.put("launched", false);
                out.put("message", chosen.getString("label", pkg) + " has no launchable activity.");
                call.resolve(out);
                return;
            }
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(launch);
            out.put("launched", true);
            out.put("label", chosen.getString("label", pkg));
            out.put("packageName", pkg);
            call.resolve(out);
        } catch (Exception e) {
            Log.w(TAG, "openApp failed", e);
            out.put("launched", false);
            out.put("message", "The app could not be opened: " + safeMessage(e));
            call.resolve(out);
        }
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        String target = call.getString("target", "app");
        if (target == null) target = "app";
        String label = "Settings";
        Intent intent;
        switch (target) {
            case "wifi":
                intent = new Intent(Settings.ACTION_WIFI_SETTINGS);
                label = "Wi-Fi settings";
                break;
            case "bluetooth":
                intent = new Intent(Settings.ACTION_BLUETOOTH_SETTINGS);
                label = "Bluetooth settings";
                break;
            case "display":
                intent = new Intent(Settings.ACTION_DISPLAY_SETTINGS);
                label = "Display settings";
                break;
            case "sound":
                intent = new Intent(Settings.ACTION_SOUND_SETTINGS);
                label = "Sound settings";
                break;
            case "battery":
                intent = new Intent(Settings.ACTION_BATTERY_SAVER_SETTINGS);
                label = "Battery settings";
                break;
            case "apps":
                intent = new Intent(Settings.ACTION_APPLICATION_SETTINGS);
                label = "App settings";
                break;
            case "notifications":
                intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                intent.putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
                label = "Notification settings";
                break;
            case "data":
                intent = new Intent(Settings.ACTION_DATA_USAGE_SETTINGS);
                label = "Network settings";
                break;
            case "app":
            default:
                intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
                label = "J.A.R.V.I.S. app settings";
                break;
        }
        JSObject out = new JSObject();
        try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            out.put("ok", true);
            out.put("label", label);
        } catch (Exception e) {
            Log.w(TAG, "openSettings failed", e);
            out.put("ok", false);
            out.put("message", "This device does not expose " + label + ".");
        }
        call.resolve(out);
    }

    // ── Clipboard ──────────────────────────────────────────────────────────

    @PluginMethod
    public void clipboardWrite(PluginCall call) {
        String text = call.getString("text", "");
        JSObject out = new JSObject();
        try {
            ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null) {
                out.put("ok", false);
                call.resolve(out);
                return;
            }
            cm.setPrimaryClip(ClipData.newPlainText("J.A.R.V.I.S.", text == null ? "" : text));
            out.put("ok", true);
        } catch (Exception e) {
            out.put("ok", false);
        }
        call.resolve(out);
    }

    @PluginMethod
    public void clipboardRead(PluginCall call) {
        JSObject out = new JSObject();
        try {
            ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null || !cm.hasPrimaryClip() || cm.getPrimaryClip() == null) {
                out.put("text", "");
                call.resolve(out);
                return;
            }
            ClipData clip = cm.getPrimaryClip();
            if (clip.getItemCount() == 0) {
                out.put("text", "");
                call.resolve(out);
                return;
            }
            CharSequence text = clip.getItemAt(0).coerceToText(getContext());
            out.put("text", text == null ? "" : text.toString());
        } catch (Exception e) {
            out.put("text", "");
            out.put("error", "The system blocked clipboard access: " + safeMessage(e));
        }
        call.resolve(out);
    }

    // ── Notifications ──────────────────────────────────────────────────────

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "J.A.R.V.I.S. alerts",
                NotificationManager.IMPORTANCE_DEFAULT
            );
            channel.setDescription("Local notifications requested from J.A.R.V.I.S.");
            nm.createNotificationChannel(channel);
        } catch (Exception e) {
            Log.w(TAG, "channel creation failed", e);
        }
    }

    @PluginMethod
    public void notify(PluginCall call) {
        JSObject out = new JSObject();
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            out.put("ok", false);
            out.put("message", "Notification permission is not granted.");
            call.resolve(out);
            return;
        }
        String title = call.getString("title", "J.A.R.V.I.S.");
        String body = call.getString("body", "");
        try {
            ensureChannel();
            NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) {
                out.put("ok", false);
                out.put("message", "Notification service unavailable.");
                call.resolve(out);
                return;
            }
            Intent open = new Intent(getContext(), MainActivity.class);
            open.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            int flags = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
            PendingIntent pending = PendingIntent.getActivity(getContext(), 0, open, flags);

            Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(getContext(), CHANNEL_ID)
                : new Notification.Builder(getContext());
            builder
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title == null ? "J.A.R.V.I.S." : title)
                .setContentText(body == null ? "" : body)
                .setStyle(new Notification.BigTextStyle().bigText(body == null ? "" : body))
                .setAutoCancel(true)
                .setContentIntent(pending);
            if (Build.VERSION.SDK_INT >= 21) builder.setColor(0xFF7DD3FC);

            nm.notify((int) (SystemClock.uptimeMillis() % 100000), builder.build());
            out.put("ok", true);
        } catch (Exception e) {
            Log.w(TAG, "notify failed", e);
            out.put("ok", false);
            out.put("message", "Notification failed: " + safeMessage(e));
        }
        call.resolve(out);
    }

    // ── Camera / files (Storage Access Framework) ──────────────────────────

    @PluginMethod
    public void pickImage(PluginCall call) {
        String source = call.getString("source", "gallery");
        if ("camera".equals(source)) {
            if (getPermissionState("camera") != PermissionState.GRANTED) {
                requestPermissionForAlias("camera", call, "pickImagePermissionCallback");
                return;
            }
            launchCamera(call);
            return;
        }
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("image/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        startActivityForResult(call, Intent.createChooser(intent, "Select an image"), "imageResult");
    }

    @PermissionCallback
    private void pickImagePermissionCallback(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            JSObject out = new JSObject();
            out.put("error", "Camera permission denied.");
            call.resolve(out);
            return;
        }
        launchCamera(call);
    }

    private void launchCamera(PluginCall call) {
        try {
            File dir = new File(getContext().getCacheDir(), "captures");
            if (!dir.exists() && !dir.mkdirs()) {
                JSObject out = new JSObject();
                out.put("error", "Could not create a capture directory.");
                call.resolve(out);
                return;
            }
            File photo = new File(dir, "capture-" + System.currentTimeMillis() + ".jpg");
            Uri uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                photo
            );
            pendingCapturePath = photo.getAbsolutePath();
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, uri);
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(call, intent, "imageResult");
        } catch (Exception e) {
            JSObject out = new JSObject();
            out.put("error", "Camera could not be opened: " + safeMessage(e));
            call.resolve(out);
        }
    }

    @ActivityCallback
    private void imageResult(PluginCall call, ActivityResult result) {
        JSObject out = new JSObject();
        try {
            if (result == null || result.getResultCode() != Activity.RESULT_OK) {
                out.put("cancelled", true);
                call.resolve(out);
                return;
            }
            InputStream in = null;
            String name = "image";
            String mime = "image/jpeg";
            if (pendingCapturePath != null) {
                File file = new File(pendingCapturePath);
                if (!file.exists()) {
                    out.put("error", "The captured photo could not be read.");
                    call.resolve(out);
                    return;
                }
                in = new java.io.FileInputStream(file);
                name = file.getName();
            } else if (result.getData() != null && result.getData().getData() != null) {
                Uri uri = result.getData().getData();
                in = getContext().getContentResolver().openInputStream(uri);
                String type = getContext().getContentResolver().getType(uri);
                if (type != null) mime = type;
                String last = uri.getLastPathSegment();
                if (last != null) name = last;
            }
            if (in == null) {
                out.put("error", "No image data was returned.");
                call.resolve(out);
                return;
            }
            byte[] bytes = readAll(in, MAX_FILE_BYTES);
            Bitmap bitmap = decodeSampled(bytes, MAX_IMAGE_DIMENSION);
            if (bitmap == null) {
                out.put("error", "The selected image could not be decoded.");
                call.resolve(out);
                return;
            }
            ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.JPEG, 85, jpeg);
            bitmap.recycle();
            String base64 = Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP);
            out.put("dataUrl", "data:image/jpeg;base64," + base64);
            out.put("mime", "image/jpeg");
            out.put("name", name);
        } catch (Exception e) {
            Log.w(TAG, "pickImage result failed", e);
            out.put("error", "Image selection failed: " + safeMessage(e));
        } finally {
            pendingCapturePath = null;
        }
        call.resolve(out);
    }

    @PluginMethod
    public void pickFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("*/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        startActivityForResult(call, Intent.createChooser(intent, "Select a file"), "fileResult");
    }

    @ActivityCallback
    private void fileResult(PluginCall call, ActivityResult result) {
        JSObject out = new JSObject();
        try {
            if (result == null || result.getResultCode() != Activity.RESULT_OK) {
                out.put("cancelled", true);
                call.resolve(out);
                return;
            }
            Uri uri = result.getData() != null ? result.getData().getData() : null;
            if (uri == null) {
                out.put("error", "No file was returned.");
                call.resolve(out);
                return;
            }
            String mime = getContext().getContentResolver().getType(uri);
            String name = uri.getLastPathSegment();
            InputStream in = getContext().getContentResolver().openInputStream(uri);
            if (in == null) {
                out.put("error", "The file could not be opened.");
                call.resolve(out);
                return;
            }
            byte[] bytes = readAll(in, MAX_FILE_BYTES);
            out.put("name", name == null ? "file" : name);
            if (mime != null) out.put("mime", mime);
            out.put("size", bytes.length);
            boolean isImage = mime != null && mime.startsWith("image/");
            if (isImage) {
                Bitmap bitmap = decodeSampled(bytes, MAX_IMAGE_DIMENSION);
                if (bitmap != null) {
                    ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
                    bitmap.compress(Bitmap.CompressFormat.JPEG, 85, jpeg);
                    bitmap.recycle();
                    out.put("dataUrl", "data:image/jpeg;base64," + Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP));
                }
            } else if (bytes.length <= MAX_FILE_BYTES) {
                out.put("dataUrl", "data:" + (mime == null ? "application/octet-stream" : mime) + ";base64,"
                    + Base64.encodeToString(bytes, Base64.NO_WRAP));
            }
            out.put("truncated", bytes.length >= MAX_FILE_BYTES);
        } catch (Exception e) {
            Log.w(TAG, "pickFile result failed", e);
            out.put("error", "File selection failed: " + safeMessage(e));
        }
        call.resolve(out);
    }

    @PluginMethod
    public void shareText(PluginCall call) {
        String text = call.getString("text", "");
        JSObject out = new JSObject();
        try {
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("text/plain");
            send.putExtra(Intent.EXTRA_TEXT, text == null ? "" : text);
            Intent chooser = Intent.createChooser(send, "Share from J.A.R.V.I.S.");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
            out.put("ok", true);
        } catch (Exception e) {
            out.put("ok", false);
            out.put("message", "Sharing is unavailable: " + safeMessage(e));
        }
        call.resolve(out);
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    // ── Secure credential vault (Android Keystore) ─────────────────────────

    @PluginMethod
    public void secureSet(PluginCall call) {
        final String name = call.getString("name");
        if (name == null || name.trim().isEmpty()) {
            call.reject("A credential name is required.");
            return;
        }
        final String value = call.getString("value", "");
        io.execute(() -> {
            try {
                JarvisSecureStore.put(getContext(), name, value);
                call.resolve();
            } catch (Exception e) {
                call.reject("Secure storage failed: " + safeMessage(e));
            }
        });
    }

    @PluginMethod
    public void secureGet(PluginCall call) {
        final String name = call.getString("name");
        if (name == null || name.trim().isEmpty()) {
            call.reject("A credential name is required.");
            return;
        }
        io.execute(() -> {
            try {
                JSObject out = new JSObject();
                out.put("value", JarvisSecureStore.get(getContext(), name));
                call.resolve(out);
            } catch (Exception e) {
                call.reject("Secure storage read failed: " + safeMessage(e));
            }
        });
    }

    @PluginMethod
    public void secureRemove(PluginCall call) {
        final String name = call.getString("name");
        io.execute(() -> {
            try {
                if (name != null && !name.trim().isEmpty()) {
                    JarvisSecureStore.remove(getContext(), name);
                }
                call.resolve();
            } catch (Exception e) {
                call.reject("Secure storage delete failed: " + safeMessage(e));
            }
        });
    }

    // ── Local SQLite memory (schema owned by the TypeScript memory layer) ───

    private JarvisDb db() {
        if (database == null) database = new JarvisDb(getContext());
        return database;
    }

    @PluginMethod
    public void dbQuery(PluginCall call) {
        final String sql = call.getString("sql");
        if (sql == null || sql.trim().isEmpty()) {
            call.reject("SQL is required.");
            return;
        }
        final JSArray params = call.getArray("params", new JSArray());
        io.execute(() -> {
            try {
                JSONArray rows = JarvisDb.query(db().getWritableDatabase(), sql, new JSONArray(params.toString()));
                JSObject out = new JSObject();
                out.put("rows", rows);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("Local memory read failed: " + safeMessage(e));
            }
        });
    }

    @PluginMethod
    public void dbExec(PluginCall call) {
        final String sql = call.getString("sql");
        if (sql == null || sql.trim().isEmpty()) {
            call.reject("SQL is required.");
            return;
        }
        final JSArray params = call.getArray("params", new JSArray());
        io.execute(() -> {
            try {
                JarvisDb.exec(db().getWritableDatabase(), sql, new JSONArray(params.toString()));
                JSObject out = new JSObject();
                out.put("changes", 0);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("Local memory write failed: " + safeMessage(e));
            }
        });
    }

    // ── Provider HTTP (native avoids provider CORS blocks) ──────────────────

    @PluginMethod
    public void httpRequest(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("A URL is required.");
            return;
        }
        final String method = call.getString("method", "POST");
        final String body = call.getString("body", "");
        final int timeout = call.getInt("timeoutMs", 60000);
        final boolean allowInsecure = Boolean.TRUE.equals(call.getBoolean("allowInsecure", false));
        final JSObject headers = call.getObject("headers", new JSObject());
        new Thread(() -> {
            try {
                JSONObject result = JarvisHttp.request(url, method, new JSONObject(headers.toString()), body, timeout, allowInsecure);
                JSObject out = new JSObject();
                out.put("status", result.optInt("status", 0));
                out.put("body", result.optString("body", ""));
                call.resolve(out);
            } catch (Exception e) {
                call.reject("Network request failed: " + safeMessage(e));
            }
        }).start();
    }

    @PluginMethod
    public void httpStreamStart(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("A URL is required.");
            return;
        }
        final String method = call.getString("method", "POST");
        final String body = call.getString("body", "");
        final int timeout = call.getInt("timeoutMs", 120000);
        final boolean allowInsecure = Boolean.TRUE.equals(call.getBoolean("allowInsecure", false));
        final JSObject headers = call.getObject("headers", new JSObject());
        final String streamId = UUID.randomUUID().toString();
        try {
            JarvisHttp.startStream(
                streamId,
                url,
                method,
                new JSONObject(headers.toString()),
                body,
                timeout,
                allowInsecure,
                chunk -> {
                    // The HTTP client runs on a worker thread; Capacitor's
                    // notifyListeners touches the WebView, which must happen on
                    // the main thread.
                    final String chunkText = chunk;
                    main.post(() -> {
                        JSObject data = new JSObject();
                        data.put("streamId", streamId);
                        data.put("chunk", chunkText);
                        notifyListeners("httpChunk", data);
                    });
                },
                status -> {
                    final int httpStatus = status;
                    main.post(() -> {
                        JSObject data = new JSObject();
                        data.put("streamId", streamId);
                        data.put("status", httpStatus);
                        notifyListeners("httpDone", data);
                    });
                },
                error -> {
                    final String detail = error;
                    main.post(() -> {
                        JSObject data = new JSObject();
                        data.put("streamId", streamId);
                        data.put("message", detail);
                        notifyListeners("httpError", data);
                    });
                });
            JSObject out = new JSObject();
            out.put("streamId", streamId);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("The streaming request could not start: " + safeMessage(e));
        }
    }

    @PluginMethod
    public void httpAbort(PluginCall call) {
        String streamId = call.getString("streamId");
        if (streamId != null && !streamId.isEmpty()) JarvisHttp.abort(streamId);
        call.resolve();
    }

    // ── "Hey JARVIS" monitoring (microphone foreground service) ─────────────
    // Real work happens in JarvisWakeService: the device's own SpeechRecognizer
    // runs behind a permanent notification and broadcasts when it hears the
    // phrase. The plugin only translates that into Capacitor events.

    private JSObject wakeStatusObject() {
        JSObject out = new JSObject();
        out.put("state", JarvisWakeService.state());
        out.put("modelReady", SpeechRecognizer.isRecognitionAvailable(getContext()));
        out.put("message", JarvisWakeService.message());
        out.put("engine", "android-speech-recognizer");
        return out;
    }

    private JSObject wakeError(String detail) {
        JSObject out = wakeStatusObject();
        out.put("state", "error");
        out.put("message", detail);
        return out;
    }

    @PluginMethod
    public void wakeStatus(PluginCall call) {
        call.resolve(wakeStatusObject());
    }

    @PluginMethod
    public void wakeStart(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.resolve(wakeError("Microphone permission is required before wake-word monitoring can start."));
            return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
            JSObject out = wakeStatusObject();
            out.put("state", "model-missing");
            out.put(
                "message",
                "This phone has no Android speech-recognition service, so “Hey JARVIS” cannot be detected. Install/enable the Google speech service or use tap-to-talk."
            );
            call.resolve(out);
            return;
        }
        Intent intent = new Intent(getContext(), JarvisWakeService.class);
        intent.setAction(JarvisWakeService.ACTION_START);
        intent.putExtra(JarvisWakeService.EXTRA_PHRASE, call.getString("phrase", "hey jarvis"));
        intent.putExtra(JarvisWakeService.EXTRA_LANGUAGE, call.getString("language", "en-US"));
        try {
            ContextCompat.startForegroundService(getContext(), intent);
            JSObject out = wakeStatusObject();
            if ("off".equals(out.getString("state"))) out.put("state", "starting");
            call.resolve(out);
        } catch (Exception e) {
            call.resolve(wakeError("Android refused to start the microphone service: " + safeMessage(e)));
        }
    }

    @PluginMethod
    public void wakeStop(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), JarvisWakeService.class));
        } catch (Exception ignored) {
        }
        JSObject out = wakeStatusObject();
        out.put("state", "off");
        out.put("message", "Wake-word monitoring is off.");
        call.resolve(out);
    }

    @PluginMethod
    public void wakePause(PluginCall call) {
        if (!JarvisWakeService.isMonitoring()) {
            call.resolve(wakeStatusObject());
            return;
        }
        Intent intent = new Intent(getContext(), JarvisWakeService.class);
        intent.setAction(JarvisWakeService.ACTION_PAUSE);
        try {
            getContext().startService(intent);
        } catch (Exception e) {
            Log.w(TAG, "wake pause failed", e);
        }
        call.resolve(wakeStatusObject());
    }

    @PluginMethod
    public void wakeResume(PluginCall call) {
        String state = JarvisWakeService.state();
        try {
            if ("off".equals(state) || "error".equals(state) || "model-missing".equals(state)) {
                Intent intent = new Intent(getContext(), JarvisWakeService.class);
                intent.setAction(JarvisWakeService.ACTION_START);
                ContextCompat.startForegroundService(getContext(), intent);
            } else {
                Intent intent = new Intent(getContext(), JarvisWakeService.class);
                intent.setAction(JarvisWakeService.ACTION_RESUME);
                getContext().startService(intent);
            }
        } catch (Exception e) {
            call.resolve(wakeError("Wake-word monitoring could not resume: " + safeMessage(e)));
            return;
        }
        JSObject out = wakeStatusObject();
        if ("paused".equals(out.getString("state")) || "wake".equals(out.getString("state"))) {
            out.put("state", "starting");
        }
        call.resolve(out);
    }

    @PluginMethod
    public void wakeDownloadModel(PluginCall call) {
        JSObject out = new JSObject();
        out.put("ok", false);
        out.put(
            "message",
            "There is no bundled wake-word model: this build uses the phone's installed speech-recognition service. Configure that service instead."
        );
        call.resolve(out);
    }

    // ── Binary HTTP for speech providers (base64 audio) ─────────────────────

    @PluginMethod
    public void httpRequestBase64(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("A URL is required.");
            return;
        }
        final String method = call.getString("method", "POST");
        final String body = call.getString("body", "");
        final int timeout = call.getInt("timeoutMs", 45000);
        final boolean allowInsecure = Boolean.TRUE.equals(call.getBoolean("allowInsecure", false));
        final JSObject headers = call.getObject("headers", new JSObject());
        new Thread(() -> {
            try {
                JSONObject result = JarvisHttp.requestBase64(url, method, new JSONObject(headers.toString()), body, timeout, allowInsecure);
                JSObject out = new JSObject();
                out.put("status", result.optInt("status", 0));
                out.put("mime", result.optString("mime", ""));
                out.put("base64", result.optString("base64", ""));
                out.put("body", result.optString("body", ""));
                call.resolve(out);
            } catch (Exception e) {
                call.reject("Speech request failed: " + safeMessage(e));
            }
        }).start();
    }

    /** Deep link to this app's system permission page (for permanent denials). */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject out = new JSObject();
            out.put("ok", true);
            call.resolve(out);
        } catch (Exception e) {
            JSObject out = new JSObject();
            out.put("ok", false);
            out.put("message", "Android settings could not be opened: " + safeMessage(e));
            call.resolve(out);
        }
    }

    private byte[] readAll(InputStream in, long limit) throws Exception {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        long total = 0;
        try {
            int read;
            while ((read = in.read(chunk)) > 0) {
                total += read;
                if (total > limit) {
                    int allowed = (int) Math.max(0, limit - (total - read));
                    if (allowed > 0) buffer.write(chunk, 0, allowed);
                    break;
                }
                buffer.write(chunk, 0, read);
            }
        } finally {
            try {
                in.close();
            } catch (Exception ignored) {
            }
        }
        return buffer.toByteArray();
    }

    private Bitmap decodeSampled(byte[] bytes, int maxDimension) {
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
            int sample = 1;
            int largest = Math.max(bounds.outWidth, bounds.outHeight);
            while (largest / sample > maxDimension * 2) sample *= 2;
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, opts);
            if (bitmap == null) return null;
            int width = bitmap.getWidth();
            int height = bitmap.getHeight();
            int largestSide = Math.max(width, height);
            if (largestSide <= maxDimension) return bitmap;
            float scale = (float) maxDimension / (float) largestSide;
            Bitmap scaled = Bitmap.createScaledBitmap(
                bitmap,
                Math.max(1, Math.round(width * scale)),
                Math.max(1, Math.round(height * scale)),
                true
            );
            if (scaled != bitmap) bitmap.recycle();
            return scaled;
        } catch (Exception e) {
            Log.w(TAG, "decode failed", e);
            return null;
        }
    }

    private String safeMessage(Exception e) {
        String message = e.getMessage();
        return message == null || message.isEmpty() ? e.getClass().getSimpleName() : message;
    }
}
