# JARVIS Android — Bug Report and Fix Record

This report documents the defects found in the Android port that was actually
checked out (`3e3b2f9`), the evidence for each root cause, the files involved,
the fix that was implemented and how the fix is verified. Confirmed defects are
separated from suspected device-only causes.

> **Method.** Every claim below was checked against source before changing it.
> The WebView permission path was verified in the installed Capacitor source
> (`node_modules/@capacitor/android/.../BridgeWebChromeClient.java`), which
> *does* request `RECORD_AUDIO` for `getUserMedia`. The microphone failure was
> therefore **not** diagnosed as a permission-declaration bug.

## Confirmed defects

### 1. P0 — Tap-to-talk silently discarded speech (wake-word gate)

**Root cause.** The only voice pipeline was `JarvisMic` in
`web/src/lib/voice.ts`. `_transcribe()` forwards a transcript to the chat only
if it contains the configured wake word **or** the `_awakeUntil` follow-up
window is open:

```ts
const hasWake = detectWake(text, wakeWord);
const inFollowup = now < this._awakeUntil;
if (!hasWake && !inFollowup) { /* "(ignored)" */ return; }
```

`CommandBar.toggleMic()` starts `mic.start(...)` but never arms
`_awakeUntil`. On a phone, tapping the microphone therefore opened a real
recording session, produced a real transcript, and dropped it unless the user
happened to say “Jarvis”. The UI then displayed `(ignored) "…"`. This exactly
matches “microphone does not work properly”.

**Affected files.** `web/src/lib/voice.ts`, `web/src/components/Chat/CommandBar.tsx`.

**Fix.** A dedicated mobile voice pipeline (`web/src/lib/voicePipeline.ts`) with
explicit states. Tap-to-talk submits the recognized text directly; there is no
wake-word requirement for a manual tap. The desktop wake-word pipeline is
untouched for desktop parity.

**Verification.** `web/tests/mobile.test.mjs` covers the state machine
(`LISTENING → PROCESSING_AUDIO → TRANSCRIBING → SUBMITTING_REQUEST`), and a
failure path (`permission_denied → ERROR`). Device verification of an actual
transcript is listed in `TEST_REPORT.md`.

### 2. P0 — Microphone failures were invisible and left inconsistent state

**Root cause.** `JarvisMic._initAudio()` caught `getUserMedia` failure, set the
status string `"mic blocked"`, and returned — without clearing
`_wantListening`, resetting `micEnabled`, or entering an error state. The UI
continued to show an enabled wake toggle. `available()` existed but was never
called. There was no distinction between “recording failed”, “transcription
failed” and “backend unreachable”.

**Affected files.** `web/src/lib/voice.ts`, `web/src/components/Chat/CommandBar.tsx`.

**Fix.** `voiceState.ts` defines `IDLE / REQUESTING_PERMISSION / LISTENING /
PROCESSING_AUDIO / TRANSCRIBING / SUBMITTING_REQUEST / THINKING / SPEAKING /
STOPPED / ERROR`. Every failure enters `ERROR` with an actionable message
(permission → Android settings path; missing recognizer → install/enable speech
service; empty clip → speak again; backend → configure address). The native
plugin also reports `SpeechRecognizer` error codes with human-readable text.

**Verification.** Unit tests for all transitions plus explicit failure cases.
The UI renders the error text in the composer and on the Home core.

### 3. P0 — No native speech recognition or text-to-speech on Android

**Root cause.** `web/android/app/src/main/java/com/jarvis/local/MainActivity.java`
was an empty `BridgeActivity`; no Capacitor plugin existed. The only STT path was
`MediaRecorder → POST /api/stt` (Whisper on a backend), and the only TTS paths
were `window.speechSynthesis` (frequently voiceless in Android WebView) or
backend `/api/tts` (needs a reachable backend). On a fresh install with no
backend, the app could neither hear nor speak.

**Affected files.** `MainActivity.java`, `AndroidManifest.xml`,
`web/src/lib/voice.ts`, `web/src/App.tsx`.

