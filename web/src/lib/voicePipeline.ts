/**
 * Voice pipeline — native Android SpeechRecognizer/TextToSpeech first, with
 * the original backend Whisper pipeline as the browser/desktop fallback.
 *
 * This module is used by the mobile UI. The desktop CommandBar keeps using
 * the original `mic`/`streamSpeak` implementation untouched.
 *
 * HONESTY RULES (enforced by voiceState.ts):
 *  - LISTENING is only entered after recognition actually started.
 *  - A transcript is only emitted when a real transcript exists.
 *  - SPEAKING is only entered when an audio engine actually started.
 *  - Every failure lands in ERROR with an actionable message.
 */
import { apiUrl, backendConfigured } from "./backend";
import { useStore } from "./store";
import { voiceStateLabel, voiceStateToOrb, reduceVoiceState, type VoiceEvent, type VoiceState } from "./voiceState";
import * as native from "../platform/native";
import { getAdapter } from "../platform";
import { cleanSpeechText } from "./speechText";

export type VoiceEngine = "native" | "web" | "none";

export interface VoiceSnapshot {
  state: VoiceState;
  /** Live partial transcript from the recognizer (never fabricated). */
  partial: string;
  /** Last finalized transcript. */
  transcript: string | null;
  error: string | null;
  /** Normalized 0..1 input/playback level for the 3D core. */
  level: number;
  engine: VoiceEngine;
  recognitionAvailable: boolean;
  ttsAvailable: boolean;
}

export interface StartOptions {
  onFinal: (text: string) => void;
  onPartial?: (text: string) => void;
  language?: string;
}

type Listener = (snap: VoiceSnapshot) => void;

const MAX_WEB_RECORDING_MS = 20_000;

class VoicePipeline {
  private snap: VoiceSnapshot = {
    state: "IDLE",
    partial: "",
    transcript: null,
    error: null,
    level: 0,
    engine: "none",
    recognitionAvailable: false,
    ttsAvailable: false,
  };

  private listeners = new Set<Listener>();
  private sessionId = 0;
  private opts: StartOptions | null = null;

  // Web (MediaRecorder) session resources
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;
  private webMime = "";

  // Web TTS playback
  private audio: HTMLAudioElement | null = null;
  private audioUrl: string | null = null;

  private wired = false;
  private ttsSession = 0;

