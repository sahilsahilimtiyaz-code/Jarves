/**
 * Android action router (pure planning half).
 *
 * Converts a recognized/typed user request into a typed action descriptor.
 * Execution lives in `actions.ts`; this module has no browser or native
 * dependency so it is unit-testable in Node.
 *
 * SAFETY
 * ------
 * - Only documented Android APIs are reachable (intents, sensors, clipboard).
 * - Nothing here can run a shell command.
 * - Actions with external side effects (`notify`) require explicit approval.
 * - Unknown phrasing returns null: the text goes to the JARVIS backend instead
 *   of being guessed into a local action.
 */
export type PhoneActionKind =
  | "open_app"
  | "open_settings"
  | "battery"
  | "device_info"
  | "clipboard_read"
  | "clipboard_write"
  | "notify"
  | "time";

export interface PhoneAction {
  kind: PhoneActionKind;
  /** Raw recognized text that produced this action. */
  source: string;
  args: Record<string, string>;
  /** Human-readable one-line description shown before execution. */
  label: string;
  /** External side effect → require a confirmation tap. */
  requiresApproval: boolean;
}

const SETTINGS_TARGETS: { target: string; label: string; re: RegExp }[] = [
  { target: "wifi", label: "Wi-Fi settings", re: /\bwi[\s-]?fi\b|\bwireless\b/i },
  { target: "bluetooth", label: "Bluetooth settings", re: /\bbluetooth\b/i },
  { target: "display", label: "Display settings", re: /\bdisplay\b|\bbrightness\b|\bscreen\b/i },
  { target: "sound", label: "Sound settings", re: /\bsound\b|\bvolume\b/i },
  { target: "battery", label: "Battery settings", re: /\bbattery\b/i },
  { target: "apps", label: "App settings", re: /\bapps?\b|\bapplication\b/i },
  { target: "notifications", label: "Notification settings", re: /\bnotifications?\b/i },
  { target: "data", label: "Network settings", re: /\bdata\b|\bmobile network\b|\bcellular\b/i },
];

function cleanTarget(raw: string): string {
  return raw
    .replace(/^(?:the|my|an?)\s+/i, "")
    .replace(/\s+(?:app|application)$/i, "")
    .replace(/[.?!,]+$/g, "")
    .trim();
}

/**
 * Plan a local phone action from text. Returns null when the request is not
 * an action this app can perform with a documented Android API.
 */
export function planPhoneAction(input: string): PhoneAction | null {
  const source = (input || "").trim();
  if (!source) return null;

  // Clipboard write must be checked before generic "copy" handling.
  const clipboardWrite = /\bcopy\s+(.+?)\s+to\s+(?:my\s+|the\s+)?clipboard\b/i.exec(source);
  if (clipboardWrite) {
    return {
      kind: "clipboard_write",
      source,
      args: { text: clipboardWrite[1].replace(/^["“]|["”]$/g, "").trim() },
      label: `Copy “${clipboardWrite[1].trim().slice(0, 40)}” to clipboard`,
      requiresApproval: false,
    };
  }

  if (/\b(?:read|show|what(?:'s| is)|whats)\b[^.]*\bclipboard\b/i.test(source) ||
      /\bpaste\b/i.test(source)) {
    return {
      kind: "clipboard_read",
      source,
      args: {},
      label: "Read the clipboard",
      requiresApproval: false,
    };
  }

  const notify = /\bnotify\s+me\s+(?:that|to|about)\s+(.+)$/i.exec(source);
  if (notify) {
    return {
      kind: "notify",
      source,
      args: { title: "J.A.R.V.I.S.", body: notify[1].replace(/[.?!]+$/g, "").trim() },
      label: `Post a notification: “${notify[1].trim().slice(0, 48)}”`,
      requiresApproval: true,
    };
  }

  if (/\b(?:battery|charge)\b/i.test(source) &&
      /\b(?:level|percent|percentage|status|how much|how is|what(?:'s| is)|whats|check)\b/i.test(source)) {
    return {
      kind: "battery",
      source,
      args: {},
      label: "Read this phone's battery status",
      requiresApproval: false,
    };
  }

  if (/\b(?:device|phone)\s+(?:info|information|specs?)\b/i.test(source) ||
      /\b(?:android version|how much ram|how many cores|what phone)\b/i.test(source)) {
    return {
      kind: "device_info",
      source,
      args: {},
      label: "Read this phone's hardware information",
      requiresApproval: false,
    };
  }

  // Bare "open settings" has no qualifying word — treat it as this app's
  // settings screen rather than falling through to app launching.
  if (/^(?:please\s+)?(?:open|show|go\s+to|launch)\s+(?:the\s+)?(?:settings?|preferences?)$/i.test(source)) {
    return {
      kind: "open_settings",
      source,
      args: { target: "app" },
      label: "Open this app's Android settings screen",
      requiresApproval: false,
    };
  }

  const settings = /\b(?:open|show|go\s+to|launch)\b\s+(?:the\s+)?([a-z\s-]{3,24}?)\s*(?:settings?|preferences?)\b/i.exec(source);
  if (settings) {
    const phrase = settings[1].trim();
    const match = SETTINGS_TARGETS.find((t) => t.re.test(phrase));
    if (match) {
      return {
        kind: "open_settings",
        source,
        args: { target: match.target },
        label: `Open ${match.label}`,
        requiresApproval: false,
      };
    }
  }

  const openApp = /^(?:please\s+)?(?:open|launch|start)\s+(.+)$/i.exec(source);
  if (openApp) {
    const target = cleanTarget(openApp[1]);
    // Avoid hijacking "open settings" style requests already handled above.
    if (target && !/\bsettings?\b/i.test(target)) {
      return {
        kind: "open_app",
        source,
        args: { query: target },
        label: `Open “${target}” on this phone`,
        requiresApproval: false,
      };
    }
  }

  if (/\b(?:what(?:'s| is)?\s+the\s+time|what\s+time\s+is\s+it|current\s+time)\b/i.test(source)) {
    return {
      kind: "time",
      source,
      args: {},
      label: "Read this phone's clock",
      requiresApproval: false,
    };
  }

  return null;
}

/** Human-readable description of an action, used in confirmations/logs. */
export function describeAction(action: PhoneAction): string {
  return action.label;
}

/** Actions this build can perform without a backend. */
export const LOCAL_ACTION_KINDS: PhoneActionKind[] = [
  "open_app",
  "open_settings",
  "battery",
  "device_info",
  "clipboard_read",
  "clipboard_write",
  "notify",
  "time",
];
