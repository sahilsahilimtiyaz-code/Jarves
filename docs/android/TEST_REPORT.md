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
