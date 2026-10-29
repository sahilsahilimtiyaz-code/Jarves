/**
 * First-launch system-access gate.
 *
 * Android only grants microphone, notification and camera access through a
 * runtime dialog. The app used to ask for the microphone only when the owner
 * tapped it, so a fresh install looked dead: no prompt, no recognizer, an
 * "unknown" permission and a provider form that could not use voice. This gate
 * runs before the shell so the real Android dialogs appear on first launch and
 * the result of every request is visible.
 *
 * It never fakes a grant: each row shows the state read back from Android.
 */
import { useCallback, useEffect, useState } from "react";
import * as native from "../platform/native";
import { detectPlatform } from "../platform";
import { APP_BUILD } from "../lib/version";
import { Card, Chip } from "./ui";

const PROMPTED_KEY = "jarvis.access.prompted.v2";

type RowState = "checking" | "prompt" | "granted" | "denied" | "unavailable";
type Bridge = "checking" | "ready" | "unavailable";

interface Row {
  id: "microphone" | "notifications" | "camera";
  title: string;
  body: string;
  required: boolean;
  state: RowState;
}

const INITIAL_ROWS: Row[] = [
  {
    id: "microphone",
    title: "Microphone",
    body: "Speech recognition and “Hey JARVIS”. Audio is used by Android's recognizer, never stored by this app.",
    required: true,
    state: "checking",
  },
  {
    id: "notifications",
    title: "Notifications",
    body: "The permanent banner shown while wake-word monitoring is active, plus local alerts.",
    required: false,
    state: "checking",
  },
  {
    id: "camera",
    title: "Camera",
    body: "Only opened when you choose to capture a photo for analysis. Never used in the background.",
    required: false,
    state: "checking",
  },
];

export function shouldShowAccessGate(): boolean {
  // The Capacitor global is normally present, but a cold WebView can paint the
  // first frame before it is injected. The user agent is a safe second signal:
  // a plain desktop browser never contains Android, while the APK always does.
  const android =
    detectPlatform() === "android" ||
    (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent));
  if (!android) return false;
  try {
    return localStorage.getItem(PROMPTED_KEY) !== "1";
  } catch {
    return true;
  }
}

function markPrompted(): void {
  try {
    localStorage.setItem(PROMPTED_KEY, "1");
  } catch {
    /* private storage is not fatal; the gate simply appears again */
  }
}

function stateFromPermission(value: string | undefined): RowState {
  if (value === "granted") return "granted";
  if (value === "denied") return "denied";
  if (value === "prompt" || value === "prompt_with_rationale") return "prompt";
  return "unavailable";
}

function tone(state: RowState): "ok" | "warn" | "danger" | "accent" {
  if (state === "granted") return "ok";
  if (state === "denied" || state === "unavailable") return "danger";
  if (state === "checking") return "accent";
  return "warn";
}

function stateLabel(state: RowState): string {
  switch (state) {
    case "granted":
      return "granted";
    case "denied":
      return "denied";
    case "unavailable":
      return "not available";
    case "checking":
      return "checking";
    default:
      return "needs access";
  }
}

