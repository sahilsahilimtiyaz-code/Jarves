import { useRef, useState } from "react";
import { useStore } from "../lib/store";
import { usePrefs } from "../lib/prefs";
import { useBackendHealth, useProviderStatus, useVoiceStatus, greetingFor, statusLabel } from "./hooks";
import { useDeviceInfo, describeDevice, formatMb } from "../lib/deviceInfo";
import { executePhoneAction } from "../lib/actions";
import { voicePipeline } from "../lib/voicePipeline";
import { voiceStateLabel } from "../lib/voiceState";
import JarvisCore, { useCoreMeter } from "./JarvisCore";
import { Card, Chip, ScreenHeader, Section, StatusLine } from "./ui";
import type { ScreenProps } from "./types";

export default function HomeScreen({ onNavigate }: ScreenProps) {
  const connected = useStore((s) => s.connected);
  const orbState = useStore((s) => s.orbState);
  const tools = useStore((s) => s.tools);
  const health = useBackendHealth(20_000);
  const provider = useProviderStatus();
  const device = useDeviceInfo(true, 20_000);
  const voice = useVoiceStatus();
  const animationMode = usePrefs((s) => s.animationMode);
  const accent = usePrefs((s) => s.accent);
  const coreWrapRef = useRef<HTMLDivElement>(null);
  useCoreMeter(coreWrapRef, true);

  const [latestAction, setLatestAction] = useState<{ ok: boolean; message: string } | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const info = device.snapshot?.info ?? {};
  // A configured on-device model is the primary capability; the JARVIS backend
  // is optional. "Offline" must therefore never mean "no model configured".
  const aiReady = Boolean(provider.active);
  const offline = !aiReady && health.status !== "online";
  const status: "online" | "offline" | "checking" | "idle" = aiReady
    ? "online"
    : health.status === "online"
      ? "online"
      : health.status === "offline"
        ? "offline"
        : health.status === "checking" || provider.loading
          ? "checking"
          : "idle";

  const runQuickAction = async (kind: "battery" | "device_info") => {
    setBusyAction(kind);
    try {
      const outcome = await executePhoneAction({
        kind,
        source: "home quick action",
        args: {},
        label: kind === "battery" ? "Battery status" : "Device information",
        requiresApproval: false,
      });
      setLatestAction({ ok: outcome.ok, message: outcome.message });
    } finally {
      setBusyAction(null);
    }
  };

  const recent = tools.slice(-4).reverse();

  return (
    <div className="pb-2">
      <ScreenHeader
        eyebrow="Mark IV · Mobile"
        title="J.A.R.V.I.S."
        subtitle={
          <div className="flex flex-wrap items-center gap-2">
            <StatusLine
              state={status}
              label={aiReady ? `${provider.active?.label} online` : statusLabel(health, connected)}
              detail={health.status === "online" && health.latencyMs != null ? `${health.latencyMs} ms` : undefined}
            />
          </div>
        }
        right={
          <>
            <Chip tone={aiReady || health.status === "online" ? "accent" : "warn"}>
              {aiReady
                ? provider.active!.model
                : health.status === "online"
                  ? health.model
                    ? `${health.provider ?? "model"} · ${health.model}`
                    : "backend linked"
                  : provider.error
                    ? "storage error"
                    : "no model"}
            </Chip>
            <button
              type="button"
              className="m-icon-btn"
              aria-label="Open settings"
              onClick={() => onNavigate("settings")}
            >
              <GearIcon />
            </button>
          </>
        }
      />

      <p className="m-body mb-4">
        {greetingFor()}{" "}
        {aiReady
          ? "Your configured model is ready, and phone actions run on this device."
          : health.status === "online"
            ? "Your JARVIS backend is reachable."
            : "No AI model is configured yet — add one in Memory → Providers. Phone actions already work without it."}
      </p>

      <div ref={coreWrapRef} className="mb-4">
        <JarvisCore
          state={orbState}
          offline={offline}
          lowPower={animationMode === "low"}
          accent={accent}
        />
      </div>

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
        <span className="m-label">Voice</span>
        <span className="m-row-sub">{voice.state === "ERROR" && voice.error ? voice.error : voiceStateLabel(voice.state)}</span>
      </div>
      <div className="m-scroll-x mb-5">
        <button
          type="button"
          className="m-btn"
          data-variant="primary"
          onClick={() => onNavigate("chat")}
        >
          <MicIcon /> Ask JARVIS
        </button>
        <button
          type="button"
          className="m-btn"
          onClick={() => {
            setBusyAction("battery");
            void (async () => {
              // Read the REAL battery value, then speak that exact result.
              const outcome = await executePhoneAction({
                kind: "battery",
                source: "home quick action",
                args: {},
                label: "Battery status",
                requiresApproval: false,
              });
              setLatestAction({ ok: outcome.ok, message: outcome.message });
              if (outcome.ok) {
                const spoken = await voicePipeline.speak(outcome.message);
                if (!spoken.ok) setLatestAction({ ok: false, message: spoken.error ?? "Speech unavailable" });
              }
              setBusyAction(null);
            })();
          }}
          disabled={busyAction === "battery"}
        >
          <SpeakerIcon /> Read battery aloud
        </button>
        <button type="button" className="m-btn" onClick={() => onNavigate("tools")}>
          <GridIcon /> Phone actions
        </button>
        <button type="button" className="m-btn" onClick={() => onNavigate("settings")}>
          <LinkIcon /> {health.status === "online" ? "Backend" : "Connect"}
        </button>
      </div>

      {latestAction && (
        <Card className="mb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="m-label mb-1">{latestAction.ok ? "Real result" : "Action failed"}</div>
              <p className="m-small" style={{ color: latestAction.ok ? "rgba(232,244,255,0.9)" : "#fecdd3" }}>
                {latestAction.message}
              </p>
            </div>
            <button type="button" className="m-btn" data-variant="ghost" data-size="sm" onClick={() => setLatestAction(null)}>
              Dismiss
            </button>
          </div>
        </Card>
      )}

      <Section title="This phone" action={<span className="m-row-sub">measured on device</span>}>
        <div className="grid grid-cols-2 gap-3">
          <Card>
            <div className="m-label">Battery</div>
            <div className="m-title mt-1" style={{ fontSize: 26 }}>
              {typeof info.batteryPercent === "number" && info.batteryPercent >= 0 ? `${info.batteryPercent}%` : "—"}
            </div>
            <div className="m-row-sub mt-1">
              {info.charging ? "charging" : typeof info.batteryPercent === "number" ? "on battery" : "native only"}
              {typeof info.batteryTemperatureC === "number" ? ` · ${info.batteryTemperatureC.toFixed(1)}°C` : ""}
            </div>
            <button
              type="button"
              className="m-btn mt-3 w-full"
              data-size="sm"
              onClick={() => void runQuickAction("battery")}
              disabled={busyAction === "battery"}
            >
              {busyAction === "battery" ? "Reading…" : "Re-read battery"}
            </button>
          </Card>
          <Card>
            <div className="m-label">Device</div>
            <div className="m-h2 mt-1 truncate" title={describeDevice(device.snapshot)}>
              {info.model || "This phone"}
            </div>
            <div className="m-row-sub mt-1">
              {info.androidRelease ? `Android ${info.androidRelease}` : "Android"} · {info.cpuCores ?? "—"} cores
            </div>
            <div className="m-row-sub mt-1">
              {formatMb(info.availRamMb)} free / {formatMb(info.totalRamMb)}
            </div>
            <button
              type="button"
              className="m-btn mt-3 w-full"
              data-size="sm"
              onClick={() => void runQuickAction("device_info")}
              disabled={busyAction === "device_info"}
            >
              {busyAction === "device_info" ? "Reading…" : "Device details"}
            </button>
          </Card>
        </div>
      </Section>

      <Section title="JARVIS backend (optional)" action={<span className="m-row-sub">not required for chat</span>}>
        <Card>
          {health.status === "unconfigured" ? (
            <>
              <div className="m-h2">No backend configured</div>
              <p className="m-small mt-2">
                Optional. AI chat uses the model configured on this phone; this backend only adds its tool registry, desktop tools
                and its own memory. Phone actions never need it.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="m-btn" data-variant="primary" onClick={() => onNavigate("memory")}>
                  Configure AI model
                </button>
                <button type="button" className="m-btn" onClick={() => onNavigate("settings")}>
                  Add backend
                </button>
              </div>
            </>
          ) : health.status === "offline" ? (
            <>
              <div className="m-h2">Backend unreachable</div>
              <p className="m-small mt-2">{health.error}</p>
              <p className="m-row-sub mt-2">Target: {health.target}</p>
              <button type="button" className="m-btn mt-3" onClick={() => onNavigate("settings")}>
                Fix connection
              </button>
            </>
          ) : (
            <>
              <RowKV k="Provider" v={health.provider ?? "—"} />
              <RowKV k="Model" v={health.model ?? "—"} />
              <RowKV k="Tools" v={health.tools != null ? String(health.tools) : "—"} />
              <RowKV k="Latency" v={health.latencyMs != null ? `${health.latencyMs} ms` : "—"} />
              <RowKV k="Permissions" v={health.permissionMode ?? "—"} />
              <RowKV k="Live channel" v={connected ? "connected" : "reconnecting"} />
            </>
          )}
        </Card>
      </Section>

      <Section title="Recent activity">
        {recent.length === 0 ? (
          <Card>
            <p className="m-small">
              No tool or phone activity yet. Actions you run are logged here with their real result.
            </p>
          </Card>
        ) : (
          <Card>
            {recent.map((tool) => (
              <div className="m-row" key={tool.id}>
                <span className="m-dot" data-state={tool.status === "ok" ? "online" : tool.status === "fail" ? "offline" : "checking"} />
                <div className="m-row-main">
                  <div className="m-row-title m-mono" style={{ fontSize: 11.5 }}>
                    {tool.tool}
                  </div>
                  <div className="m-row-sub">{tool.result || tool.preview || tool.status}</div>
                </div>
                <span className="m-row-sub">{new Date(tool.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
            ))}
          </Card>
        )}
      </Section>
    </div>
  );
}

function RowKV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="m-row-sub">{k}</span>
      <span className="m-mono truncate" style={{ fontSize: 11.5, color: "rgba(232,244,255,0.86)" }} title={v}>
        {v}
      </span>
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8.5 21h7" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      <path d="M16 8a5 5 0 0 1 0 8M19 5a9 9 0 0 1 0 14" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 8.96 4a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" />
    </svg>
  );
}
