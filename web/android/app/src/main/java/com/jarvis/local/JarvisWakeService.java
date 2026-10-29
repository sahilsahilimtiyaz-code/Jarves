package com.jarvis.local;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import java.util.ArrayList;
import java.util.Locale;

/**
 * "Hey JARVIS" foreground monitor.
 *
 * WHAT IT REALLY IS
 * -----------------
 * There is no bundled wake-word model. This service uses the Android
 * SpeechRecognizer that is installed on the phone (Google, Samsung, …) and
 * looks for the wake phrase in its partial/final transcripts. That means:
 *  - it needs a speech-recognition service on the device (reported honestly),
 *  - on most devices recognition is done by the system speech service and may
 *    use the network; this app never uploads the audio itself,
 *  - it runs only while the owner enables monitoring, behind a permanent
 *    foreground notification, and stops the moment monitoring is disabled.
 *
 * LIFECYCLE
 * ---------
 * START   → foreground notification + recognizer loop
 * WAKE    → recognizer released (so the mic is free), WAKE broadcast sent,
 *           service state becomes "paused"
 * RESUME  → loop restarts once the command has been answered
 * STOP    → recognizer released, notification removed, service destroyed
 */
public class JarvisWakeService extends Service {

    private static final String TAG = "JarvisWake";
    private static final String CHANNEL_ID = "jarvis_wake";
    private static final int NOTIFICATION_ID = 4712;
    private static final String PREFS = "jarvis.wake.v1";

    public static final String ACTION_WAKE_EVENT = "com.jarvis.local.WAKE_EVENT";
    public static final String ACTION_START = "com.jarvis.local.wake.START";
    public static final String ACTION_STOP = "com.jarvis.local.wake.STOP";
    public static final String ACTION_PAUSE = "com.jarvis.local.wake.PAUSE";
    public static final String ACTION_RESUME = "com.jarvis.local.wake.RESUME";
    public static final String EXTRA_PHRASE = "phrase";
    public static final String EXTRA_LANGUAGE = "language";

    private static final int MAX_CONSECUTIVE_ERRORS = 6;

    private static volatile String state = "off";
    private static volatile String message = "Wake-word monitoring is off.";

    private final Handler main = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private boolean monitoring = false;
    private boolean paused = false;
    private boolean foreground = false;
    private int consecutiveErrors = 0;

    private String wakePhrase = "hey jarvis";
    private String language = "en-US";

    // ── State shared with the Capacitor plugin ─────────────────────────────

    public static String state() {
        return state;
    }

    public static String message() {
        return message;
    }

    public static boolean isMonitoring() {
        return "monitoring".equals(state) || "starting".equals(state) || "paused".equals(state) || "wake".equals(state);
    }

    private void publish(String next, String detail) {
        String nextMessage = detail == null ? "" : detail;
        // Recognition restarts every few seconds; do not spam the UI with an
        // identical "monitoring" event on every restart.
        if (foreground && next.equals(state) && nextMessage.equals(message)) {
            updateNotification();
            return;
        }
        state = next;
        message = nextMessage;
        Intent intent = new Intent(ACTION_WAKE_EVENT);
        intent.setPackage(getPackageName());
        intent.putExtra("type", "state");
        intent.putExtra("state", state);
        intent.putExtra("message", message);
        sendBroadcast(intent);
        if (foreground) updateNotification();
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (intent != null) {
            String phrase = intent.getStringExtra(EXTRA_PHRASE);
            if (phrase != null && !phrase.trim().isEmpty()) wakePhrase = normalizePhrase(phrase);
            String lang = intent.getStringExtra(EXTRA_LANGUAGE);
            if (lang != null && !lang.trim().isEmpty()) language = lang.trim();
            prefs().edit().putString("phrase", wakePhrase).putString("language", language).apply();
        } else {
            // System restart: restore the owner's saved configuration.
            wakePhrase = prefs().getString("phrase", wakePhrase);
            language = prefs().getString("language", language);
        }

        if (ACTION_STOP.equals(action)) {
            stopEverything("Wake-word monitoring is off.");
            return START_NOT_STICKY;
        }

        if (ACTION_PAUSE.equals(action)) {
            if (!monitoring) {
                publish("off", "Wake-word monitoring is not running.");
                return START_NOT_STICKY;
            }
            paused = true;
            cancelRecognizer();
            publish("paused", "Wake word paused while JARVIS handles your command.");
            return START_STICKY;
        }

        if (ACTION_RESUME.equals(action) || ACTION_START.equals(action)) {
            if (!ensurePermission()) return START_NOT_STICKY;
            if (!SpeechRecognizer.isRecognitionAvailable(this)) {
                publish("model-missing", "This phone has no Android speech-recognition service, so wake-word monitoring cannot run. Tap-to-talk still works if the microphone is granted.");
                return START_NOT_STICKY;
            }
            monitoring = true;
            paused = false;
            ensureForeground();
            publish("starting", "Starting wake-word monitoring for “" + wakePhrase + "”…");
            startRecognizer();
            return START_STICKY;
        }

        return START_STICKY;
    }

