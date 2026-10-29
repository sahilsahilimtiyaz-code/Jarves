# JARVIS Android — Feature Parity Report

Contract for “no silent feature loss”: every original capability is either
preserved, adapted for the phone, or explicitly marked as requiring the backend
or a connected desktop. Nothing was replaced by a mock. The desktop HUD
(`viewport ≥ 900 px`, Electron, browser) is unchanged.

## Runtime modes

| Mode | Meaning | What actually runs |
|---|---|---|
| **A — connected backend** | The phone reaches the JARVIS FastAPI backend (LAN, VPN or HTTPS relay) | LLM chat, streaming, all registered tools, media pipelines, backend memory, agents |
| **B — connected desktop** | Mode A and the backend host is the user's PC | Additionally PowerShell, host filesystem/Desktop tools, OCR, 3D renderers — all on the PC |
| **C — Android-only** | No backend configured (fresh install) | Mobile UI, 3D core, native voice input/output, phone actions (apps/settings/battery/clipboard/notifications/camera picker/files), local memory notes. No chat/tool results are fabricated |

## Mobile application shell (new, additive)

| Feature | Status | Notes |
|---|---|---|
| Portrait-first screens with bottom navigation | NEW | Home, Chat, Tools, Memory, Settings; one active tab; 56 px targets |
| Safe areas, cutouts, gesture navigation | PRESERVED/ADAPTED | `env(safe-area-inset-*)`, `viewport-fit=cover`, nav above the system bar |
| Keyboard handling | FIXED | `adjustResize`, `100dvh`, scroll-to-composer, no covered send button |
| Desktop HUD | PRESERVED | Unchanged branch at ≥ 900 px; mobile shell is lazy-loaded (`?mobile=1` for review) |
| Original panels (Media, Terminal, Plan, Swarm, Mission) | PRESERVED (desktop) / ANDROID-ADAPTED | Media results still render from the same WS events; the mobile Chat shows tool/media activity inline. Desktop panels are untouched |
| Three.js animated core | NEW IMPLEMENTATION | Real WebGL shader core, rings, particles, segment ring; reacts to real RMS/TTS levels; disposes cleanly; low-power + reduced-motion |
| Status honesty | NEW | Phone vs backend metrics are labelled; offline/error states replace fake “online” |

## Voice

| Feature | Status | Notes |
|---|---|---|
| Tap-to-talk recognition | FIXED | Android `SpeechRecognizer` (native bridge); direct submission, no wake word required |
| Partial transcripts | NEW | Live partials appear in the composer |
| Permission flow | FIXED | Native runtime request with granted/denied result; permanent denial guidance |
| Backend Whisper STT | PRESERVED | Browser fallback records with `MediaRecorder` and posts to `/api/stt` |
| Text-to-speech | FIXED | Android `TextToSpeech` with real start/range/done events; backend/browser TTS retained elsewhere |
| Voice selection | NEW | Settings lists system voices, language selection, real test playback |
| Barge-in / “cancel” voice command | PRESERVED (desktop) | Desktop `JarvisMic` untouched; mobile uses the stop control and TTS stop |
| Wake word while backgrounded | ABSENT (documented) | No background microphone service |

## AI and backend

| Feature | Status | Notes |
|---|---|---|
| WebSocket chat (`/ws`) | PRESERVED | Same protocol: `chat`, `stream_*`, `thinking`, `tool_*`, `plan`, `suggestions`, `confirm_request`, `done` |
| Streaming responses | PRESERVED | Mobile chat renders `stream_delta`; retry/stop controls added |
| Stop generation | NEW (UI) | Sends the existing `cancel` message |
| Backend configuration | FIXED | Address + `/api/health` test with latency; Android without backend never dials the app shell |
| Provider/model/permission errors | IMPROVED | Health data and backend errors are shown; missing model/auth/rate-limit errors arrive through the existing error events |
| Memory | PRESERVED + NEW | Backend memory search + separate on-device notes that never overwrite `data/memory.db` |
| Provider secrets | PRESERVED | None in the APK; they stay on the backend |

## Android phone actions (new, real)

| Action | Implementation | Honest result |
|---|---|---|
| Launch installed app | `PackageManager` + launcher intent, `<queries>` | Opens it or reports “no installed app matched / several matches” |
| System settings shortcuts | Documented `Settings.ACTION_*` intents | Opens the screen; explicitly does **not** claim to change the setting |
| Battery / battery temperature / charging | `BatteryManager` + sticky battery intent | Real values |
| Device model, Android version, cores, RAM, 1-min load | `Build`, `ActivityManager.MemoryInfo`, `/proc/loadavg` | Real values; missing values shown as unavailable |
| Clipboard read/write | `ClipboardManager` | Reports empty/blocked honestly |
| Local notification | `NotificationManager` + runtime permission | Requires approval; real permission state |
| Camera / gallery | `ACTION_IMAGE_CAPTURE` with FileProvider / `ACTION_GET_CONTENT` | Returns a real image; analysis via backend `/api/analyze-image` |
| File selection | Storage Access Framework (`ACTION_GET_CONTENT`) | Returns real metadata/content; scoped storage respected |
| Share text | `ACTION_SEND` chooser | Real share sheet |
| Voice/typed routing | `actionPlan.ts` typed parser | Only supported phrasings execute; ordinary conversation goes to the model |

**Safety.** No shell execution, no AccessibilityService, no protected-setting
writes. Side-effecting notification requires explicit approval. Every execution
is written to the existing tool log with its real status.

## Backend-dependent capabilities (Mode A/B)

Chat, tool registry, web research, image/video search, media generation,
Whisper, backend TTS, long-term memory, memory galaxy, plans, swarms, agents,
reader, uploads and vision analysis all execute on the JARVIS backend through
the original endpoints and WebSocket contract. Tool cards in the mobile Tools
screen are generated from the live `/api/tools` registry, grouped by plugin,
with execution location shown.

## Connected-desktop capabilities (Mode B)

`shell`/`system`, Tesseract OCR, TRELLIS/Hunyuan 3D, Desktop-folder media and
Windows power control remain on the backend host and are shown as backend tools.
They are not reimplemented on the phone and never claim to run there.

## Transport

| Aspect | Status |
|---|---|
| Same-origin desktop URLs | PRESERVED |
| Configurable backend base | PRESERVED + surfaced in mobile Settings |
| WS reconnect | PRESERVED (capped backoff + resume + address change) |
| Cleartext HTTP | Debug APK only (Artifact is debug); release requires HTTPS |
| TLS/auth | Not weakened: no custom trust manager, no hostname verification override, no embedded tokens |
| Secrets | None in the APK or repository |

## Known limitations

1. Wake-word is foreground-only; no background service.
2. No accessibility-based screen automation by design.
3. Backend chat/tools/Whisper/vision need Mode A; the app says so instead of mocking.
4. Debug artifact permits cleartext for LAN; production must use HTTPS and its own keystore.
5. Device-only checks (actual mic audio, speaker output, camera, WebGL smoothness on the A54) are listed in `TEST_REPORT.md` and are not claimed as verified.
6. Local on-device notes are separate from backend memory; nothing is auto-uploaded.
