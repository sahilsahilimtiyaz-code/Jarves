import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

// Executes the real TypeScript modules (provider adapters, memory SQL, routing,
// evolution, greetings) with SQLite from node:sqlite. No mocks of the code under
// test: only the storage port is swapped for an in-process SQLite database.
const moduleUrls = new Map();

// Resolve the module graph first: a data: URL cannot resolve "./catalog", so
// each dependency is transpiled, encoded, and substituted into its importer.
async function moduleUrl(url) {
  if (moduleUrls.has(url.href)) return moduleUrls.get(url.href);
  const source = readFileSync(url, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  });
  let code = outputText;
  const specs = [...new Set([...code.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)].map((m) => m[1]))];
  for (const spec of specs) {
    const target = new URL(spec.endsWith(".ts") ? spec : `${spec}.ts`, url);
    const dep = await moduleUrl(target);
    code = code.split(`"${spec}"`).join(JSON.stringify(dep)).split(`'${spec}'`).join(JSON.stringify(dep));
  }
  const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  moduleUrls.set(url.href, dataUrl);
  return dataUrl;
}

async function loadTS(relpath) {
  return import(await moduleUrl(new URL(relpath, import.meta.url)));
}

const catalog = await loadTS("../src/lib/ai/catalog.ts");
const protocols = await loadTS("../src/lib/ai/protocols.ts");
const router = await loadTS("../src/lib/ai/router.ts");
const storeModule = await loadTS("../src/lib/ai/store.ts");
const evolution = await loadTS("../src/lib/ai/evolution.ts");
const greetingModule = await loadTS("../src/lib/ai/greeting.ts");
const personality = await loadTS("../src/lib/ai/personality.ts");
const types = await loadTS("../src/lib/ai/types.ts");

function makeDb() {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    async query(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    async exec(sql, params = []) {
      if (params && params.length) db.prepare(sql).run(...params);
      else db.exec(sql);
    },
  };
}

async function makeStore() {
  const port = makeDb();
  const store = new storeModule.MemoryStore(port);
  await store.migrate();
  return { store, port };
}

// ── Catalogue ──────────────────────────────────────────────────────────────

test("catalogue: 20 real providers, unique ids, HTTPS endpoints", () => {
  assert.equal(catalog.PROVIDERS.length, 20);
  const ids = new Set(catalog.PROVIDERS.map((p) => p.id));
  assert.equal(ids.size, 20);
  for (const provider of catalog.PROVIDERS) {
    assert.match(provider.baseUrl, /^https:\/\//, provider.id);
    assert.ok(provider.docs.startsWith("http"), provider.id);
    assert.ok(provider.capabilities && typeof provider.capabilities.tools === "boolean");
  }
  assert.equal(catalog.providerById("openrouter").protocol, "openai");
  assert.equal(catalog.providerById("anthropic").protocol, "anthropic");
  assert.equal(catalog.providerById("gemini").protocol, "gemini");
  assert.equal(catalog.providerById("cohere").protocol, "cohere");
  assert.equal(catalog.providerById("nope"), undefined);
});

test("catalogue: endpoint policy rejects remote cleartext, allows HTTPS + LAN with opt-in", () => {
  assert.equal(catalog.isEndpointAllowed("https://api.openai.com/v1"), true);
  assert.equal(catalog.isEndpointAllowed("http://api.openai.com/v1"), false);
  assert.equal(catalog.isEndpointAllowed("http://192.168.1.5:8080/v1", false), false);
  assert.equal(catalog.isEndpointAllowed("http://192.168.1.5:8080/v1", true), true);
  assert.equal(catalog.isEndpointAllowed("http://localhost:1234/v1", true), true);
  assert.equal(catalog.isEndpointAllowed("ftp://host/x"), false);
  assert.equal(catalog.isEndpointAllowed("not a url"), false);
});

test("catalogue: base URL normalisation keeps sub-paths", () => {
  assert.equal(catalog.normalizeBaseUrl("api.example.com/v1/"), "https://api.example.com/v1");
  assert.equal(catalog.normalizeBaseUrl("https://API.example.com:443/v1"), "https://api.example.com/v1");
  assert.equal(catalog.normalizeBaseUrl(""), "");
  assert.equal(catalog.joinUrl("https://x/v1/", "/models"), "https://x/v1/models");
});

// ── Protocol adapters ──────────────────────────────────────────────────────

test("openai: request shape, tools, and tool-result round trip", () => {
  const def = catalog.providerById("openai");
  const built = protocols.buildChatRequest(def, def.baseUrl, "sk-test", {
    model: "gpt-4o-mini",
    system: "be brief",
    messages: [
      { role: "system", text: "be brief" },
      { role: "user", text: "open YouTube" },
      { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "open_app", args: { query: "YouTube" } }] },
      { role: "tool", results: [{ id: "c1", name: "open_app", content: '{"ok":true}' }] },
    ],
    tools: [{ name: "open_app", description: "open", parameters: { type: "object", properties: {} } }],
  });
  assert.equal(built.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(built.headers.Authorization, "Bearer sk-test");
  const body = JSON.parse(built.body);
  assert.equal(body.model, "gpt-4o-mini");
  assert.equal(body.messages[1].content, "open YouTube");
  assert.equal(body.messages[2].tool_calls[0].function.name, "open_app");
  assert.equal(body.messages[3].role, "tool");
  assert.equal(body.messages[3].tool_call_id, "c1");
  assert.equal(body.tools[0].function.name, "open_app");
});

