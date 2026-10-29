/**
 * MobileSheets — the phone HUD's mission layout, purely additive.
 *
 * The desktop preserves its full floating-panel HUD; on narrow viewports
 * Space is limited, so the SAME original panels (MediaHub, ToolFeed,
 * TerminalPanel, PlanPanel, SwarmPanel, MissionLog, Settings…) are mounted
 * inside full-screen sheets opened from a chip rail above the CommandBar.
 * Nothing is reimplemented — every sheet hosts the original component.
 */
import { useMemo, useState } from "react";
import { useStore, type MediaKind } from "../../lib/store";
import MediaHub from "../Media/MediaHub";
import ToolFeed from "../Tools/ToolFeed";
import TerminalPanel from "./TerminalPanel";
import PlanPanel from "./PlanPanel";
import SwarmPanel from "./SwarmPanel";
import MissionLog from "./MissionLog";
import Settings from "./Settings";

type Sheet =
  | null
  | "media"
  | "tools"
  | "terminal"
  | "mission"
  | "settings"
  | "plan|max";

const MEDIA_KIND_META: { kind: MediaKind; label: string; accent: string }[] = [
  { kind: "image",     label: "IMAGE GEN",   accent: "#a5f3fc" },
  { kind: "model3d",   label: "3D MODELS",   accent: "#bae6fd" },
  { kind: "video",     label: "VIDEOS",      accent: "#fbbf24" },
  { kind: "videos",    label: "VIDEOS II",   accent: "#fbbf24" },
  { kind: "search",    label: "WEB SEARCH",  accent: "#7dd3fc" },
  { kind: "images",    label: "IMG SEARCH",  accent: "#7dd3fc" },
  { kind: "news",      label: "NEWS",        accent: "#fca5a5" },
  { kind: "page",      label: "PAGES",       accent: "#bae6fd" },
  { kind: "pdf",       label: "PDFS",        accent: "#bae6fd" },
  { kind: "webcam",    label: "CAMERA",      accent: "#fb7185" },
  { kind: "galaxy",    label: "MEMORY MAP",  accent: "#a78bfa" },
];

