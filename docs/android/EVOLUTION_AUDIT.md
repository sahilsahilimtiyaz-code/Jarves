# Evolution Engine — implementation audit

Audit of the checked-out repository at `e355269` (Android port from the previous
pass), followed by what was implemented for the memory/evolution/provider work.

## What already existed

| Area | State found | Consequence |
| --- | --- | --- |
| Conversation pipeline | Android chat used the WebSocket `/ws` channel to a **user-hosted FastAPI backend** (`ws.ts`, `backend.ts`). No provider SDK, no direct API calls. | A fresh APK could not answer anything without a PC/server. |
| Persistence | Chat lived in the Zustand store (localStorage via `persist`); `memoryStore.ts` kept 500 notes in localStorage. Backend memory lived in the server's `data/memory.db`. | No durable, searchable on-device transcript; nothing survived WebView data clearing. |
| Memory retrieval | Memory was a UI list; nothing was injected into a model request from the phone. | "Memory" was storage, not recall. |
| Voice | Native `SpeechRecognizer` + `TextToSpeech` existed (from the previous pass) and worked only while the Activity was foreground. | Tap-to-talk real; no wake word. |
| Android actions | Typed `planPhoneAction` → `executePhoneAction` with 8 real actions and honest results; tool log in the UI. | Sound base to expose to a model, but the model never saw tools. |
| Providers | None. `Settings` only configured a backend URL. | — |
| Tests | 31 Node tests (wake phrase, platform, mobile copy/voice state). | No coverage of memory, providers or greetings. |

## What was added in this change

1. **Direct provider gateway** (`web/src/lib/ai/`): a 20-provider catalogue, four
   protocol adapters (OpenAI Chat Completions, Anthropic Messages, Gemini
   `generateContent`, Cohere v2), role routing, explicit-only fallback, daily
   token budget, error mapping, model discovery and SSE accumulation.
2. **Native credential vault**: `JarvisSecureStore` (AES-256-GCM key in
   AndroidKeyStore, ciphertext in prefs) plus `secureSet/Get/Remove` bridge
   methods. Provider keys never enter SQLite, Zustand, logs or exports.
3. **Native HTTP transport**: `JarvisHttp` + `httpRequest/httpStreamStart/abort`
   because provider APIs do not send CORS headers. HTTPS enforced; cleartext
   only for opt-in loopback/LAN hosts.
4. **Local SQLite memory**: `JarvisDb` (schema owned by `store.ts`) with layers
   for profile facts, transcripts, episodes, procedures, events and usage.
   Migrations are `CREATE IF NOT EXISTS`; the existing backend database is not
   touched.
5. **Retrieval before every request**: ranked profile facts, relevant episodes,
   only TESTED/APPROVED procedures, recent turns, and exact-message search when
   the owner asks for a quotation or an earlier instruction.
6. **Deterministic extraction**: explicit "remember…", "call me…", "I prefer…",
   "my project uses…", "remind me…", "forget…". Credential-shaped text is
   rejected before any write.
7. **Evolution engine**: reflections derived from recorded tool outcomes, draft
   procedures only from *verified* success, structural evaluation cases,
   protected-surface approval gate, version/parent version and rollback helper.
8. **Greeting service**: four configurable periods, first-run / returning /
   mic-denied / backend-offline / daily-review scenarios, quiet hours, idempotent
   key per launch, and speech only when TTS is genuinely available.
9. **Persona**: one prompt builder that separates tone from the hard execution
   rules (tool results are the only proof of an action).
10. **UI**: the Memory tab is now a Memory & Evolution Center (providers, profile,
    archive, skills, timeline, controls, notes); Chat routes to the on-device
    provider when one is configured and falls back to the backend otherwise.

## Confirmed gaps (not implemented)

- **Always-listening wake word.** No foreground microphone service is shipped.
  `wake*` bridge methods return `state: "off"` with an explicit message, and the
  UI says "Not available in this build". Tap-to-talk is unaffected. Vosk
  (`com.alphacephei:vosk-android`) is the intended engine; it needs a ~40 MB
  model download and a service implementation that was not delivered here.
- **Streaming in the chat UI.** The gateway streams and is tested at the
  protocol level, but `ChatScreen` currently requests a complete answer.
- **Background consolidation scheduler.** Manual controls and storage exist;
  no WorkManager job runs it.
- **Android Gradle compile of the new Java classes** was not executed in this
  environment (no Android SDK/JDK toolchain installed at the time of writing).
  The TS layer typechecks and all 67 Node tests pass.

Nothing in this change claims device-verified behaviour for microphone, TTS,
provider network calls or SQLite on hardware.