test("openai: parses text, tool calls and usage", () => {
  const def = catalog.providerById("openai");
  const parsed = protocols.parseChatResponse(def, {
    model: "gpt-4o-mini",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: "Opening it.",
          tool_calls: [{ id: "call_9", function: { name: "open_app", arguments: '{"query":"YouTube"}' } }],
        },
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 5 },
  });
  assert.equal(parsed.text, "Opening it.");
  assert.equal(parsed.toolCalls[0].name, "open_app");
  assert.deepEqual(parsed.toolCalls[0].args, { query: "YouTube" });
  assert.deepEqual(parsed.usage, { input: 12, output: 5 });
});

test("openai: malformed tool arguments never throw and become empty", () => {
  const def = catalog.providerById("openai");
  const parsed = protocols.parseChatResponse(def, {
    choices: [{ message: { tool_calls: [{ id: "x", function: { name: "open_app", arguments: "{not json" } }] } }],
  });
  assert.deepEqual(parsed.toolCalls[0].args, {});
});

test("anthropic: system is out-of-band and tools use input_schema", () => {
  const def = catalog.providerById("anthropic");
  const built = protocols.buildChatRequest(def, def.baseUrl, "sk-ant-x", {
    model: "claude-3-5-sonnet-latest",
    system: "be brief",
    messages: [
      { role: "system", text: "be brief" },
      { role: "user", text: "hi" },
    ],
    tools: [{ name: "battery", description: "battery", parameters: { type: "object", properties: {} } }],
  });
  assert.equal(built.url, "https://api.anthropic.com/v1/messages");
  assert.equal(built.headers["x-api-key"], "sk-ant-x");
  assert.equal(built.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(built.body);
  assert.equal(body.system, "be brief");
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.messages.length, 1);
  assert.equal(body.tools[0].input_schema.type, "object");
});

test("anthropic: parses text blocks and tool_use blocks", () => {
  const def = catalog.providerById("anthropic");
  const parsed = protocols.parseChatResponse(def, {
    model: "claude",
    stop_reason: "tool_use",
    content: [
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "toolu_1", name: "battery", input: {} },
    ],
    usage: { input_tokens: 9, output_tokens: 3 },
  });
  assert.equal(parsed.text, "Checking.");
  assert.equal(parsed.toolCalls[0].id, "toolu_1");
  assert.deepEqual(parsed.usage, { input: 9, output: 3 });
});

