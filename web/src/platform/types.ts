/**
 * Platform capability types — the single abstraction surface for
 * desktop (Electron), web (backend-served) and Android (Capacitor)
 * behaviour. Each capability reports HONEST availability; callers must
 * degrade visibly rather than fake success.
 */
import type { Platform } from "./detect";

export interface PlatformCapabilities {
  /** getUserMedia microphone capture available */
  microphone: boolean;
  /** MediaRecorder audio recording available */
  recording: boolean;
  /** window.speechSynthesis (browser TTS) available */
  speechSynthesis: boolean;
  /** Server-side TTS reachable through the backend (/api/tts) */
  serverTts: boolean;
  /** Serve an external link in the OS browser */
  openExternal: boolean;
  /** Save/share files to device storage */
  downloads: boolean;
  /** System clipboard write */
  clipboard: boolean;
  /** Capture still images via the device camera (not the backend webcam) */
  deviceCamera: boolean;
  /** Native notifications (outside the page) */
  notifications: boolean;
  /** Windows-PC control tools are intended for this platform */
  connectedDesktop: boolean;
}

export interface PlatformAdapter {
  readonly id: Platform;
  readonly displayName: string;
  readonly capabilities: PlatformCapabilities;
  /** One-time async setup (permissions priming, listeners, …). */
  init(): Promise<void>;
  /** Ask the OS for microphone access. Resolves to granted/denied. */
  requestMicPermission(): Promise<boolean>;
  /** Ask the OS for camera access. Resolves to granted/denied. */
  requestCameraPermission(): Promise<boolean>;
  /** Open a URL in the OS browser (or deny gracefully on unsupported). */
  openExternal(url: string): Promise<void>;
  /**
   * Persist/download content. `url` may be any fetchable URL (often a
   * backend media URL). Returns false when the platform cannot save.
   */
  download(url: string, filename: string): Promise<boolean>;
  copyToClipboard(text: string): Promise<boolean>;
  /** Register a resume/foreground callback (app-return and WS reconnect). */
  onResume(fn: () => void): () => void;
  /** Free-form advisory text shown in Settings (per-platform limitations). */
  notes(): string[];
}
