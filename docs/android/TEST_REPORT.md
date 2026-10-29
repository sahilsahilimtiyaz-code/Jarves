# JARVIS Android — Test Report

Record of the checks actually performed for this redesign/fix, the results, and
what remains unverified. Nothing in this file is inferred from a green check
that did not run.

## Environment

- Cloud Linux VM, Node.js 24.21 / npm 11.19 (project lockfile used with `npm ci`).
- JDK 21 (Temurin, project-local) and Android SDK 35 + build-tools 35.0.0
  installed locally only for verification; neither is committed.
- No physical Android device and no browser automation available (the headless
  Chromium install failed host-library checks and there is no root to add the
  required system packages). Device/browser-only checks are listed as pending.

## Checks executed — results

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Dependency install from lockfile | `npm ci` (web) | ✅ exit 0 |
| 2 | Unit tests (wake word + backend/platform + new mobile suite) | `npm test` | ✅ **31/31 pass** |
| 3 | TypeScript + production build | `npm run build` | ✅ exit 0 |
| 4 | Bundle split (mobile/Three.js lazy) | build output | ✅ desktop main 446.97 kB (137.76 kB gzip); `MobileShell` chunk 542.45 kB (140.11 kB gzip) loaded only on the mobile path |
| 5 | Capacitor sync of web build + plugins | `npx cap sync android` | ✅ 5 plugins detected, sync finished |
| 6 | Android debug build | `./gradlew assembleDebug --no-daemon` (JDK 21, SDK 35) | ✅ `BUILD SUCCESSFUL`, 222 tasks |
| 7 | APK exists / non-trivial size | `stat` | ✅ 6,550,482 bytes |
| 8 | APK contains the HUD | `unzip -l` | ✅ `assets/public/index.html` + hashed JS/CSS present |
| 9 | Native bridge is packaged | dex inspection | ✅ `JarvisNative` symbols in `classes4.dex` |
| 10 | Manifest permissions | `aapt2 dump permissions` | ✅ INTERNET, RECORD_AUDIO, CAMERA, POST_NOTIFICATIONS |
| 11 | Manifest behaviour | `aapt2 dump xmltree` | ✅ `<queries>` present; `windowSoftInputMode=0x10` (adjustResize) |
| 12 | Backend syntax integrity (unchanged backend) | `python3 -m compileall -q jarvis` | ✅ exit 0 |
| 13 | APK checksum | `sha256sum` | `2c0b1df0e824c8b7b51ae172d749907d8f7ad19982977ff09943d85227c26f0d` |

Local APK (not committed; build output): `web/android/app/build/outputs/apk/debug/app-debug.apk`.
The official downloadable artifact is produced by GitHub Actions:
**`JARVIS-Android-debug-APK`** (contains `app-debug.apk`).

### New automated coverage (12 tests in `web/tests/mobile.test.mjs`)

- `open/launch …` → `open_app`; bare `open settings` → app settings; Wi-Fi /
  Bluetooth / display / apps targets resolved correctly.
- Battery, device info and clock commands map to local reads.
- Clipboard read/write preserves the exact text payload.
- Notifications require explicit approval.
- Ordinary conversation (“weather”, “explain quantum entanglement”, empty
  input) is **not** hijacked into an action.
- Voice state machine: full happy path, denial/error terminal states, illegal
  events do not resurrect a session, orb mapping.
- Speech text normalisation strips markdown before TTS.

Existing suites remain green: 8 wake-word tests + 11 backend/platform tests.

## Checks that could NOT run here

| Check | Why | Status |
|---|---|---|
| Headless UI screenshot / visual regression | Chromium requires OS libs (`libnss3`, `libatk…`) and there is no root; Playwright install failed host validation | **Blocked — not performed** |
| Actual microphone capture and transcript | Needs a physical device with a speech-recognition service | **Pending on device** |
| Audible TTS output, voice selection | Needs device audio | **Pending on device** |
| App launching / settings intents / notification display | Needs device PackageManager and notification service | **Pending on device** |
| Camera/file pickers and backend vision analysis | Needs device + backend | **Pending on device** |
| WebGL smoothness/thermals on Galaxy A54 | Needs device GPU | **Pending on device** |
| GitHub Actions run result | Workflow executes after the push; the run page is the receipt | **To confirm in Actions** |
| Electron desktop packaging | Unchanged; not rebuilt here (no Electron dependencies installed) | **Not run** |

