import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Same transpile-to-data-URL pattern as wakeWord.test.mjs: exercises the
// real TypeScript sources (backend address resolution, platform detection,
// reconnect backoff) with zero browser or Android dependence.
async function loadTS(relpath) {
  const source = readFileSync(new URL(relpath, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const backend = await loadTS("../src/lib/backend.ts");
const backoff = await loadTS("../src/lib/backoff.ts");
const detect = await loadTS("../src/platform/detect.ts");

test("normalizeBackendUrl: scheme-less LAN addresses get a default http scheme", () => {
  assert.equal(backend.normalizeBackendUrl("192.168.1.20:7341"), "http://192.168.1.20:7341");
  assert.equal(backend.normalizeBackendUrl(" http://192.168.1.20:7341 "), "http://192.168.1.20:7341");
  // The Android emulator special-case documented in docs/android/BACKEND.md.
  assert.equal(backend.normalizeBackendUrl("10.0.2.2:7341"), "http://10.0.2.2:7341");
});

test("normalizeBackendUrl: pasted paths/queries are dropped, origin is kept", () => {
  assert.equal(backend.normalizeBackendUrl("http://X.NET/api/ws"), "http://x.net");
  assert.equal(backend.normalizeBackendUrl("https://jarvis.example.com/"), "https://jarvis.example.com");
  assert.equal(backend.normalizeBackendUrl("https://jarvis.example.com/#/settings"), "https://jarvis.example.com");
});

test("normalizeBackendUrl: WHATWG normalization details", () => {
  assert.equal(backend.normalizeBackendUrl("https://jarvis.example.com:443"), "https://jarvis.example.com");
  // Scheme and hostname are lowercased; a space in the host is rejected.
  assert.equal(backend.normalizeBackendUrl("HtTpS://JaRvIs.ExAmPlE.Com"), "https://jarvis.example.com");
  assert.equal(backend.normalizeBackendUrl("hey jarvis.local"), "");
});

test("normalizeBackendUrl: rejects non-http schemes and garbage", () => {
  assert.equal(backend.normalizeBackendUrl("ftp://host/file"), "");
  assert.equal(backend.normalizeBackendUrl("not a url"), "");
  assert.equal(backend.normalizeBackendUrl("http://x:99999"), "");
  assert.equal(backend.normalizeBackendUrl(""), "");
});

test("apiUrl: empty base stays same-origin (desktop byte-for-byte behaviour)", () => {
  assert.equal(backend.apiUrl("/api/health"), "/api/health");
  assert.equal(backend.apiUrl("api/health"), "/api/health"); // leading slash enforced
});

test("apiUrl + wsUrl with a configured backend produce absolute URLs", async () => {
  const saved = await backend.setBackendBase("192.168.1.20:7341");
  assert.equal(saved, "http://192.168.1.20:7341");
  assert.equal(backend.backendBase(), "http://192.168.1.20:7341");
  assert.equal(backend.backendConfigured(), true);
  assert.equal(backend.apiUrl("/api/health"), "http://192.168.1.20:7341/api/health");
  assert.equal(backend.apiUrl("/media/generated/x.png"), "http://192.168.1.20:7341/media/generated/x.png");

  assert.equal(backend.wsUrl(), "ws://192.168.1.20:7341/ws");
  await backend.setBackendBase("https://jarvis.example.com");
  assert.equal(backend.wsUrl(), "wss://jarvis.example.com/ws");
  // Reset to "no backend configured" for later tests / module state.
  const cleared = await backend.setBackendBase("");
  assert.equal(cleared, "");
  assert.equal(backend.backendConfigured(), false);
  assert.equal(backend.apiUrl("/api/health"), "/api/health");
});

test("toWebSocketUrl swaps only the scheme", () => {
  assert.equal(backend.toWebSocketUrl("http://host:7341"), "ws://host:7341");
  assert.equal(backend.toWebSocketUrl("https://host:7341"), "wss://host:7341");
  assert.equal(backend.toWebSocketUrl("ws://host"), "ws://host");
});

test("wsUrl without a configured base mimics the original same-origin dial", () => {
  // No backend configured and no window: still must not throw.
  assert.equal(backend.wsUrl(), "ws:///ws");
});

test("wsBackoffDelay ramps and caps", () => {
  assert.equal(backoff.wsBackoffDelay(0), 1500);
  assert.equal(backoff.wsBackoffDelay(1), 3750);
  assert.equal(backoff.wsBackoffDelay(2), 6000);
  assert.equal(backoff.wsBackoffDelay(10), 6000); // capped
});

test("detectPlatform: Electron preload bridge wins (desktop unchanged)", () => {
  globalThis.window = { jarvis: { hello: () => {} } };
  try {
    assert.equal(detect.detectPlatform(), "electron");
  } finally { delete globalThis.window; }
});

test("detectPlatform: Capacitor android WebView", () => {
  globalThis.window = {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
  };
  try {
    assert.equal(detect.detectPlatform(), "android");
  } finally { delete globalThis.window; }
});

test("detectPlatform: Capacitor global without native platform = plain web", () => {
  globalThis.window = { Capacitor: { isNativePlatform: () => false } };
  try {
    assert.equal(detect.detectPlatform(), "web");
  } finally { delete globalThis.window; }
});

test("detectPlatform: no window at all = web", () => {
  assert.equal(detect.detectPlatform(), "web");
});
