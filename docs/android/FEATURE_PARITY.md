# JARVIS Android — Feature Parity Report

This document states, feature by feature, what happens to every part of the
original J.A.R.V.I.S. desktop project when it runs inside the Android APK —
and by extension in every other way the web HUD is served (Electron desktop,
plain browser). It is the contract for the "no silent feature loss" rule of
this port: nothing was deleted or faked, and every gap is listed openly.

## Scope and method

- Audited the real source: `jarvis/` (FastAPI backend) and `web/` (React HUD).
- Every hard-coded URL construction site in the front-end was enumerated and
  is now routed through the backend resolver (`web/src/lib/backend.ts`).
- Android code is additive only: the desktop Electron shell, its preload
  bridge, all panels, the Three.js arc reactor, and the backend itself are
  unmodified. Git diffs of the port consist of new files plus a small number
  of additive edits, itemized below.

## Runtime modes (be honest about what is reachable from a phone)

| Mode | Meaning | What runs |
|------|---------|-----------|
| **A — connected backend** | The HUD (APK, desktop or browser tab) reaches a running JARVIS backend (same computer, LAN, emulator or an HTTPS relay) | Full tool set of that backend host executes there: LLM chat, all 80+ tools, media pipelines, memory, agents, Windows/PC integration |
| **B — connected desktop** | A is up and the backend host is the user's Windows desktop | Additionally the features that shell out to that desktop: PowerShell, Desktop-folder services, TRELLIS/Hunyuan local renders — all CPU/live-drive work happens on the desktop, not on the phone |
| **C — Android-only** | No backend configured (fresh APK install) | The HUD boots, remembers settings, shows a clear "backend required" state on every backend surface; NO tool runs, NO results are mocked |

## Classification legend

- **PRESERVED** — identical in behaviour and bindings everywhere.
- **ANDROID-ADAPTED** — same capability, new platform plumbing (URLs, permissions, sheets, downloads).
- **BACKEND-DEPENDENT** — requires Mode A; fails *honestly* in Mode C.
- **CONNECTED-DESKTOP-DEPENDENT** — requires the backend host to be the user's computer (Mode B).
- **ABSENT** — does not exist on Android; stated, not faked.

## Front-end HUD & visual experience

| Feature | Class | Notes |
|---------|-------|-------|
| Three.js arc reactor (WebGL) | PRESERVED | Same component, same shaders/animations. Hidden only on coarse-pointer phones? No — the **Reticle** (aim follower) is hidden on touch pointers (`hidden [@media(pointer:fine)]:block`); the reactor is kept |
| Reactor status orb (idle/thinking/speaking) | PRESERVED | Driven by the same WS events |
| Ambience blobs / CSS engine | ANDROID-ADAPTED | Blur radius reduced on the phone tier, `prefers-reduced-motion` rules unified; visual language intact |
| Chat window, streaming, markdown | PRESERVED | Same components, same WS `stream_begin/delta/end` contract |
| Command bar + attachments | ANDROID-ADAPTED | Uploads now target the configured backend (`apiUrl`); attachment removal uses tap-friendly `reveal-on-touch` |
| Media Bay / Media Hub / Lightbox | ANDROID-ADAPTED | Media URLs resolve against the backend (`backendUrl(item.url)`); in Mode C they show honest empty/require states |
| 3D model viewer (GLB) | ANDROID-ADAPTED | Viewer identical; **download** on Android routes through the platform share sheet because the WebView has no download manager |
| Neural Galaxy (canvas) | PRESERVED | Same lazy chunk, fed by the same `media` kind=galaxy events |
| Tool Feed / Terminal / Plan / Swarm / Mission Log panels | PRESERVED | Same components; on <900 px screens they are reachable from the new bottom chip rail (see Android UX below) |
| Settings panel | ANDROID-ADAPTED | Additive **Backend** section (Android only) to set/validate the backend URL; every other setting untouched |
| Splash screen & launcher icon | ANDROID-ADAPTED | Ink-dark splash + arc-reactor adaptive icons, HUD palette colors |

## Android-only UX layer (additive)