**Fix.** New `JarvisNativePlugin.java` (registered in `MainActivity`) exposes
Android `SpeechRecognizer` (partials, final result, RMS level, error mapping),
`TextToSpeech` (real `UtteranceProgressListener` start/range/done events), device
telemetry, intents, clipboard, notifications, and SAF pickers. The mobile voice
pipeline prefers the native engine and falls back to the original backend
Whisper route in browsers. Chat replies on Android are spoken through native TTS
in `App.tsx`; desktop keeps its streaming TTS queue.

**Verification.** Local Android compile (Gradle `assembleDebug`) plus CI. Actual
audibility is a device test (documented).

### 4. P0 — “3D” core was SVG, not WebGL, and not audio-reactive

**Root cause.** The centrepiece `web/src/components/Orb/Orb.tsx` is an SVG dial
with CSS rotation. `ArcReactor.tsx` is also SVG. The project’s
`FEATURE_PARITY.md` claimed a preserved “Three.js arc reactor”; no Three.js
reactor existed, and `audioLevel` was only produced by the desktop VAD loop, so
a phone had no real amplitude source.

**Affected files.** `web/src/components/Orb/Orb.tsx`,
`web/src/components/HUD/ArcReactor.tsx`, `web/src/App.tsx`,
`web/src/lib/voice.ts`.

**Fix.** New `web/src/mobile/JarvisCore.tsx`: one Three.js scene (shader core,
five orbital torus rings, 96-segment energy ring, particle shell, halo) rendered
in a single RAF loop. It reacts to real `SpeechRecognizer` RMS and real TTS
range events; idle/thinking/speaking states change speeds and intensity; offline
desaturates and dims. Cleanup disposes every geometry/material/renderer, stops
on backgrounding, honours reduced motion, and supports a low-power mode.

**Verification.** Production build (WebGL code compiled and code-split). Visual
verification on a real device is listed as pending; no animation is used as
evidence that voice works.

### 5. P1 — Desktop HUD merely compressed onto the phone

**Root cause.** `App.tsx`’s `<900px` branch kept the desktop composition at
fixed pixel offsets (`top-[76px]`, `h-[136px]`, 12px monospace chat) with a chip
rail instead of navigation. Panels overlapped the command bar; the Settings,
Tools, Plan and Media panels lived in sheets; there was no bottom navigation and
no first-run setup.

**Affected files.** `web/src/App.tsx`,
`web/src/components/HUD/MobileSheets.tsx`.

**Fix.** `web/src/mobile/` implements a real app frame: fixed five-tab bottom
navigation (Home, Chat, Tools, Memory, Settings), safe-area padding, 46–56 px
touch targets, dedicated screens, a cinematic Home with the live 3D core, a
real conversation screen, a tool directory, memory, and settings. The desktop
branch at ≥900 px is unchanged. `?mobile=1` allows reviewing the shell on a
desktop browser.

**Verification.** Production build; layout code inspected for safe-area and
keyboard handling; manual device checklist in `TEST_REPORT.md`.

### 6. P1 — No Android actions at all, and package visibility missing

**Root cause.** No intents were implemented; there was no ability to launch an
app, open a settings screen, read the battery, use the clipboard or post a
notification. The manifest also had no `<queries>` element, so even a future
`queryIntentActivities` call would return an empty list on API 30+.

**Affected files.** `web/android/app/src/main/AndroidManifest.xml`,
`MainActivity.java`, `web/src/components/HUD/MobileSheets.tsx`.

**Fix.** Native methods for `openApp`, `listApps`, `openSettings`,
`getDeviceInfo`, `clipboardRead/Write`, `notify`, `pickImage`, `pickFile`,
`shareText`. A typed TS router (`actionPlan.ts` + `actions.ts`) maps recognized
or typed commands to those methods, logs every real outcome into the existing
tool log, requires approval for notifications, and refuses unknown phrasing
(it goes to the model instead). Added `<queries>` for launcher intents.

**Verification.** 12 unit tests cover intent parsing, approval requirements and
non-hijacking of ordinary conversation. Native execution is device-only.

### 7. P1 — No usable backend setup on the phone

**Root cause.** `App.tsx` called `getHealth()` on a relative path even on
Android with no backend configured, and the mobile UI had no first-run setup or
connection test. Chat was simply disabled with “Reconnecting…”. Backend,
provider and model errors were invisible.

