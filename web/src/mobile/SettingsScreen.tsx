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
import { useBackendHealth, useVoiceStatus } from "./hooks";
import { voicePipeline } from "../lib/voicePipeline";
import { voiceStateLabel } from "../lib/voiceState";
import * as native from "../platform/native";
import { detectPlatform } from "../platform";
import { Card, Chip, Row, ScreenHeader, Section, Toggle } from "./ui";
import type { ScreenProps } from "./types";

type Probe = { state: "idle" | "testing" | "ok" | "fail"; message: string };

const SPEECH_TEST = "Good evening, sir. All voice systems are online and at your service.";

export default function SettingsScreen({ onNavigate }: ScreenProps) {
  const health = useBackendHealth(30_000);
  const voice = useVoiceStatus();
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
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const [micTest, setMicTest] = useState<string | null>(null);
  const [voiceTestState, setVoiceTestState] = useState<string | null>(null);

  const refreshNative = useCallback(async () => {
    const available = await native.nativeAvailable().catch(() => false);
    if (!available) return;
    try {
      const [c, v, p] = await Promise.all([
        native.getCapabilities(),
        native.getVoices(),
        native.checkMicPermission(),
      ]);
      setCaps(c || null);
      setVoices(Array.isArray(v?.voices) ? v.voices : []);
      setPermState(p?.state || "unknown");
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

  const testVoice = async () => {
    if (voice.state === "SPEAKING") {
      await voicePipeline.stopSpeaking();
      setVoiceTestState("Stopped.");
      return;
    }
    const result = await voicePipeline.speak(SPEECH_TEST);
    setVoiceTestState(result.ok ? "Playback requested — listen for the voice." : result.error ?? "Speech failed.");
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

      <Section title="Backend connection">
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
          <p className="m-small mt-2">Voice state: {voiceStateLabel(voice.state)} · engine: {voice.engine}</p>
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
      </Section>

      <Section title="Permissions">
        <Card>
          <Row
            title="Microphone"
            subtitle="Required for voice input and speech recognition"
            right={<span className="m-chip" data-tone={permState === "granted" ? "ok" : "warn"}>{permState}</span>}
          />
          <Row
            title="Camera"
            subtitle="Only used when you capture a photo"
            right={
              <button
                type="button"
                className="m-btn"
                data-size="sm"
                onClick={() => void native.requestCameraPermission().then(() => refreshNative()).catch(() => undefined)}
              >
                Request
              </button>
            }
          />
          <Row
            title="Notifications"
            subtitle="Local notifications (Android 13+ requires permission)"
            right={
              <button
                type="button"
                className="m-btn"
                data-size="sm"
                onClick={() => void native.requestNotificationPermission().then(() => refreshNative()).catch(() => undefined)}
              >
                Request
              </button>
            }
          />
          <button type="button" className="m-btn mt-2 w-full" onClick={() => void requestMic()}>
            Request microphone access
          </button>
          <p className="m-row-sub mt-2">
            If Android permanently denies a permission, enable it in system settings → Apps → J.A.R.V.I.S. → Permissions.
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
          </div>
        </Card>
      </Section>

      <Section title="About">
        <Card>
          <div className="m-h2">J.A.R.V.I.S. for Android</div>
          <p className="m-small mt-2">
            A mobile-first front-end for the original JARVIS project, connected to your own backend. Voice, chat and phone actions report their real state; nothing is simulated.
          </p>
          <div className="m-row-sub mt-2">App package: com.jarvis.local · version 0.3.0</div>
        </Card>
      </Section>
    </div>
  );
}
