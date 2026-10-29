# JARVIS Android — Backend Requirements

The APK is a *client*. Brain, memory, media pipelines and PC integration all
live in the FastAPI backend in the `jarvis/` folder of this repository — the
same one the desktop Electron app talks to. Nothing about the backend
changes for this port; this doc only explains how phones reach it and what
becomes available in each mode.

## Start the backend so a phone can reach it

The backend does not listen on the network by default (CLI-only binding):

```bash
# Windows / desktop that will do the automation:
python -m jarvis --host 0.0.0.0 --port 7341
# or run.bat / run-app.bat as set up in this repo (see README)
```

- Find the desktop's LAN IP (`ipconfig`): e.g. `192.168.1.20`.
- On the phone: Settings → Backend → `192.168.1.20:7341`.
- Android **emulator** special-case: the host is `10.0.2.2` on the emulated
  NAT network — use `10.0.2.2:7341`.

What the backend must expose (unchanged contract):
- `GET /api/health`, `GET /api/stats` (HUD status),
- WebSocket `/ws` (chat/stream/tool/task/media/plan/confirm events),
- `POST /api/stt` + voice/TTS routes for the voice pipeline,
- `/media/*` and generated asset routes referenced by chat cards,
- `/api/reader` and friends for the reading/search surfaces.

All of these are served by the same backend the desktop uses — version,
tools and data stay in one place.

## Transport reality check (read this)

The original backend ships **plain HTTP with no token and no HTTPS**, and
CORS `allow_origins=["*"]`. This port did not change that. Consequences:

- Inside your **own trusted LAN** this matches the original desktop setup.
- Putting the backend on the public internet as raw HTTP is unsafe.
- Additionally, the backend's `config.yaml` has `permissions.mode: bypass`
  by default in this repository — CAUTION/DANGEROUS tools run without an
  interactive confirm prompt. Combined with an open port, that is real
  power. Scope it.

Recommended setups, in order of preference:

1. **Tailscale/WireGuard** — phone joins your tailnet; the backend binds
   `0.0.0.0` but is only reachable through the tunnel. Best easy security on
   the road.
2. **HTTPS reverse proxy** — caddy/nginx + Let's Encrypt (or an internal CA)
   in front of port 7341. The phone then uses an `https://` address;
   WebSocket upgrades to `wss://` automatically.
3. **Home LAN + firewall scoping** — allow port 7341 only from your own
   devices; router AP-**isolation off** for your phone/desktop pair
   *on purpose*.

## Transport on the APK side

- The debug APK permits cleartext (plain-HTTP) traffic, through a
  `src/debug` manifest overlay only, because your LAN backend has no TLS.
- A release APK does NOT permit cleartext: an HTTPS address is required
  (build one with your own keystore — see `android/app/src/debug` comments).
- No secrets/tokens/keys are embedded in the app: connection info is what
  you type in Settings, stored in the WebView's local storage under
  `jarvis.backend.url` and never synced anywhere.

## What works per connection mode

| Capability | Mode C (no backend) | Mode A (any backend) | Mode B (backend on your Windows PC) |
|---|---|---|---|
| Chat with the LLM | – | ✅ | ✅ |
| All 80+ backend tools (web, files, media gen, memory, …) | – | ✅ on backend host | ✅ on the PC |
| Voice input | ✅ Android `SpeechRecognizer` (on-device/Google service) | ✅ (native, or Whisper fallback in a browser) | ✅ |
| Voice output | ✅ Android `TextToSpeech` | ✅ native TTS or backend `/api/tts` | ✅ |
| Phone actions (apps, settings, battery, clipboard, notifications, camera/file pickers) | ✅ native Android APIs | ✅ | ✅ |
| Local memory notes | ✅ on-device (`jarvis.memory.local.v1`) | ✅ | ✅ |
| Whisper STT on the backend | – | ✅ | ✅ |
| Shell/PowerShell, Desktop-folder tools, OCR, TRELLIS/Hunyuan 3D, power control | – | Only if the host machine has those (per plugin code) | ✅ full desktop integration |
| Wake word | – | – (foreground only in the desktop HUD) | – |
| UI/settings | ✅ | ✅ | ✅ |

Chat and backend tools require a reachable backend. Native voice and phone
services do not — the app reports each capability honestly.

Tool execution always happens **on the backend host**. The phone never runs
the automation locally (no AccessibilityService etc.) — that design keeps the
phone a controller/terminal rather than a second JARVIS machine.

## Backend hardware notes

The heavy paths (FLUX, Hunyuan/TRELLIS, Whisper) are the same GPU-bound jobs
as the desktop uses; the phone adds nothing to their load except downloading
the small finished media. If those already work on your desktop, the phone
experience works.

## FAQ

**Does the APK work with zero backend?**
Yes — Mode C includes the mobile UI, the WebGL core, native speech recognition
and Android TextToSpeech, real phone actions and local memory notes. Chat,
backend tools, Whisper and backend memory show a truthful “backend required”
state. Nothing is faked.

**Is my backend now exposed to the internet because of the Android app?**
No. The APK dials you; it exposes nothing. Your exposure is set by the
backend bind/relay you choose.

**Auth?**
Not part of the project (neither desktop nor Android). Keep the backend off
the public internet; use the tunnel/proxy patterns above.

**Why can native speech work without the backend?**
Android `SpeechRecognizer` and `TextToSpeech` are OS services, bridged by
`JarvisNativePlugin`. The backend Whisper/TTS routes remain the fallback in a
browser and the preferred high-quality engine when reachable. No audio is
uploaded unless the browser fallback (`POST /api/stt`) is used.

**Where are phone actions executed?**
On the phone, through documented Android intents/APIs. Backend tools execute on
the backend host. The Tools screen labels the execution location of every tool,
and no natural-language output can execute a shell command on the phone.
