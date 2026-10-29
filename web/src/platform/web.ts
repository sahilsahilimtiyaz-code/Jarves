/**
 * Web / Electron adapter — defers to the browser behaviour the original
 * JARVIS desktop build already ships. Electron keeps its `window.jarvis`
 * preload bridge untouched; this adapter simply reports what exists.
 * Nothing here may alter desktop behaviour.
 */
import type { PlatformAdapter } from "./types";
import { detectPlatform, type Platform } from "./detect";

export class WebAdapter implements PlatformAdapter {
  readonly id: Platform = detectPlatform();

  get displayName(): string {
    return this.id === "electron" ? "Desktop (Electron)" : "Desktop (browser)";
  }

  readonly capabilities = {
    microphone: typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia),
    recording: typeof MediaRecorder !== "undefined",
    speechSynthesis: typeof window !== "undefined" && Boolean(window.speechSynthesis),
    serverTts: true, // backend /api/tts — reachable when the backend is configured
    openExternal: this.id === "electron", // desktop opens real browser windows
    downloads: true, // anchor download works on desktop
    clipboard: Boolean(navigator?.clipboard?.writeText),
    deviceCamera: false, // device-camera stills are an Android capability
    notifications: false,
    connectedDesktop: true, // shell / PC tools run on the host this backend serves
  };

  async init(): Promise<void> {
    // No setup needed on desktop/web — original behaviour stands.
  }

  async requestMicPermission(): Promise<boolean> {
    // Browsers grant lazily inside getUserMedia; the JarvisMic pipeline
    // surfaces denial through its own mic status strings. Report the
    // *availability* honestly; the real grant happens at first use.
    return this.capabilities.microphone;
  }

  async requestCameraPermission(): Promise<boolean> {
    return false;
  }

  async openExternal(url: string): Promise<void> {
    try {
      window.open(url, "_blank", "noopener");
    } catch { /* invalid URL — ignore */ }
  }

  async download(url: string, filename: string): Promise<boolean> {
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || "jarvis-download";
      document.body.appendChild(a);
      a.click();
      a.remove();
      return true;
    } catch {
      return false;
    }
  }

  async copyToClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  onResume(fn: () => void): () => void {
    const handler = () => {
      if (document.visibilityState === "visible") fn();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }

  notes(): string[] {
    if (this.id === "electron") {
      return [
        "PC-control and shell tools run on this desktop's backend.",
        "Closing the window keeps JARVIS in the tray (desktop behaviour).",
      ];
    }
    return ["Web mode: shell / PC tools run on the backend host, not this tab."];
  }
}