export default function MobileSheets() {
  const [sheet, setSheet] = useState<Sheet>(null);
  const [mediaKind, setMediaKind] = useState<MediaKind | null>(null);

  const media = useStore((s) => s.media);
  const swarms = useStore((s) => s.swarms);
  const plan = useStore((s) => s.plan);
  const toolsCount = useStore((s) => s.tools.length);
  const connected = useStore((s) => s.connected);
  const backendConfigured = useStore((s) => Boolean(s.health)); // health implies reachable backend

  const kindCounts = useMemo(() => {
    const map = new Map<MediaKind, number>();
    for (const card of media) {
      for (const k of card.kind === "video" ? (["video", "videos"] as MediaKind[]) : [card.kind]) {
        map.set(k, (map.get(k) || 0) + (card.items?.length || 0));
      }
    }
    return map;
  }, [media]);

  const openMediaKinds = MEDIA_KIND_META.filter((m) => (kindCounts.get(m.kind) || 0) > 0);
  const activeMediaKinds = new Set(openMediaKinds.map((m) => m.kind));
  const hasPlan = plan != null;
  const hasSwarms = swarms.length > 0;
  const swarmActive = swarms.some((s) => s.active);

  const open = (s: Sheet) => { setSheet(s); };
  const openSettings = () => { setSheet("settings"); };

  return (
    <>
      {/* Chip rail — sits directly above the CommandBar strip */}
      <div className="fixed left-4 right-4 z-30 flex items-center gap-1.5 overflow-x-auto"
           style={{ bottom: "calc(4rem + 84px + env(safe-area-inset-bottom, 0px))", paddingLeft: "env(safe-area-inset-left, 0px)", paddingRight: "env(safe-area-inset-right, 0px)" }}>
        <Chip
          label={connected ? "●" : "○ connect"}
          onClick={openSettings}
          active={!connected || !backendConfigured}
          tone={connected ? undefined : "warn"}
        />
        {openMediaKinds.length > 0 && (
          <Chip label="MEDIA" badge={media.reduce((n, c) => n + (c.items?.length || 0), 0)} onClick={() => { if (!activeMediaKinds.has(mediaKind as MediaKind)) setMediaKind(openMediaKinds[0].kind); open("media"); }} />
        )}
        <Chip label="TOOLS" badge={toolsCount} onClick={() => open("tools")} />
        <Chip label="TERMINAL" onClick={() => open("terminal")} />
        <Chip label="MISSION" onClick={() => open("mission")} />
        {hasPlan && <Chip label="PLAN" onClick={() => open("plan|max")} active={!!plan && !plan.complete} />}
        {hasSwarms && <Chip label="SWARM" badge={swarms.length} onClick={() => open("plan|max")} active={swarmActive} />}
        <Chip label="⚙" onClick={openSettings} />
      </div>

      {/* Sheet overlay */}
      {sheet && (
        <div
          className="fixed left-2 right-2 z-40 holo-panel overflow-hidden"
          style={{ top: "calc(224px + env(safe-area-inset-top, 0px))", bottom: "calc(4rem + 136px + env(safe-area-inset-bottom, 0px))" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="panel-header flex items-center justify-between px-3 py-1.5 shrink-0">
            <span className="text-display text-[10px] tracking-[0.4em] text-shimmer">
              {sheet === "media" ? "MEDIA BAY" : sheet === "tools" ? "TOOL FEED" : sheet === "terminal" ? "TERMINAL" : sheet === "mission" ? "MISSION LOG" : sheet === "settings" ? "SETTINGS" : "BRIEFING"}
            </span>
            <button onClick={() => open(null)} className="glass-chip px-2 py-0.5 text-[10px] pointer-events-auto">✕ close</button>
          </div>

          <div className="absolute inset-x-0 top-[34px] bottom-0 overflow-y-auto overscroll-contain p-3">
            {sheet === "media" && mediaKind && (
              <MediaHub
                kinds={[mediaKind]}
                title={MEDIA_KIND_META.find((m) => m.kind === mediaKind)?.label || "MEDIA"}
                accent={MEDIA_KIND_META.find((m) => m.kind === mediaKind)?.accent || "#a5f3fc"}
              />
            )}
            {sheet === "media" && !mediaKind && (
              <div className="text-mono text-[11px] text-jarvis-ice/50 py-6 text-center">
                No media yet — ask JARVIS to generate or search for something.
              </div>
            )}
            {sheet === "media" && mediaKind && openMediaKinds.length > 1 && (
              <div className="flex flex-wrap gap-1.5 pt-2">
                {openMediaKinds.map((m) => (
                  <button
                    key={m.kind}
                    onClick={() => setMediaKind(m.kind)}
                    className={`glass-chip text-[9px] px-2 py-1 ${mediaKind === m.kind ? "text-jarvis-cyan" : "opacity-60"}`}
                  >
                    {m.label} · {kindCounts.get(m.kind) || 0}
                  </button>
                ))}
              </div>
            )}
            {sheet === "tools" && <ToolFeed />}
            {sheet === "terminal" && <TerminalPanel />}
            {sheet === "mission" && <MissionLog />}
            {sheet === "plan|max" && (
              <div className="space-y-3">
                {hasPlan && <PlanPanel />}
                {hasSwarms && <SwarmPanel />}
                {!hasPlan && !hasSwarms && (
                  <div className="text-mono text-[11px] text-jarvis-ice/50 py-6 text-center">
                    No plan or swarm activity.
                  </div>
                )}
              </div>
            )}
            {sheet === "settings" && (
              <div className="h-full">
                <Settings />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function Chip({ label, badge, onClick, active, tone }: {
  label: string; badge?: number; onClick: () => void; active?: boolean;
  tone?: "warn";
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 flex items-center gap-1 rounded-full border px-2.5 py-1 text-mono text-[10px] tracking-[0.2em] transition-colors ${
        tone === "warn"
          ? "border-jarvis-warn/60 text-jarvis-warn bg-jarvis-warn/10"
          : active
            ? "border-jarvis-aqua/70 text-jarvis-aqua bg-jarvis-aqua/10"
            : "border-jarvis-cyan/25 text-jarvis-ice/70 bg-jarvis-ink/40"
      }`}
    >
      {badge !== undefined && badge > 0 && (
        <span className="inline-flex items-center justify-center min-w-3.5 h-3.5 px-0.5 rounded-full bg-jarvis-cyan/25 text-[8px] text-jarvis-ice">{badge}</span>
      )}
      <span>{label}</span>
    </button>
  );
}
