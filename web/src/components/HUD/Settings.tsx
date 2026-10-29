/**
 * SETTINGS PANEL — in-app config without editing config.yaml.
 *
 * Covers the controls most users actually want to flip: voice on/off,
 * wake-word capture, persona/agent, permission mode, FLUX preload, panel
 * layout reset, full state wipe. Read-only mirrors of server health are
 * shown for context. Anything that requires a backend restart is flagged.
 */
import { useEffect, useState } from "react";
import { useStore } from "../../lib/store";
import { resetAllLayouts } from "./Floating";
import {
  backendBase, backendConfigured, setBackendBase, probeBackend,
} from "../../lib/backend";
import { getAdapter } from "../../platform";
import type { Health } from "../../lib/store";

type Probe = { state: "idle" | "testing" | "ok" | "fail"; message: string };

export function BackendSection() {
  const [editing, setEditing] = useState<string>("");
  const [probe, setProbe] = useState<Probe>({ state: "idle", message: "" });
  const adapter = getAdapter();
  const connected = useStore((s) => s.connected);
  const health = useStore((s) => s.health);
  const platform = adapter.id;

  // Same-origin desktop build: the backend is the UI host; the address is
  // fixed by the shell (Electron) or the serving origin (browser).
  const sameOrigin = platform !== "android";
  const label = sameOrigin
    ? "Local backend (same origin as this HUD)"
    : backendBase() || "";

  const save = async (url: string) => {
    const b = await setBackendBase(url);
    setProbe({ state: "testing", message: "probing…" });
    const h: Health | null = await probeBackend(b);
    if (platform === "android" && !b) {
      setProbe({ state: "idle", message: "cleared — Android offline mode (UI only)" });
      return;
    }
    if (b && h) {
      setProbe({
        state: "ok",
        message: `online · ${h.name} · ${h.tools} tools · ${h.agents.length} agents · perm:${h.permission_mode}`,
      });
    } else {
      setProbe({ state: "fail", message: "no response — check host/IP, backend running, and firewall" });
    }
  };

  return (
    <Section title="BACKEND CONNECTION">
      <div className="text-[10px] text-jarvis-ice/45 pb-1 leading-relaxed">
        {sameOrigin ? (
          <>This HUD is served by its own FastAPI backend — no extra configuration needed.
          Voice, tools, memory and agents all run on this machine.</>
        ) : (
          <>Point the phone at your JARVIS backend host. On the computer run:
          <span className="text-jarvis-aqua"> python -m jarvis.main --host 0.0.0.0</span> and
          allow TCP/7341 in the firewall. Example: <span className="text-jarvis-aqua">http://192.168.1.20:7341</span></>
        )}
      </div>
      {!sameOrigin && (
        <div className="flex items-center gap-1.5">
          <input
            value={editing !== "" ? editing : label}
            onChange={(e) => setEditing(e.target.value)}
            placeholder="http://192.168.1.20:7341"
            spellCheck={false}
            className="flex-1 min-w-0 bg-jarvis-glass border border-jarvis-cyan/20 focus:border-jarvis-cyan/60 outline-none rounded-md px-2 py-1.5 text-jarvis-ice text-[11px] transition-colors"
          />
          <button
            onClick={() => { void save(editing !== "" ? editing : label); setEditing(label); }}
            className="glass-chip px-2 py-1.5 text-[10px] uppercase tracking-wider hover:bg-jarvis-cyan/10 transition-colors"
          >save</button>
        </div>
      )}
      <div className="flex items-center gap-2 text-[10px]">
        <span
          className={`inline-block w-1.5 h-1.5 rounded-full ${
            probe.state === "ok" || connected ? "bg-jarvis-ok shadow-[0_0_8px_rgba(52,211,153,0.8)]"
            : probe.state === "fail" ? "bg-jarvis-danger"
            : probe.state === "testing" ? "bg-jarvis-warn animate-pulse"
            : connected ? "bg-jarvis-ok" : "bg-jarvis-ice/25"
          }`}
        />
        <span className="text-jarvis-ice/70">
          {probe.state === "idle"
            ? connected
              ? `connected · ${health?.name || "backend live"}`
              : platform === "android" && !backendConfigured()
                ? "not configured — phone runs in standalone (UI-only) mode"
                : "disconnected"
            : probe.message}
        </span>
      </div>
      <div className="text-[10px] text-jarvis-ice/40 leading-relaxed">
        {adapter.notes().map((n, i) => <div key={i} className="pt-0.5">· {n}</div>)}
      </div>
    </Section>
  );
}

