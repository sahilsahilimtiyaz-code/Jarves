import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

// ttsProtocols.ts has no imports, so it can be transpiled straight to a data URL.
const source = readFileSync(new URL("../src/lib/ai/ttsProtocols.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const tts = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

const config = (over = {}) => ({
  id: "v1",
  provider: "elevenlabs",
  label: "ElevenLabs",
  voice: "21m00Tcm4TlvDq8ikWAM",
  enabled: true,
  language: "en-GB",
  ...over,
});

test("tts catalogue: eight providers + custom, all HTTPS, unique ids", () => {
  assert.equal(tts.TTS_PROVIDERS.length, 8);
  const ids = new Set(tts.TTS_PROVIDERS.map((p) => p.id));
  assert.equal(ids.size, 8);
  for (const provider of tts.TTS_PROVIDERS) {
    assert.match(provider.baseUrl, /^https:\/\//, provider.id);
    assert.ok(provider.docs.startsWith("http"), provider.id);
    assert.ok(provider.voiceExamples.length > 0, provider.id);
  }
  assert.equal(tts.ttsProvider("fish").label, "Fish Audio");
  assert.equal(tts.ttsProvider("custom").protocol, "custom");
  assert.equal(tts.ttsProvider("nope"), undefined);
});

test("elevenlabs: URL, header and body", () => {
  const def = tts.ttsProvider("elevenlabs");
  const req = tts.buildTtsRequest(def, config(), "sk_live", "Good evening, sir.");
  assert.match(req.url, /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/21m00Tcm4TlvDq8ikWAM\?output_format=mp3_44100_128$/);
  assert.equal(req.headers["xi-api-key"], "sk_live");
  const body = JSON.parse(req.body);
  assert.equal(body.text, "Good evening, sir.");
  assert.equal(body.model_id, "eleven_multilingual_v2");
  assert.equal(req.response, "binary");
});

test("fish audio: bearer token, format and optional reference id", () => {
  const def = tts.ttsProvider("fish");
  const req = tts.buildTtsRequest(def, config({ voice: "ref-123" }), "fish-key", "Hello");
  assert.equal(req.url, "https://api.fish.audio/v1/tts");
  assert.equal(req.headers.Authorization, "Bearer fish-key");
  const body = JSON.parse(req.body);
  assert.equal(body.reference_id, "ref-123");
  assert.equal(body.format, "mp3");
});

test("openai speech: model, voice and mp3 response", () => {
  const def = tts.ttsProvider("openai");
  const req = tts.buildTtsRequest(def, config({ provider: "openai", voice: "nova" }), "sk-x", "Hi");
  assert.equal(req.url, "https://api.openai.com/v1/audio/speech");
  assert.equal(req.body && JSON.parse(req.body).voice, "nova");
  assert.equal(JSON.parse(req.body).response_format, "mp3");
});

test("google: synthesize URL, API-key header and JSON audio response", () => {
  const def = tts.ttsProvider("google");
  const req = tts.buildTtsRequest(def, config({ provider: "google", voice: "en-GB-Neural2-B" }), "AIza-key", "Hi");
  assert.equal(req.url, "https://texttospeech.googleapis.com/v1/text:synthesize");
  assert.equal(req.headers["X-Goog-Api-Key"], "AIza-key");
  const body = JSON.parse(req.body);
  assert.equal(body.voice.name, "en-GB-Neural2-B");
  assert.equal(body.audioConfig.audioEncoding, "MP3");
  assert.equal(req.response, "base64-json");
  assert.equal(tts.parseTtsResponse(def, { status: 200, body: JSON.stringify({ audioContent: "A".repeat(64) }) }).mime, "audio/mpeg");
});

test("deepgram: voice becomes the Aura model query, token auth", () => {
  const def = tts.ttsProvider("deepgram");
  const req = tts.buildTtsRequest(def, config({ provider: "deepgram", voice: "aura-orion-en" }), "dg", "Hi");
  assert.equal(req.url, "https://api.deepgram.com/v1/speak?model=aura-orion-en");
  assert.equal(req.headers.Authorization, "Token dg");
});

test("azure: SSML body escapes text and asks for mp3", () => {
  const def = tts.ttsProvider("azure");
  const req = tts.buildTtsRequest(def, config({ provider: "azure", voice: "en-GB-RyanNeural" }), "az", "A & B <test>");
  assert.equal(req.headers["Ocp-Apim-Subscription-Key"], "az");
  assert.equal(req.headers["X-Microsoft-OutputFormat"], "audio-24khz-48kbitrate-mono-mp3");
  assert.match(req.body, /&amp;/);
  assert.match(req.body, /&lt;test&gt;/);
  assert.match(req.body, /en-GB-RyanNeural/);
});

test("cartesia and playht: required version/secondary headers", () => {
  const cartesia = tts.ttsProvider("cartesia");
  const req = tts.buildTtsRequest(cartesia, config({ provider: "cartesia", voice: "voice-id" }), "c-key", "Hi");
  assert.equal(req.url, "https://api.cartesia.ai/tts/bytes");
  assert.equal(req.headers["X-API-Key"], "c-key");
  assert.equal(req.headers["Cartesia-Version"], "2024-06-10");
  assert.equal(JSON.parse(req.body).voice.id, "voice-id");

  const playht = tts.ttsProvider("playht");
  const pReq = tts.buildTtsRequest(playht, config({ provider: "playht", account: "user-1" }), "secret", "Hi");
  assert.equal(pReq.headers.AUTHORIZATION, "secret");
  assert.equal(pReq.headers["X-USER-ID"], "user-1");
});

test("parse: binary audio passes through, empty response is an error", () => {
  const def = tts.ttsProvider("elevenlabs");
  const ok = tts.parseTtsResponse(def, { status: 200, base64: "QUJD", mime: "audio/mpeg" });
  assert.deepEqual(ok, { base64: "QUJD", mime: "audio/mpeg" });
  assert.throws(() => tts.parseTtsResponse(def, { status: 200, base64: "" }), /empty audio response/);
});

test("parse: provider errors are readable and never include a key", () => {
  const def = tts.ttsProvider("openai");
  assert.throws(
    () => tts.parseTtsResponse(def, { status: 401, body: JSON.stringify({ error: { message: "Invalid API key" } }) }),
    /rejected the key: Invalid API key/,
  );
  assert.throws(() => tts.parseTtsResponse(def, { status: 429, body: "" }), /rate-limited/);
  assert.throws(() => tts.parseTtsResponse(def, { status: 402, body: "" }), /insufficient credit/);
});

test("parse: custom JSON audio payloads are accepted", () => {
  const def = tts.ttsProvider("custom");
  const parsed = tts.parseTtsResponse(def, { status: 200, body: JSON.stringify({ audio_base64: "B".repeat(64) }) });
  assert.equal(parsed.base64.length, 64);
});
