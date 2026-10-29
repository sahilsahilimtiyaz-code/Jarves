import { useCallback, useEffect, useMemo, useState } from "react";
import { apiUrl } from "../lib/backend";
import { analyzeImage } from "../lib/api";
import { useBackendHealth } from "./hooks";
import { executePhoneAction } from "../lib/actions";
import type { PhoneAction, PhoneActionKind } from "../lib/actionPlan";
import * as native from "../platform/native";
import type { NativeAppEntry } from "../platform/native";
import { Card, Chip, ScreenHeader, Section, Sheet } from "./ui";
import type { ScreenProps } from "./types";

interface BackendTool {
  name: string;
  description?: string;
  permission?: string;
  plugin?: string;
}

interface Outcome {
  ok: boolean;
  message: string;
}

const GROUP_BY_PLUGIN: Record<string, string> = {
  web_tools: "Web research",
  browser_tools: "Web research",
  quote_tools: "Web research",
  code_tools: "Writing & reasoning",
  file_tools: "Files",
  media_generation: "Images & media",
  vision_tools_optional: "Camera & vision",
  memory_tools: "Memory & productivity",
  calendar_optional: "Memory & productivity",
  email_optional: "Integrations",
  smart_home_optional: "Integrations",
  voice_tools_optional: "Voice",
  shell_tools: "Connected desktop",
  system_monitor: "Host monitoring",
  agent_backend_tools: "Agents & research",
};

const SETTINGS_SHORTCUTS: { target: string; label: string; note: string }[] = [
  { target: "wifi", label: "Wi-Fi", note: "opens the real Wi-Fi settings screen" },
  { target: "bluetooth", label: "Bluetooth", note: "opens Bluetooth settings" },
  { target: "display", label: "Display", note: "opens display settings" },
  { target: "sound", label: "Sound", note: "opens sound settings" },
  { target: "battery", label: "Battery", note: "opens battery settings" },
  { target: "app", label: "App info", note: "this app's system settings" },
];