    private boolean ensurePermission() {
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            publish("error", "Microphone permission is not granted, so wake-word monitoring cannot start.");
            return false;
        }
        return true;
    }

    // ── Recognition loop ───────────────────────────────────────────────────

    private void startRecognizer() {
        if (!monitoring || paused) return;
        if (!ensurePermission()) {
            stopEverything("Microphone permission was revoked, so monitoring stopped.");
            return;
        }
        cancelRecognizer();
        main.post(() -> {
            if (!monitoring || paused) return;
            try {
                recognizer = SpeechRecognizer.createSpeechRecognizer(this);
                recognizer.setRecognitionListener(listener);
                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
                intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
                recognizer.startListening(intent);
                publish("monitoring", "Listening for “" + wakePhrase + "”.");
            } catch (Exception e) {
                Log.w(TAG, "could not start recognition", e);
                scheduleRestart(1500, "The speech recognizer could not start: " + safeMessage(e));
            }
        });
    }

    private void scheduleRestart(long delayMs, String detail) {
        if (!monitoring || paused) return;
        if (detail != null) publish("monitoring", detail);
        main.postDelayed(() -> {
            if (monitoring && !paused) startRecognizer();
        }, delayMs);
    }

    private void cancelRecognizer() {
        final SpeechRecognizer current = recognizer;
        recognizer = null;
        if (current == null) return;
        main.post(() -> {
            try {
                current.cancel();
                current.destroy();
            } catch (Exception ignored) {
            }
        });
    }

    private void onWakeDetected(String text) {
        if (paused) return;
        paused = true;
        cancelRecognizer();
        consecutiveErrors = 0;
        publish("wake", "Heard “" + wakePhrase + "”. Listening for your command.");
        Intent event = new Intent(ACTION_WAKE_EVENT);
        event.setPackage(getPackageName());
        event.putExtra("type", "wake");
        event.putExtra("text", text == null ? "" : text);
        event.putExtra("phrase", wakePhrase);
        event.putExtra("at", System.currentTimeMillis());
        sendBroadcast(event);
    }

    private boolean matchesWake(String text) {
        String normalized = normalizeText(text);
        if (normalized.isEmpty()) return false;
        String phrase = normalizePhrase(wakePhrase);
        if (phrase.isEmpty()) phrase = "hey jarvis";
        if (normalized.contains(phrase)) return true;

        // The system recognizer often hears "jervis", "charvis" or drops "hey".
        // Keep the JARVIS aliases even when the configured phrase is the default.
        if (phrase.endsWith("jarvis")) {
            return normalized.matches(".*\\b(?:hey|hi|ok|okay)?[\\s,]*"
                    + "(?:jarvis|jervis|charvis|jarvas|jarvus|javis|jarviz|darvis)\\b.*");
        }
        return false;
    }

    private static String normalizeText(String value) {
        if (value == null) return "";
        return value.toLowerCase(Locale.ROOT)
                .replaceAll("[^\\p{L}\\p{N}\\s]", " ")
                .replaceAll("\\s+", " ")
                .trim();
    }

    private static String normalizePhrase(String value) {
        return normalizeText(value);
    }

    private final RecognitionListener listener = new RecognitionListener() {
        @Override
        public void onReadyForSpeech(Bundle params) {
            consecutiveErrors = 0;
        }

        @Override
        public void onBeginningOfSpeech() {
        }

        @Override
        public void onRmsChanged(float rmsdB) {
        }

        @Override
        public void onBufferReceived(byte[] buffer) {
        }

        @Override
        public void onEndOfSpeech() {
        }

        @Override
        public void onError(int error) {
            if (!monitoring || paused) return;
            consecutiveErrors++;
            switch (error) {
                case SpeechRecognizer.ERROR_NO_MATCH:
                case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                    // Normal silence: restart quietly, do not spam the UI.
                    scheduleRestart(250, null);
                    return;
                case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                    stopEverything("Microphone permission is missing, so wake-word monitoring stopped.");
                    return;
                case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                    scheduleRestart(900, "Waiting for the speech recognizer to be free…");
                    return;
                case SpeechRecognizer.ERROR_CLIENT:
                    cancelRecognizer();
                    scheduleRestart(800, "The speech recognizer reset; restarting monitoring…");
                    return;
                case SpeechRecognizer.ERROR_NETWORK:
                case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                        stopEverything("Wake-word monitoring stopped: the phone's speech service needs a network connection and kept failing. Tap-to-talk still works.");
                        return;
                    }
                    scheduleRestart(1500, "The speech service is unreachable; retrying…");
                    return;
                case SpeechRecognizer.ERROR_AUDIO:
                    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                        stopEverything("Wake-word monitoring stopped: the microphone is unavailable (another app may be holding it).");
                        return;
                    }
                    scheduleRestart(1200, "Microphone busy; retrying wake-word monitoring…");
                    return;
                case SpeechRecognizer.ERROR_SERVER:
                default:
                    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                        stopEverything("Wake-word monitoring stopped after repeated speech-service errors (code " + error + ").");
                        return;
                    }
                    scheduleRestart(1500, "Speech service error (code " + error + "); retrying…");
            }
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            String text = firstResult(partialResults);
            if (text != null && matchesWake(text)) onWakeDetected(text);
        }

        @Override
        public void onResults(Bundle results) {
            if (!monitoring || paused) return;
            String text = firstResult(results);
            if (text != null && matchesWake(text)) {
                onWakeDetected(text);
                return;
            }
            scheduleRestart(250, null);
        }

        @Override
        public void onEvent(int eventType, Bundle params) {
        }
    };

    private String firstResult(Bundle bundle) {
        if (bundle == null) return null;
        ArrayList<String> matches = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (matches == null) return null;
        for (String candidate : matches) {
            if (candidate != null && matchesWake(candidate)) return candidate;
        }
        return matches.isEmpty() ? null : matches.get(0);
    }

    // ── Foreground notification ────────────────────────────────────────────

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "J.A.R.V.I.S. wake word",
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while JARVIS is monitoring the microphone for “Hey JARVIS”.");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this, 1, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent stop = new Intent(this, JarvisWakeService.class);
        stop.setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(
                this, 2, stop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        String title = "J.A.R.V.I.S. is listening for “" + wakePhrase + "”";
        String detail;
        if ("paused".equals(state) || "wake".equals(state)) {
            detail = "Waiting for your command.";
        } else if ("error".equals(state) || "model-missing".equals(state)) {
            detail = message;
        } else {
            detail = "Microphone is on. Tap Stop to end monitoring.";
        }

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(detail)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(contentIntent)
                .addAction(0, "Stop monitoring", stopIntent)
                .build();
    }

    private void ensureForeground() {
        try {
            int type = 0;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            }
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type);
            foreground = true;
        } catch (Exception e) {
            Log.w(TAG, "startForeground failed", e);
            monitoring = false;
            publish("error", "Android refused to start the microphone foreground service: " + safeMessage(e));
            stopSelf();
        }
    }

    private void updateNotification() {
        try {
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification());
        } catch (Exception ignored) {
        }
    }

    private void stopEverything(String detail) {
        monitoring = false;
        paused = false;
        cancelRecognizer();
        publish("off", detail);
        try {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        } catch (Exception ignored) {
        }
        foreground = false;
        stopSelf();
    }

    @Override
    public void onDestroy() {
        monitoring = false;
        paused = false;
        cancelRecognizer();
        main.removeCallbacksAndMessages(null);
        if (!"error".equals(state) && !"model-missing".equals(state)) {
            state = "off";
            message = "Wake-word monitoring is off.";
        }
        Intent intent = new Intent(ACTION_WAKE_EVENT);
        intent.setPackage(getPackageName());
        intent.putExtra("type", "state");
        intent.putExtra("state", state);
        intent.putExtra("message", message);
        sendBroadcast(intent);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private static String safeMessage(Exception e) {
        String text = e.getMessage();
        return text == null || text.isEmpty() ? e.getClass().getSimpleName() : text;
    }
}
