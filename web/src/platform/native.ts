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
let listenersPromise: Promise<void> | null = null;
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
    // Capacitor usually injects the global before the first script, but on a
    // cold WebView start it can arrive after React's first render. Treat an
    // Android WebView as native even while `isNativePlatform` is settling, so
    // the permission gate is never skipped and the plugin can be registered as
    // soon as the bridge is ready.
    const reportsNative = typeof cap?.isNativePlatform === "function" ? cap.isNativePlatform() : false;
    const androidWebView =
      cap?.getPlatform?.() === "android" ||
      (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent) && Boolean(cap));
    if (!cap || (!reportsNative && !androidWebView)) return null;
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

/**
 * Probe the native bridge.
 *
 * A single failed `getCapabilities` used to be cached as `false` for the whole
 * process. One transient bridge hiccup at cold start therefore disabled every
 * native feature permanently: no provider storage, "engine: none", an unknown
 * mic permission and no phone actions until the app was force-stopped. Now a
 * failure is retried with backoff and is never cached, so the next call can
 * recover. A successful probe is cached because it is the expensive one.
 */
export function nativeAvailable(): Promise<boolean> {
  if (!availableCache) {
    availableCache = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const p = await nativePlugin();
        if (!p) return false;
        try {
          // Make sure event delivery exists before any stream or wake event can
          // be emitted. Safe to await repeatedly; the promise is memoised.
          await attachListeners(p);
          const res = await withTimeout<{ native?: boolean }>(p.getCapabilities(), "getCapabilities", 12_000);
          if (res?.native) return true;
        } catch {
          /* bridge not ready yet — retry below */
        }
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
      }
      // Do not memoise a failure: the caller may retry after the WebView settles.
      availableCache = null;
      return false;
    })();
  }
  return availableCache;
}

/** Forget a successful probe so the next call re-checks the bridge. */
export function resetNativeAvailability(): void {
  availableCache = null;
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

/**
 * Register every native event listener exactly once.
 *
 * This is awaited by the bridge probe: streaming responses emit `httpChunk`
 * immediately after the HTTP thread starts, and listeners used to be attached
 * only when the first `onNative()` call happened — one round trip per event.
 * Chunks that arrived during those round trips were silently lost, which made
 * long provider answers look empty or truncated.
 */
function attachListeners(plugin: any): Promise<void> {
  if (listenersPromise) return listenersPromise;
  listenersPromise = (async () => {
    const results = await Promise.all(
      EVENTS.map(async (name) => {
        try {
          const handle = await withTimeout<PluginListenerHandle>(
            plugin.addListener(name, (data: any) => {
              const set = bus.get(name);
              if (!set) return;
              for (const fn of set) {
                try {
                  fn(data);
                } catch (e) {
                  console.warn("[native] listener threw", name, e);
                }
              }
            }),
            `addListener:${name}`,
            4_000,
          );
          if (handle) handles.push(handle);
          return true;
        } catch {
          // A bridge that is not ready yet must not permanently disable event
          // delivery; a later probe retries the whole attachment.
          return false;
        }
      }),
    );
    if (results.some((ok) => !ok)) listenersPromise = null;
  })();
  return listenersPromise;
}

// ── Typed call helpers ─────────────────────────────────────────────────────

const DEFAULT_CALL_TIMEOUT = 20_000;

/**
 * Per-method ceilings. A Capacitor bridge call that never resolves used to
 * leave the UI stuck on "Saving…" forever; every call now fails loudly instead.
 */
const CALL_TIMEOUTS: Record<string, number> = {
  dbQuery: 15_000,
  dbExec: 15_000,
  secureSet: 15_000,
  secureGet: 15_000,
  secureRemove: 15_000,
  getCapabilities: 12_000,
  checkPermissions: 12_000,
  checkMicPermission: 12_000,
  requestMicPermission: 60_000,
  requestCameraPermission: 60_000,
  requestNotificationPermission: 60_000,
  httpRequest: 150_000,
  httpRequestBase64: 150_000,
  httpStreamStart: 30_000,
  httpAbort: 10_000,
  startListening: 25_000,
  stopListening: 15_000,
  speak: 20_000,
  stopSpeaking: 10_000,
  getVoices: 15_000,
  listApps: 20_000,
  openApp: 20_000,
  wakeStart: 25_000,
  wakeStop: 15_000,
  wakePause: 15_000,
  wakeResume: 25_000,
  wakeStatus: 12_000,
};

/** Resolve `promise` or reject with a bridge-specific message after `ms`. */
export async function withTimeout<T>(promise: Promise<T>, label: string, ms = DEFAULT_CALL_TIMEOUT): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`The Android bridge did not answer “${label}” within ${Math.round(ms / 1000)}s.`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function call<T>(method: string, args?: Record<string, unknown>): Promise<T> {
  const plugin = await nativePlugin();
  if (!plugin) throw new Error("Native bridge unavailable");
  const fn = (plugin as any)[method];
  if (typeof fn !== "function") {
    throw new Error(`The installed APK does not implement “${method}”. Install the current build.`);
  }
  return await withTimeout(fn.call(plugin, args ?? {}) as Promise<T>, method, CALL_TIMEOUTS[method] ?? DEFAULT_CALL_TIMEOUT);
}

/** Normalise Capacitor's permission enum ("GRANTED", "PROMPT_WITH_RATIONALE"). */
export function normalizePermissionState(raw: unknown):
  | "granted"
  | "denied"
  | "prompt"
  | "prompt_with_rationale"
  | "unknown" {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (value === "granted" || value === "denied" || value === "prompt" || value === "prompt_with_rationale") {
    return value;
  }
  return "unknown";
}

export function getCapabilities(): Promise<any> {
  return call("getCapabilities");
}

export interface NativePermissionReport {
  microphone: string;
  camera: string;
  notifications: string;
  speechRecognition: boolean;
  tts: boolean;
  ttsReady?: boolean;
  files?: boolean;
  plugin?: string;
}

export function checkMicPermission(): Promise<{ state: string }> {
  return call("checkMicPermission");
}

/** Everything the Permissions card needs, in one real native call. */
export async function checkPermissions(): Promise<NativePermissionReport> {
  const raw = await call<Partial<NativePermissionReport>>("checkPermissions");
  return {
    microphone: normalizePermissionState(raw?.microphone),
    camera: normalizePermissionState(raw?.camera),
    notifications: normalizePermissionState(raw?.notifications),
    speechRecognition: Boolean(raw?.speechRecognition),
    tts: Boolean(raw?.tts),
    ttsReady: Boolean(raw?.ttsReady),
    files: raw?.files !== false,
    plugin: typeof raw?.plugin === "string" ? raw.plugin : undefined,
  };
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

export async function getVoices(): Promise<{ voices: string[]; language?: string; ready?: boolean }> {
  const raw = await call<{ voices?: unknown; language?: string; ready?: boolean }>("getVoices");
  // Capacitor serialises a Java JSArray as an array-like object; normalise it
  // for every consumer instead of letting `Array.isArray` silently drop it.
  const voices = Array.isArray(raw?.voices)
    ? (raw.voices as string[])
    : raw?.voices && typeof raw.voices === "object"
      ? Object.values(raw.voices as Record<string, string>).filter((value) => typeof value === "string")
      : [];
  return { voices, language: raw?.language, ready: raw?.ready };
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

export function wakeStart(phrase?: string, language?: string): Promise<WakeStatus> {
  return call("wakeStart", { phrase: phrase || "hey jarvis", language: language || "en-US" });
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
  listenersPromise = null;
  handles.length = 0;
  bus.clear();
}
