/**
 * Bounded, provider-agnostic tool loop.
 *
 * The model proposes tool calls; this module validates them against a fixed
 * schema, applies the risk policy, executes through documented Android APIs,
 * and returns the *real* result. Unknown tools and invalid arguments never
 * execute. Every step is bounded and cancellable.
 */
import { getAdapter } from "../../platform";
import * as native from "../../platform/native";
import { executePhoneAction } from "../actions";
import type { PhoneAction } from "../actionPlan";
import type { AIGateway } from "./gateway";
import { draftProcedure, evaluateProcedure, reflect } from "./evolution";
import type { MemoryStore } from "./store";
import type { ToolSpec, WireMessage } from "./protocols";
import { AiError, type RoleKey } from "./types";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  risk: "safe" | "confirm";
}

const NO_ARGS = { type: "object", properties: {}, additionalProperties: false };

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "open_app",
    description: "Launch an installed Android app by name (e.g. YouTube). Reports whether it was actually launched.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "App name as the owner said it" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "open_settings",
    description: "Open an Android settings screen. Opens the screen only; it does not change the setting.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: ["wifi", "bluetooth", "display", "sound", "battery", "apps", "notifications", "data", "app"],
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
  },
  { name: "battery", description: "Read this phone's battery percentage, charging state and temperature.", risk: "safe", parameters: NO_ARGS },
  { name: "device_info", description: "Read real device model, Android version, RAM and load from Android APIs.", risk: "safe", parameters: NO_ARGS },
  { name: "clipboard_read", description: "Read the current clipboard text.", risk: "safe", parameters: NO_ARGS },
  {
    name: "clipboard_write",
    description: "Copy text to the clipboard.",
    risk: "confirm",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "notify",
    description: "Post a local notification.",
    risk: "confirm",
    parameters: {
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string" } },
      required: ["body"],
      additionalProperties: false,
    },
  },
  {
    name: "open_url",
    description: "Open an http(s) URL in the phone's browser.",
    risk: "confirm",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "share_text",
    description: "Open the Android share sheet with text.",
    risk: "confirm",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  { name: "time", description: "Read the phone's current local time.", risk: "safe", parameters: NO_ARGS },
];