test("gemini: generateContent URL, function declarations and parsing", () => {
  const def = catalog.providerById("gemini");
  const built = protocols.buildChatRequest(def, def.baseUrl, "AIza-test", {
    model: "gemini-2.0-flash",
    system: "brief",
    messages: [{ role: "user", text: "battery" }],
    tools: [{ name: "battery", description: "read", parameters: { type: "object", properties: {} } }],
  });
  assert.match(built.url, /\/models\/gemini-2\.0-flash:generateContent$/);
  assert.equal(built.headers["x-goog-api-key"], "AIza-test");
  const body = JSON.parse(built.body);
  assert.equal(body.systemInstruction.parts[0].text, "brief");
  assert.equal(body.tools[0].functionDeclarations[0].name, "battery");

  const parsed = protocols.parseChatResponse(def, {
    candidates: [
      {
        content: {
          parts: [{ text: "It is 80%." }, { functionCall: { name: "battery", args: {} } }],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6 },
  });
  assert.equal(parsed.text, "It is 80%.");
  assert.equal(parsed.toolCalls[0].name, "battery");
  assert.deepEqual(parsed.usage, { input: 4, output: 6 });
});

test("cohere: parsing is non-streaming and normalises billed units", () => {
  const def = catalog.providerById("cohere");
  const parsed = protocols.parseChatResponse(def, {
    message: {
      content: [{ type: "text", text: "Hello." }],
      tool_calls: [{ id: "t1", function: { name: "time", arguments: "{}" } }],
    },
    finish_reason: "TOOL_CALL",
    usage: { tokens: { input_tokens: 2, output_tokens: 3 } },
  });
  assert.equal(parsed.text, "Hello.");
  assert.equal(parsed.toolCalls[0].name, "time");
  assert.deepEqual(parsed.usage, { input: 2, output: 3 });
});

test("model discovery handles OpenAI, Gemini and Cohere shapes", () => {
  assert.deepEqual(protocols.parseModels(catalog.providerById("openai"), { data: [{ id: "gpt-4o-mini" }] }), [
    { id: "gpt-4o-mini", label: "gpt-4o-mini" },
  ]);
  assert.deepEqual(protocols.parseModels(catalog.providerById("gemini"), { models: [{ name: "models/gemini-2.0-flash" }] }), [
    { id: "gemini-2.0-flash", label: "gemini-2.0-flash" },
  ]);
  assert.deepEqual(protocols.parseModels(catalog.providerById("cohere"), { models: [{ name: "command-r" }] }), [
    { id: "command-r", label: "command-r" },
  ]);
});

test("HTTP errors are mapped without leaking the key", () => {
  const message = protocols.describeHttpError(401, JSON.stringify({ error: { message: "Invalid API key" } }));
  assert.match(message, /rejected the API key \(401\)/);
  assert.match(message, /Invalid API key/);
  assert.doesNotMatch(message, /sk-/);
  assert.match(protocols.describeHttpError(429, ""), /Rate limit/);
});

test("streaming: OpenAI deltas accumulate text and fragmented tool arguments", () => {
  const accumulator = protocols.createStreamAccumulator(catalog.providerById("openai"), "gpt-4o-mini");
  let visible = "";
  for (const payload of [
    { choices: [{ delta: { content: "Open" } }] },
    { choices: [{ delta: { content: "ing." } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "open_app", arguments: '{"query":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"YouTube"}' } }] }, finish_reason: "tool_calls" }] },
  ]) {
    const step = accumulator.push(JSON.stringify(payload));
    if (step.text) visible += step.text;
  }
  const result = accumulator.result();
  assert.equal(visible, "Opening.");
  assert.equal(result.text, "Opening.");
  assert.equal(result.toolCalls[0].name, "open_app");
  assert.deepEqual(result.toolCalls[0].args, { query: "YouTube" });
});

