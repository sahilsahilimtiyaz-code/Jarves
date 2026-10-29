import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

// Exercises the REAL provider gateway over REAL SQLite (node:sqlite). Only the
// network transport is absent: these tests never claim a model was contacted.
const moduleUrls = new Map();

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

const storeModule = await loadTS("../src/lib/ai/store.ts");
const gatewayModule = await loadTS("../src/lib/ai/gateway.ts");
const nativeModule = await loadTS("../src/platform/native.ts");

/** One on-disk database; every "restart" reuses the same port. */
function makePort() {
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

async function freshGateway(port) {
  const store = new storeModule.MemoryStore(port);
  await store.migrate();
  return { store, gateway: new gatewayModule.AIGateway(store) };
}

test("a saved provider survives a simulated app restart", async () => {
  const port = makePort();
  const first = await freshGateway(port);
  const saved = await first.gateway.upsert({
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
    apiKey: "sk-or-v1-abcdefghijklmnopqrstuvwxyz",
    roles: ["default"],
  });
  assert.equal(saved.provider, "openrouter");
  assert.equal(saved.model, "openai/gpt-4o-mini");
  assert.equal(saved.enabled, true);

  // Process death: brand-new store + gateway over the same database.
  const restarted = await freshGateway(port);
  const list = await restarted.gateway.load(true);
  assert.equal(list.length, 1, "the provider must still be configured after a restart");
  assert.equal(list[0].model, "openai/gpt-4o-mini");
  assert.equal(list[0].id, saved.id);
  assert.equal(await restarted.gateway.hasKey(saved.id), true, "the stored key must still be readable");
});

test("the API key is never written into the settings database", async () => {
  const port = makePort();
  const { store, gateway } = await freshGateway(port);
  const key = "sk-or-v1-SECRETSECRETSECRET1234";
  await gateway.upsert({ provider: "openrouter", model: "openai/gpt-4o-mini", apiKey: key });
  const rows = await store.getSetting("ai.providers.v1", []);
  const serialized = JSON.stringify(rows);
  assert.equal(serialized.includes("SECRETSECRET"), false, "config JSON must not contain the key");
});

test("an empty model is rejected instead of saving a broken provider", async () => {
  const { gateway } = await freshGateway(makePort());
  await assert.rejects(
    () => gateway.upsert({ provider: "openrouter", model: "   ", apiKey: "sk-or-v1-abcdefghijklmnop" }),
    (error) => /model/i.test(error.message),
  );
  assert.equal((await gateway.load(true)).length, 0);
});

test("cleartext HTTP endpoints are refused unless explicitly allowed", async () => {
  const { gateway } = await freshGateway(makePort());
  await assert.rejects(
    () =>
      gateway.upsert({
        provider: "custom",
        baseUrl: "http://example.com/v1",
        model: "some-model",
        apiKey: "key",
      }),
    (error) => /HTTPS|insecure/i.test(error.message),
  );
});

test("chat without a configured provider reports a configuration error, not a fake reply", async () => {
  const { gateway } = await freshGateway(makePort());
  await assert.rejects(
    () => gateway.chat({ messages: [{ role: "user", text: "hello" }] }),
    (error) => error.code === "config" && /provider/i.test(error.message),
  );
});

test("removing a provider deletes its config and stored key", async () => {
  const port = makePort();
  const { gateway } = await freshGateway(port);
  const saved = await gateway.upsert({
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    apiKey: "gsk_abcdefghijklmnopqrstuvwxyz",
  });
  await gateway.remove(saved.id);
  const restarted = await freshGateway(port);
  assert.equal((await restarted.gateway.load(true)).length, 0);
  assert.equal(await restarted.gateway.hasKey(saved.id), false);
});

test("updating a provider keeps its id and replaces the model", async () => {
  const { gateway } = await freshGateway(makePort());
  const saved = await gateway.upsert({ provider: "openrouter", model: "google/gemini-2.0-flash-001" });
  const updated = await gateway.upsert({ id: saved.id, provider: "openrouter", model: "openai/gpt-4o-mini" });
  assert.equal(updated.id, saved.id);
  const list = await gateway.load(true);
  assert.equal(list.length, 1);
  assert.equal(list[0].model, "openai/gpt-4o-mini");
});

test("editing a provider with a blank key keeps the stored key", async () => {
  const { gateway } = await freshGateway(makePort());
  const key = "sk-or-v1-abcdefghijklmnopqrstuvwxyz";
  const saved = await gateway.upsert({ provider: "openrouter", model: "openai/gpt-4o-mini", apiKey: key });
  const updated = await gateway.upsert({ id: saved.id, provider: "openrouter", model: "google/gemini-2.0-flash-001", apiKey: "" });
  assert.equal(updated.id, saved.id);
  assert.equal(updated.model, "google/gemini-2.0-flash-001");
  assert.equal(await gateway.hasKey(saved.id), true, "a blank edit field must not delete the saved key");
});

/**
 * Android 8/9 ship SQLite 3.22, which rejects `ON CONFLICT … DO UPDATE`.
 * Reproduce that parser so the store can never silently regress to upsert
 * syntax and make provider saves fail on those phones again.
 */
function makeLegacySqlitePort() {
  const port = makePort();
  const exec = port.exec.bind(port);
  port.exec = async (sql, params = []) => {
    if (/\bon\s+conflict\b/i.test(sql)) {
      throw new Error('near "ON": syntax error (legacy SQLite has no UPSERT)');
    }
    return exec(sql, params);
  };
  return port;
}

test("provider settings persist on the legacy SQLite shipped by Android 8/9", async () => {
  const port = makeLegacySqlitePort();
  const first = await freshGateway(port);
  const saved = await first.gateway.upsert({
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
    apiKey: "sk-or-v1-abcdefghijklmnopqrstuvwxyz",
  });
  const restarted = await freshGateway(port);
  const list = await restarted.gateway.load(true);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, saved.id);
  assert.equal(list[0].model, "openai/gpt-4o-mini");
});

test("permission states are normalised from Capacitor's enum casing", () => {
  const { normalizePermissionState } = nativeModule;
  assert.equal(normalizePermissionState("GRANTED"), "granted");
  assert.equal(normalizePermissionState("DENIED"), "denied");
  assert.equal(normalizePermissionState("PROMPT"), "prompt");
  assert.equal(normalizePermissionState("PROMPT_WITH_RATIONALE"), "prompt_with_rationale");
  assert.equal(normalizePermissionState("granted"), "granted");
  assert.equal(normalizePermissionState(undefined), "unknown");
  assert.equal(normalizePermissionState("something-else"), "unknown");
});
