import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Exercise the real TypeScript sources of the mobile action router, the voice
// state machine and the speech-text normaliser. These modules are pure so they
// run in Node with no browser, Android or network dependency.
async function loadTS(relpath) {
  const source = readFileSync(new URL(relpath, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const plan = await loadTS("../src/lib/actionPlan.ts");
const state = await loadTS("../src/lib/voiceState.ts");
const speech = await loadTS("../src/lib/speechText.ts");

test("actionPlan: open/launch commands map to open_app", () => {
  const action = plan.planPhoneAction("Open YouTube");
  assert.equal(action.kind, "open_app");
  assert.equal(action.args.query, "YouTube");
  assert.equal(action.requiresApproval, false);

  assert.equal(plan.planPhoneAction("launch spotify").args.query, "spotify");
  assert.equal(plan.planPhoneAction("please open the camera app").args.query, "camera");
});

test("actionPlan: settings phrasing maps to documented settings targets", () => {
  assert.equal(plan.planPhoneAction("Open Wi-Fi settings").args.target, "wifi");
  assert.equal(plan.planPhoneAction("show bluetooth settings").args.target, "bluetooth");
  assert.equal(plan.planPhoneAction("go to display settings").args.target, "display");
  assert.equal(plan.planPhoneAction("open app settings").args.target, "apps");
  // Screen brightness mentions display but is still a settings shortcut,
  // never a claim that JARVIS changed the brightness.
  assert.equal(plan.planPhoneAction("open brightness settings").args.target, "display");
});

test("actionPlan: battery, device info and clock are local reads", () => {
  assert.equal(plan.planPhoneAction("What is my battery level?").kind, "battery");
  assert.equal(plan.planPhoneAction("check battery status").kind, "battery");
  assert.equal(plan.planPhoneAction("device info").kind, "device_info");
  assert.equal(plan.planPhoneAction("what android version is this").kind, "device_info");
  assert.equal(plan.planPhoneAction("what time is it").kind, "time");
});

test("actionPlan: clipboard read/write keep the exact payload", () => {
  const write = plan.planPhoneAction("copy hello world to my clipboard");
  assert.equal(write.kind, "clipboard_write");
  assert.equal(write.args.text, "hello world");
  assert.equal(plan.planPhoneAction("What is on my clipboard?").kind, "clipboard_read");
  assert.equal(plan.planPhoneAction("paste").kind, "clipboard_read");
});

test("actionPlan: notifications require explicit approval", () => {
  const action = plan.planPhoneAction("notify me that the build finished");
  assert.equal(action.kind, "notify");
  assert.equal(action.args.body, "the build finished");
  assert.equal(action.requiresApproval, true);
});

test("actionPlan: ordinary conversation is not hijacked", () => {
  assert.equal(plan.planPhoneAction("What is the weather in London?"), null);
  assert.equal(plan.planPhoneAction("Explain quantum entanglement"), null);
  assert.equal(plan.planPhoneAction(""), null);
  assert.equal(plan.planPhoneAction("open settings").kind, "open_settings");
});

test("voiceState: recording and transcription only follow real events", () => {
  let s = "IDLE";
  s = state.reduceVoiceState(s, { type: "request_permission" });
  assert.equal(s, "REQUESTING_PERMISSION");
  s = state.reduceVoiceState(s, { type: "permission_granted" });
  assert.equal(s, "LISTENING");
  s = state.reduceVoiceState(s, { type: "audio_captured" });
  assert.equal(s, "PROCESSING_AUDIO");
  s = state.reduceVoiceState(s, { type: "transcribing" });
  assert.equal(s, "TRANSCRIBING");
  s = state.reduceVoiceState(s, { type: "submitting" });
  assert.equal(s, "SUBMITTING_REQUEST");
  s = state.reduceVoiceState(s, { type: "thinking" });
  assert.equal(s, "THINKING");
  s = state.reduceVoiceState(s, { type: "speaking" });
  assert.equal(s, "SPEAKING");
  s = state.reduceVoiceState(s, { type: "speech_done" });
  assert.equal(s, "IDLE");
});

test("voiceState: denial and errors are terminal until reset", () => {
  let s = state.reduceVoiceState("REQUESTING_PERMISSION", { type: "permission_denied" });
  assert.equal(s, "ERROR");
  assert.equal(state.reduceVoiceState(s, { type: "speech_done" }), "ERROR");
  assert.equal(state.reduceVoiceState(s, { type: "reset" }), "IDLE");
  assert.equal(state.reduceVoiceState("LISTENING", { type: "error", message: "boom" }), "ERROR");
});

test("voiceState: illegal events cannot resurrect a session", () => {
  assert.equal(state.reduceVoiceState("IDLE", { type: "audio_captured" }), "IDLE");
  assert.equal(state.reduceVoiceState("IDLE", { type: "speech_done" }), "IDLE");
  assert.equal(state.reduceVoiceState("STOPPED", { type: "listening" }), "LISTENING");
  assert.equal(state.reduceVoiceState("SPEAKING", { type: "stop" }), "STOPPED");
});

test("voiceState: labels and orb mapping stay honest", () => {
  assert.equal(state.voiceStateLabel("LISTENING"), "Listening…");
  assert.equal(state.voiceStateLabel("THINKING"), "Thinking…");
  assert.equal(state.voiceStateToOrb("LISTENING"), "listening");
  assert.equal(state.voiceStateToOrb("TRANSCRIBING"), "thinking");
  assert.equal(state.voiceStateToOrb("SPEAKING"), "speaking");
  assert.equal(state.voiceStateToOrb("ERROR"), "idle");
  assert.equal(state.isVoiceBusy("LISTENING"), true);
  assert.equal(state.isVoiceBusy("IDLE"), false);
});

test("speechText: markdown is stripped before speaking", () => {
  assert.equal(speech.cleanSpeechText("**Hello** `code`"), "Hello code");
  assert.equal(speech.cleanSpeechText("[docs](https://example.com)"), "docs");
  assert.equal(speech.cleanSpeechText("```js\nx\n``` done"), "code block  done");
});