test("streaming: Anthropic text deltas and errors", () => {
  const accumulator = protocols.createStreamAccumulator(catalog.providerById("anthropic"), "claude");
  const first = accumulator.push(JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } }));
  assert.equal(first.text, "Hello");
  const error = accumulator.push(JSON.stringify({ error: { message: "overloaded" } }));
  assert.equal(error.error, "overloaded");
});

// ── Routing ────────────────────────────────────────────────────────────────

function config(overrides = {}) {
  return {
    id: "cfg1",
    provider: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    roles: ["default"],
    stream: false,
    allowFallback: false,
    allowInsecure: false,
    enabled: true,
    ...overrides,
  };
}

test("router: role selection and explicit-only fallback", () => {
  const primary = config({ id: "a" });
  const fallback = config({ id: "b", roles: ["fallback"], allowFallback: true, provider: "groq" });
  const disabled = config({ id: "c", enabled: false });

  assert.deepEqual(router.selectChain([primary, fallback, disabled], "default").map((c) => c.id), ["a"]);
  // A fallback is never used unless the caller opts in.
  assert.deepEqual(router.selectChain([primary, fallback], "default", true).map((c) => c.id), ["a", "b"]);
  // And a config without allowFallback is never a fallback.
  const notAuthorised = config({ id: "d", roles: ["fallback"], allowFallback: false });
  assert.deepEqual(router.selectChain([primary, notAuthorised], "default", true).map((c) => c.id), ["a"]);
  assert.deepEqual(router.selectChain([primary], "vision"), []);
  assert.equal(router.defaultConfig([disabled, primary]).id, "a");
});

// ── Memory layers ──────────────────────────────────────────────────────────

test("memory: schema migrates and a preference survives a new store instance", async () => {
  const { store } = await makeStore();
  await store.putMemory({ category: "style", content: "Prefers concise answers", confidence: 0.9 });
  const refreshed = new storeModule.MemoryStore(makeDb());
  await refreshed.migrate();
  // Different database file → separate memory (proves nothing is process-global).
  assert.equal((await refreshed.listMemories()).length, 0);
  assert.equal((await store.listMemories("style"))[0].content, "Prefers concise answers");
});

test("memory: duplicate facts are confirmed, not duplicated", async () => {
  const { store } = await makeStore();
  await store.putMemory({ category: "preference", content: "Uses a FastAPI backend" });
  await store.putMemory({ category: "preference", content: "Uses a FastAPI backend" });
  const rows = await store.listMemories();
  assert.equal(rows.length, 1);
  assert.ok(rows[0].confidence >= 0.7);
});

test("memory: a new form of address supersedes the old one", async () => {
  const { store } = await makeStore();
  await store.putMemory({ category: "address", content: "sir" });
  await store.putMemory({ category: "address", content: "Mr. Rao" });
  const rows = await store.listMemories("address");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, "Mr. Rao");
});

test("memory: secrets are never stored, and delete removes the row", async () => {
  const { store } = await makeStore();
  const stored = await store.putMemory({ category: "preference", content: "My API key is sk-abcdefghijklmnop1234567890" });
  assert.equal(stored, null);
  const fact = await store.putMemory({ category: "general", content: "Prefers dark mode" });
  await store.deleteMemory(fact.id);
  assert.equal((await store.listMemories()).length, 0);
});

test("memory: forget finds by fragment and hard-deletes it", async () => {
  const { store } = await makeStore();
  await store.putMemory({ category: "preference", content: "Prefers verbose answers" });
  await store.putMemory({ category: "project", content: "Project: JARVIS Android" });
  assert.equal(await store.forget("verbose"), 1);
  const rows = await store.listMemories();
  assert.equal(rows.length, 1);
  assert.match(rows[0].content, /JARVIS/);
});

