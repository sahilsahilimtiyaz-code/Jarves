/**
 * Android action executor.
 *
 * Executes a planned PhoneAction through the native bridge and reports the
 * REAL outcome. Every execution is written to the existing tool log, so the
 * Home screen's "recent activity" and the Tools screen show what actually
 * happened. Nothing is simulated: when the native bridge is missing or an
 * intent cannot be resolved, the message says so.
 */
import { nextId, useStore } from "./store";
import { planPhoneAction, type PhoneAction, type PhoneActionKind } from "./actionPlan";
import * as native from "../platform/native";

export interface ActionOutcome {
  kind: PhoneActionKind;
  ok: boolean;
  message: string;
  /** Structured payload for callers that render more detail. */
  data?: Record<string, unknown>;
}

const ANDROID_ONLY =
  "Phone actions need the Android app build (the native bridge is not present in this runtime).";

function logAction(tool: string, ok: boolean, message: string, args: Record<string, string> = {}): void {
  try {
    useStore.getState().pushTool({
      id: nextId(),
      tool: `android.${tool}`,
      permission: "safe",
      preview: message.slice(0, 140),
      args,
      status: ok ? "ok" : "fail",
      result: message,
      ts: Date.now(),
    });
  } catch {
    /* logging must never break the action */
  }
}

function formatMb(mb?: number): string {
  if (typeof mb !== "number" || !isFinite(mb) || mb <= 0) return "unknown";
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** Execute a planned action. `approved` must be true for side effects. */
export async function executePhoneAction(
  action: PhoneAction,
  approved = false,
): Promise<ActionOutcome> {
  const available = await native.nativeAvailable().catch(() => false);
  if (!available) {
    logAction(action.kind, false, ANDROID_ONLY, action.args);
    return { kind: action.kind, ok: false, message: ANDROID_ONLY };
  }

  try {
    switch (action.kind) {
      case "open_app": {
        const query = action.args.query || "";
        const result = await native.openApp(query);
        if (result.launched) {
          const label = result.label || query;
          const message = `Opened ${label} on this phone.`;
          logAction(action.kind, true, message, action.args);
          return { kind: action.kind, ok: true, message, data: { packageName: result.packageName } };
        }
        if (result.matches && result.matches.length > 1) {
          const names = result.matches.slice(0, 4).map((m) => m.label).join(", ");
          const message = `“${query}” matches several installed apps (${names}). Be more specific.`;
          logAction(action.kind, false, message, action.args);
          return { kind: action.kind, ok: false, message, data: { matches: result.matches } };
        }
        const message = `No installed app matched “${query}”. Nothing was launched.`;
        logAction(action.kind, false, message, action.args);
        return { kind: action.kind, ok: false, message };
      }

      case "open_settings": {
        const target = action.args.target || "app";
        const result = await native.openSettings(target);
        const message = result.ok
          ? `Opened ${result.label || `${target} settings`}. (This opens the settings screen; it does not change the setting.)`
          : result.message || `This device has no settings screen for “${target}”.`;
        logAction(action.kind, result.ok, message, action.args);
        return { kind: action.kind, ok: result.ok, message };
      }

      case "battery": {
        const info = await native.getDeviceInfo();
        const charging = info.charging ? "charging" : "on battery";
        const temp =
          typeof info.batteryTemperatureC === "number" && isFinite(info.batteryTemperatureC)
            ? ` · ${info.batteryTemperatureC.toFixed(1)} °C`
            : "";
        const message = `This phone's battery is at ${info.batteryPercent}% (${charging})${temp}.`;
        logAction(action.kind, true, message);
        return { kind: action.kind, ok: true, message, data: { ...info } };
      }

      case "device_info": {
        const info = await native.getDeviceInfo();
        const load =
          typeof info.load1 === "number" && isFinite(info.load1)
            ? `${info.load1.toFixed(2)} (1 min load)`
            : "unavailable";
        const message =
          `${info.manufacturer} ${info.model} · Android ${info.androidRelease} (SDK ${info.sdkInt}) · ` +
          `${info.cpuCores} CPU cores · load ${load} · ` +
          `RAM ${formatMb(info.availRamMb)} free of ${formatMb(info.totalRamMb)} · ` +
          `battery ${info.batteryPercent}%`;
        logAction(action.kind, true, message);
        return { kind: action.kind, ok: true, message, data: { ...info } };
      }

      case "clipboard_read": {
        const result = await native.clipboardRead();
        const text = (result?.text || "").trim();
        const message = text
          ? `Clipboard contains: “${text.slice(0, 400)}”`
          : "The clipboard is empty (or the system blocked reading it while the app is not focused).";
        logAction(action.kind, true, message);
        return { kind: action.kind, ok: true, message, data: { text } };
      }

      case "clipboard_write": {
        const text = action.args.text || "";
        if (!text) {
          const message = "There was no text to copy.";
          logAction(action.kind, false, message, action.args);
          return { kind: action.kind, ok: false, message };
        }
        await native.clipboardWrite(text);
        const message = `Copied ${text.length} characters to the clipboard.`;
        logAction(action.kind, true, message, action.args);
        return { kind: action.kind, ok: true, message };
      }

      case "notify": {
        if (!approved) {
          return {
            kind: action.kind,
            ok: false,
            message: "Posting a notification needs your confirmation.",
          };
        }
        const result = await native.notify(action.args.title || "J.A.R.V.I.S.", action.args.body || "");
        const message = result.ok
          ? "Notification posted."
          : result.message || "Notification permission was not granted.";
        logAction(action.kind, result.ok, message, action.args);
        return { kind: action.kind, ok: result.ok, message };
      }

      case "time": {
        const message = `This phone's clock reads ${new Date().toLocaleTimeString()}.`;
        logAction(action.kind, true, message);
        return { kind: action.kind, ok: true, message };
      }

      default: {
        const message = "That action is not implemented on this device.";
        logAction(String(action.kind), false, message);
        return { kind: action.kind, ok: false, message };
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "The action failed on this device.";
    logAction(action.kind, false, message, action.args);
    return { kind: action.kind, ok: false, message };
  }
}

/**
 * Plan + execute a local phone command from recognized text.
 * Returns null when the text is not a supported local action (the caller
 * should then send it to the JARVIS backend instead).
 */
export async function runLocalPhoneCommand(text: string): Promise<ActionOutcome | null> {
  const action = planPhoneAction(text);
  if (!action) return null;
  if (action.requiresApproval) {
    return {
      kind: action.kind,
      ok: false,
      message: `${action.label} needs confirmation before it runs.`,
      data: { requiresApproval: true, action },
    };
  }
  return executePhoneAction(action);
}