No claim is made that the APK’s microphone, speaker, camera or phone actions
work merely because Gradle compiled them.

## Manual device checklist — Samsung Galaxy A54, Android 16

Preconditions: install the CI artifact; have a JARVIS backend reachable on the
same Wi-Fi (or test the no-backend behaviour first).

| Area | Step | Expected |
|---|---|---|
| Install | Open APK, allow unknown source | Splash then mobile Home; no white flash |
| Layout | Rotate portrait/landscape, gesture nav on | Nothing under system bars; nav reachable; no horizontal scroll |
| Bottom nav | Tap all five tabs | Each loads its screen; active tab clearly marked |
| Home core | Observe 10 s | Rings rotate at different speeds, particles drift, segments pulse; no jank |
| Core states | Start mic; send a request; play TTS; go offline | Listening reacts to voice; thinking accelerates; speaking reacts; offline dims and labels OFFLINE |
| Background | Home button, return | Animation resumes once; no duplicate loops/battery spike |
| Permissions | First mic tap | Android runtime prompt; deny → visible guidance, no crash; re-enable in Settings → allow → works |
| STT | Tap mic, say “Open Wi-Fi settings” | Partial transcript appears; Wi-Fi settings opens; real result logged |
| STT variants | “What is my battery level?” / “Open YouTube” / “What is on my clipboard?” | Real battery %, YouTube launches if installed (else honest message), clipboard text or empty notice |
| TTS | Settings → Voice → Test voice output | Audible speech; Stop stops it; core shows SPEAKING only while audio plays |
| Chat | With backend configured, send a message | User bubble, thinking indicator, streamed assistant text, spoken reply |
| Cancel | Send a long request, tap stop | Generation stops; no fake answer |
| Retry | Tap Retry on last reply | Request re-sent without duplicate user bubble |
| Errors | Stop backend, send message | Explicit offline error; no infinite spinner; no “online” badge |
| Backend | Change address, test with wrong IP then right IP | Failure guidance then online latency/model/tools |
| Phone actions | Settings shortcuts: Wi-Fi/Bluetooth/Display/App info | Correct system screens open; app states it did not change settings |
| Notification | Tools → Send notification → approve | System prompt (Android 13+) then notification appears |
| Clipboard | Copy text, read clipboard | Exact text read/written; blocked case explained |
| Camera | Tools → Analyze photo | Camera opens; result from backend vision; offline case says backend required |
| Files | Tools → Select a file | SAF picker; real name/type/size shown |
| Memory | Add/filter/pin/delete local note; search backend memory | Persists across restart; backend memory untouched |
| Keyboard | Focus composer in Chat | Composer stays above keyboard and nav; send visible |
| Safe areas | Gesture bar/notch | No controls clipped |
| Network change | Wi-Fi ↔ mobile data, screen off/on | WebSocket reconnects; no duplicate messages |
| Long session | 15+ messages, media, camera | No freeze, no memory blow-up, no overheating warning |

If any item fails, capture `adb logcat -s JarvisNative Capacitor` and the
diagnostics text from Settings → Diagnostics.

## Notes on test honesty

- The listening animation reacts to the recognizer's real RMS callback; it does
  not run on a timer. If recognition does not start, the UI stays in
  REQUESTING_PERMISSION/ERROR rather than showing “Listening”.
- Chat never fabricates an answer: with no backend the request is not sent and
  an explicit error is shown.
- Phone actions return the native result (including “no app matched”, “several
  matches”, “notification permission not granted”).

## GitHub Actions runs

| Run | Result | Cause |
| --- | --- | --- |
| #3 (commit `bbfa13d`) | ❌ failed in 16 s, before any project code ran | `android-actions/setup-android@v3` executes `sdkmanager tools`; Google removed the standalone `tools` package, so the action aborted with `Warning: Failed to find package 'tools'` |
| next | see the Actions tab | workflow now uses the runner's preinstalled SDK: accepts licences, installs `platforms;android-35` + `build-tools;35.0.0` only, then runs tests, build, `cap sync`, Gradle and the APK verification |

The project itself was not implicated in run #3 — checkout, `npm ci`, tests, build and Gradle never executed. The same Gradle task sequence succeeds locally (`BUILD SUCCESSFUL`, 6,550,482-byte APK).