test("retrieval: relevant preferences rank first and superseded rows are excluded", async () => {
  const { store } = await makeStore();
  await store.putMemory({ category: "style", content: "Prefers concise answers" });
  await store.putMemory({ category: "project", content: "Project: a photo gallery" });
  await store.putMemory({ category: "address", content: "sir" });
  await store.putMemory({ category: "address", content: "Vikram" });

  const context = await storeModule.retrieveContext(store, "keep the concise answers coming");
  assert.ok(context.profile.length > 0);
  assert.equal(context.profile[0].content, "Prefers concise answers");
  assert.match(context.text, /Owner profile/);
  assert.doesNotMatch(context.text, /sir/);
});

test("archive: messages persist, search and delete with the conversation", async () => {
  const { store } = await makeStore();
  await store.ensureConversation("conv1", "First");
  await store.addMessage({
    id: "m1",
    conversation_id: "conv1",
    role: "user",
    text: "Please remind me about the microphone test",
    ts: Date.now(),
    provider: null,
    model: null,
    tool_calls: null,
    status: "ok",
    attachments: null,
  });
  assert.equal((await store.searchMessages("microphone")).length, 1);
  const exact = await storeModule.retrieveContext(store, "what did I say previously about the microphone test");
  assert.match(exact.text, /Exact earlier messages/);
  await store.deleteConversation("conv1");
  assert.equal((await store.messages?.length) ?? 0, 0);
  assert.equal((await store.conversations()).length, 0);
});

test("usage accounting sums per day and export contains no credentials", async () => {
  const { store } = await makeStore();
  await store.recordUsage("openai", "gpt-4o-mini", "default", 10, 5);
  await store.recordUsage("groq", "llama", "fast", 3, 2);
  const usage = await store.usageSince(0);
  assert.equal(usage.input, 13);
  assert.equal(usage.output, 7);
  assert.equal(usage.calls, 2);
  const exported = JSON.parse(await store.exportAll());
  assert.ok(Array.isArray(exported.memories));
  assert.doesNotMatch(await store.exportAll(), /sk-[A-Za-z0-9]{16,}/);
});

// ── Extraction ─────────────────────────────────────────────────────────────

test("extraction: explicit memories, address, corrections, reminders and forget", () => {
  const preference = storeModule.extractMemoryCandidates("Remember that I prefer concise answers");
  assert.equal(preference[0].category, "style");
  assert.equal(preference[0].explicit, true);

  const address = storeModule.extractMemoryCandidates("Call me Vikram");
  assert.equal(address[0].category, "address");
  assert.equal(address[0].content, "Vikram");

  const project = storeModule.extractMemoryCandidates("My project uses a FastAPI backend");
  assert.equal(project[0].category, "project");

  const reminder = storeModule.extractMemoryCandidates("Remind me to test the microphone tomorrow");
  assert.equal(reminder[0].category, "reminder");

  const forget = storeModule.extractMemoryCandidates("Forget that I prefer verbose answers");
  assert.equal(forget[0].forget, "I prefer verbose answers");

  assert.deepEqual(storeModule.extractMemoryCandidates("What is the weather?"), []);
});

test("extraction: credentials and editorial questions are not memories", () => {
  assert.deepEqual(storeModule.extractMemoryCandidates("Remember that my key is sk-abcdefghijklmnop1234"), []);
  assert.equal(storeModule.isSecretLike("password: hunter2hunter2"), true);
  assert.equal(storeModule.isSecretLike("I like tea"), false);
});

// ── Evolution ──────────────────────────────────────────────────────────────

function episode(overrides = {}) {
  return {
    id: "ep1",
    goal: "Open YouTube",
    context: null,
    actions: '["open_app: Opened YouTube on this phone."]',
    tools: '["open_app"]',
    result: "Opened YouTube on this phone.",
    error: null,
    feedback: null,
    outcome: "success",
    lesson: null,
    created_at: Date.now(),
    ...overrides,
  };
}

