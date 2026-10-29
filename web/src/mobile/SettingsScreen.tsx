import { useCallback, useEffect, useState } from "react";
import {
  backendBase,
  backendConfigured,
  probeBackend,
  setBackendBase,
  normalizeBackendUrl,
} from "../lib/backend";
import { wsClient } from "../lib/ws";
import { useStore } from "../lib/store";
import { MIC_LANGUAGES, usePrefs } from "../lib/prefs";
import { useLocalMemory } from "../lib/memoryStore";
import { useBackendHealth, useProviderStatus, useVoiceStatus, useWakeWordStatus } from "./hooks";
import { voicePipeline } from "../lib/voicePipeline";
import { wakeWordService, wakeStateLabel } from "../lib/wakeWordService";
import { voiceStateLabel } from "../lib/voiceState";
import * as native from "../platform/native";
import TtsPanel from "./TtsPanel";
import { detectPlatform } from "../platform";
import { APP_BUILD } from "../lib/version";
import { Card, Chip, Row, ScreenHeader, Section, Toggle } from "./ui";
import type { ScreenProps } from "./types";

type Probe = { state: "idle" | "testing" | "ok" | "fail"; message: string };

const SPEECH_TEST = "Good evening, sir. All voice systems are online and at your service.";

export default function SettingsScreen({ onNavigate }: ScreenProps) {
  const health = useBackendHealth(30_000);
  const voice = useVoiceStatus();
  const wake = useWakeWordStatus();
  const provider = useProviderStatus();
  const connected = useStore((s) => s.connected);
  const voiceEnabled = useStore((s) => s.voiceEnabled);
  const setVoiceEnabled = useStore((s) => s.setVoiceEnabled);
  const clearChat = useStore((s) => s.clearChat);
  const clearTools = useStore((s) => s.clearTools);
  const clearMedia = useStore((s) => s.clearMedia);
  const clearLocalMemory = useLocalMemory((s) => s.clear);
  const notes = useLocalMemory((s) => s.notes);

  const animationMode = usePrefs((s) => s.animationMode);
  const setAnimationMode = usePrefs((s) => s.setAnimationMode);
  const micLanguage = usePrefs((s) => s.micLanguage);
  const setMicLanguage = usePrefs((s) => s.setMicLanguage);
  const accent = usePrefs((s) => s.accent);
  const setAccent = usePrefs((s) => s.setAccent);

  const platform = detectPlatform();
  const [url, setUrl] = useState(backendBase());
  const [probe, setProbe] = useState<Probe>({ state: "idle", message: "" });
  const [voices, setVoices] = useState<string[]>([]);
  const [caps, setCaps] = useState<Record<string, unknown> | null>(null);
  const [permState, setPermState] = useState<string>("unknown");
  const [perms, setPerms] = useState<native.NativePermissionReport | null>(null);
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const [micTest, setMicTest] = useState<string | null>(null);
  const [voiceTestState, setVoiceTestState] = useState<string | null>(null);
  const [permNotice, setPermNotice] = useState<string | null>(null);
  const [wakeBusy, setWakeBusy] = useState(false);
  const [wakeNotice, setWakeNotice] = useState<string | null>(null);

  const refreshNative = useCallback(async () => {
    const available = await native.nativeAvailable().catch(() => false);
    if (!available) return;
    try {
      const [c, v, p] = await Promise.all([
        native.getCapabilities(),
        native.getVoices(),
        native.checkPermissions(),
      ]);
      setCaps(c || null);
      setVoices(Array.isArray(v?.voices) ? v.voices : []);
      setPerms(p);
      setPermState(p.microphone);
    } catch {
      /* diagnostics stay honest: absent values simply stay empty */
    }
  }, []);

  useEffect(() => {
    void refreshNative();
  }, [refreshNative]);

  const saveBackend = async () => {
    setProbe({ state: "testing", message: "Saving and probing /api/health…" });
    const normalized = normalizeBackendUrl(url);
    if (url.trim() && !normalized) {
      setProbe({
        state: "fail",
        message: "That is not a valid http(s) address. Example: http://192.168.1.20:7341",
      });
      return;
    }
    const base = await setBackendBase(url);
    setUrl(base);
    const started = performance.now();
    const result = base ? await probeBackend(base) : await probeBackend("");
    const latency = Math.round(performance.now() - started);
    if (result) {
      setProbe({
        state: "ok",
        message: `Online in ${latency} ms · ${result.name} · ${result.model?.provider}/${result.model?.model} · ${result.tools} tools`,
      });
      useStore.getState().setHealth(result);
      wsClient.reconnectNow();
    } else {
      setProbe({
        state: "fail",
        message: base
          ? "No response from /api/health. Check the host/IP, that the backend is running, and the firewall."
          : "No address entered. Chat stays offline until a backend is configured.",
      });
    }
  };

  const requestMic = async () => {
    try {
      const granted = await voicePipeline.startListening({
        language: micLanguage,
        onFinal: (text) => {
          setMicTest(text);
          void voicePipeline.cancel();
        },
      });
      if (!granted.ok) setMicTest(granted.error ?? "Microphone could not start.");
    } catch (e) {
      setMicTest(e instanceof Error ? e.message : "Microphone test failed.");
    }
    await refreshNative();
  };

  /** Ask for every runtime permission the app can actually use, one by one. */
  const requestAll = async () => {
    setPermNotice("requesting");
    const results: string[] = [];
    const attempt = async (label: string, task: () => Promise<{ granted?: boolean } | void>) => {
      try {
        const value: any = await task();
        results.push(`${label} ${value?.granted === false ? "denied" : "granted"}`);
      } catch {
        results.push(`${label} unavailable`);
      }
    };
    await attempt("microphone", () => native.requestMicPermission());
    await attempt("camera", () => native.requestCameraPermission());
    await attempt("notifications", () => native.requestNotificationPermission());
    setPermNotice(results.join(" · "));
    await refreshNative();
  };

  const testVoice = async () => {
    if (voice.state === "SPEAKING") {
      await voicePipeline.stopSpeaking();
      setVoiceTestState("Stopped.");
      return;
    }
    const result = await voicePipeline.speak(SPEECH_TEST);
    setVoiceTestState(result.ok ? "Playback requested — listen for the voice." : result.error ?? "Speech failed.");
  };

  const toggleWake = async (enabled: boolean) => {
    setWakeBusy(true);
    try {
      const result = enabled ? await wakeWordService.enable() : await wakeWordService.disable();
      setWakeNotice(result.message);
      setPermState(enabled && result.ok ? "granted" : permState);
      await refreshNative();
    } finally {
      setWakeBusy(false);
    }
  };

  const copyDiagnostics = async () => {
    const report = [
      "J.A.R.V.I.S. diagnostics",
      `platform: ${platform}`,
      `backend: ${backendBase() || "(same-origin)"} configured=${backendConfigured()}`,
      `health: ${health.status} latency=${health.latencyMs ?? "—"}ms target=${health.target || "—"}`,
      `ws: ${connected ? "connected" : "disconnected"}`,
      `model: ${health.provider ?? "—"}/${health.model ?? "—"}`,
      `voice state: ${voice.state} engine=${voice.engine}`,
      `mic permission: ${permState}`,
      `native caps: ${caps ? JSON.stringify(caps) : "unavailable"}`,
      `voices: ${voices.slice(0, 5).join(", ") || "none reported"}`,
      `native bridge: ${platform === "android" ? "expected" : "not applicable"}`,
      `animation mode: ${animationMode} accent: ${accent} language: ${micLanguage}`,
      `chat entries: ${useStore.getState().chat.length}`,
      `local notes: ${notes.length}`,
      `timestamp: ${new Date().toISOString()}`,
    ].join("\n");
    const copied = await native
      .nativeAvailable()
      .then(async (available) => {
        if (!available) return false;
        await native.clipboardWrite(report);
        return true;
      })
      .catch(() => false);
    if (!copied) {
      try {
        await navigator.clipboard.writeText(report);
      } catch {
        setProbe({ state: "fail", message: "Clipboard is blocked; diagnostics could not be copied." });
        return;
      }
    }
    setDiagnosticsCopied(true);
    setTimeout(() => setDiagnosticsCopied(false), 2000);
  };

  return (
    <div className="pb-2">
      <ScreenHeader
        eyebrow="Configuration"
        title="Settings"
        subtitle="Backend, voice, permissions and diagnostics."
        right={
          <Chip tone={health.status === "online" ? "ok" : health.status === "unconfigured" ? "warn" : "danger"}>
            {health.status}
          </Chip>
        }
      />

      <Section title="AI model (on this phone)">
        <Card>
          <Row
            title="AI provider"
            subtitle={provider.loading ? "Reading on-device settings…" : provider.error ? provider.error : provider.active ? `${provider.active.label} · ${provider.active.model}` : "No model configured"}
            right={
              <span className="m-chip" data-tone={provider.active ? "ok" : provider.error ? "danger" : "warn"}>
                {provider.loading ? "checking" : provider.active ? "connected" : "unset"}
              </span>
            }
          />
          <Row
            title="Provider & model"
            subtitle="Answers directly from the device — no PC or backend required"
            right={
              <button type="button" className="m-btn" data-size="sm" data-variant="primary" onClick={() => onNavigate("memory")}>
                Configure
              </button>
            }
          />
          <Row
            title="Local memory"
            subtitle="SQLite on this phone · survives restarts"
            right={<span className="m-chip" data-tone={provider.error ? "danger" : "ok"}>{provider.error ? "unavailable" : "available"}</span>}
          />
          <Row
            title="Phone actions"
            subtitle="Battery, settings, apps and clipboard run without a model or internet"
            right={<span className="m-chip" data-tone="ok">local</span>}
          />
          <p className="m-row-sub mt-2">
            The JARVIS backend below is optional and never required for chat or phone actions. Keys are encrypted with the
            Android Keystore. If chat says “no model”, open Memory → Providers and use “Test local storage” to see the exact
            database error.
          </p>
        </Card>
      </Section>

      <Section title="Backend connection (optional)">
        <Card className="mb-3">
          <div className="m-label mb-2">JARVIS backend address</div>
          <input
            className="m-input"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="http://192.168.1.20:7341"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <div className="mt-2 flex gap-2">
            <button type="button" className="m-btn flex-1" data-variant="primary" onClick={() => void saveBackend()}>
              {probe.state === "testing" ? "Testing…" : "Save & test connection"}
            </button>
            <button
              type="button"
              className="m-btn"
              onClick={() => {
                void setBackendBase("").then(() => {
                  setUrl("");
                  setProbe({ state: "idle", message: "Backend address cleared — chat stays offline." });
                  wsClient.reconnectNow();
                });
              }}
            >
              Clear
            </button>
          </div>
          {probe.message && (
            <p className="m-small mt-2" style={{ color: probe.state === "fail" ? "#fecdd3" : probe.state === "ok" ? "#bbf7d0" : undefined }}>
              {probe.message}
            </p>
          )}
          <div className="mt-2">
            <Row
              title="Backend status"
              subtitle={health.target ? `Target: ${health.target}` : "No target"}
              right={
                <span className="m-chip" data-tone={health.status === "online" ? "ok" : "warn"}>
                  {health.status === "online" ? `${health.latencyMs ?? "?"} ms` : health.status}
                </span>
              }
            />
            <Row
              title="Live channel"
              subtitle="WebSocket /ws — chat, streaming, tools, confirmations"
              right={
                <button type="button" className="m-btn" data-size="sm" onClick={() => wsClient.reconnectNow()}>
                  {connected ? "Reconnect" : "Connect"}
                </button>
              }
            />
          </div>
          <p className="m-row-sub mt-2">
            On Android the backend must be reachable from the phone — 127.0.0.1 is the phone itself, not your computer. Emulator host: 10.0.2.2.
            Prefer HTTPS (reverse proxy or VPN) when not on a trusted LAN.
          </p>
        </Card>

        {health.status === "online" && (
          <Card>
            <Row title="Provider" subtitle="Configured on the backend" right={<span className="m-row-sub">{health.provider ?? "—"}</span>} />
            <Row title="Model" subtitle="Active chat model" right={<span className="m-row-sub">{health.model ?? "—"}</span>} />
            <Row title="Tools" subtitle="Registered backend tools" right={<span className="m-row-sub">{health.tools ?? "—"}</span>} />
            <Row title="Permission mode" subtitle="Backend safety tier" right={<span className="m-row-sub">{health.permissionMode ?? "—"}</span>} />
          </Card>
        )}
      </Section>

      <Section title="Voice">
        <Card className="mb-3">
          <Toggle
            label="Speak replies aloud"
            hint="Android TextToSpeech on the phone; backend/browser TTS elsewhere"
            value={voiceEnabled}
            onChange={setVoiceEnabled}
          />
          <div className="m-row">
            <div className="m-row-main">
              <div className="m-row-title">Recognition language</div>
              <div className="m-row-sub">Used by Android SpeechRecognizer</div>
            </div>
            <select
              className="m-input"
              style={{ width: 150, minHeight: 42 }}
              value={micLanguage}
              onChange={(event) => setMicLanguage(event.target.value)}
              aria-label="Recognition language"
            >
              {MIC_LANGUAGES.map((language) => (
                <option key={language.tag} value={language.tag}>
                  {language.label}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="m-btn" onClick={() => void testVoice()}>
              {voice.state === "SPEAKING" ? "Stop voice test" : "Test voice output"}
            </button>
            <button type="button" className="m-btn" onClick={() => void requestMic()}>
              Test microphone
            </button>
          </div>
          {voiceTestState && <p className="m-row-sub mt-2">{voiceTestState}</p>}
          <p className="m-small mt-2">
            Voice state: {voiceStateLabel(voice.state)} · engine: {voice.engine === "none" ? "unavailable" : voice.engine} · recognition:{" "}
            {perms ? (perms.speechRecognition ? "available" : "missing") : "checking"}
          </p>
          {voice.error && <p className="m-small mt-1" style={{ color: "#fecdd3" }}>{voice.error}</p>}
          {micTest !== null && (
            <div className="m-inset mt-2 p-3">
              <div className="m-label">Microphone test transcript</div>
              <p className="m-small mt-1">{micTest || "(empty)"}</p>
            </div>
          )}
          {voices.length > 0 && (
            <p className="m-row-sub mt-2">System voices: {voices.slice(0, 4).join(", ")}{voices.length > 4 ? ` +${voices.length - 4}` : ""}</p>
          )}
        </Card>

        <Card className="mt-3">
          <Toggle
            label="“Hey JARVIS” wake word"
            hint="Runs a microphone foreground service with a permanent notification. Requires the phone's speech-recognition service; turn it off to release the microphone."
            value={wake.enabled}
            onChange={(enabled) => {
              if (!wakeBusy) void toggleWake(enabled);
            }}
          />
          <Row
            title="Monitoring state"
            subtitle={`${wakeStateLabel(wake.state)} · engine: ${wake.engine === "none" ? "unavailable" : wake.engine}`}
            right={
              <span className="m-chip" data-tone={wake.state === "monitoring" ? "ok" : wake.state === "error" || wake.state === "model-missing" ? "danger" : "warn"}>
                {wakeBusy ? "working…" : wake.state}
              </span>
            }
          />
          <p className="m-small mt-2">
            Recording starts only after monitoring is enabled and stops the moment it is disabled. Detection uses Android
            SpeechRecognizer in partial transcripts; ambient audio is never uploaded by this app. Some devices send speech to
            their system speech service, which may use the network.
          </p>
          {wake.message && <p className="m-row-sub mt-1">{wake.message}</p>}
          {wakeNotice && <p className="m-row-sub mt-1">{wakeNotice}</p>}
        </Card>

        <TtsPanel />
      </Section>

      <Section title="Permissions">
        <Card>
          <Row
            title="Microphone"
            subtitle="Voice input via the Android speech recogniser"
            right={
              <span className="m-chip" data-tone={permState === "granted" ? "ok" : "warn"}>
                {permState}
              </span>
            }
          />
          <Row
            title="Camera"
            subtitle="Only used when you capture a photo"
            right={
              <span className="m-chip" data-tone={perms?.camera === "granted" ? "ok" : "warn"}>
                {perms?.camera ?? "unknown"}
              </span>
            }
          />
          <Row
            title="Notifications"
            subtitle="Local notifications (Android 13+ requires permission)"
            right={
              <span className="m-chip" data-tone={perms?.notifications === "granted" ? "ok" : "warn"}>
                {perms?.notifications ?? "unknown"}
              </span>
            }
          />
          <Row
            title="Speech recognition engine"
            subtitle="Android SpeechRecognizer availability, read from the device"
            right={
              <span className="m-chip" data-tone={perms?.speechRecognition ? "ok" : "warn"}>
                {perms ? (perms.speechRecognition ? "available" : "missing") : "unknown"}
              </span>
            }
          />
          <Row
            title="Text-to-speech engine"
            subtitle="Android TTS used for spoken replies"
            right={
              <span className="m-chip" data-tone={perms?.ttsReady ? "ok" : "warn"}>
                {perms ? (perms.ttsReady ? "ready" : perms.tts ? "initialising" : "unavailable") : "unknown"}
              </span>
            }
          />
          <Row
            title="Files & photos"
            subtitle="Storage Access Framework: the app only ever sees the file you pick"
            right={
              <button
                type="button"
                className="m-btn"
                data-size="sm"
                onClick={() =>
                  void native
                    .pickFile()
                    .then((file) =>
                      setPermNotice(
                        file?.cancelled
                          ? "File picker closed."
                          : file?.name
                            ? `Selected ${file.name} (${file.size ?? 0} bytes). Access is scoped to that file.`
                            : "No file was selected.",
                      ),
                    )
                    .catch((e) => setPermNotice(e instanceof Error ? e.message : "The file picker failed."))
                }
              >
                Choose
              </button>
            }
          />
          <Row
            title="Device control"
            subtitle="Launch apps, open settings screens, read battery/device data and use the clipboard. Android grants no permission to change protected settings or read other apps' data."
            right={<span className="m-chip" data-tone="warn">limited</span>}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="m-btn" data-variant="primary" onClick={() => void requestAll()} disabled={permNotice === "requesting"}>
              {permNotice === "requesting" ? "Requesting…" : "Request all permissions"}
            </button>
            <button type="button" className="m-btn" onClick={() => void requestMic()}>
              Microphone
            </button>
            <button
              type="button"
              className="m-btn"
              onClick={() =>
                void native
                  .openAppSettings()
                  .then((result) => setPermNotice(result?.ok ? "Android app settings opened." : result?.message || "Could not open settings."))
                  .catch(() => setPermNotice("Could not open Android settings."))
              }
            >
              App settings
            </button>
          </div>
          {permNotice && permNotice !== "requesting" && <p className="m-row-sub mt-2">{permNotice}</p>}
          <p className="m-row-sub mt-2">
            A permanent denial ("Don't allow again") can only be changed in Android settings → Apps → J.A.R.V.I.S. → Permissions.
          </p>
        </Card>
      </Section>

      <Section title="Display & animation">
        <Card>
          <div className="m-row">
            <div className="m-row-main">
              <div className="m-row-title">3D core performance</div>
              <div className="m-row-sub">Low power reduces pixel density and particle count</div>
            </div>
            <div className="flex gap-1">
              <button type="button" className="m-btn" data-size="sm" data-variant={animationMode === "auto" ? "primary" : undefined} onClick={() => setAnimationMode("auto")}>
                Auto
              </button>
              <button type="button" className="m-btn" data-size="sm" data-variant={animationMode === "low" ? "primary" : undefined} onClick={() => setAnimationMode("low")}>
                Low
              </button>
            </div>
          </div>
          <div className="m-row">
            <div className="m-row-main">
              <div className="m-row-title">Accent</div>
              <div className="m-row-sub">Ice blue or restrained violet</div>
            </div>
            <div className="flex gap-1">
              <button type="button" className="m-btn" data-size="sm" data-variant={accent === "cyan" ? "primary" : undefined} onClick={() => setAccent("cyan")}>
                Cyan
              </button>
              <button type="button" className="m-btn" data-size="sm" data-variant={accent === "violet" ? "primary" : undefined} onClick={() => setAccent("violet")}>
                Violet
              </button>
            </div>
          </div>
          <p className="m-row-sub mt-2">The core also honours the system reduced-motion setting automatically.</p>
        </Card>
      </Section>

      <Section title="Data">
        <Card>
          <Row
            title="Clear conversation"
            subtitle="Removes this app's chat history only"
            right={
              <button
                type="button"
                className="m-btn"
                data-size="sm"
                data-variant="danger"
                onClick={() => {
                  if (confirm("Clear the conversation shown in this app? Backend memory is preserved.")) {
                    clearChat();
                    clearTools();
                    clearMedia();
                  }
                }}
              >
                Clear
              </button>
            }
          />
          <Row
            title="Clear local memory notes"
            subtitle={`${notes.length} on-device notes · backend memory untouched`}
            right={
              <button
                type="button"
                className="m-btn"
                data-size="sm"
                data-variant="danger"
                onClick={() => {
                  if (confirm("Delete all on-device memory notes? Backend memory is not affected.")) clearLocalMemory();
                }}
              >
                Clear
              </button>
            }
          />
        </Card>
      </Section>

      <Section title="Diagnostics">
        <Card>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="m-btn" onClick={() => void copyDiagnostics()}>
              {diagnosticsCopied ? "Copied" : "Copy diagnostics"}
            </button>
            <button type="button" className="m-btn" onClick={() => { void refreshNative(); onNavigate("tools"); }}>
              Phone capabilities
            </button>
          </div>
          <div className="m-inset mt-3 p-3">
            <div className="m-row-sub">Platform: {platform}</div>
            <div className="m-row-sub">Backend: {backendBase() || (platform === "android" ? "not configured" : "same origin")}</div>
            <div className="m-row-sub">Health: {health.status}{health.latencyMs != null ? ` · ${health.latencyMs} ms` : ""}</div>
            <div className="m-row-sub">Live channel: {connected ? "connected" : "disconnected"}</div>
            <div className="m-row-sub">Voice: {voice.state} · {voice.engine}</div>
            <div className="m-row-sub">Mic permission: {permState}</div>
            <div className="m-row-sub">Native caps: {caps ? Object.keys(caps).length + " reported" : "not available"}</div>
            <div className="m-row-sub">
              Native bridge: {caps && typeof caps.plugin === "string" ? `v${caps.plugin}` : "unavailable"}
            </div>
            <div className="m-row-sub">App build: {APP_BUILD}</div>
          </div>
        </Card>
      </Section>

      <Section title="About">
        <Card>
          <div className="m-h2">J.A.R.V.I.S. for Android</div>
          <p className="m-small mt-2">
            A mobile-first front-end for the original JARVIS project, connected to your own backend. Voice, chat and phone actions report their real state; nothing is simulated.
          </p>
          <div className="m-row-sub mt-2">App package: com.jarvis.local · build {APP_BUILD}</div>
          <div className="m-row-sub mt-1">
            If this number does not match the APK you downloaded, the phone is still running an older build.
          </div>
        </Card>
      </Section>
    </div>
  );
}