## Evolution / standalone-provider pass

New automated coverage (`web/tests/ai.test.mjs`, 36 tests, 67 total):

- 20-provider catalogue integrity, HTTPS policy, URL normalisation.
- OpenAI/Anthropic/Gemini/Cohere request building, tool round-trips, response and
  model-list parsing, malformed tool arguments, 401/429 error text without keys.
- SSE accumulation for OpenAI (text + fragmented tool arguments) and Anthropic.
- Role routing and explicit-only fallback.
- SQLite schema, dedupe/confirmation, address supersession, secret rejection,
  hard delete, forget-by-fragment, retrieval ranking/supersession exclusion,
  archive search + exact-message recall, usage totals, export without secrets.
- Memory extraction (preference, address, project, reminder, forget) and
  rejection of credential-shaped utterances.
- Evolution: drafts only from verified success, hypothesis vs observation,
  evaluation failures, protected-surface approval, rollback reconstruction.
- Greetings: four periods, first run, returning session, mic denial, backend
  outage, quiet hours, dedupe, address and TTS-honesty.
- Persona prompt and error-code mapping.

Checks run: `npm test` 67/67 pass · `npx tsc --noEmit` clean · `npm run build`
succeeds. **Not run:** Gradle compile of the new Java classes (no SDK/JDK in
this environment), any physical-device behaviour (provider network, SQLite,
voice, Keystore), streaming UI. Those remain unverified and are listed in
EVOLUTION_AUDIT.md.

## CI run #6 failure and the Android compile

- **CI #6 failed before the Android build**: the runner used Node 20, which has no
  `node:sqlite`, so `tests/ai.test.mjs` could not load. Fixed by moving the
  workflow to Node 24 and declaring `engines.node >= 22.5`; the suite then runs
  67/67 locally on the same Node version.
- **Java compiled locally**: JDK 21 + Android SDK 35, `./gradlew assembleDebug`
  → **BUILD SUCCESSFUL** (222 tasks). This covers the new `JarvisSecureStore`,
  `JarvisDb`, `JarvisHttp` and the new plugin methods.
- Local debug APK produced by that build: 6602678 bytes, sha256 `5974adaea5b66362083b3baf31a3cc34fcda87d0781d4081baef402f708d73d7`,
  web bundle present: 1 entry.
- Still unverified: provider network calls, Keystore encryption, SQLite on a
  real device, voice, and every hardware interaction. Those need the phone.

## Premium UI, cloud voice and permissions pass

- Cloud TTS: 8 providers + custom (ElevenLabs, Fish Audio, OpenAI Speech,
  Google Cloud TTS, Deepgram Aura, Azure Speech, PlayHT, Cartesia) with a pure
  request/response layer (`ttsProtocols.ts`) and a native binary HTTP bridge.
  Keys stay in Android Keystore; playback drives a WebAudio analyser so the core
  reacts to the real voice amplitude.
- Tests: **78/78 pass** (`npm test`), including 11 new cloud-voice protocol
  tests (URLs, auth headers, SSML escaping, Google base64 JSON, error text).
- `npx tsc --noEmit` clean; `npm run build` succeeds.
- UI: premium glass/aurora layer added on top of the existing mobile CSS, plus a
  richer WebGL core (volumetric bloom shader, three orbiting sweep arcs, distant
  dust field, idle heartbeat).
- Permissions: one-tap request for microphone/camera/notifications, SAF file
  picker, and a deep link to the system app-permission screen. Device-control
  limits are stated in the UI.
- Not verified on hardware: cloud voice playback, Keystore decryption, GPU cost
  on a Galaxy A54. Those require the device.

## Debug-and-repair pass — v0.6.0

Reported symptoms: "OFFLINE MODE / No backend configured", "Backend not configured"
for a battery question, provider form stuck on "Saving…", "No model configured"
persisting, and "Voice state: Ready · engine: none" with microphone UNKNOWN.

### Confirmed causes and fixes