export default function AccessGate({ onDone }: { onDone: () => void }) {
  const [bridge, setBridge] = useState<Bridge>("checking");
  const [plugin, setPlugin] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>(INITIAL_ROWS);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  const update = useCallback((id: Row["id"], state: RowState) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, state } : row)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const available = await native.nativeAvailable().catch(() => false);
      if (cancelled) return;
      if (!available) {
        setBridge("unavailable");
        setRows((current) => current.map((row) => ({ ...row, state: "unavailable" })));
        return;
      }
      setBridge("ready");
      try {
        const caps = await native.getCapabilities();
        if (!cancelled && caps && typeof caps.plugin === "string") setPlugin(caps.plugin);
      } catch {
        /* capabilities are diagnostic only */
      }
      try {
        const report = await native.checkPermissions();
        if (cancelled) return;
        setRows((current) =>
          current.map((row) => ({
            ...row,
            state:
              row.id === "microphone"
                ? stateFromPermission(report.microphone)
                : row.id === "notifications"
                  ? stateFromPermission(report.notifications)
                  : stateFromPermission(report.camera),
          })),
        );
      } catch (e) {
        if (cancelled) return;
        setNotice(e instanceof Error ? e.message : "Android did not report permission state.");
        setRows((current) => current.map((row) => ({ ...row, state: "unavailable" })));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const ask = useCallback(
    async (id: Row["id"], task: () => Promise<{ granted?: boolean } | void>): Promise<boolean> => {
      update(id, "checking");
      try {
        const result: any = await task();
        if (result && result.granted === false) {
          update(id, "denied");
          return false;
        }
        update(id, "granted");
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : "";
        update(id, message.toLowerCase().includes("not available") ? "unavailable" : "denied");
        return false;
      }
    },
    [update],
  );

  const grant = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    if (bridge !== "ready") {
      setNotice(
        "The Android bridge is not answering. This build cannot request permissions. Install the current APK (the access screen must show a build number) and try again.",
      );
      setBusy(false);
      return;
    }
    try {
      await ask("microphone", () => native.requestMicPermission());
      await ask("notifications", () => native.requestNotificationPermission());
      await ask("camera", () => native.requestCameraPermission());
      try {
        const report = await native.checkPermissions();
        setRows((current) =>
          current.map((row) => ({
            ...row,
            state:
              row.id === "microphone"
                ? stateFromPermission(report.microphone)
                : row.id === "notifications"
                  ? stateFromPermission(report.notifications)
                  : stateFromPermission(report.camera),
          })),
        );
      } catch {
        /* the individual results above are still real */
      }
      setFinished(true);
      markPrompted();
    } finally {
      setBusy(false);
    }
  }, [ask, bridge]);

  const skip = useCallback(() => {
    markPrompted();
    onDone();
  }, [onDone]);

  const enter = useCallback(() => {
    markPrompted();
    onDone();
  }, [onDone]);

  const micGranted = rows.find((row) => row.id === "microphone")?.state === "granted";

  return (
    <div className="m-shell" data-accent="cyan">
      <main className="m-main m-gate">
        <div className="m-gate-head">
          <div className="m-gate-orb" aria-hidden="true">
            <span className="m-gate-ring m-gate-ring--outer" />
            <span className="m-gate-ring m-gate-ring--inner" />
            <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.3">
              <path d="M12 2.6 20.6 19H3.4L12 2.6Z" />
              <path d="M12 8.2 16.4 18H7.6L12 8.2Z" opacity=".55" />
            </svg>
          </div>
          <div className="m-eyebrow">SYSTEM ACCESS</div>
          <h1 className="m-title">J.A.R.V.I.S.</h1>
          <p className="m-body m-gate-copy">
            Before the interface starts, grant the Android permissions the assistant actually uses. Each row is the
            state Android reports — nothing is assumed.
          </p>
        </div>

        <Card className="mb-3">
          {rows.map((row) => (
            <div className="m-gate-row" key={row.id}>
              <div className="m-row-main">
                <div className="m-row-title">
                  {row.title}
                  {row.required ? <span className="m-gate-required"> required</span> : null}
                </div>
                <div className="m-row-sub">{row.body}</div>
              </div>
              <Chip tone={tone(row.state)}>{stateLabel(row.state)}</Chip>
            </div>
          ))}
        </Card>

        {bridge === "unavailable" && (
          <div className="m-gate-warning">
            <strong>Native bridge unavailable.</strong> The APK on this phone is not running the current build, or the
            native plugin failed to register. This is why permissions and storage cannot work. Install the APK built from
            this commit; the gate will then show a bridge version below.
          </div>
        )}

        {notice && <div className="m-gate-warning">{notice}</div>}

        <div className="m-gate-actions">
          {finished || micGranted ? (
            <button type="button" className="m-btn" data-variant="primary" onClick={enter}>
              Enter JARVIS
            </button>
          ) : (
            <button type="button" className="m-btn" data-variant="primary" onClick={() => void grant()} disabled={busy || bridge === "checking"}>
              {busy ? "Requesting Android permissions…" : bridge === "checking" ? "Checking the native bridge…" : "Grant access"}
            </button>
          )}
          {!finished && !micGranted && (
            <button type="button" className="m-btn" data-variant="ghost" onClick={skip} disabled={busy}>
              Continue without permissions
            </button>
          )}
        </div>

        <p className="m-gate-foot">
          Build {APP_BUILD}
          {plugin ? ` · native bridge ${plugin}` : ""} · microphone {rows.find((row) => row.id === "microphone")?.state ?? "checking"}
        </p>
      </main>
    </div>
  );
}