| Feature | Class | Notes |
|---------|-------|-------|
| Bottom chip rail + full-screen sheets (mobile <900 px) | NEW | `MobileSheets.tsx` mounts the *original* components inside sheets — no mobile clones |
| Backend URL editor + status probe | NEW (Android only) | Stored in `localStorage["jarvis.backend.url"]`; probe hits `/api/health` |
| Safe-area insets (notch/nav bar) | NEW | `viewport-fit=cover` + inline `env(safe-area-inset-*)` paddings |
| Link interception for external http(s) | NEW | Android adapter opens external links in the phone browser |
| Foreground-resume reconnect | NEW | App resume + backend-change events trigger `wsClient.reconnectNow()` |
| Desktop layout ≥900 px | PRESERVED | Exact original desktop layout; the mobile branch is an additive screen-width branch in `App.tsx` |

## Voice pipeline

| Feature | Class | Notes |
|---------|-------|-------|
| Push-to-talk STT (mic → recorder → backend `/api/stt`) | ANDROID-ADAPTED | Mic button pre-requests `RECORD_AUDIO` (runtime, denyable); audio still transcribed by the backend (Whisper on the backend host) |
| TTS playback (`/api/voice/*` streaming) | ANDROID-ADAPTED | Requests routed via backend URL; the backend's voice profile selection is used as-is |
| Wake word ("Hey JARVIS") | PRESERVED (in-app), **ABSENT (background)** | Matching of wake phrases on live transcripts is unchanged **while the app is foreground and mic-armed**. There is NO always-on background listening: the WebView has no service-role mic capability and this port deliberately did **not** add a foreground-service recorder. Do not rely on wake-word while the app is backgrounded |
| Browser SpeechSynthesis fallback voice | ANDROID-ADAPTED | On Android WebView, `speechSynthesis` exists but is often headless-silent; the UI prefers backend TTS. This absence was known and is documented, not worked around with fake motion |
| TTS→mic auto-mute (don't transcribe ourselves) | PRESERVED | `onTtsStart` hook unchanged |
| Cancel speech / interrupt | PRESERVED | Same `cancel` WS message |

## Tool execution (the 80+ tool backend)

All of the backend tool registry (~83 tools across 15 plugin modules), the
SAFE/CAUTION/DANGEROUS permission tiers, confirm flow, slash commands,
intents and the 9 agents are **BACKEND-DEPENDENT (Mode A)** — they execute on
the backend host via the same WebSocket contract
(`ping/info/error/assistant/stream*/thinking/tool_proposed/task_*/tool_result/media/plan/suggestions/confirm_request/done`).
In Mode C the tool surfaces display "backend required" and send nothing; the
APK contains **no mocked tool results**.

The subset that additionally requires the backend host to be the user's
Windows desktop (**CONNECTED-DESKTOP-DEPENDENT (Mode B)**), because the
plugins hard-code the host machine — deliberately preserved as-is, documented
here rather than "ported" onto the phone:

| Tool / plugin | Host dependency (unchanged) |
|---------------|------------------------------|
| `system` / `shell` | PowerShell command execution on the backend host |
| Tesseract OCR | `C:\Program Files\Tesseract OCR\tesseract.exe` on the host |
| TRELLIS.2 / Hunyuan3D image→3D | Host-side Python venv (`venv/Scripts/python.exe`) rendering |
| Desktop-folder media tools | `%USERPROFILE%\Desktop` on the host |
| Windows power control | Host OS session |
| Intent router PC-parlance ("open on PC", etc.) | Executes on the host |

**Not implemented (and not faked):** phone-local equivalents of these (e.g.
an AccessibilityService that mirrors PC control onto the phone). The phone is
a *controller + display*; automation actions run on the connected machine.

## Heavy AI/media pipelines (Mode A)

| Feature | Where it runs | APK impact |
|---------|---------------|-----------|
| LLM chat (Ollama/compatible) | backend host | none — chat is WS |
| Whisper STT | backend host | mic capture only |
| FLUX image generation | backend host | only generated PNGs are downloaded and displayed |
| TRELLIS.2 / Hunyuan3D GLB | backend host only | GLB streamed to the viewer |
| GLB viewing | in-app WebView (WebGL) | PRESERVED, lazy chunk |
| Browser/web search, page reading, media search | backend host | results rendered by the same components |
| SQLite long-term memory, memory galaxy | backend host (`data/memory.db`) | rendered remotely |
| Plan & reflect, agent swarm/parallel tasks | backend host | swarm progress mirrored per-task into the store (additive `swarm_id` mirroring in `ws.ts`) |
| Webcam/OCR vision | phone camera capture → backend | `CAMERA` runtime permission; front camera preferred on phones |
| CLI delegation / external agents | backend host | unchanged |

**None of these models ship inside the APK** — the APK is ~a few MB of HUD,
not gigabytes of model weights. Backends serve the models.

## Backend connectivity layer

| Aspect | Status |
|--------|--------|
| Same-origin URLs (desktop & vanilla browser) | PRESERVED — empty base URL means every endpoint path is untouched, exactly like the original build |
| Configurable backend base (Android/LAN/HTTPS) | NEW — `lib/backend.ts`: `normalizeBackendUrl` (scheme defaulting, trailing-path strip), `apiUrl`, `wsUrl` (http→ws / https→wss), `probeBackend` (`/api/health`), change events |
| WebSocket reconnection | ANDROID-ADAPTED — capped backoff (1.5→3.75→6 s), resume-triggered immediate reconnect, Android gate that does **not** dial the app-shell origin with no backend configured |
| CORS | backend already `allow_origins=["*"]` — no backend change needed |
| HTTPS / auth | **none in this project**: the backend binds plain HTTP, CLI-only (`--host/--port`), no token. Documented mitigations in `BACKEND.md` (HTTPS reverse proxy, Tailscale, firewall scoping); no secrets are embedded in the APK |
| Cleartext traffic | Debug APK allows plain-HTTP LAN traffic (debug-manifest only); release builds must not and will not |

## What is deliberately left desktop-only

- The Electron-specific preload API (`window.jarvis`) and every code path
  that uses it — detection prefers `electron` when the bridge exists.
- Desktop window controls/tray behaviour, power users' `.bat` launchers.
- Host-filesystem tool execution (see Mode B list above).

## File map of the port (for reviewers)

New (`web/src`): `lib/backend.ts`, `lib/backoff.ts`, `platform/{types,detect,web,android,index}.ts`,
`components/HUD/MobileSheets.tsx`. Tests: `web/tests/platform.test.mjs`.
Android project: `web/android/` (Capacitor-generated + manifest/permissions/icon/splash customization).
CI: `.github/workflows/android-apk.yml`.
Additive edits: `App.tsx` (boot init + mobile branch + link interceptor),
`Settings.tsx` (BackendSection), `CommandBar.tsx`, `voice.ts`, `api.ts`,
`Model3DViewer.tsx`, `WebcamFeed.tsx`, `ws.ts` (URL/adapter/backoff plumbing +
same handlers), `globals.css`, `index.html` (`viewport-fit`).

## Known limitations (true at time of writing)

1. Wake word listening only works app-foreground (see Voice).
2. APK is debug-signed, cleartext-permitted for LAN backends; produce a
   release build for store-style distribution (no signing key is embedded —
   a release needs your own keystore).
3. `permissions.mode: bypass` in the backend `config.yaml` means CAUTION/DANGEROUS
   tools execute without confirmation prompts when a backend accepts them.
   That is a **backend security posture**, not an Android side effect — but
   anyone able to reach the backend port can drive it. Scope it (firewall /
   Tailscale) and read `BACKEND.md` before putting it on a shared LAN.
4. The Android WebView's `speechSynthesis` voices are device-dependent; when
   absent the HUD silently prefers backend TTS (real limitation, no motion-
   faking voice bars).
5. Local WebSocket `ping` keepalive, attachment previews and focus behaviour
   reproduce the desktop contract; exotic downloads (multi-file) still
   default to the share sheet one file at a time.
