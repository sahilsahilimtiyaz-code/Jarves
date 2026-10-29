/**
 * Owner-facing controller for the Android "Hey JARVIS" monitor.
 *
 * The real listening happens in `JarvisWakeService` (microphone foreground
 * service + the phone's SpeechRecognizer). This module:
 *  - persists the owner's choice so monitoring resumes after a restart,
 *  - requests the permissions the service needs before starting,
 *  - reports the real state the service broadcasts (no optimistic "listening"),
 *  - pauses the monitor while a command is captured, answered and spoken.
 *
 * If the native bridge or a speech-recognition service is missing, the state is
 * "unavailable"/"model-missing" with a reason. Nothing here pretends to listen.
 */
import * as native from "../platform/native";
import { usePrefs } from "./prefs";

export type WakeState =
  | "off"
  | "starting"
  | "monitoring"
  | "paused"
  | "wake"
  | "error"
  | "model-missing"
  | "unavailable";

export interface WakeSnapshot {
  /** The owner's persisted preference. */
  enabled: boolean;
  state: WakeState;
  message: string;
  modelReady: boolean;
  engine: string;
  updatedAt: number;
}

export interface WakePayload {
  text: string;
  phrase: string;
  at?: number;
}

type Listener = (snap: WakeSnapshot) => void;
type WakeHandler = (payload: WakePayload) => void;

const ACTIVE_STATES: WakeState[] = ["starting", "monitoring", "paused", "wake"];

export function wakeStateLabel(state: WakeState): string {
  switch (state) {
    case "monitoring":
      return "Listening for “Hey JARVIS”";
    case "starting":
      return "Starting microphone service…";
    case "paused":
      return "Paused while JARVIS answers";
    case "wake":
      return "Wake word heard";
    case "error":
      return "Monitoring error";
    case "model-missing":
      return "No speech service on this phone";
    case "unavailable":
      return "Native build required";
    default:
      return "Monitoring off";
  }
}

class WakeWordService {
  private snap: WakeSnapshot = {
    enabled: false,
    state: "off",
    message: "Wake-word monitoring is off.",
    modelReady: false,
    engine: "none",
    updatedAt: Date.now(),
  };

  private listeners = new Set<Listener>();
  private wired = false;
  private initPromise: Promise<void> | null = null;
  private handler: WakeHandler | null = null;
  private pending: WakePayload | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;

