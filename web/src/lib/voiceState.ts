/**
 * Voice state machine — pure, testable, and the single source of truth for
 * what the microphone/speaker UI is allowed to claim.
 *
 * The rule this file enforces: the UI may only say "Listening" after a real
 * recognition session started, only say "Transcribing" while a real
 * transcription request is in flight, and only say "Speaking" while a real
 * audio engine is playing. Any failure lands in ERROR with a message.
 */
export type VoiceState =
  | "IDLE"
  | "REQUESTING_PERMISSION"
  | "LISTENING"
  | "PROCESSING_AUDIO"
  | "TRANSCRIBING"
  | "SUBMITTING_REQUEST"
  | "THINKING"
  | "SPEAKING"
  | "STOPPED"
  | "ERROR";

export type VoiceEvent =
  | { type: "request_permission" }
  | { type: "permission_granted" }
  | { type: "permission_denied"; reason?: string }
  | { type: "listening" }
  | { type: "audio_captured" }
  | { type: "transcribing" }
  | { type: "submitting" }
  | { type: "thinking" }
  | { type: "speaking" }
  | { type: "speech_done" }
  | { type: "stop" }
  | { type: "error"; message?: string }
  | { type: "reset" };

/**
 * Transition table. Unknown/illegal events intentionally return the current
 * state so a late native callback (e.g. a result after the user cancelled)
 * cannot resurrect a session that has already ended.
 */
export function reduceVoiceState(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (event.type) {
    case "reset":
      return "IDLE";
    case "stop":
      return state === "IDLE" || state === "STOPPED" ? state : "STOPPED";
    case "error":
      return "ERROR";
    case "request_permission":
      return "REQUESTING_PERMISSION";
    case "permission_denied":
      return "ERROR";
    case "permission_granted":
      return state === "REQUESTING_PERMISSION" ? "LISTENING" : state;
    case "listening":
      return "LISTENING";
    case "audio_captured":
      return state === "LISTENING" ? "PROCESSING_AUDIO" : state;
    case "transcribing":
      return "TRANSCRIBING";
    case "submitting":
      return "SUBMITTING_REQUEST";
    case "thinking":
      return "THINKING";
    case "speaking":
      return "SPEAKING";
    case "speech_done":
      return state === "SPEAKING" ? "IDLE" : state;
    default:
      return state;
  }
}

/** True while the user's voice pipeline owns the microphone or the turn. */
export function isVoiceBusy(state: VoiceState): boolean {
  return (
    state === "REQUESTING_PERMISSION" ||
    state === "LISTENING" ||
    state === "PROCESSING_AUDIO" ||
    state === "TRANSCRIBING" ||
    state === "SUBMITTING_REQUEST"
  );
}

export function voiceStateLabel(state: VoiceState): string {
  switch (state) {
    case "IDLE":
      return "Ready";
    case "REQUESTING_PERMISSION":
      return "Requesting microphone permission…";
    case "LISTENING":
      return "Listening…";
    case "PROCESSING_AUDIO":
      return "Processing audio…";
    case "TRANSCRIBING":
      return "Transcribing…";
    case "SUBMITTING_REQUEST":
      return "Sending to JARVIS…";
    case "THINKING":
      return "Thinking…";
    case "SPEAKING":
      return "Speaking";
    case "STOPPED":
      return "Stopped";
    case "ERROR":
      return "Voice error";
    default:
      return "Ready";
  }
}

/** Map a state to the orb animation state used by the 3D core. */
export function voiceStateToOrb(state: VoiceState): "idle" | "listening" | "thinking" | "speaking" {
  switch (state) {
    case "LISTENING":
    case "REQUESTING_PERMISSION":
      return "listening";
    case "PROCESSING_AUDIO":
    case "TRANSCRIBING":
    case "SUBMITTING_REQUEST":
    case "THINKING":
      return "thinking";
    case "SPEAKING":
      return "speaking";
    default:
      return "idle";
  }
}