test("evolution: verified success drafts a procedure, failure does not", () => {
  const draft = evolution.draftProcedure(episode());
  assert.ok(draft);
  assert.equal(draft.risk, "low");
  assert.ok(draft.steps.length > 0);
  assert.equal(evolution.draftProcedure(episode({ outcome: "failed", result: null })), null);
  assert.equal(evolution.draftProcedure(episode({ outcome: "success", result: "" })), null);
});

test("evolution: reflection distinguishes observations from hypotheses", () => {
  const success = evolution.reflect(episode());
  assert.equal(success.hypothesis, false);
  assert.match(success.observed, /Verified result/);
  const failure = evolution.reflect(episode({ outcome: "failed", result: null, error: "No matching app" }));
  assert.equal(failure.hypothesis, true);
  assert.match(failure.lesson, /No matching app/);
});

test("evolution: evaluation rejects incomplete procedures", () => {
  const draft = evolution.draftProcedure(episode());
  const complete = evolution.evaluateProcedure(draft);
  assert.equal(complete.passed, true);

  const incomplete = evolution.evaluateProcedure({
    ...draft,
    purpose: "x",
    verification: [],
    failures: [],
  });
  assert.equal(incomplete.passed, false);
  assert.ok(incomplete.failures.includes("defines verification"));
});

test("evolution: protected surfaces need explicit owner approval", () => {
  const risky = {
    name: "grant-permissions",
    purpose: "Change Android permissions for the app",
    prerequisites: ["adb"],
    permissions: ["android.permission.WRITE_SECURE_SETTINGS"],
    steps: ["Grant permission"],
    expected: ["granted"],
    failures: ["denied"],
    verification: ["check"],
    risk: "low",
  };
  assert.equal(evolution.requiresOwnerApproval(risky), true);
  const safe = evolution.draftProcedure(episode());
  assert.equal(evolution.requiresOwnerApproval(safe), false);
  const decision = evolution.decidePromotion(risky, evolution.evaluateProcedure(risky), { autoPromote: true, ownerApproved: false });
  assert.equal(decision.allowed, false);
  assert.equal(decision.status, "VALIDATED");
});

test("evolution: rollback reconstructs the previous body", () => {
  const draft = evolution.draftProcedure(episode());
  const candidate = evolution.rollbackCandidate({
    ...draft,
    id: "p1",
    name: "task:open-youtube",
    status: "TESTED",
    version: 3,
    parent_version: 2,
    created_at: Date.now(),
    updated_at: Date.now(),
    test_result: null,
    prerequisites: JSON.stringify(draft.prerequisites),
    permissions: JSON.stringify(draft.permissions),
    steps: JSON.stringify(draft.steps),
    expected: JSON.stringify(draft.expected),
    failures: JSON.stringify(draft.failures),
    verification: JSON.stringify(draft.verification),
    purpose: draft.purpose,
  });
  assert.equal(candidate.name, "task:open-youtube");
  assert.ok(candidate.steps.length > 0);
});

// ── Greetings ──────────────────────────────────────────────────────────────

function greetingContext(overrides = {}) {
  return {
    now: new Date(2026, 9, 29, 7, 30),
    launchId: "launch-1",
    firstInstall: false,
    providerConfigured: true,
    backendConfigured: false,
    backendStatus: "unconfigured",
    micPermission: "granted",
    ttsAvailable: true,
    spokenEnabled: true,
    hasResumableSession: false,
    lastSessionAt: Date.now() - 1000,
    dailyReviewReady: false,
    lastGreetingKey: null,
    address: "sir",
    ...overrides,
  };
}

