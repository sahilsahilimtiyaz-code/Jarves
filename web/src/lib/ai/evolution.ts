/**
 * Controlled self-improvement primitives.
 *
 * The engine learns from *recorded tool outcomes*, not from prose. Everything
 * here is pure and deterministic so a proposed change can be evaluated and
 * rejected before it reaches a stored procedure — and so the safety rules can
 * be unit-tested.
 *
 * A model may draft memories and experimental procedures. It may never alter
 * executable code, permissions, authentication, the trusted tool registry or
 * these safety rules; that requires an owner-approved code change.
 */
import type { EpisodeRecord, ProcedureRecord } from "./store";

export type ProcedureStatus = "DRAFT" | "VALIDATED" | "TESTED" | "APPROVED" | "MONITORED" | "RETIRED";

export interface Reflection {
  goal: string;
  intended: string;
  observed: string;
  worked: string[];
  failed: string[];
  missing: string[];
  rootCause: string | null;
  lesson: string | null;
  evidence: string;
  confidence: number;
  /** Hypotheses are never promoted without a confirming test. */
  hypothesis: boolean;
}

export interface EvaluationCase {
  name: string;
  /** Returns true when the candidate procedure satisfies the case. */
  check: (procedure: DraftProcedure) => boolean;
}

export interface DraftProcedure {
  name: string;
  purpose: string;
  prerequisites: string[];
  permissions: string[];
  steps: string[];
  expected: string[];
  failures: string[];
  verification: string[];
  risk: "low" | "medium" | "high";
}

export interface EvaluationResult {
  passed: boolean;
  score: number;
  failures: string[];
  cases: { name: string; ok: boolean }[];
}

const SUCCESS = /^(ok|success|succeeded|completed|opened|posted|created)$/i;

export function isVerifiedSuccess(outcome: string, result?: string | null): boolean {
  if (!SUCCESS.test((outcome || "").trim())) return false;
  return Boolean((result || "").trim());
}

/**
 * Build a reflection from an episode. Deterministic: no model call, so it can
 * run after every non-trivial task without spending tokens.
 */
export function reflect(episode: EpisodeRecord): Reflection {
  const success = isVerifiedSuccess(episode.outcome, episode.result);
  const tools = safeList(episode.tools);
  const actions = safeList(episode.actions);
  const observed = success
    ? `Verified result: ${(episode.result || "").trim()}`
    : `Failure: ${(episode.error || episode.result || "no result recorded").trim()}`;
  const missing: string[] = [];
  if (!success && !episode.error) missing.push("error detail was not captured");
  if (!tools.length) missing.push("no tool was recorded for this task");

  return {
    goal: episode.goal,
    intended: episode.goal,
    observed,
    worked: success ? actions : actions.slice(0, Math.max(0, actions.length - 1)),
    failed: success ? [] : [episode.error || "the final step did not verify"],
    missing,
    rootCause: success ? null : (episode.error || "").trim() || null,
    lesson: success
      ? `The recorded sequence works for "${episode.goal}" when its prerequisites hold.`
      : `Do not repeat the failing step for "${episode.goal}" without changing the cause: ${episode.error || "unknown"}.`,
    evidence: success ? (episode.result || "") : (episode.error || episode.result || ""),
    confidence: success ? 0.8 : episode.error ? 0.6 : 0.4,
    hypothesis: !success,
  };
}

function safeList(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item)).filter(Boolean);
    if (typeof parsed === "string") return [parsed];
  } catch {
    return raw.split(/\s*(?:,|;|\n)\s*/).filter(Boolean);
  }
  return [];
}

/**
 * Draft a reusable procedure from a *verified* episode. Unverified episodes
 * produce nothing: a failed guess must never become a documented workflow.
 */
export function draftProcedure(episode: EpisodeRecord): DraftProcedure | null {
  if (!isVerifiedSuccess(episode.outcome, episode.result)) return null;
  const tools = safeList(episode.tools);
  const actions = safeList(episode.actions);
  if (!tools.length && !actions.length) return null;
  return {
    name: `task:${episode.goal.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 48)}`,
    purpose: `Reproduce the verified outcome for "${episode.goal}".`,
    prerequisites: ["The configured JARVIS provider is reachable", "Required Android permissions are granted"],
    // Do not fabricate permission names: record the tool that requires one
    // and let the owner inspect the real Android permission in Tools.
    permissions: tools.map((tool) => `tool:${tool}`),
    steps: actions.length ? actions : tools.map((tool) => `Run ${tool}`),
    expected: [episode.result || "the task completes"],
    failures: [episode.error || "an earlier attempt failed; verify prerequisites before retrying"],
    verification: ["The tool result reports success", "The owner-visible outcome matches the goal"],
    risk: "low",
  };
}

