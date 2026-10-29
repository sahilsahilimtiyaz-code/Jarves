/**
 * JarvisAI — the facade the UI talks to.
 *
 * Composes: local memory (SQLite), retrieval, persona, the provider gateway and
 * the bounded tool loop. No React, no DOM: everything here is testable in Node
 * and reused by the mobile screens.
 */
import * as native from "../../platform/native";
import { detectPlatform } from "../../platform/detect";
import { AIGateway } from "./gateway";
import { runTurn, TOOL_DEFINITIONS, type Approver, type ToolTrace } from "./agent";
import {
  extractMemoryCandidates,
  retrieveContext,
  uid,
  type MemoryStore,
} from "./store";
import { buildSystemPrompt } from "./personality";
import {
  DEFAULT_BOUNDARIES,
  inQuietHours,
  selectGreeting,
  shouldEmit,
  statusGreeting,
  type Boundaries,
  type Greeting,
  type GreetingContext,
} from "./greeting";
import type { WireMessage } from "./protocols";
import type { RoleKey } from "./types";

export interface MindPrefs {
  /** Keep full transcripts in the local archive. */
  retention: boolean;
  /** Extract durable memories from utterances. */
  extraction: boolean;
  /** Offer background/manual consolidation. */
  consolidation: boolean;
  /** Speak greetings when audio is available. */
  spokenGreetings: boolean;
  /** Owner override; empty means "use the stored address memory". */
  address: string;
  /** Promote low-risk, evaluated procedures without a tap. */
  autoPromote: boolean;
  quietStart: number;
  quietEnd: number;
  boundaries: Boundaries;
  /** 0 disables the daily token cap. */
  dailyTokenBudget: number;
}

export const DEFAULT_MIND_PREFS: MindPrefs = {
  retention: true,
  extraction: true,
  consolidation: false,
  spokenGreetings: true,
  address: "",
  autoPromote: false,
  quietStart: 23,
  quietEnd: 7,
  boundaries: DEFAULT_BOUNDARIES,
  dailyTokenBudget: 0,
};

const PREFS_KEY = "ai.mind.v1";

export interface HandleOptions {
  conversationId: string;
  onDelta?: (text: string) => void;
  approve?: Approver;
  role?: RoleKey;
}

export interface HandleResult {
  text: string;
  providerLabel: string;
  toolTrace: ToolTrace[];
  kind: "model" | "memory" | "error";
}

export interface GreetingInput {
  launchId: string;
  providerConfigured: boolean;
  backendConfigured: boolean;
  backendStatus: GreetingContext["backendStatus"];
  micPermission: GreetingContext["micPermission"];
  ttsAvailable: boolean;
  hasResumableSession: boolean;
  dailyReviewReady?: boolean;
}

export class JarvisAI {
  constructor(
    readonly store: MemoryStore,
    readonly gateway: AIGateway,
  ) {}

  async prefs(): Promise<MindPrefs> {
    const stored = await this.store.getSetting<Partial<MindPrefs>>(PREFS_KEY, {});
    return { ...DEFAULT_MIND_PREFS, ...stored };
  }

  async setPrefs(patch: Partial<MindPrefs>): Promise<MindPrefs> {
    const next = { ...(await this.prefs()), ...patch };
    await this.store.setSetting(PREFS_KEY, next);
    return next;
  }

  async address(): Promise<string> {
    const prefs = await this.prefs();
    if (prefs.address.trim()) return prefs.address.trim();
    const stored = await this.store.listMemories("address");
    return (stored[0]?.content || "sir").trim() || "sir";
  }

  async lastSessionAt(): Promise<number | null> {
    const value = await this.store.getSetting<number | null>("ai.session.lastAt", null);
    return typeof value === "number" ? value : null;
  }

  async noteSession(): Promise<void> {
    await this.store.setSetting("ai.session.lastAt", Date.now());
  }