test("greetings: all four periods use the real clock", () => {
  assert.equal(greetingModule.periodFor(new Date(2026, 9, 29, 6, 0)), "morning");
  assert.equal(greetingModule.periodFor(new Date(2026, 9, 29, 13, 0)), "afternoon");
  assert.equal(greetingModule.periodFor(new Date(2026, 9, 29, 19, 0)), "evening");
  assert.equal(greetingModule.periodFor(new Date(2026, 9, 29, 2, 0)), "lateNight");

  assert.match(greetingModule.selectGreeting(greetingContext()).text, /^Good morning, sir\./);
  assert.match(greetingModule.selectGreeting(greetingContext({ now: new Date(2026, 9, 29, 14, 0) })).text, /^Good afternoon/);
  assert.match(greetingModule.selectGreeting(greetingContext({ now: new Date(2026, 9, 29, 20, 0) })).text, /^Good evening/);
  assert.match(greetingModule.selectGreeting(greetingContext({ now: new Date(2026, 9, 29, 2, 0) })).text, /^You're up late/);
});

test("greetings: first run, returning session, refusal and outage are honest", () => {
  const firstRun = greetingModule.selectGreeting(greetingContext({ firstInstall: true, providerConfigured: false }));
  assert.equal(firstRun.scenario, "first_run");
  assert.match(firstRun.text, /Tell me how you'd like me to address you/);

  const returningContext = greetingContext({ hasResumableSession: true });
  returningContext.lastSessionAt = returningContext.now.getTime() - 7 * 60 * 60 * 1000;
  const returning = greetingModule.selectGreeting(returningContext);
  assert.equal(returning.scenario, "returning");
  assert.equal(returning.action, "resume");

  const mic = greetingModule.selectGreeting(greetingContext({ micPermission: "denied" }));
  assert.equal(mic.scenario, "mic_denied");

  const offline = greetingModule.selectGreeting(
    greetingContext({ providerConfigured: false, backendConfigured: true, backendStatus: "offline" }),
  );
  assert.equal(offline.scenario, "backend_offline");
  assert.match(offline.text, /Local phone actions and saved memory still work/);
});

test("greetings: quiet hours suppress speech; dedupe key prevents repeat", () => {
  const quiet = greetingModule.selectGreeting(
    greetingContext({ now: new Date(2026, 9, 29, 1, 0), quietHours: { start: 23, end: 7 } }),
  );
  assert.equal(quiet.quiet, true);
  assert.equal(quiet.speak, false);

  const greeting = greetingModule.selectGreeting(greetingContext());
  assert.equal(greetingModule.shouldEmit(greeting, null), true);
  assert.equal(greetingModule.shouldEmit(greeting, greeting.key), false);
});

test("greetings: custom address is used and TTS absence never claims speech", () => {
  const greeting = greetingModule.selectGreeting(greetingContext({ address: "Vikram", ttsAvailable: false }));
  assert.match(greeting.text, /Vikram/);
  assert.equal(greeting.speak, false);
});

// ── Persona ────────────────────────────────────────────────────────────────

test("persona: address, memory provenance and execution honesty are enforced", () => {
  const prompt = personality.buildSystemPrompt({
    address: "Vikram",
    memoryBlock: "- [style] Prefers concise answers",
    platform: "android",
    tools: ["open_app", "battery"],
    now: new Date(2026, 9, 29, 9, 0),
    providerLabel: "gemini-2.0-flash",
    backendAvailable: false,
  });
  assert.match(prompt, /Address the owner as "Vikram"/);
  assert.match(prompt, /Prefers concise answers/);
  assert.match(prompt, /Only report an action as done when a tool result/);
  assert.match(prompt, /No JARVIS backend is required/);
  assert.match(prompt, /open_app, battery/);
});

test("errors: status codes map to actionable codes", () => {
  assert.equal(types.errorCodeForStatus(401), "auth");
  assert.equal(types.errorCodeForStatus(429), "quota");
  assert.equal(types.errorCodeForStatus(404), "model");
  assert.equal(types.errorCodeForStatus(500), "provider");
});