/** Structural checks every stored procedure must satisfy. */
export const DEFAULT_EVALUATION_CASES: EvaluationCase[] = [
  { name: "has a purpose", check: (p) => p.purpose.trim().length > 12 },
  { name: "has ordered steps", check: (p) => p.steps.length > 0 && p.steps.every((step) => step.trim().length > 2) },
  { name: "declares prerequisites", check: (p) => p.prerequisites.length > 0 },
  { name: "defines verification", check: (p) => p.verification.length > 0 },
  { name: "records a known failure mode", check: (p) => p.failures.length > 0 },
  {
    name: "no destructive action without approval",
    check: (p) => !p.steps.some((step) => /\b(?:delete|erase|factory reset|format|wipe|uninstall)\b/i.test(step)) || p.risk !== "low",
  },
];

export function evaluateProcedure(
  candidate: DraftProcedure,
  cases: EvaluationCase[] = DEFAULT_EVALUATION_CASES,
): EvaluationResult {
  const results = cases.map((testCase) => {
    let ok = false;
    try {
      ok = testCase.check(candidate);
    } catch {
      ok = false;
    }
    return { name: testCase.name, ok };
  });
  const passedCount = results.filter((result) => result.ok).length;
  const score = results.length ? passedCount / results.length : 0;
  return {
    passed: passedCount === results.length,
    score,
    failures: results.filter((result) => !result.ok).map((result) => result.name),
    cases: results,
  };
}

/**
 * Promotion policy. Automatic promotion is limited to low-risk procedures that
 * passed every case; anything touching protected surfaces needs the owner.
 */
export const PROTECTED_TERMS =
  /\b(?:android\.permission\.|permissions?|keystore|api[ _-]?key|credential|authentication|login|payment|factory reset|root|shell|accessibilityservice|selinux)\b/i;

export function requiresOwnerApproval(candidate: DraftProcedure): boolean {
  if (candidate.risk !== "low") return true;
  const body = [candidate.purpose, ...candidate.steps, ...candidate.permissions].join(" ");
  return PROTECTED_TERMS.test(body);
}

export interface PromotionDecision {
  allowed: boolean;
  status: ProcedureStatus;
  reason: string;
}

export function decidePromotion(
  candidate: DraftProcedure,
  evaluation: EvaluationResult,
  options: { autoPromote: boolean; ownerApproved: boolean },
): PromotionDecision {
  if (!evaluation.passed) {
    return { allowed: false, status: "DRAFT", reason: `Evaluation failed: ${evaluation.failures.join(", ")}` };
  }
  if (requiresOwnerApproval(candidate)) {
    return options.ownerApproved
      ? { allowed: true, status: "APPROVED", reason: "Owner approved a procedure that touches a protected surface." }
      : { allowed: false, status: "VALIDATED", reason: "Touches a protected surface; owner approval required." };
  }
  if (!options.autoPromote) {
    return { allowed: false, status: "VALIDATED", reason: "Evaluation passed; waiting for owner promotion." };
  }
  return { allowed: true, status: "VALIDATED", reason: "Low-risk procedure passed every evaluation case." };
}

/** A procedure is only "tested" when a recorded verification succeeded. */
export function markTested(procedure: ProcedureRecord, testResult: { passed: boolean; detail: string }): ProcedureStatus {
  if (!testResult.passed) return "VALIDATED";
  if (!procedure.steps.trim() || !procedure.verification) return "VALIDATED";
  return "TESTED";
}

/** Previous known-good body for rollback (kept alongside the new draft). */
export function rollbackCandidate(current: ProcedureRecord): DraftProcedure | null {
  if (!current.steps) return null;
  return {
    name: current.name,
    purpose: current.purpose,
    prerequisites: safeList(current.prerequisites),
    permissions: safeList(current.permissions),
    steps: safeList(current.steps),
    expected: safeList(current.expected),
    failures: safeList(current.failures),
    verification: safeList(current.verification),
    risk: "low",
  };
}
