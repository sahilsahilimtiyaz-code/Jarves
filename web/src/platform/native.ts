/**
 * Native Android bridge (Capacitor plugin "JarvisNative").
 *
 * WHY THIS EXISTS
 * ---------------
 * The original port relied on the WebView's `getUserMedia`/`MediaRecorder`
 * plus the backend `/api/stt` route for speech. In an Android WebView that
 * fails in several independent ways (no runtime RECORD_AUDIO grant before the
 * WebView asks, no Web Speech API, no browser voices, and no backend on a
 * fresh install). A small, well-scoped native plugin fixes the whole chain:
 * Android `SpeechRecognizer` for STT, Android `TextToSpeech` for output, real
 * device sensors, intents and the Storage Access Framework.
 *
 * CONTRACT
 * --------
 * Every call resolves or throws; nothing is mocked. When the plugin is not
 * installed (plain browser, Electron, desktop preview) `nativeAvailable()`
 * resolves false and callers surface a visible reason rather than fake data.
 *
 * The plugin class lives at:
 *   web/android/app/src/main/java/com/jarvis/local/JarvisNativePlugin.java
 */
import type { PluginListenerHandle } from "@capacitor/core";

export interface NativeDeviceInfo {
  manufacturer: string;
  brand: string;
  model: string;
  device: string;
  androidRelease: string;
  sdkInt: number;
  batteryPercent: number;
  charging: boolean;
  batteryTemperatureC?: number;
  cpuCores: number;
  load1?: number;
  totalRamMb?: number;
  availRamMb?: number;
  appVersion?: string;
}

export interface NativeAppEntry {
  label: string;
  packageName: string;
}

export interface NativeActionResult {
  ok: boolean;
  launched?: boolean;
  message?: string;
  label?: string;
  packageName?: string;
  matches?: NativeAppEntry[];
}

export type NativeSpeechEvent =
  | { type?: string; text?: string; partial?: boolean; message?: string; code?: number; level?: number };

type Handler = (data: any) => void;

const EVENTS = [
  "speechPartial",
  "speechResult",
  "speechError",
  "speechState",
  "level",
  "ttsStart",
  "ttsRange",
  "ttsDone",
  "ttsError",
  "httpChunk",
  "httpDone",
  "httpError",
  "wakeWord",
  "wakeState",
] as const;

type NativeEventName = (typeof EVENTS)[number];

const bus = new Map<string, Set<Handler>>();
let pluginPromise: Promise<any | null> | null = null;
let listenersAttached = false;
const handles: PluginListenerHandle[] = [];

/**
 * Resolve the native plugin once. Returns null for every non-Android runtime.
 * registerPlugin is imported dynamically so the desktop bundle does not pull
 * @capacitor/core into its critical path.
 */
export function nativePlugin(): Promise<any | null> {
  if (pluginPromise) return pluginPromise;
  pluginPromise = (async () => {
    if (typeof window === "undefined") return null;
    const cap = (window as any).Capacitor;
    if (!cap || typeof cap.isNativePlatform !== "function" || !cap.isNativePlatform()) return null;
    try {
      const core = await import("@capacitor/core");
      return core.registerPlugin("JarvisNative") as any;
    } catch {
      return null;
    }
  })();
  return pluginPromise;
}

let availableCache: Promise<boolean> | null = null;
export function nativeAvailable(): Promise<boolean> {
  if (!availableCache) {
    availableCache = (async () => {
      const p = await nativePlugin();
      if (!p) return false;
      try {
        const res = await p.getCapabilities();
        return Boolean(res?.native);
      } catch {
        return false;
      }
    })();
  }
  return availableCache;
}

/** Subscribe to a native event. Returns an unsubscribe function. */
export function onNative(name: NativeEventName, fn: Handler): () => void {
  let set = bus.get(name);
  if (!set) {
    set = new Set<Handler>();
    bus.set(name, set);
  }
  set.add(fn);
  void nativePlugin()
    .then((p) => (p ? attachListeners(p) : undefined))
    .catch(() => undefined);
  return () => {
    set?.delete(fn);
  };
}

async function attachListeners(plugin: any): Promise<void> {
  if (listenersAttached) return;
  listenersAttached = true;
  for (const name of EVENTS) {
    try {
      const handle = await plugin.addListener(name, (data: any) => {
        const set = bus.get(name);
        if (!set) return;
        for (const fn of set) {
          try {
            fn(data);
          } catch (e) {
            console.warn("[native] listener threw", name, e);
          }
        }
      });
      if (handle) handles.push(handle);
    } catch {
      // Older shells may not declare every event; subscription is best-effort
      // and the caller still receives the promise rejection from the method.
    }
  }
}

// ── Typed call helpers ─────────────────────────────────────────────────────

async function call<T>(method: string, args?: Record<string, unknown>): Promise<T> {
  const plugin = await nativePlugin();
  if (!plugin) throw new Error("Native bridge unavailable");
  return (await plugin[method](args ?? {})) as T;
}