  getSnapshot(): VoiceSnapshot {
    return this.snap;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snap);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    useStore.getState().setOrb(voiceStateToOrb(this.snap.state));
    for (const fn of this.listeners) {
      try {
        fn(this.snap);
      } catch {
        /* a broken subscriber must not break the pipeline */
      }
    }
  }

  private patch(patch: Partial<VoiceSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.emit();
  }

  private transition(event: VoiceEvent, patch: Partial<VoiceSnapshot> = {}): void {
    const state = reduceVoiceState(this.snap.state, event);
    this.snap = { ...this.snap, state, ...patch };
    if (event.type === "error") {
      this.snap.error = event.message || "Voice operation failed";
    } else if (event.type === "permission_denied") {
      this.snap.error = event.reason || "Microphone permission was denied";
    }
    if (event.type === "listening" || event.type === "reset" || event.type === "stop") {
      this.snap.error = null;
    }
    this.emit();
  }

  /** Probe engines honestly — used by Settings diagnostics. */
  async detect(): Promise<{ engine: VoiceEngine; recognition: boolean; tts: boolean; reason?: string }> {
    const isNative = await native.nativeAvailable();
    if (isNative) {
      this.wireNative();
      try {
        const caps = await native.getCapabilities();
        this.patch({
          engine: "native",
          recognitionAvailable: Boolean(caps?.speechRecognition),
          ttsAvailable: Boolean(caps?.tts),
        });
        return {
          engine: "native",
          recognition: Boolean(caps?.speechRecognition),
          tts: Boolean(caps?.tts),
          reason: caps?.speechRecognition ? undefined : "Android speech recognition service unavailable on this device",
        };
      } catch {
        this.patch({ engine: "native", recognitionAvailable: false, ttsAvailable: false });
        return { engine: "native", recognition: false, tts: false, reason: "Native bridge did not respond" };
      }
    }
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    const recognizer = Boolean(md?.getUserMedia) && typeof MediaRecorder !== "undefined";
    const tts = Boolean(
      (typeof window !== "undefined" && window.speechSynthesis) || backendConfigured(),
    );
    this.patch({ engine: recognizer ? "web" : "none", recognitionAvailable: recognizer, ttsAvailable: tts });
    return {
      engine: recognizer ? "web" : "none",
      recognition: recognizer,
      tts,
      reason: recognizer
        ? backendConfigured()
          ? undefined
          : "Browser capture works, but transcription needs the JARVIS backend (Whisper)"
        : "No audio capture API in this runtime",
    };
  }

  private wireNative(): void {
    if (this.wired) return;
    this.wired = true;

    native.onNative("speechPartial", (d) => {
      if (!this.opts) return;
      const text = typeof d?.text === "string" ? d.text : "";
      this.snap = { ...this.snap, partial: text };
      this.emit();
      this.opts.onPartial?.(text);
    });

    native.onNative("speechResult", (d) => {
      if (!this.opts) return;
      const text = typeof d?.text === "string" ? d.text.trim() : "";
      const opts = this.opts;
      this.opts = null;
      if (!text) {
        this.fail("No speech was recognized. Tap the microphone and speak again.");
        return;
      }
      this.transition({ type: "audio_captured" }, { partial: "" });
      this.transition({ type: "submitting" }, { transcript: text });
      opts.onFinal(text);
    });

    native.onNative("speechError", (d) => {
      if (!this.opts) return;
      this.opts = null;
      const message = typeof d?.message === "string" ? d.message : "Speech recognition failed";
      this.fail(message);
    });

    native.onNative("level", (d) => {
      const value = typeof d?.level === "number" ? d.level : 0;
      this.snap = { ...this.snap, level: Math.max(0, Math.min(1, value)) };
      this.emit();
    });

    native.onNative("ttsStart", () => {
      if (this.snap.state !== "SPEAKING") this.transition({ type: "speaking" });
    });
    native.onNative("ttsRange", (d) => {
      const level = typeof d?.level === "number" ? d.level : 0.6;
      this.snap = { ...this.snap, level: Math.max(0, Math.min(1, level)) };
      this.emit();
    });
    native.onNative("ttsDone", () => {
      this.transition({ type: "speech_done" }, { level: 0 });
    });
    native.onNative("ttsError", (d) => {
      this.fail(typeof d?.message === "string" ? d.message : "Text-to-speech failed");
    });
  }

  /** Public failure path for callers (e.g. request rejected by the backend). */
  fail(message: string): void {
    this.cleanupWeb();
    this.opts = null;
    this.transition({ type: "error", message });
  }

  markThinking(): void {
    this.transition({ type: "thinking" });
  }

  markIdle(): void {
    this.transition({ type: "reset" }, { level: 0, partial: "" });
  }

  markSpeaking(): void {
    this.transition({ type: "speaking" });
  }

  /**
   * Start a real recognition session.
   * Returns ok:false with a user-facing reason when it cannot start.
   */
  async startListening(opts: StartOptions): Promise<{ ok: boolean; error?: string }> {
    if (this.isBusy()) {
      await this.cancel();
    }
    this.sessionId++;
    this.opts = opts;
    this.snap = { ...this.snap, partial: "", transcript: null, error: null, level: 0 };
    this.transition({ type: "request_permission" });

    const isNative = await native.nativeAvailable();
    if (isNative) {
      this.wireNative();
      this.patch({ engine: "native" });
      let granted = false;
      try {
        let perm = await native.checkMicPermission();
        if (perm?.state !== "granted") {
          const req = await native.requestMicPermission();
          granted = Boolean(req?.granted);
          if (!granted) perm = await native.checkMicPermission();
          if (perm?.state === "granted") granted = true;
        } else {
          granted = true;
        }
      } catch {
        granted = false;
      }
      if (!granted) {
        const message =
          "Microphone permission denied. Enable it in Android Settings → Apps → J.A.R.V.I.S. → Permissions → Microphone, then try again.";
        this.fail(message);
        return { ok: false, error: message };
      }
      try {
        const started = await native.startListening(opts.language || "en-US");
        if (!started?.granted) {
          const message =
            started?.reason ||
            "Android speech recognition could not start. Check that a speech-recognition service (e.g. Google) is installed and enabled.";
          this.fail(message);
          return { ok: false, error: message };
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : "Android speech recognition could not start.";
        this.fail(message);
        return { ok: false, error: message };
      }
      this.transition({ type: "listening" });
      return { ok: true };
    }

    return this.startWebRecording(opts);
  }

  private isBusy(): boolean {
    const s = this.snap.state;
    return s === "LISTENING" || s === "REQUESTING_PERMISSION" || s === "TRANSCRIBING" || s === "PROCESSING_AUDIO";
  }

  private async startWebRecording(opts: StartOptions): Promise<{ ok: boolean; error?: string }> {
    this.patch({ engine: "web" });
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md?.getUserMedia || typeof MediaRecorder === "undefined") {
      const message =
        "This runtime has no microphone capture. Use the Android app build (native speech bridge) or a browser with microphone support.";
      this.fail(message);
      return { ok: false, error: message };
    }
    try {
      const adapterOk = await getAdapter().requestMicPermission().catch(() => false);
      if (adapterOk === false) {
        // Not necessarily fatal in a browser (grant happens at getUserMedia),
        // so continue and let the platform error be the source of truth.
      }
      this.stream = await md.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      const message =
        name === "NotAllowedError"
          ? "Microphone permission was denied. Allow microphone access for J.A.R.V.I.S. in the system permission prompt or app settings."
          : name === "NotFoundError"
            ? "No microphone was found on this device."
            : `Could not open the microphone${name ? ` (${name})` : ""}. Another app may be using it.`;
      this.fail(message);
      return { ok: false, error: message };
    }

    this.webMime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";
    this.chunks = [];
    try {
      this.recorder = new MediaRecorder(this.stream, this.webMime ? { mimeType: this.webMime } : undefined);
    } catch {
      this.cleanupWeb();
      const message = "Audio recording is not supported by this WebView.";
      this.fail(message);
      return { ok: false, error: message };
    }
    const session = this.sessionId;
    this.recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
    };
    this.recorder.onstop = () => {
      if (session === this.sessionId) void this.transcribeWeb();
    };
    try {
      this.recorder.start(250);
    } catch {
      this.cleanupWeb();
      const message = "Audio recording could not start.";
      this.fail(message);
      return { ok: false, error: message };
    }
    this.transition({ type: "listening" });
    this.autoStopTimer = setTimeout(() => void this.stopListening(), MAX_WEB_RECORDING_MS);
    void opts;
    return { ok: true };
  }

  /** Stop capture and let the engine finalize/transcribe. */
  async stopListening(): Promise<void> {
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
    if (await native.nativeAvailable()) {
      const hadSession = !!this.opts;
      if (!hadSession) return;
      try {
        await native.stopListening();
      } catch {
        this.fail("Could not stop the recorder cleanly.");
        return;
      }
      this.transition({ type: "audio_captured" });
      return;
    }
    if (this.recorder && this.recorder.state === "recording") {
      try {
        this.recorder.stop();
      } catch {
        this.cleanupWeb();
        this.fail("Could not finish the recording.");
      }
      return;
    }
    if (this.snap.state === "LISTENING") {
      this.fail("The recording ended before any audio was captured. Try again.");
    }
  }

  /** Cancel without submitting anything (user-initiated). */
  async cancel(): Promise<void> {
    this.sessionId++;
    this.opts = null;
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
    if (await native.nativeAvailable()) {
      try {
        await native.cancelListening();
      } catch {
        /* noop */
      }
    }
    this.cleanupWeb();
    this.transition({ type: "stop" }, { partial: "", level: 0 });
  }

  private async transcribeWeb(): Promise<void> {
    this.transition({ type: "audio_captured" });
    const blob = new Blob(this.chunks, { type: this.webMime || "audio/webm" });
    this.chunks = [];
    this.cleanupWeb();
    if (blob.size < 2500) {
      this.fail("No speech was captured. Tap the microphone and speak after it opens.");
      return;
    }
    if (!backendConfigured()) {
      this.fail(
        "Speech transcription needs the JARVIS backend (Whisper). Configure the backend address in Settings → Backend, then try again.",
      );
      return;
    }
    this.transition({ type: "transcribing" });
    const session = this.sessionId;
    try {
      const form = new FormData();
      form.append("audio", blob, this.webMime.includes("mp4") ? "speech.mp4" : "speech.webm");
      const resp = await fetch(apiUrl("/api/stt"), { method: "POST", body: form });
      if (session !== this.sessionId) return; // cancelled while in flight
      if (!resp.ok) throw new Error(`Transcription failed (HTTP ${resp.status})`);
      const data = await resp.json();
      const text = typeof data?.text === "string" ? data.text.trim() : "";
      if (!text) {
        this.fail("Transcription returned no text — the clip was silent or not recognized.");
        return;
      }
      const opts = this.opts;
      this.opts = null;
      this.transition({ type: "submitting" }, { transcript: text });
      opts?.onFinal(text);
    } catch (e) {
      if (session !== this.sessionId) return;
      const message = e instanceof Error ? e.message : "Transcription failed";
      this.fail(`${message}. Check the backend connection in Settings.`);
    }
  }

  /**
   * Speak text using a real engine. Native Android TTS on the APK, backend
   * /api/tts or browser speech synthesis elsewhere. Returns false with a
   * reason when no engine is usable.
   */
  async speak(text: string): Promise<{ ok: boolean; error?: string }> {
    const clean = cleanSpeechText(text);
    if (!clean) return { ok: false, error: "Nothing to speak" };

    if (await native.nativeAvailable()) {
      this.wireNative();
      this.ttsSession++;
      try {
        await native.stopSpeaking();
        const res = await native.speak(clean);
        if (!res?.ok) {
          const message = res?.reason || "Android text-to-speech is unavailable on this device.";
          this.fail(message);
          return { ok: false, error: message };
        }
        // SPEAKING is entered by the real "ttsStart" callback, not optimistically.
        return { ok: true };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Android text-to-speech failed.";
        this.fail(message);
        return { ok: false, error: message };
      }
    }

    this.stopWebAudio();
    if (backendConfigured()) {
      try {
        const resp = await fetch(apiUrl("/api/tts"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: clean }),
        });
        if (resp.ok) {
          const blob = await resp.blob();
          if (blob.size > 0) {
            this.audioUrl = URL.createObjectURL(blob);
            this.audio = new Audio(this.audioUrl);
            this.audio.onended = () => {
              this.transition({ type: "speech_done" }, { level: 0 });
              this.stopWebAudio();
            };
            this.audio.onerror = () => {
              this.stopWebAudio();
              this.fail("Backend speech audio could not be played.");
            };
            this.transition({ type: "speaking" });
            await this.audio.play();
            return { ok: true };
          }
        }
      } catch {
        /* fall through to browser TTS */
      }
    }

    const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
    if (synth) {
      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.lang = "en-GB";
      utterance.rate = 0.94;
      utterance.pitch = 0.82;
      utterance.onstart = () => this.transition({ type: "speaking" });
      utterance.onend = () => this.transition({ type: "speech_done" }, { level: 0 });
      utterance.onerror = () => this.fail("Browser speech synthesis failed (no voice installed?).");
      synth.cancel();
      synth.speak(utterance);
      return { ok: true };
    }

    const message = "No text-to-speech engine is available. Configure a backend or install a system voice.";
    this.fail(message);
    return { ok: false, error: message };
  }

  async stopSpeaking(): Promise<void> {
    if (await native.nativeAvailable()) {
      try {
        await native.stopSpeaking();
      } catch {
        /* noop */
      }
    }
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* noop */
    }
    this.stopWebAudio();
    if (this.snap.state === "SPEAKING") this.transition({ type: "speech_done" }, { level: 0 });
  }

  private stopWebAudio(): void {
    if (this.audio) {
      try {
        this.audio.pause();
        this.audio.removeAttribute("src");
        this.audio.load();
      } catch {
        /* noop */
      }
      this.audio = null;
    }
    if (this.audioUrl) {
      try {
        URL.revokeObjectURL(this.audioUrl);
      } catch {
        /* noop */
      }
      this.audioUrl = null;
    }
  }

  private cleanupWeb(): void {
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
    if (this.recorder) {
      try {
        this.recorder.ondataavailable = null;
        this.recorder.onstop = null;
        if (this.recorder.state === "recording") this.recorder.stop();
      } catch {
        /* noop */
      }
      this.recorder = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* noop */
        }
      }
      this.stream = null;
    }
  }

  /** Label for the UI — same text the state machine uses. */
  label(): string {
    if (this.snap.state === "ERROR" && this.snap.error) return this.snap.error;
    return voiceStateLabel(this.snap.state);
  }
}

export const voicePipeline = new VoicePipeline();
export { cleanSpeechText };
