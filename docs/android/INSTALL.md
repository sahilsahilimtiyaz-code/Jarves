# JARVIS Android — Install & Troubleshooting

## What you get

A debug-signed, installable APK produced by GitHub Actions. It is a mobile-first
JARVIS application: dedicated Home / Chat / Tools / Memory / Settings screens,
a real WebGL animated core, native Android voice input and speech output, and
real phone actions (apps, settings shortcuts, battery/device data, clipboard,
notifications, camera and file pickers).

The AI brain, its models, the 80+ backend tools and PC automation do **not**
ship in the APK. They run on your JARVIS backend (see `BACKEND.md`). Phone
actions and native speech work without a backend; chat and backend tools do not.

## How to build / download the APK

1. Push this repository to GitHub (workflow:
   `.github/workflows/android-apk.yml`).
2. Open the repository → **Actions** → workflow **android-apk**.
3. Use **Run workflow**, or push to `main`/`master`.
4. The job installs Node 20, JDK 21, Android platform 35 and build-tools 35,
   runs the unit tests + production build, syncs Capacitor, assembles the APK,
   and verifies that `app-debug.apk` is ≥1 MB **and contains**
   `assets/public/index.html`.
5. Download the artifact **`JARVIS-Android-debug-APK`** from the run summary,
   unzip it, and copy `app-debug.apk` to the phone.

If the build fails, the run is red and no artifact is uploaded. Gradle reports
are attached as `android-build-logs` on failure.

## Install on the phone

1. Copy `app-debug.apk` to the phone (or download the artifact ZIP on it).
2. Tap it. Play Protect may warn that the developer is unknown — it is your own
   debug build.
3. Allow "Install unknown apps" for the browser/file manager if asked.
4. Open **J.A.R.V.I.S.**

## First launch

The app opens on **Home** in offline mode until you configure a backend:

1. Tap **Settings** in the bottom navigation (or the gear on Home).
2. Enter the backend address, e.g. `192.168.1.20:7341` — the field adds
   `http://` automatically. In an emulator use `10.0.2.2:7341`.
3. Press **Save & test connection**. A green result shows the latency, provider,
   model and tool count.
4. Chat and backend tools now work; `Reconnect` forces a fresh WebSocket.

Without a backend you can still use: native voice input, native speech output,
app launching, settings shortcuts, battery/device readouts, clipboard,
notifications, camera, file picker and local memory notes. Every screen states
what is unavailable instead of showing fake results.

## Permissions

| Permission | Requested when | Why |
|---|---|---|
| Microphone | first tap of the mic button (voice input / test) | Android `SpeechRecognizer`; also browser capture fallback |
| Camera | first photo capture | camera intent for image analysis (backend performs analysis) |
| Notifications | first notification test / request button | local notifications on Android 13+ |
| Internet | install time | reaching your configured backend |

There is no location, contacts, SMS, background-audio service or accessibility
service. Nothing listens while the app is backgrounded.

## Voice

- **Tap the mic** → Android asks for microphone permission (first time) → the
  core changes to LISTENING and reacts to your actual voice level → your
  transcript appears in the composer → it is submitted.
- Tap the square stop button to cancel recording or stop a reply.
- **Test voice output** and **Test microphone** live in Settings → Voice.
- If recognition is unavailable, the app says so (e.g. no speech service
  installed) rather than pretending to listen.
- Replies are spoken with Android TextToSpeech while “Speak replies aloud” is on.

## Troubleshooting

**“No backend configured” on Chat**
Expected until Settings → Backend is set. Phone commands still work.

**Connection test fails**
- Is the backend running with `--host 0.0.0.0`? See `BACKEND.md`.
- Do not use `127.0.0.1` on the phone — that is the phone itself. Use the PC's
  LAN IP, or `10.0.2.2` in an emulator.
- Check that phone and PC are on the same Wi-Fi and that AP isolation is off.
- Allow TCP/7341 through the host firewall for private networks.
- Prefer HTTPS (reverse proxy or VPN) outside a trusted LAN. The debug APK
  permits plain HTTP for LAN use; a release build requires HTTPS.

**Microphone says permission denied**
Android Settings → Apps → J.A.R.V.I.S. → Permissions → Microphone → Allow. Then
tap **Request microphone access** in Settings.

**No voice output**
Settings → Voice → **Test voice output**. If it reports no engine, install/enable
a system text-to-speech engine. Android TTS works without a backend.

**“Backend unreachable” but the desktop browser works**
The desktop page is same-origin with the backend; the phone is not. Configure
the LAN/relay address explicitly.

**Keyboard covers the composer**
The activity uses `adjustResize`; keep the latest build installed. Report the
device/Android version if it recurs.

**App restarts without the previous chat**
The app preserves chat and settings, but Android may kill a backgrounded app;
reconnect is automatic on resume.

**Diagnostics**
Settings → Diagnostics → **Copy diagnostics** includes platform, backend
target, health/latency, WebSocket state, voice state, microphone permission and
native capability names. `adb logcat` shows `JarvisNative` and Capacitor logs.
