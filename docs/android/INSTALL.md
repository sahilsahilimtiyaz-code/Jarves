# JARVIS Android — Install & Troubleshooting

## What you get

A debug-signed APK built by GitHub Actions. It is the JARVIS HUD for phones
and tablets: chat, voice, media hubs, 3D viewer, Neural Galaxy, plan/swarm
panels and the tool console — connected over the network to your JARVIS
backend. The backend, its models and your PC-side tools do **not** ship in
the APK (see `BACKEND.md`).

## How to build / download the APK

1. Push this repository to GitHub (the workflow is
   `.github/workflows/android-apk.yml`).
2. Open the repo on GitHub → **Actions** tab → workflow **android-apk**.
3. Either **Run workflow** (button) or push to `main`/`master`.
4. After ~8–15 minutes the run shows a green check. In the run summary the
   **Artifacts** section lists `JARVIS-Android-debug-APK`.
5. Click it to download a ZIP containing `app-debug.apk`, unzip it on your
   computer and copy the APK to the phone (or download the ZIP directly on
   the phone in Chrome).

The build itself runs on GitHub hardware (Java + Android SDK + Gradle). A
failing build is visible in the logs — this workflow does not fake success;
if the APK file is missing or tiny, the run is failed on purpose.

## Install steps on the phone

1. Get `app-debug.apk` onto the phone.
2. Tap it. If Google Play Protect warns about an *unknown app developer*
   (a locally built debug APK), that is expected — it is your own build.
3. Allow "Install unknown apps / from this source" if asked.
4. Open **J.A.R.V.I.S.** from the launcher — the arc-reactor splash appears.

## First launch (important)

The app boots in **Mode C (Android-only)** until you give it a backend:

1. Open ⚙ Settings → **Backend**.
2. Enter the backend address, e.g. `192.168.1.20:7341` (it is normalized to
   `http://…`; HTTPS just works too), or `10.0.2.2:7341` inside an emulator.
3. Press the check/refresh control — the status should turn connected.
   The host indicator in the HUD follows once the WebSocket is up.

How to start that backend: read `BACKEND.md`.

## Permissions you will be asked for (and only those)

| Permission | When requested | Why |
|-----------|----------------|-----|
| Microphone | tapping the mic button (voice chat) | browser-style STT capture; audio is transcribed by your backend |
| Camera | opening the webcam/camera vision panel | image capture → backend vision/OCR |
| *(install time)* INTERNET | granted by default | reaching your backend host; nothing else uses the network |

No location, contacts, SMS, accessibility or background-audio services are
declared. Denying camera/mic degrades those panels only, exactly like
denying it in a browser tab.

## Troubleshooting

**Settings probe fails ("not reachable")**
- Is the backend actually running? On the backend host: `python -m jarvis` or
  `run.bat`, with `--host` reachable on your network (see BACKEND.md).
- Same Wi-Fi? Some guest/hotel networks isolate clients (AP isolation).
- OS firewalls (Windows Defender) block port 7341 for Java/node inbound —
  allow it for private networks.
- Address typos: the editor strips paths/trailing slashes; use just
  `http://IP:port`.

**Connected on desktop browser tab, not on the phone**
- You typed `localhost:7341` on the phone — that means *the phone itself*.
  Use the desktop's LAN IP instead.
- The ZIP's APK is a debug build and permits plain-HTTP LAN traffic; a future
  release build will require HTTPS for the transport (documented in
  BACKEND.md).

**WebSocket shows connected but tools say “backend required”**
- This happens when the backend host restarted with a different port/restart
  pending — re-probe in Settings; reconnects are automatic on resume.

**Voice says nothing / mic unavailable**
- Grant microphone when asked; check system-level mic permission for JARVIS.
- If TTS is silent: some WebViews lack usable synthesis voices — the app
  prefers your backend's TTS; make sure `voiceEnabled` is on and the backend
  voice profile is working on the desktop first.

**App killed when backgrounded**
- Android may reclaim memory; the HUD reconnects (resume) with backoff, chat
  history lives in the backend-side conversation. Background listening is not
  a feature at this time.

**Launcher icon / splash**
- Adaptive icons fall back gracefully; a light "blank" splash means the
  WebView took long to boot — the dark canvas is used precisely to avoid
  white flashes, so report such a case in an issue.

**Where is log/diag**
- Terminal panel in HUD shows the live WS traffic; Mission Log records runs.
- `adb logcat` works if you connect the phone to a computer with the dev SDK
  (the app logs as Capacitor/Java + console messages).