| # | Cause (file / function) | Fix |
|---|---|---|
| 1 | `web/src/mobile/HomeScreen.tsx`, `ChatScreen.tsx`, `hooks.ts:statusLabel` treated the **optional** JARVIS backend as the only AI capability. With a provider saved the UI still said "offline mode" and chat refused with "Backend not configured". | New `useProviderStatus()` in `hooks.ts` reads the real provider list (`gateway.load(true)`) and both screens now report the on-device model separately from the backend. The backend block is labelled optional. |
| 2 | `JarvisNativePlugin.checkMicPermission` / `getCapabilities` returned Capacitor's Java enum via `toString()` → `"GRANTED"`, while `web/src/platform/native.ts` and the screens compared `"granted"`. Microphone therefore read as not-granted/unknown and `startListening` re-requested permission on every attempt. | `permissionLabel()` lower-cases the enum once on the Java side; new `checkPermissions` plugin method returns mic/camera/notifications + real speech/TTS availability; `normalizePermissionState()` guards the web side. |
| 3 | Every Capacitor call was awaited with no ceiling, so a bridge call that never answered left `MindScreen.run()` parked and the button showing "Saving…" forever. | `withTimeout()` in `platform/native.ts` wraps **every** bridge call with a per-method ceiling (15 s storage/Keystore, 150 s HTTP, 20 s speech). Failures now surface as text instead of a frozen button. |
| 4 | `MindScreen.saveProvider()` never awaited schema initialisation and never verified the write, so a provider that failed to persist looked identical to one that saved. | It now awaits `initMind()`, re-reads with `load(true)`, throws if the row is missing, and reports whether the Keystore key was readable back. "Test local storage" (`storageProbe()`) writes and reads a probe row and returns the real SQLite error. |
| 5 | `AndroidManifest.xml` declared a `<queries>` block for `RecognitionService` but not `TTS_SERVICE`, so on Android 11+ TTS engine discovery could report no voices. | `TTS_SERVICE` intent query added; verified present in the packaged manifest with `aapt2 dump xmltree`. |
| 6 | `ChatScreen` created its conversation id inside the component, so switching tabs started a new conversation and orphaned the archive rows. | The id is now a module constant for the app session. |
| 7 | Local phone actions were described in copy as needing a model/backend. | Copy and the "no model" banner now state that battery/settings/apps/clipboard run locally, and the banner links to Memory → Providers instead of Backend. |

### Checks executed

| Check | Command | Result |
|---|---|---|
| Unit tests (all suites incl. new provider suite) | `npm test` | ✅ **86/86 pass** |
| TypeScript | `npx tsc --noEmit` | ✅ clean |
| Production build | `npm run build` | ✅ exit 0 |
| Capacitor sync | `npx cap sync android` | ✅ exit 0 |
| Android debug build | `./gradlew assembleDebug --no-daemon` (JDK 21, SDK 35) | ✅ `BUILD SUCCESSFUL`, 222 tasks, 0 `error:` lines |
| APK produced | `stat` | ✅ 6,601,335 bytes |
| Web bundle packaged | `unzip -l` | ✅ `assets/public/index.html` + hashed JS/CSS |
| Manifest queries | `aapt2 dump xmltree` | ✅ `RecognitionService` **and** `TTS_SERVICE` present |
| Manifest permissions | `aapt2 dump permissions` | ✅ INTERNET, RECORD_AUDIO, CAMERA, POST_NOTIFICATIONS |
| New plugin method packaged | dex string scan | ✅ `checkPermissions` in `classes2.dex` / `classes4.dex` |
| APK checksum | `shasum -a 256` | `65026d2595e81c4c19a670e792d1aaa2521fb1b3dd0ed54faca660dc2e46ec80` |

### New tests (`web/tests/provider.test.mjs`, 8 cases)

- A saved provider is re-read by a **new store + gateway over the same database** (restart simulation) with the same id, model and readable key.
- The API key never appears in the settings JSON.
- Empty model / cleartext HTTP endpoint are rejected instead of saved.
- `chat()` with no provider raises a `config` error rather than inventing a reply.
- Removing a provider deletes config and key.
- Updating keeps the id and replaces the model.
- `normalizePermissionState` maps `GRANTED`/`PROMPT_WITH_RATIONALE`/junk correctly.

### Still unverified (needs the phone — unchanged by a green build)

Provider HTTP/streaming from a real device, Keystore encryption/decryption across
process death, SQLite on hardware, microphone capture and transcripts, TTS
playback including cloud voices, permission dialogs, wake-word service (still not
implemented — the bridge reports it as unavailable), and GitHub Actions itself.

The battery-question path is exercised by unit tests only as far as action
planning; the native read is device-only.