**Affected files.** `web/src/lib/backend.ts`, `web/src/App.tsx`,
`web/src/components/HUD/Settings.tsx`.

**Fix.** The mobile Settings screen accepts a backend address, normalizes it,
runs `/api/health` with latency, reconnects the WebSocket, and reports HTTP or
network failure. Home shows unconfigured/offline/online states with the model,
provider, tool count and permission mode. The 15 s desktop poll now skips the
Android app-shell origin when no backend is configured.

**Verification.** `normalizeBackendUrl`/`apiUrl`/`wsUrl` tests (pre-existing and
extended) plus manual probe logic review. A real connection requires a backend.

### 8. P1 — Android text input could be covered by the keyboard

**Root cause.** `MainActivity` had no `windowSoftInputMode`, so the activity did
not guarantee resize behaviour for the composer.

**Fix.** `android:windowSoftInputMode="adjustResize"`, `100dvh` layout,
scroll-on-focus, and the composer sits above the fixed navigation bar.

**Verification.** Device checklist item (keyboard vs composer).

### 9. P2 — CI could produce an artifact that lacked the HUD

**Root cause.** The workflow relied on the runner’s preinstalled SDK, never
checked that `assets/public/index.html` was inside the APK, and accepted an APK
as small as 200 KB — small enough to pass with a missing web bundle. No build
logs were uploaded on failure, and Android-only path changes (`web/android/**`)
did not trigger it.

**Fix.** `.github/workflows/android-apk.yml` installs platform 35 and
build-tools 35 explicitly, runs tests + production build, syncs Capacitor,
assembles, requires the APK to be ≥1 MB **and** contain
`assets/public/index.html`, uploads the artifact only after verification, and
uploads Gradle reports on failure. `web/android/**` pushes trigger the job.

**Verification.** Workflow is validated by GitHub Actions on the pushed commit;
local Gradle build is recorded in `TEST_REPORT.md`.

### 10. P2 — Misleading/absent status information

**Root cause.** The mobile UI showed a hard-coded SVG dial with decorative
“MARK IV” text, plus panels fed by desktop stats that may be stale or belong to
the PC, without labels distinguishing phone from backend.

**Fix.** Phone metrics (battery, model, cores, RAM, load) come from Android APIs
and are labelled “This phone”. Backend metrics (provider, model, tools,
latency) are labelled “not this phone”. Offline state is explicit; there is no
fake success, and every tool row reports its execution location.

## Suspected / device-only causes (not assumed)

| Suspect | Why it is not yet confirmed | How to confirm |
|---|---|---|
| `MediaRecorder` Opus/WebM support inside the specific WebView | Capacitor’s permission bridge is present, so capture may work; the backend Whisper route was still missing on a fresh install | Browser fallback is implemented; device test with a configured backend |
| `SpeechRecognizer` absent on a given device (no Google speech service) | Samsung Galaxy A54 normally ships the service, but this cannot be proven without the device | The plugin checks `SpeechRecognizer.isRecognitionAvailable()` and reports a real error |
| TTS voice quality / missing en-GB data | Engine data is device/user specific | `getVoices()` is shown in Settings; the engine falls back to the device locale |
| WebGL performance/heat on the A54 | Needs physical measurement | Low-power mode + reduced-motion support; manual FPS/thermal check |
| Cleartext LAN HTTP blocked | The **debug** manifest allows cleartext (the artifact is debug); release does not | Debug APK reaches `http://LAN:7341`; release needs HTTPS |
| WebSocket duplication after reconnect | The reconnect path closes the old socket first; no double forking observed in code | Two-client soak test on device |

## Known limitations retained honestly

- Wake-word listening is foreground-only; there is no background microphone
  service (by design and by Android policy).
- No AccessibilityService automation. Phone control is limited to documented
  intents and APIs; JARVIS never taps arbitrary UI or changes protected settings.
- Backend-dependent actions (chat, tools, Whisper TTS, vision analysis, media)
  require a reachable JARVIS backend. Phone actions do not.
- Release builds require HTTPS; the debug artifact allows cleartext for a LAN
  lab only.
- Physical-device tests for microphone audibility, camera, notifications and
  WebGL smoothness remain unverified until run on the A54 (see `TEST_REPORT.md`).
