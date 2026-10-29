# Standalone AI architecture (phone-only brain)

Goal: the APK answers, remembers and acts **without a PC, Python backend or
desktop agent**. The FastAPI backend remains optional for desktop-scoped tools.

```
Android APK
├── React/Three.js UI (existing premium shell, Memory tab extended)
├── web/src/lib/ai/
│   ├── catalog.ts     20 providers, protocols, endpoint policy
│   ├── protocols.ts   request builders + response/SSE parsers
│   ├── gateway.ts     roles, retries, budget, key access
│   ├── router.ts      explicit-only fallback
│   ├── agent.ts       bounded tool loop + approval gates
│   ├── store.ts       SQLite memory layers + retrieval
│   ├── evolution.ts   reflections, draft procedures, evaluation, rollback
│   ├── greeting.ts    time/context greetings + idempotency
│   └── index.ts       JarvisAI facade
└── native bridge (JarvisNativePlugin)
    ├── JarvisSecureStore  AES-256-GCM key in AndroidKeyStore
    ├── JarvisDb           app-private SQLite (jarvis_mind.db)
    └── JarvisHttp         HTTPS/SSE via HttpURLConnection
```

## Providers

OpenRouter, Google Gemini, OpenAI, Anthropic, xAI, Z.ai/GLM, NVIDIA NIM,
DeepSeek, Groq, Mistral, Together, Fireworks, Cerebras, Hugging Face, Cohere,
Perplexity, Qwen/DashScope, Moonshot/Kimi, SiliconFlow, DeepInfra — plus a
custom OpenAI-compatible endpoint.

Protocol families, not per-vendor branches:

| Protocol | Providers | Notes |
| --- | --- | --- |
| `openai` | 16 of the catalogue | Chat Completions, tools, vision, SSE |
| `anthropic` | Claude | `system` out-of-band, `tool_use`/`tool_result`, SSE |
| `gemini` | Gemini | `generateContent`, `functionDeclarations`, `alt=sse` |
| `cohere` | Cohere | v2 chat, non-streaming |

The **OpenAI Responses API is not implemented** (different item model); the UI
requires a Chat Completions base URL.

## Request path

1. `ChatScreen` sees a configured provider → `JarvisAI.handle()`.
2. User message is archived; explicit memories are extracted.
3. Context is retrieved within a character budget.
4. `runTurn` calls `gateway.chat` with tool schemas.
5. Tool calls are schema-checked, risk-gated (`notify`, `clipboard_write`,
   `open_url`, `share_text` need confirmation), executed via the existing
   Android action layer, and returned as JSON results.
6. The loop is capped (5 steps by default); the final answer can only claim what
   the tool results prove.
7. Episode + reflection + possible draft procedure are recorded.

## Keys and transport

- Keys: Keystore-encrypted ciphertext in prefs; read only to build a request.
  UI masks input, offers replace/remove, and states that a rooted device can
  observe a key in use.
- Transport: native HTTP because provider APIs do not send CORS headers.
  HTTPS enforced. Cleartext allowed only for loopback/private LAN with the
  explicit development flag.
- Budget: optional daily token cap from `usage`; 0 disables it.
- Fallback: only configs that opted in **and** are enabled, and only when the
  caller allows it. No silent switch to a paid model.

## Failure reporting

401/403 → key/model refused; 404 → model/endpoint; 429 → quota/rate limit;
5xx → provider outage; network/timeout; unsupported tool calling (retried
without tools, with the limitation stated); no provider configured; config
blocked for insecure HTTP. Messages never include the key.

## Deliberately not delivered

- Always-listening wake word / microphone foreground service.
- Streaming rendering in `ChatScreen` (gateway supports and tests SSE).
- WorkManager consolidation scheduler.
- Camera/image analysis through a provider (native capture exists; sending an
  image to a vision model is not wired in this pass).