export default function ToolsScreen({ onNavigate }: ScreenProps) {
  const health = useBackendHealth(30_000);

  const [backendTools, setBackendTools] = useState<BackendTool[]>([]);
  const [toolsStatus, setToolsStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [toolsError, setToolsError] = useState<string | null>(null);

  const [apps, setApps] = useState<NativeAppEntry[]>([]);
  const [appQuery, setAppQuery] = useState("");
  const [appsError, setAppsError] = useState<string | null>(null);
  const [nativeReady, setNativeReady] = useState<boolean | null>(null);

  const [result, setResult] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingNotify, setPendingNotify] = useState<PhoneAction | null>(null);
  const [clipboardText, setClipboardText] = useState("");
  const [fileInfo, setFileInfo] = useState<{ name: string; size?: number; mime?: string } | null>(null);

  const toolGroups = useMemo(() => {
    const groups = new Map<string, BackendTool[]>();
    for (const tool of backendTools) {
      const key = GROUP_BY_PLUGIN[tool.plugin || ""] || "Other integrations";
      const list = groups.get(key) || [];
      list.push(tool);
      groups.set(key, list);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [backendTools]);

  const loadTools = useCallback(async () => {
    if (health.status !== "online") return;
    setToolsStatus("loading");
    setToolsError(null);
    try {
      const response = await fetch(apiUrl("/api/tools"));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const list = Array.isArray(data?.tools) ? (data.tools as BackendTool[]) : [];
      setBackendTools(list);
      setToolsStatus("ok");
    } catch (e) {
      setToolsStatus("error");
      setToolsError(e instanceof Error ? e.message : "Tool registry unavailable");
    }
  }, [health.status]);

  useEffect(() => {
    void loadTools();
  }, [loadTools]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const available = await native.nativeAvailable().catch(() => false);
      if (cancelled) return;
      setNativeReady(available);
      if (!available) return;
      try {
        const list = await native.listApps();
        if (!cancelled) setApps(list.apps || []);
      } catch (e) {
        if (!cancelled) setAppsError(e instanceof Error ? e.message : "Could not list installed apps");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async (label: string, action: () => Promise<Outcome>) => {
    setBusy(label);
    setResult(null);
    try {
      const outcome = await action();
      setResult(outcome);
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : "The action failed." });
    } finally {
      setBusy(null);
    }
  };

  const runKind = (kind: PhoneActionKind, args: Record<string, string> = {}, label?: string) =>
    run(label ?? kind, async () => {
      const outcome = await executePhoneAction({
        kind,
        args,
        source: "tools screen",
        label: label ?? kind,
        requiresApproval: false,
      });
      return { ok: outcome.ok, message: outcome.message };
    });

  const filteredApps = useMemo(() => {
    const query = appQuery.trim().toLowerCase();
    if (!query) return [];
    return apps
      .filter((app) => app.label.toLowerCase().includes(query) || app.packageName.toLowerCase().includes(query))
      .slice(0, 6);
  }, [appQuery, apps]);

  const analyzePhoto = (source: "camera" | "gallery") =>
    run(source === "camera" ? "Capturing photo" : "Choosing photo", async () => {
      const available = await native.nativeAvailable().catch(() => false);
      if (!available) {
        return { ok: false, message: "Photo capture requires the Android app build." };
      }
      const picked = await native.pickImage(source);
      if (picked.cancelled) return { ok: false, message: "Cancelled." };
      if (picked.error || !picked.dataUrl) {
        return { ok: false, message: picked.error || "No image was captured." };
      }
      if (health.status !== "online") {
        return {
          ok: false,
          message: "The photo was captured, but image analysis needs the JARVIS backend. Configure it in Settings and try again.",
        };
      }
      const file = dataUrlToFile(picked.dataUrl, picked.name || `photo-${Date.now()}.jpg`, picked.mime || "image/jpeg");
      // Real backend vision route (/api/analyze-image) — no local simulation.
      const analysis = await analyzeImage(
        file,
        "Describe this image in detail. Identify any visible text, objects and context.",
      );
      if (!analysis?.ok) {
        return { ok: false, message: analysis?.error || "The backend returned no analysis for this image." };
      }
      return { ok: true, message: analysis.analysis || "The backend returned an empty analysis." };
    });

  const pickFile = () =>
    run("Selecting file", async () => {
      const available = await native.nativeAvailable().catch(() => false);
      if (!available) return { ok: false, message: "File selection requires the Android app build." };
      const picked = await native.pickFile();
      if (picked.cancelled) return { ok: false, message: "Cancelled." };
      if (picked.error || !picked.name) return { ok: false, message: picked.error || "No file was selected." };
      setFileInfo({ name: picked.name, size: picked.size, mime: picked.mime });
      return {
        ok: true,
        message: `Selected “${picked.name}” via the Android Storage Access Framework${
          picked.size ? ` (${formatBytes(picked.size)})` : ""
        }.`,
      };
    });

  return (
    <div className="pb-2">
      <ScreenHeader
        eyebrow="Capabilities"
        title="Tools"
        subtitle="Phone actions run here; backend tools run on the connected JARVIS host."
        right={<Chip tone={health.status === "online" ? "accent" : "warn"}>{health.status === "online" ? `${backendTools.length || health.tools || 0} backend tools` : "backend offline"}</Chip>}
      />

      {result && (
        <Card className="mb-4">
          <div className="m-label mb-1">{result.ok ? "Done" : "Not completed"}</div>
          <p className="m-small" style={{ color: result.ok ? "rgba(232,244,255,0.9)" : "#fecdd3" }}>{result.message}</p>
        </Card>
      )}

      <Section title="On this phone" action={<span className="m-row-sub">native Android APIs</span>}>
        {nativeReady === false && (
          <Card className="mb-3">
            <p className="m-small">
              The native bridge is not present in this runtime. Phone actions work in the installed Android build; nothing here is simulated.
            </p>
          </Card>
        )}

        <Card className="mb-3">
          <div className="m-label mb-2">Open an installed app</div>
          <input
            className="m-input"
            value={appQuery}
            onChange={(event) => setAppQuery(event.target.value)}
            placeholder="Type an app name (e.g. YouTube, Spotify)"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          {appsError && <p className="m-row-sub mt-2">{appsError}</p>}
          {appQuery.trim() && (
            <div className="mt-2">
              {filteredApps.length === 0 ? (
                <p className="m-row-sub">No installed app matches “{appQuery.trim()}”.</p>
              ) : (
                filteredApps.map((app) => (
                  <div className="m-row" key={app.packageName}>
                    <div className="m-row-main">
                      <div className="m-row-title">{app.label}</div>
                      <div className="m-row-sub">{app.packageName}</div>
                    </div>
                    <button
                      type="button"
                      className="m-btn"
                      data-size="sm"
                      data-variant="primary"
                      disabled={busy !== null}
                      onClick={() =>
                        void runKind("open_app", { query: app.label }, `Opening ${app.label}`)
                      }
                    >
                      Open
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
          <p className="m-row-sub mt-2">
            {apps.length > 0 ? `${apps.length} launchable apps discovered on this device.` : "App list loads from Android PackageManager."}
          </p>
        </Card>

        <Card className="mb-3">
          <div className="m-label mb-2">System settings shortcuts</div>
          <div className="grid grid-cols-3 gap-2">
            {SETTINGS_SHORTCUTS.map((shortcut) => (
              <button
                key={shortcut.target}
                type="button"
                className="m-btn"
                style={{ flexDirection: "column", gap: 2, padding: "8px 4px", minHeight: 60 }}
                disabled={busy !== null}
                onClick={() => void runKind("open_settings", { target: shortcut.target }, `Opening ${shortcut.label}`)}
                title={shortcut.note}
              >
                <span style={{ fontSize: 12.5 }}>{shortcut.label}</span>
                <span className="m-row-sub" style={{ fontSize: 9 }}>opens screen</span>
              </button>
            ))}
          </div>
          <p className="m-row-sub mt-2">These open the official Android settings screens. JARVIS never claims to have changed a protected setting.</p>
        </Card>

        <Card className="mb-3">
          <div className="m-label mb-2">Device & clipboard</div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="m-btn" disabled={busy !== null} onClick={() => void runKind("battery", {}, "Reading battery")}>
              Battery status
            </button>
            <button type="button" className="m-btn" disabled={busy !== null} onClick={() => void runKind("device_info", {}, "Reading device info")}>
              Device info
            </button>
            <button type="button" className="m-btn" disabled={busy !== null} onClick={() => void runKind("clipboard_read", {}, "Reading clipboard")}>
              Read clipboard
            </button>
            <button type="button" className="m-btn" disabled={busy !== null} onClick={() => void runKind("time", {}, "Reading clock")}>
              Current time
            </button>
          </div>
          <div className="mt-3 flex gap-2">
            <input
              className="m-input"
              value={clipboardText}
              onChange={(event) => setClipboardText(event.target.value)}
              placeholder="Text to copy to clipboard"
            />
            <button
              type="button"
              className="m-btn"
              disabled={!clipboardText.trim() || busy !== null}
              onClick={() => void runKind("clipboard_write", { text: clipboardText }, "Writing clipboard")}
            >
              Copy
            </button>
          </div>
        </Card>

        <Card className="mb-3">
          <div className="m-label mb-2">Camera, files & notifications</div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="m-btn" disabled={busy !== null} onClick={() => void analyzePhoto("camera")}>
              Analyze photo
            </button>
            <button type="button" className="m-btn" disabled={busy !== null} onClick={() => void analyzePhoto("gallery")}>
              Analyze gallery image
            </button>
            <button type="button" className="m-btn" disabled={busy !== null} onClick={() => void pickFile()}>
              Select a file
            </button>
            <button
              type="button"
              className="m-btn"
              disabled={busy !== null}
              onClick={() =>
                setPendingNotify({
                  kind: "notify",
                  source: "tools screen",
                  args: { title: "J.A.R.V.I.S.", body: "Local notification test from your phone." },
                  label: "Post a test notification",
                  requiresApproval: true,
                })
              }
            >
              Send notification
            </button>
          </div>
          {fileInfo && (
            <div className="mt-3">
              <div className="m-row-sub">Selected file</div>
              <div className="m-row-title mt-1">{fileInfo.name}</div>
              <div className="m-row-sub">
                {fileInfo.mime || "unknown type"}
                {fileInfo.size ? ` · ${formatBytes(fileInfo.size)}` : ""}
              </div>
            </div>
          )}
          <p className="m-row-sub mt-2">
            Photos and files are picked with official Android pickers. Image analysis is performed by the configured JARVIS backend — nothing is analyzed locally or mocked.
          </p>
        </Card>
      </Section>

      <Section
        title="Backend tools"
        action={
          health.status === "online" ? (
            <button type="button" className="m-btn" data-variant="ghost" data-size="sm" onClick={() => void loadTools()}>
              Refresh
            </button>
          ) : undefined
        }
      >
        {health.status !== "online" ? (
          <Card>
            <div className="m-h2">Backend required</div>
            <p className="m-small mt-2">
              The tool registry lives in the JARVIS backend. Configure and test the backend to load the real tool list; no placeholder tools are shown.
            </p>
            <button type="button" className="m-btn mt-3" data-variant="primary" onClick={() => onNavigate("settings")}>
              Configure backend
            </button>
          </Card>
        ) : toolsStatus === "loading" ? (
          <Card><p className="m-small">Loading the real tool registry…</p></Card>
        ) : toolsStatus === "error" ? (
          <Card>
            <p className="m-small" style={{ color: "#fecdd3" }}>Tool registry failed to load: {toolsError}</p>
            <button type="button" className="m-btn mt-3" onClick={() => void loadTools()}>Retry</button>
          </Card>
        ) : backendTools.length === 0 ? (
          <Card><p className="m-small">The backend reports zero enabled tools. Check its config.yaml plugins.</p></Card>
        ) : (
          toolGroups.map(([group, tools]) => (
            <Card className="mb-3" key={group}>
              <div className="mb-1 flex items-center justify-between">
                <span className="m-h2" style={{ fontSize: 14 }}>{group}</span>
                <span className="m-row-sub">{tools.length}</span>
              </div>
              {tools.map((tool) => (
                <div className="m-row" key={tool.name}>
                  <div className="m-row-main">
                    <div className="m-row-title m-mono" style={{ fontSize: 12 }}>{tool.name}</div>
                    <div className="m-row-sub">{tool.description || "No description provided by the backend."}</div>
                  </div>
                  <span className="m-chip">{tool.permission || "backend"}</span>
                </div>
              ))}
              <div className="m-row-sub mt-2">Execution location: on the configured backend host.</div>
            </Card>
          ))
        )}
      </Section>

      <Sheet open={Boolean(pendingNotify)} title="Confirm notification" onClose={() => setPendingNotify(null)}>
        <p className="m-body">Post a local notification on this phone?</p>
        <p className="m-small mt-2">This is an external side effect and runs only after approval.</p>
        <div className="mt-4 flex gap-2">
          <button type="button" className="m-btn flex-1" onClick={() => setPendingNotify(null)}>Cancel</button>
          <button
            type="button"
            className="m-btn flex-1"
            data-variant="primary"
            onClick={() => {
              const action = pendingNotify;
              setPendingNotify(null);
              if (action) {
                void run("Sending notification", async () => {
                  const outcome = await executePhoneAction(action, true);
                  return { ok: outcome.ok, message: outcome.message };
                });
              }
            }}
          >
            Send
          </button>
        </div>
      </Sheet>
    </div>
  );
}

function dataUrlToFile(dataUrl: string, name: string, mime: string): File {
  const [meta, data] = dataUrl.split(",");
  const match = /data:([^;]+)/.exec(meta || "");
  const type = match?.[1] || mime;
  const binary = atob(data || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type });
}

function formatBytes(size?: number): string {
  if (!size || size < 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