export function getCapabilities(): Promise<any> {
  return call("getCapabilities");
}

export function checkMicPermission(): Promise<{ state: string }> {
  return call("checkMicPermission");
}

export function requestMicPermission(): Promise<{ granted: boolean }> {
  return call("requestMicPermission");
}

export function requestCameraPermission(): Promise<{ granted: boolean }> {
  return call("requestCameraPermission");
}

export function requestNotificationPermission(): Promise<{ granted: boolean }> {
  return call("requestNotificationPermission");
}

export function startListening(language?: string): Promise<{ granted: boolean; reason?: string }> {
  return call("startListening", { language: language || "en-US" });
}

export function stopListening(): Promise<void> {
  return call("stopListening");
}

export function cancelListening(): Promise<void> {
  return call("cancelListening");
}

export function speak(text: string, voice?: string): Promise<{ ok: boolean; reason?: string }> {
  return call("speak", { text, voice: voice ?? "" });
}

export function stopSpeaking(): Promise<void> {
  return call("stopSpeaking");
}

export function getVoices(): Promise<{ voices: string[]; language?: string }> {
  return call("getVoices");
}

export function getDeviceInfo(): Promise<NativeDeviceInfo> {
  return call("getDeviceInfo");
}

export function listApps(): Promise<{ apps: NativeAppEntry[] }> {
  return call("listApps");
}

export function openApp(query: string): Promise<NativeActionResult> {
  return call("openApp", { query });
}

export function openSettings(target: string): Promise<NativeActionResult> {
  return call("openSettings", { target });
}

export function clipboardWrite(text: string): Promise<{ ok: boolean }> {
  return call("clipboardWrite", { text });
}

export function clipboardRead(): Promise<{ text: string }> {
  return call("clipboardRead");
}

export function notify(title: string, body: string): Promise<NativeActionResult> {
  return call("notify", { title, body });
}

export function shareText(text: string): Promise<NativeActionResult> {
  return call("shareText", { text });
}

export function pickImage(
  source: "camera" | "gallery",
): Promise<{ dataUrl?: string; mime?: string; name?: string; error?: string; cancelled?: boolean }> {
  return call("pickImage", { source });
}

export function pickFile(): Promise<{
  name?: string;
  mime?: string;
  size?: number;
  dataUrl?: string;
  error?: string;
  cancelled?: boolean;
}> {
  return call("pickFile");
}

// ── Secure credential vault (Android Keystore) ────────────────────────────

export function secureSet(name: string, value: string): Promise<void> {
  return call("secureSet", { name, value });
}

export function secureGet(name: string): Promise<{ value: string | null }> {
  return call("secureGet", { name });
}

export function secureRemove(name: string): Promise<void> {
  return call("secureRemove", { name });
}

// ── Local SQLite memory ───────────────────────────────────────────────────

export function dbQuery(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, any>[] }> {
  return call("dbQuery", { sql, params });
}

export function dbExec(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
  return call("dbExec", { sql, params });
}

// ── Provider network (native HTTP avoids provider CORS) ───────────────────

export interface NativeHttpResponse {
  status: number;
  body: string;
}

export function httpRequest(input: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  allowInsecure?: boolean;
}): Promise<NativeHttpResponse> {
  return call("httpRequest", input);
}

export function httpStreamStart(input: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  allowInsecure?: boolean;
}): Promise<{ streamId: string }> {
  return call("httpStreamStart", input);
}

export function httpAbort(input: { streamId: string }): Promise<void> {
  return call("httpAbort", input);
}

/** Binary/audio request: returns base64 for audio content types. */
export function httpRequestBase64(input: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  allowInsecure?: boolean;
}): Promise<{ status: number; base64?: string; mime?: string; body?: string }> {
  return call("httpRequestBase64", input);
}

/** Open this app's Android permission page (permanent denials). */
export function openAppSettings(): Promise<{ ok: boolean; message?: string }> {
  return call("openAppSettings");
}

// ── Wake word (foreground microphone service) ─────────────────────────────

export interface WakeStatus {
  state: "off" | "starting" | "monitoring" | "paused" | "wake" | "error" | "model-missing";
  modelReady: boolean;
  message?: string;
}

export function wakeStatus(): Promise<WakeStatus> {
  return call("wakeStatus");
}

export function wakeStart(): Promise<WakeStatus> {
  return call("wakeStart");
}

export function wakeStop(): Promise<WakeStatus> {
  return call("wakeStop");
}

export function wakePause(): Promise<WakeStatus> {
  return call("wakePause");
}

export function wakeResume(): Promise<WakeStatus> {
  return call("wakeResume");
}

export function wakeDownloadModel(): Promise<{ ok: boolean; message: string }> {
  return call("wakeDownloadModel");
}

/** Test hook: forget cached plugin/listener state (never used in production). */
export function __resetNativeForTests(): void {
  pluginPromise = null;
  availableCache = null;
  listenersAttached = false;
  handles.length = 0;
  bus.clear();
}
