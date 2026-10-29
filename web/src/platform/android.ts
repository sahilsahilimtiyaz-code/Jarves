/**
 * Android (Capacitor) adapter.
 *
 * Native concerns are wired through first-party Capacitor plugins, imported
 * DYNAMICALLY so the desktop bundle never includes them. Behaviour contract:
 *  - permissions are requested lazily and honestly (denials are reported,
 *    never faked)
 *  - external links leave the WebView via the OS browser
 *  - "download" uses the Android share sheet (webView downloads are silent
 *    no-ops in Capacitor — this is the reliable save path)
 *  - resume events trigger the caller's reconnect logic — the WebSocket
 *    channel does not survive process death or long backgrounds
 *
 * The plugin imports happen with narrow fallbacks so the adapter degrades
 * to browser-only behaviour when a plugin isn't installed.
 */
import type { PlatformAdapter } from "./types";

type AnyModule = Record<string, any>;

async function tryImport(): Promise<AnyModule | null> {
  try {
    return await import("@capacitor/core");
  } catch {
    return null;
  }
}

async function requireModule(name: string): Promise<AnyModule | null> {
  try {
    return await import(/* @vite-ignore */ name);
  } catch {
    return null;
  }
}

export class AndroidAdapter implements PlatformAdapter {
  readonly id = "android" as const;
  readonly displayName = "Android";

  readonly capabilities = {
    microphone: typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia),
    recording: typeof MediaRecorder !== "undefined",
    speechSynthesis: Boolean(
      typeof window !== "undefined" && (window as any).speechSynthesis,
    ), // Android WebView: often absent — adapter dies happily to server TTS
    serverTts: true,
    openExternal: true,
    downloads: true, // via filesystem + share sheet
    clipboard: true,
    deviceCamera: true,
    notifications: false, // no notification channel is authorised in v1
    connectedDesktop: false, // phone ≠ Windows host; PC tools run on the backend host
  };

  async init(): Promise<void> {
    const cap = await tryImport();
    if (!cap) return;
    // Warm the app plugin so resume events are delivered even before first
    // use (Capacitor lazily loads plugin bridges on demand otherwise).
    void requireModule("@capacitor/app");
  }

  async requestMicPermission(): Promise<boolean> {
    const cap = await tryImport();
    if (!cap?.Capacitor?.Permissions) return false;
    // REQUEST_RECORD_AUDIO == 'microphone' in Capacitor's public alias
    return this._requestPermission(cap, "microphone" as any);
  }

  async requestCameraPermission(): Promise<boolean> {
    const cap = await tryImport();
    if (!cap?.Capacitor?.Permissions) return false;
    return this._requestPermission(cap, "camera" as any);
  }

  private async _requestPermission(cap: AnyModule, perm: string): Promise<boolean> {
    try {
      const state = await cap.Capacitor.Permissions.query({ permission: perm });
      if (state?.state === "granted") return true;
      const res = await cap.Capacitor.Permissions.request({ permission: perm });
      return res?.state === "granted";
    } catch {
      return false;
    }
  }

  async openExternal(url: string): Promise<void> {
    const mod = await requireModule("@capacitor/browser");
    const Browser = mod?.Browser ?? null;
    if (Browser?.open?.bind(Browser)) {
      await Browser.open({ url, presentationStyle: "fullscreen" });
      return;
    }
    // No browser plugin — last resort: window.open escaped in the WebView's
    // default behaviour, which on Android still leaves the app if Capacitor
    // can catch the navigation.
    try {
      window.open(url, "_blank");
    } catch { /* ignore */ }
  }

  async download(url: string, filename: string): Promise<boolean> {
    // Capacitor's WebView has no download manager — fetch → cache file →
    // share sheet. The share sheet exposes "Save to files / Gallery" so the
    // user completes the download explicitly.
    try {
      const resp = await fetch(url);
      if (!resp.ok) return false;
      const blob = await resp.blob();
      const data = await this._blobToDataUrl(blob);
      const fsMod = await requireModule("@capacitor/filesystem");
      const FS = fsMod?.Filesystem;
      if (!FS) return false;
      const file = await FS.writeFile({
        path: `Download/jarvis-${Date.now()}-${filename || "media"}`,
        directory: "Cache" as any,
        data,
        recursive: true,
      } as any);
      const shareMod = await requireModule("@capacitor/share");
      const Share = shareMod?.Share;
      if (Share) {
        await Share.share({
          title: filename || "JARVIS media",
          url: file.uri,
          dialogTitle: "Save JARVIS media",
        } as any);
      }
      return true;
    } catch {
      return false;
    }
  }

  private _blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  async copyToClipboard(text: string): Promise<boolean> {
    try {
      const mod = await requireModule("@capacitor/clipboard");
      const Clip = mod?.Clipboard;
      if (Clip) {
        await Clip.write({ string: text });
        return true;
      }
    } catch { /* fall through */ }
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  onResume(fn: () => void): () => void {
    let cancelled = false;
    let off: (() => void) | null = null;
    void (async () => {
      const mod = await requireModule("@capacitor/app");
      const App = mod?.App;
      if (!App || cancelled) return;
      const handler = App.addListener("resume", () => {
        if (!cancelled) fn();
      });
      // registerPlugin listener returns PluginListenerHandle (a promise in
      // older versions, resolved object in current versions).
      const real = await handler;
      off = () => {
        try { real?.remove?.(); } catch { /* noop */ }
      };
    })();
    return () => {
      cancelled = true;
      try { off?.(); } catch { /* noop */ }
    };
  }

  notes(): string[] {
    return [
      "Speech recognition runs on your JARVIS backend (Whisper) — the phone needs a configured backend host for STT/TTS.",
      'Browser "Google TTS" is unavailable in Android WebView; use JARVIS voice settings (Piper / Edge) via backend.',
      "PC-control, PowerShell and desktop webcam tools run on the connected backend host — never on this phone.",
      "For internet-side access use HTTPS (reverse proxy) — cleartext HTTP is allowed for LAN-specific addresses only as required for the local lab setup.",
    ];
  }
}
