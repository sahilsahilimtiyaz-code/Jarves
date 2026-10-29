/**
 * MobileShell — the Android-first application frame.
 *
 * Dedicated portrait screens (Home / Chat / Tools / Memory / Settings) with a
 * fixed safe-area-aware bottom navigation. The desktop HUD is untouched: this
 * shell only renders on narrow viewports (the APK always qualifies).
 */
import { useEffect, useState } from "react";
import "./mobile.css";
import { useStore } from "../lib/store";
import { usePrefs } from "../lib/prefs";
import { voicePipeline } from "../lib/voicePipeline";
import { backendConfigured } from "../lib/backend";
import { detectPlatform } from "../platform";
import HomeScreen from "./HomeScreen";
import ChatScreen from "./ChatScreen";
import ToolsScreen from "./ToolsScreen";
import MemoryScreen from "./MemoryScreen";
import SettingsScreen from "./SettingsScreen";
import type { MobileTab } from "./types";

const TABS: { tab: MobileTab; label: string; icon: () => JSX.Element }[] = [
  { tab: "home", label: "Home", icon: HomeIcon },
  { tab: "chat", label: "Chat", icon: ChatIcon },
  { tab: "tools", label: "Tools", icon: ToolsIcon },
  { tab: "memory", label: "Memory", icon: MemoryIcon },
  { tab: "settings", label: "Settings", icon: SettingsIcon },
];

export default function MobileShell() {
  const [tab, setTab] = useState<MobileTab>("home");
  const accent = usePrefs((s) => s.accent);
  const streaming = useStore((s) => s.chat.some((entry) => entry.streaming));
  const toolCount = useStore((s) => s.tools.length);
  const needsBackend = detectPlatform() === "android" && !backendConfigured();

  // Probe voice engines once; this only reads capabilities, it does not listen.
  useEffect(() => {
    void voicePipeline.detect();
  }, []);

  // Android hardware back: return to Home first, then leave the app.
  useEffect(() => {
    let handle: { remove?: () => Promise<void> | void } | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const mod = await import("@capacitor/app");
        if (cancelled) return;
        handle = await mod.App.addListener("backButton", () => {
          setTab((current) => {
            if (current !== "home") return "home";
            void mod.App.exitApp();
            return current;
          });
        });
      } catch {
        // Browser/desktop: no hardware back button.
      }
    })();
    return () => {
      cancelled = true;
      void handle?.remove?.();
    };
  }, []);

  const screen =
    tab === "home" ? (
      <HomeScreen onNavigate={setTab} />
    ) : tab === "chat" ? (
      <ChatScreen onNavigate={setTab} />
    ) : tab === "tools" ? (
      <ToolsScreen onNavigate={setTab} />
    ) : tab === "memory" ? (
      <MemoryScreen onNavigate={setTab} />
    ) : (
      <SettingsScreen onNavigate={setTab} />
    );

  return (
    <div className="m-shell" data-accent={accent}>
      <main className={tab === "chat" ? "m-main m-main--chat" : "m-main"}>{screen}</main>

      <nav className="m-nav" aria-label="Primary navigation">
        {TABS.map(({ tab: id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className="m-nav-btn"
            data-active={tab === id}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => setTab(id)}
          >
            <Icon />
            <span>{label}</span>
            {id === "chat" && streaming && <span className="m-nav-badge">…</span>}
            {id === "tools" && toolCount > 0 && <span className="m-nav-badge">{Math.min(toolCount, 99)}</span>}
            {id === "settings" && needsBackend && <span className="m-nav-badge" style={{ background: "rgba(251,191,36,0.25)", borderColor: "rgba(251,191,36,0.5)" }}>!</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}

function HomeIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V21h13V9.5" />
      <path d="M9.5 21v-6h5v6" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 15a3 3 0 0 1-3 3H8l-4 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3Z" />
      <path d="M8 9h8M8 13h5" />
    </svg>
  );
}

function ToolsIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
    </svg>
  );
}

function MemoryIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a4 4 0 0 1 4 4v1a4 4 0 0 1 0 8v1a4 4 0 0 1-8 0v-1a4 4 0 0 1 0-8V7a4 4 0 0 1 4-4Z" />
      <path d="M12 7v10M9 10h6M9 14h6" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 8.96 4a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" />
    </svg>
  );
}