export default function Settings() {
  const health = useStore((s) => s.health);
  const voiceEnabled = useStore((s) => s.voiceEnabled);
  const setVoiceEnabled = useStore((s) => s.setVoiceEnabled);
  const wakeEnabled = useStore((s) => s.wakeEnabled);
  const setWakeEnabled = useStore((s) => s.setWakeEnabled);
  const bargeIn = useStore((s) => s.bargeIn);
  const setBargeIn = useStore((s) => s.setBargeIn);
  const clearChat = useStore((s) => s.clearChat);
  const clearMedia = useStore((s) => s.clearMedia);
  const clearTools = useStore((s) => s.clearTools);
  const setReader = useStore((s) => s.setReader);
  const prevSessionAvailable = useStore((s) => s.prevSessionAvailable);
  const restoreLastSession = useStore((s) => s.restoreLastSession);

  const [agents, setAgents] = useState<string[]>([]);
  useEffect(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((j) => setAgents(j?.agents || []))
      .catch(() => undefined);
  }, []);

  const cleanSlate = async () => {
    if (!confirm("Wipe all chat, media, and tool history? Backend memory is preserved.")) return;
    clearChat();
    clearMedia();
    clearTools();
    setReader(null);
    try { await fetch("/api/cleanslate", { method: "POST" }); } catch { /* noop */ }
  };

  return (
    <div className="holo-panel flex flex-col h-full overflow-hidden">
      <div className="panel-header flex items-center justify-between px-3 py-2 shrink-0">
        <span className="text-display text-[11px] tracking-[0.4em] text-shimmer">SETTINGS</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-5 text-mono text-[12px] text-jarvis-ice/85">
        {prevSessionAvailable && (
          <Section title="SESSION">
            <div className="text-[10px] text-jarvis-ice/45 pb-1">
              A previous session was kept aside on launch. Memory is always preserved.
            </div>
            <ButtonRow label="Restore previous session" onClick={() => restoreLastSession()} />
          </Section>
        )}

        <BackendSection />

        <Section title="VOICE">
          <Toggle
            label="JARVIS speaks aloud (TTS)"
            value={voiceEnabled}
            onChange={setVoiceEnabled}
          />
          <Toggle
            label="Listen for wake word (mic always on)"
            value={wakeEnabled}
            onChange={setWakeEnabled}
          />
          <Toggle
            label="Say “cancel” to stop JARVIS speaking"
            value={bargeIn}
            onChange={setBargeIn}
          />
        </Section>

        <Section title="DISPLAY">
          <ButtonRow
            label="Reset panel layout"
            danger={false}
            onClick={() => { if (confirm("Reset all panel positions?")) resetAllLayouts(); }}
          />
        </Section>

        <Section title="SYSTEM">
          <KV k="Model"        v={`${health?.model.provider || "—"}/${health?.model.model || "—"}`} />
          <KV k="Image model"  v={health?.image_model || "—"} />
          <KV k="Permissions"  v={health?.permission_mode || "—"} />
          <KV k="Tools loaded" v={String(health?.tools ?? 0)} />
          <KV k="Plugins"      v={String(health?.plugins?.length ?? 0)} />
          <KV k="Agents"       v={(agents.length ? agents : health?.agents || []).join(", ") || "—"} />
          <div className="pt-1 text-[10px] text-jarvis-ice/40">
            Change these in <span className="text-jarvis-aqua">config.yaml</span> — requires backend restart.
          </div>
        </Section>

        <Section title="DATA">
          <ButtonRow label="Clear chat history" onClick={() => { if (confirm("Wipe chat?")) clearChat(); }} />
          <ButtonRow label="Clear media bay"    onClick={() => { if (confirm("Wipe media?")) clearMedia(); }} />
          <ButtonRow label="Clear tool history" onClick={() => { if (confirm("Wipe tool history?")) clearTools(); }} />
          <ButtonRow label="Clean slate (chat + media + tools + backend session)" danger onClick={cleanSlate} />
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="text-[9px] tracking-[0.35em] text-jarvis-cyan/70 uppercase">{title}</div>
      <div className="space-y-1.5 rounded-lg border border-jarvis-cyan/10 bg-jarvis-glass/40 p-3">
        {children}
      </div>
    </section>
  );
}

function Toggle({
  label, value, onChange,
}: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer py-1">
      <span className="text-jarvis-ice/85">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className="relative w-9 h-5 rounded-full transition-colors"
        style={{
          background: value ? "rgba(125,211,252,0.7)" : "rgba(186,230,253,0.15)",
          boxShadow: value ? "0 0 12px rgba(125,211,252,0.6)" : "none",
        }}
      >
        <span
          className="absolute top-0.5 w-4 h-4 rounded-full bg-jarvis-ice transition-all"
          style={{ left: value ? 18 : 2 }}
        />
      </button>
    </label>
  );
}

function ButtonRow({
  label, onClick, danger = false,
}: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-2 py-1.5 rounded-md transition-colors border text-[11px] ${
        danger
          ? "border-jarvis-danger/30 text-jarvis-danger hover:bg-jarvis-danger/10 hover:border-jarvis-danger/55"
          : "border-jarvis-cyan/15 text-jarvis-ice/85 hover:bg-jarvis-cyan/10 hover:border-jarvis-cyan/40"
      }`}
    >
      {label}
    </button>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5 text-[11px]">
      <span className="text-jarvis-ice/45">{k}</span>
      <span className="text-jarvis-ice/90 truncate max-w-[60%]" title={v}>{v}</span>
    </div>
  );
}
