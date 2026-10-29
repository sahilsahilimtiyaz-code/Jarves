/**
 * Time- and context-aware greetings.
 *
 * One deterministic service, no scattered `new Date().getHours()` in screens.
 * It is pure apart from the supplied clock, so every scenario is testable, and
 * each greeting carries an idempotency key so a rerender or a second resume
 * event cannot speak twice.
 */
export type Period = "morning" | "afternoon" | "evening" | "lateNight";

export interface Boundaries {
  morning: number;
  afternoon: number;
  evening: number;
  lateNight: number;
}

export const DEFAULT_BOUNDARIES: Boundaries = { morning: 5, afternoon: 12, evening: 17, lateNight: 22 };

export interface QuietHours {
  start: number;
  end: number;
}

export interface GreetingContext {
  now: Date;
  /** Stable id for this launch; part of the dedupe key. */
  launchId: string;
  firstInstall: boolean;
  providerConfigured: boolean;
  backendConfigured: boolean;
  backendStatus: "unconfigured" | "checking" | "online" | "offline";
  micPermission: "granted" | "denied" | "unknown";
  ttsAvailable: boolean;
  spokenEnabled: boolean;
  hasResumableSession: boolean;
  lastSessionAt: number | null;
  dailyReviewReady: boolean;
  /** Key of the last greeting actually shown or spoken. */
  lastGreetingKey: string | null;
  address: string;
  boundaries?: Boundaries;
  quietHours?: QuietHours;
  /** Optionally pass a session/task event ("task_complete"). */
  event?: "task_complete" | "none";
}

export interface Greeting {
  text: string;
  scenario: string;
  period: Period;
  key: string;
  /** True when the caller should render it in the UI (always). */
  show: boolean;
  /** True when TTS should speak it (audio available, not quiet hours). */
  speak: boolean;
  quiet: boolean;
  /** Optional direct action offered by the copy. */
  action: "resume" | "settings" | "retry" | "review" | null;
}

export function periodFor(date: Date, boundaries: Boundaries = DEFAULT_BOUNDARIES): Period {
  const hour = date.getHours();
  if (hour >= boundaries.morning && hour < boundaries.afternoon) return "morning";
  if (hour >= boundaries.afternoon && hour < boundaries.evening) return "afternoon";
  if (hour >= boundaries.evening && hour < boundaries.lateNight) return "evening";
  return "lateNight";
}

export function inQuietHours(date: Date, quiet?: QuietHours): boolean {
  if (!quiet) return false;
  const hour = date.getHours();
  const { start, end } = quiet;
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

const TIME_GREETING: Record<Period, (name: string) => string> = {
  morning: (name) =>
    `Good morning${name}. JARVIS is online. Would you like your priorities, or a briefing for the day?`,
  afternoon: (name) =>
    `Good afternoon${name}. I'm ready to assist. Shall we continue your current project or start something new?`,
  evening: (name) =>
    `Good evening${name}. All available systems are ready. Would you like to review today's progress or prepare for tomorrow?`,
  lateNight: (name) => `You're up late${name}. I'll keep things quiet. What can I help you with?`,
};

function addressFor(context: GreetingContext): string {
  const raw = (context.address || "").trim();
  if (!raw || /^(?:sir|ma'am|madam)$/i.test(raw)) return ", sir";
  if (/^(?:none|no|nothing)$/i.test(raw)) return "";
  return `, ${raw}`;
}

const GAP_MS = 6 * 60 * 60 * 1000;

/**
 * Choose exactly one greeting. Precedence: first run → returning session →
 * broken/missing service (honest) → normal time-of-day.
 */
export function selectGreeting(context: GreetingContext): Greeting {
  const boundaries = context.boundaries ?? DEFAULT_BOUNDARIES;
  const period = periodFor(context.now, boundaries);
  const quiet = inQuietHours(context.now, context.quietHours);
  const speak = context.spokenEnabled && context.ttsAvailable && !quiet;
  const address = addressFor(context);

  const base = (scenario: string, text: string, action: Greeting["action"] = null): Greeting => ({
    text,
    scenario,
    period,
    key: `${context.launchId}:${scenario}:${period}`,
    show: true,
    speak,
    quiet,
    action,
  });

  if (context.event === "task_complete") {
    return base("task_complete", `Task completed${address}. The result has been verified.`);
  }

  if (context.firstInstall || (!context.providerConfigured && !context.backendConfigured)) {
    return base(
      "first_run",
      "Welcome. I'm JARVIS, your personal AI assistant. Tell me how you'd like me to address you, then add a model provider so I can think — local phone actions work already.",
      "settings",
    );
  }

  const gap = context.lastSessionAt ? context.now.getTime() - context.lastSessionAt : Infinity;
  if (context.hasResumableSession && gap > GAP_MS) {
    return base("returning", `Welcome back${address}. Your previous session is available. Would you like to resume where we left off?`, "resume");
  }

  if (context.backendStatus === "offline" && context.backendConfigured && !context.providerConfigured) {
    return base(
      "backend_offline",
      `The JARVIS backend is currently unavailable${address}. Local phone actions and saved memory still work. Shall we reconnect?`,
      "retry",
    );
  }

  if (context.micPermission === "denied") {
    return base(
      "mic_denied",
      `Microphone access is not enabled${address}. Grant it in Android settings if you'd like to use voice control; typing works regardless.`,
      "settings",
    );
  }

  if (context.dailyReviewReady) {
    return base("daily_review", `Your daily review is ready${address}.`, "review");
  }

  return base(period, TIME_GREETING[period](address));
}

/** True when this key was already used (prevents duplicate speech/UI). */
export function shouldEmit(greeting: Greeting, lastKey: string | null): boolean {
  return greeting.key !== lastKey;
}

/** Copy used when the owner explicitly asks for a status report. */
export function statusGreeting(context: GreetingContext): string {
  const address = addressFor(context);
  const lines = [`All requested diagnostics are as follows${address}.`];
  lines.push(context.providerConfigured ? "Model provider: configured." : "Model provider: not configured.");
  lines.push(
    context.backendStatus === "online"
      ? "JARVIS backend: online."
      : context.backendConfigured
        ? "JARVIS backend: unreachable."
        : "JARVIS backend: not configured (optional).",
  );
  lines.push(context.micPermission === "granted" ? "Microphone: granted." : "Microphone: not granted.");
  lines.push(context.ttsAvailable ? "Speech output: available." : "Speech output: unavailable.");
  return lines.join(" ");
}