  getSnapshot(): WakeSnapshot {
    return this.snap;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snap);
    return () => this.listeners.delete(fn);
  }

  private patch(patch: Partial<WakeSnapshot>): void {
    this.snap = { ...this.snap, ...patch, updatedAt: Date.now() };
    for (const fn of this.listeners) {
      try {
        fn(this.snap);
      } catch {
        /* a broken subscriber must not stop monitoring */
      }
    }
  }

  private wire(): void {
    if (this.wired) return;
    this.wired = true;

    native.onNative("wakeState", (data: any) => {
      const state = typeof data?.state === "string" ? (data.state as WakeState) : undefined;
      if (!state) return;
      const enabled = ACTIVE_STATES.includes(state) ? true : state === "off" ? false : this.snap.enabled;
      this.patch({
        state,
        message: typeof data?.message === "string" ? data.message : this.snap.message,
        enabled,
      });
      if (state === "off" || state === "error" || state === "model-missing") {
        this.clearResumeTimer();
      }
    });

    native.onNative("wakeWord", (data: any) => {
      const payload: WakePayload = {
        text: typeof data?.text === "string" ? data.text : "",
        phrase: typeof data?.phrase === "string" ? data.phrase : "hey jarvis",
        at: typeof data?.at === "number" ? data.at : Date.now(),
      };
      this.patch({ state: "wake", message: "Wake word heard — listening for your command.", enabled: true });
      if (this.handler) {
        try {
          this.handler(payload);
        } catch (e) {
          console.warn("[wake] handler failed", e);
        }
      } else {
        // ChatScreen is not mounted yet; deliver as soon as it registers.
        this.pending = payload;
      }
    });
  }

  /** Call once at mobile boot. Restores the persisted preference. */
  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      this.wire();
      this.patch({
        enabled: usePrefs.getState().wakeWordEnabled,
      });

      const available = await native.nativeAvailable().catch(() => false);
      if (!available) {
        this.patch({
          state: "unavailable",
          message: "Wake-word monitoring runs only in the Android app build.",
          engine: "none",
          modelReady: false,
        });
        return;
      }

      try {
        const status = await native.wakeStatus();
        this.patch({
          state: (status?.state as WakeState) || "off",
          message: status?.message || this.snap.message,
          modelReady: Boolean(status?.modelReady),
          engine: status?.modelReady ? "android-speech-recognizer" : "none",
        });
        // Restore monitoring after a restart if the owner left it enabled.
        if (this.snap.enabled && !ACTIVE_STATES.includes(this.snap.state)) {
          const language = usePrefs.getState().micLanguage;
          const started = await native.wakeStart("hey jarvis", language);
          this.applyNativeStatus(started, true);
        }
      } catch (e) {
        this.patch({
          state: "error",
          message: e instanceof Error ? e.message : "Wake-word status could not be read.",
        });
      }
    })().finally(() => {
      // Allow a retry after a failed boot probe.
      if (this.snap.state === "error" || this.snap.state === "unavailable") this.initPromise = null;
    });
    return this.initPromise;
  }

  private applyNativeStatus(status: native.WakeStatus | undefined, requested: boolean): void {
    if (!status) {
      this.patch({ state: "error", message: "The Android bridge did not return a wake-word state." });
      return;
    }
    const state = (status.state as WakeState) || "off";
    const active = ACTIVE_STATES.includes(state);
    if (requested) {
      usePrefs.getState().setWakeWordEnabled(active);
    }
    this.patch({
      enabled: requested ? active : this.snap.enabled,
      state,
      message: status.message || this.snap.message,
      modelReady: Boolean(status.modelReady),
      engine: status.modelReady ? "android-speech-recognizer" : "none",
    });
  }

  /** Turn monitoring on, requesting microphone/notification permission first. */
  async enable(): Promise<{ ok: boolean; message: string }> {
    this.wire();
    const available = await native.nativeAvailable().catch(() => false);
    if (!available) {
      const message = "Wake-word monitoring needs the Android app build.";
      this.patch({ state: "unavailable", message, enabled: false });
      return { ok: false, message };
    }

    try {
      const caps = await native.checkPermissions();
      if (!caps.speechRecognition) {
        const message =
          "This phone has no Android speech-recognition service, so “Hey JARVIS” cannot be detected. Tap-to-talk still works.";
        this.patch({ state: "model-missing", message, modelReady: false, enabled: false });
        return { ok: false, message };
      }

      if (caps.microphone !== "granted") {
        const granted = await native.requestMicPermission();
        if (!granted?.granted) {
          const message =
            "Microphone permission was denied. Enable it in Android Settings → Apps → J.A.R.V.I.S. → Permissions → Microphone.";
          this.patch({ state: "error", message, enabled: false });
          return { ok: false, message };
        }
      }

      if (caps.notifications !== "granted") {
        try {
          await native.requestNotificationPermission();
        } catch {
          /* the foreground notification still works on most builds */
        }
      }

      const status = await native.wakeStart("hey jarvis", usePrefs.getState().micLanguage);
      this.applyNativeStatus(status, true);
      const ok = ACTIVE_STATES.includes((status?.state as WakeState) || "off");
      return {
        ok,
        message:
          status?.message ||
          (ok ? "Monitoring started." : "Android did not start the microphone service."),
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : "Wake-word monitoring could not start.";
      this.patch({ state: "error", message, enabled: false });
      return { ok: false, message };
    }
  }

  /** Turn monitoring off and release the microphone immediately. */
  async disable(): Promise<{ ok: boolean; message: string }> {
    this.clearResumeTimer();
    usePrefs.getState().setWakeWordEnabled(false);
    try {
      if (await native.nativeAvailable().catch(() => false)) {
        await native.wakeStop();
      }
    } catch {
      /* the preference is off either way */
    }
    this.patch({ state: "off", message: "Wake-word monitoring is off.", enabled: false });
    return { ok: true, message: "Monitoring stopped and the microphone was released." };
  }

  /** Temporarily stop the recognizer without changing the owner's preference. */
  async pause(): Promise<void> {
    if (!this.snap.enabled) return;
    try {
      if (await native.nativeAvailable().catch(() => false)) {
        const status = await native.wakePause();
        this.patch({
          state: (status?.state as WakeState) || "paused",
          message: status?.message || "Paused while JARVIS handles your command.",
          enabled: true,
        });
      }
    } catch {
      /* the service will be resumed below */
    }
  }

  /** Restart monitoring (safe to call when it was never paused). */
  async resumeNow(): Promise<void> {
    this.clearResumeTimer();
    if (!this.snap.enabled) return;
    try {
      if (!(await native.nativeAvailable().catch(() => false))) return;
      const status = await native.wakeResume();
      this.patch({
        state: (status?.state as WakeState) || "starting",
        message: status?.message || this.snap.message,
        enabled: true,
      });
    } catch (e) {
      this.patch({
        state: "error",
        message: e instanceof Error ? e.message : "Wake-word monitoring could not resume.",
      });
    }
  }

  /**
   * Pause for one spoken command. A watchdog resumes monitoring even if the
   * recognition session never produces a final result, so the microphone can
   * never be left silently paused forever.
   */
  async pauseForCommand(maxPauseMs = 20_000): Promise<void> {
    this.clearResumeTimer();
    await this.pause();
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      void this.resumeNow();
    }, maxPauseMs);
  }

  private clearResumeTimer(): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  /** Register the screen that turns a detected wake word into a command. */
  setWakeHandler(fn: WakeHandler | null): void {
    this.handler = fn;
    if (fn && this.pending) {
      const pending = this.pending;
      this.pending = null;
      try {
        fn(pending);
      } catch (e) {
        console.warn("[wake] pending handler failed", e);
      }
    }
  }

  /** Refresh from the real service (Settings diagnostics). */
  async refresh(): Promise<void> {
    try {
      if (!(await native.nativeAvailable().catch(() => false))) {
        this.patch({ state: "unavailable", engine: "none", modelReady: false });
        return;
      }
      const status = await native.wakeStatus();
      this.patch({
        state: (status?.state as WakeState) || "off",
        message: status?.message || this.snap.message,
        modelReady: Boolean(status?.modelReady),
        engine: status?.modelReady ? "android-speech-recognizer" : "none",
      });
    } catch (e) {
      this.patch({
        state: "error",
        message: e instanceof Error ? e.message : "Wake-word status could not be read.",
      });
    }
  }
}

export const wakeWordService = new WakeWordService();