  /** One conversational turn, including memory writes and any tool calls. */
  async handle(text: string, options: HandleOptions): Promise<HandleResult> {
    const message = (text || "").trim();
    if (!message) throw new Error("Nothing to send.");
    const prefs = await this.prefs();
    await this.store.ensureConversation(options.conversationId, message.slice(0, 60));
    await this.store.addMessage({
      id: uid("msg"),
      conversation_id: options.conversationId,
      role: "user",
      text: message,
      ts: Date.now(),
      provider: null,
      model: null,
      tool_calls: null,
      status: "ok",
      attachments: null,
    });

    if (prefs.extraction) {
      for (const candidate of extractMemoryCandidates(message)) {
        if (candidate.forget) {
          const removed = await this.store.forget(candidate.forget);
          const reply = removed
            ? `Forgotten ${removed} item${removed === 1 ? "" : "s"} matching “${candidate.forget}”.`
            : `I had nothing stored matching “${candidate.forget}”, so nothing was deleted.`;
          await this.store.addMessage({
            id: uid("msg"),
            conversation_id: options.conversationId,
            role: "assistant",
            text: reply,
            ts: Date.now(),
            provider: "local",
            model: "memory",
            tool_calls: null,
            status: "ok",
            attachments: null,
          });
          return { text: reply, providerLabel: "local memory", toolTrace: [], kind: "memory" };
        }
        await this.store.putMemory({
          category: candidate.category,
          content: candidate.content,
          sourceRef: options.conversationId,
          confidence: candidate.confidence,
        });
      }
    }

    const address = await this.address();
    const context = await retrieveContext(this.store, message, {
      conversationId: options.conversationId,
      charBudget: 3200,
    });
    const recent = prefs.retention ? await this.store.recentMessages(options.conversationId, 10) : [];
    const history: WireMessage[] = recent
      .filter((row) => (row.role === "user" || row.role === "assistant") && row.text.trim())
      .slice(0, -1) // drop the just-persisted user message; runTurn adds it
      .slice(-8)
      .map((row) =>
        row.role === "user" ? { role: "user", text: row.text } : { role: "assistant", text: row.text },
      );

    const platform = detectPlatform();
    const system = buildSystemPrompt({
      address,
      memoryBlock: context.text,
      platform: platform === "android" ? "android" : platform === "electron" ? "desktop" : "web",
      tools: TOOL_DEFINITIONS.map((tool) => tool.name),
      now: new Date(),
      providerLabel: this.gateway.list().find((config) => config.enabled)?.model || null,
      backendAvailable: Boolean(await this.store.getSetting("backend.configured", false)),
    });

    const turn = await runTurn({
      gateway: this.gateway,
      store: this.store,
      conversationId: options.conversationId,
      system,
      history,
      userText: message,
      approve: options.approve,
      onDelta: options.onDelta,
      role: options.role,
    });

    await this.store.addMessage({
      id: uid("msg"),
      conversation_id: options.conversationId,
      role: "assistant",
      text: turn.text,
      ts: Date.now(),
      provider: turn.providerLabel.split(" · ")[0] || null,
      model: turn.providerLabel.split(" · ")[1] || null,
      tool_calls: turn.toolTrace.length ? JSON.stringify(turn.toolTrace) : null,
      status: turn.stopped ? "partial" : "ok",
      attachments: null,
    });
    await this.noteSession();
    return { text: turn.text, providerLabel: turn.providerLabel, toolTrace: turn.toolTrace, kind: "model" };
  }

  /**
   * Run the greeting service once per eligible event. Persists the emitted key
   * so a rerender, a resume, or a second screen mount cannot speak twice.
   */
  async greeting(input: GreetingInput): Promise<Greeting | null> {
    const prefs = await this.prefs();
    const ttsAvailable = input.ttsAvailable && (await native.nativeAvailable().catch(() => false));
    const lastKey = await this.store.getSetting<string | null>("ai.greeting.lastKey", null);
    const lastSessionAt = await this.lastSessionAt();
    const context: GreetingContext = {
      now: new Date(),
      launchId: input.launchId,
      firstInstall: !input.providerConfigured && !input.backendConfigured && lastSessionAt === null,
      providerConfigured: input.providerConfigured,
      backendConfigured: input.backendConfigured,
      backendStatus: input.backendStatus,
      micPermission: input.micPermission,
      ttsAvailable,
      spokenEnabled: prefs.spokenGreetings,
      hasResumableSession: input.hasResumableSession,
      lastSessionAt,
      dailyReviewReady: Boolean(input.dailyReviewReady),
      lastGreetingKey: lastKey,
      address: await this.address(),
      boundaries: prefs.boundaries,
      quietHours: { start: prefs.quietStart, end: prefs.quietEnd },
    };
    const greeting = selectGreeting(context);
    if (!shouldEmit(greeting, lastKey)) return null;
    await this.store.setSetting("ai.greeting.lastKey", greeting.key);
    await this.store.logEvent("greeting", `Greeting: ${greeting.scenario}`, greeting.text.slice(0, 300));
    return greeting;
  }

  /** Honest status copy for "JARVIS, status report". */
  async statusText(input: Omit<GreetingInput, "launchId" | "hasResumableSession">): Promise<string> {
    const prefs = await this.prefs();
    return statusGreeting({
      now: new Date(),
      launchId: "status",
      firstInstall: false,
      providerConfigured: input.providerConfigured,
      backendConfigured: input.backendConfigured,
      backendStatus: input.backendStatus,
      micPermission: input.micPermission,
      ttsAvailable: input.ttsAvailable,
      spokenEnabled: prefs.spokenGreetings,
      hasResumableSession: false,
      lastSessionAt: null,
      dailyReviewReady: false,
      lastGreetingKey: null,
      address: await this.address(),
      boundaries: prefs.boundaries,
      quietHours: { start: prefs.quietStart, end: prefs.quietEnd },
    });
  }

  /** Clear the persisted memory of the last greeting (used by "test greeting"). */
  async resetGreeting(): Promise<void> {
    await this.store.setSetting("ai.greeting.lastKey", null);
  }

  isQuietNow(boundaries: Boundaries = DEFAULT_BOUNDARIES): boolean {
    return inQuietHours(new Date(), { start: boundaries.lateNight, end: boundaries.morning });
  }
}