export function toolSpecs(): ToolSpec[] {
  return TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export interface ToolOutcome {
  ok: boolean;
  message: string;
  data?: Record<string, unknown>;
}

const SETTINGS_TARGETS = new Set(["wifi", "bluetooth", "display", "sound", "battery", "apps", "notifications", "data", "app"]);

function readString(args: Record<string, unknown>, key: string): string {
  const value = args?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function asAction(name: string, args: Record<string, unknown>): PhoneAction | ToolOutcome {
  const fail = (message: string): ToolOutcome => ({ ok: false, message });
  switch (name) {
    case "open_app": {
      const query = readString(args, "query");
      if (!query) return fail("open_app needs a non-empty query.");
      return { kind: "open_app", source: "model", args: { query }, label: `Open ${query}`, requiresApproval: false };
    }
    case "open_settings": {
      const target = readString(args, "target");
      if (!SETTINGS_TARGETS.has(target)) return fail(`Unknown settings target “${target}”.`);
      return { kind: "open_settings", source: "model", args: { target }, label: `Open ${target} settings`, requiresApproval: false };
    }
    case "battery":
      return { kind: "battery", source: "model", args: {}, label: "Read battery", requiresApproval: false };
    case "device_info":
      return { kind: "device_info", source: "model", args: {}, label: "Read device info", requiresApproval: false };
    case "clipboard_read":
      return { kind: "clipboard_read", source: "model", args: {}, label: "Read clipboard", requiresApproval: false };
    case "clipboard_write": {
      const text = readString(args, "text");
      if (!text) return fail("clipboard_write needs text.");
      return { kind: "clipboard_write", source: "model", args: { text }, label: "Copy to clipboard", requiresApproval: false };
    }
    case "notify": {
      const body = readString(args, "body");
      if (!body) return fail("notify needs a body.");
      return {
        kind: "notify",
        source: "model",
        args: { title: readString(args, "title") || "J.A.R.V.I.S.", body },
        label: "Post a notification",
        requiresApproval: true,
      };
    }
    case "time":
      return { kind: "time", source: "model", args: {}, label: "Read the clock", requiresApproval: false };
    default:
      return fail(`Unknown tool “${name}”.`);
  }
}

/** Execute one validated tool call and report exactly what happened. */
export async function runTool(name: string, rawArgs: unknown): Promise<ToolOutcome> {
  const args = rawArgs && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {};
  const available = await native.nativeAvailable().catch(() => false);
  if (!available) return { ok: false, message: "This action needs the Android app build." };

  try {
    if (name === "open_url") {
      const url = readString(args, "url");
      if (!/^https?:\/\//i.test(url)) return { ok: false, message: "open_url only accepts http(s) URLs." };
      await getAdapter().openExternal(url);
      return { ok: true, message: `Opened ${url} in the browser.`, data: { url } };
    }
    if (name === "share_text") {
      const text = readString(args, "text");
      if (!text) return { ok: false, message: "share_text needs text." };
      const result = await native.shareText(text);
      return {
        ok: Boolean(result?.ok),
        message: result?.ok ? "The Android share sheet was opened." : result?.message || "The share sheet could not be opened.",
      };
    }
    if (name === "notify") {
      const action = asAction("notify", args) as PhoneAction;
      const outcome = await executePhoneAction(action, true);
      return { ok: outcome.ok, message: outcome.message };
    }

    const planned = asAction(name, args);
    if ("ok" in planned && "message" in planned && !("kind" in planned)) return planned as ToolOutcome;
    const outcome = await executePhoneAction(planned as PhoneAction, true);
    return { ok: outcome.ok, message: outcome.message, data: outcome.data };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "The tool failed on this device." };
  }
}

export interface ApprovalRequest {
  tool: string;
  args: Record<string, unknown>;
  label: string;
}

export type Approver = (request: ApprovalRequest) => Promise<boolean>;

export interface ToolTrace {
  name: string;
  ok: boolean;
  message: string;
}

export interface TurnRequest {
  gateway: AIGateway;
  store: MemoryStore;
  conversationId: string;
  system: string;
  history: WireMessage[];
  userText: string;
  images?: string[];
  approve?: Approver;
  onDelta?: (text: string) => void;
  maxSteps?: number;
  role?: RoleKey;
}

export interface TurnResult {
  text: string;
  providerLabel: string;
  toolTrace: ToolTrace[];
  usage: { input: number; output: number };
  steps: number;
  stopped?: string;
}

/**
 * Run one assistant turn, including any tool calls, within a hard step budget.
 * Tool results are the only claim of execution the final answer can rely on.
 */
export async function runTurn(req: TurnRequest): Promise<TurnResult> {
  const maxSteps = Math.max(1, req.maxSteps ?? 5);
  const wire: WireMessage[] = [
    ...req.history,
    { role: "user", text: req.userText, images: req.images?.length ? req.images : undefined },
  ];
  const trace: ToolTrace[] = [];
  const usage = { input: 0, output: 0 };
  let providerLabel = "";
  let toolsDisabled = false;
  let steps = 0;
  let lastText = "";

  while (steps < maxSteps) {
    steps += 1;
    let outcome;
    try {
      outcome = await req.gateway.chat({
        messages: wire,
        tools: toolsDisabled ? undefined : toolSpecs(),
        system: req.system,
        onDelta: req.onDelta,
        role: req.role,
        allowFallback: true,
      });
    } catch (e) {
      if (e instanceof AiError && e.code === "model" && !toolsDisabled) {
        // The selected model cannot call tools. Answer without acting and say so.
        toolsDisabled = true;
        steps -= 1;
        continue;
      }
      throw e;
    }
    providerLabel = outcome.providerLabel;
    usage.input += outcome.result.usage.input;
    usage.output += outcome.result.usage.output;
    lastText = outcome.result.text;

    const calls = outcome.result.toolCalls;
    if (!calls.length) {
      await recordIfUseful();
      return { text: lastText, providerLabel, toolTrace: trace, usage, steps };
    }

    wire.push({ role: "assistant", text: outcome.result.text || undefined, toolCalls: calls });
    const results: { id: string; name: string; content: string }[] = [];
    for (const call of calls) {
      const definition = TOOL_DEFINITIONS.find((tool) => tool.name === call.name);
      if (!definition) {
        trace.push({ name: call.name, ok: false, message: "Unknown tool; nothing executed." });
        results.push({ id: call.id, name: call.name, content: JSON.stringify({ ok: false, message: "Unknown tool" }) });
        continue;
      }
      let approved = true;
      if (definition.risk === "confirm") {
        approved = req.approve ? await req.approve({ tool: call.name, args: call.args, label: definition.description }) : false;
      }
      if (!approved) {
        trace.push({ name: call.name, ok: false, message: "Not executed: owner approval was required." });
        results.push({
          id: call.id,
          name: call.name,
          content: JSON.stringify({ ok: false, message: "Owner approval was required and not granted." }),
        });
        continue;
      }
      const result = await runTool(call.name, call.args);
      trace.push({ name: call.name, ok: result.ok, message: result.message });
      results.push({
        id: call.id,
        name: call.name,
        content: JSON.stringify({ ok: result.ok, message: result.message, data: result.data ?? null }),
      });
    }
    wire.push({ role: "tool", results });
  }

  await recordIfUseful();
  return {
    text:
      lastText ||
      "I reached the tool-step limit before finishing. Nothing further was executed; tell me whether to continue.",
    providerLabel,
    toolTrace: trace,
    usage,
    steps,
    stopped: "step_limit",
  };

  async function recordIfUseful(): Promise<void> {
    if (!trace.length) return;
    const failures = trace.filter((entry) => !entry.ok);
    const successes = trace.filter((entry) => entry.ok);
    const outcome = failures.length === 0 ? "success" : successes.length > 0 ? "partial" : "failed";
    const episode = await req.store.addEpisode({
      goal: req.userText.slice(0, 200),
      context: JSON.stringify({ conversation: req.conversationId, steps }),
      actions: JSON.stringify(trace.map((entry) => `${entry.name}: ${entry.message.slice(0, 120)}`)),
      tools: JSON.stringify(trace.map((entry) => entry.name)),
      result: successes.length ? successes.map((entry) => entry.message).join(" ").slice(0, 500) : null,
      error: failures.length ? failures.map((entry) => entry.message).join(" ").slice(0, 500) : null,
      feedback: null,
      outcome,
      lesson: null,
    });
    // One reflection per episode: the lesson is attached to the recorded row so
    // retrieval can surface it without a second, duplicated "reflection" task.
    const reflection = reflect(episode);
    await req.store.addEpisode({
      goal: `${episode.goal} · reflection`,
      context: episode.context,
      actions: episode.actions,
      tools: episode.tools,
      result: reflection.observed.slice(0, 500),
      error: reflection.hypothesis ? (reflection.rootCause || "unverified hypothesis").slice(0, 500) : null,
      feedback: null,
      outcome: reflection.hypothesis ? "unverified" : "verified",
      lesson: `${reflection.lesson} Evidence: ${reflection.evidence.slice(0, 200)}`,
    });

    if (outcome === "success") {
      const draft = draftProcedure(episode);
      if (draft) {
        const evaluation = evaluateProcedure(draft);
        const existing = await req.store.procedureByName(draft.name);
        if (!existing && evaluation.passed) {
          await req.store.saveProcedure({
            name: draft.name,
            purpose: draft.purpose,
            prerequisites: JSON.stringify(draft.prerequisites),
            permissions: JSON.stringify(draft.permissions),
            steps: JSON.stringify(draft.steps),
            expected: JSON.stringify(draft.expected),
            failures: JSON.stringify(draft.failures),
            verification: JSON.stringify(draft.verification),
            status: "DRAFT",
            version: 1,
            test_result: JSON.stringify({ passed: evaluation.passed, score: evaluation.score }),
          });
        }
      }
    }
  }
}
