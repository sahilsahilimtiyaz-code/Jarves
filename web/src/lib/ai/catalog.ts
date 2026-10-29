/**
 * Provider catalogue for the on-device AI gateway.
 *
 * Every entry is a real, documented public API that accepts an owner-supplied
 * key. Protocol adapters live in `protocols.ts`; this file is pure data so it
 * can be unit-tested in Node and rendered by the provider settings screen.
 *
 * HONESTY RULES
 *  - `capabilities` are conservative defaults. A provider only claims tool
 *    calling when its documented API has function calling; the router checks
 *    the flag before sending tool definitions.
 *  - `suggestedModels` are *examples known to have existed*, never a claim
 *    about the current model list. The UI prefers live model discovery.
 *  - Nothing here contains a key or a default credential.
 */

export type Protocol = "openai" | "anthropic" | "gemini" | "cohere";

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  structured: boolean;
  audioIn: boolean;
  audioOut: boolean;
  reasoning: boolean;
  streaming: boolean;
}

export interface ProviderDef {
  id: string;
  label: string;
  protocol: Protocol;
  /** Base URL without a trailing slash. */
  baseUrl: string;
  /** How the key is attached to the request. */
  auth: "bearer" | "x-api-key" | "x-goog-api-key" | "none";
  /** Path appended to baseUrl for GET model discovery (protocol-dependent). */
  modelsPath?: string;
  /** Path appended to baseUrl for chat (protocol-dependent; Gemini overrides). */
  chatPath?: string;
  /** Example model IDs. Prefer discovery; these are fallbacks for manual entry. */
  suggestedModels: string[];
  capabilities: ModelCapabilities;
  keyHint: string;
  docs: string;
  /** Optional extra request headers required by the provider. */
  headers?: Record<string, string>;
  /** Shown in the provider screen as an operational note. */
  note?: string;
  /** True for the owner-defined OpenAI-compatible endpoint. */
  custom?: boolean;
}

const CAPS = (over: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  tools: true,
  vision: false,
  structured: true,
  audioIn: false,
  audioOut: false,
  reasoning: false,
  streaming: true,
  ...over,
});

const OPENAI_COMPAT = {
  protocol: "openai" as const,
  auth: "bearer" as const,
  modelsPath: "/models",
  chatPath: "/chat/completions",
};

export const PROVIDERS: ProviderDef[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    ...OPENAI_COMPAT,
    baseUrl: "https://openrouter.ai/api/v1",
    suggestedModels: ["openai/gpt-4o-mini", "google/gemini-2.0-flash-001", "anthropic/claude-3.5-sonnet"],
    capabilities: CAPS({ vision: true }),
    keyHint: "sk-or-…",
    docs: "https://openrouter.ai/docs",
    headers: { "HTTP-Referer": "https://jarvis.local", "X-Title": "J.A.R.V.I.S." },
    note: "Aggregator: one key reaches many vendors. Model IDs use the vendor/model form.",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    protocol: "gemini",
    auth: "x-goog-api-key",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelsPath: "/models",
    suggestedModels: ["gemini-2.0-flash", "gemini-1.5-pro"],
    capabilities: CAPS({ vision: true, audioIn: true, reasoning: true }),
    keyHint: "AIza…",
    docs: "https://ai.google.dev/gemini-api/docs",
    note: "Gemini uses generateContent, not Chat Completions; the adapter maps tools and images.",
  },
  {
    id: "openai",
    label: "OpenAI",
    ...OPENAI_COMPAT,
    baseUrl: "https://api.openai.com/v1",
    suggestedModels: ["gpt-4o-mini", "gpt-4o"],
    capabilities: CAPS({ vision: true, reasoning: true }),
    keyHint: "sk-…",
    docs: "https://platform.openai.com/docs/api-reference",
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    protocol: "anthropic",
    auth: "x-api-key",
    baseUrl: "https://api.anthropic.com/v1",
    modelsPath: "/models",
    chatPath: "/messages",
    suggestedModels: ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"],
    capabilities: CAPS({ vision: true, reasoning: true }),
    keyHint: "sk-ant-…",
    docs: "https://docs.anthropic.com/en/api/messages",
    headers: { "anthropic-version": "2023-06-01" },
  },
  {
    id: "xai",
    label: "xAI Grok",
    ...OPENAI_COMPAT,
    baseUrl: "https://api.x.ai/v1",
    suggestedModels: ["grok-2-latest"],
    capabilities: CAPS({ vision: true }),
    keyHint: "xai-…",
    docs: "https://docs.x.ai/docs/api-reference",
  },
  {
    id: "zai",
    label: "Z.ai / GLM",
    ...OPENAI_COMPAT,
    baseUrl: "https://api.z.ai/api/paas/v4",
    suggestedModels: ["glm-4-plus", "glm-4-flash"],
    capabilities: CAPS({ vision: true }),
    keyHint: "API key from z.ai",
    docs: "https://docs.z.ai/",
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    ...OPENAI_COMPAT,
    baseUrl: "https://integrate.api.nvidia.com/v1",
    suggestedModels: ["meta/llama-3.1-70b-instruct"],
    capabilities: CAPS({ vision: true }),
    keyHint: "nvapi-…",
    docs: "https://docs.api.nvidia.com/",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    ...OPENAI_COMPAT,
    baseUrl: "https://api.deepseek.com/v1",
    suggestedModels: ["deepseek-chat", "deepseek-reasoner"],
    capabilities: CAPS({ reasoning: true }),
    keyHint: "sk-…",
    docs: "https://api-docs.deepseek.com/",
  },
  {
    id: "groq",
    label: "Groq",
    ...OPENAI_COMPAT,
    baseUrl: "https://api.groq.com/openai/v1",
    suggestedModels: ["llama-3.3-70b-versatile"],
    capabilities: CAPS({ reasoning: true }),
    keyHint: "gsk_…",
    docs: "https://console.groq.com/docs/api",
  },
  {
    id: "mistral",
    label: "Mistral AI",
    ...OPENAI_COMPAT,
    baseUrl: "https://api.mistral.ai/v1",
    suggestedModels: ["mistral-large-latest", "mistral-small-latest"],
    capabilities: CAPS({ vision: true }),
    keyHint: "API key from console.mistral.ai",
    docs: "https://docs.mistral.ai/api/",
  },
  {
    id: "together",
    label: "Together AI",
    ...OPENAI_COMPAT,
    baseUrl: "https://api.together.xyz/v1",
    suggestedModels: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"],
    capabilities: CAPS({ vision: true }),
    keyHint: "API key from together.ai",
    docs: "https://docs.together.ai/reference",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    ...OPENAI_COMPAT,
    baseUrl: "https://api.fireworks.ai/inference/v1",
    suggestedModels: ["accounts/fireworks/models/llama-v3p3-70b-instruct"],
    capabilities: CAPS({ vision: true }),
    keyHint: "fw_…",
    docs: "https://docs.fireworks.ai/api-reference",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    ...OPENAI_COMPAT,
    baseUrl: "https://api.cerebras.ai/v1",
    suggestedModels: ["llama3.3-70b"],
    capabilities: CAPS(),
    keyHint: "csk-…",
    docs: "https://inference-docs.cerebras.ai/",
  },
  {
    id: "huggingface",
    label: "Hugging Face Inference",
    ...OPENAI_COMPAT,
    baseUrl: "https://router.huggingface.co/v1",
    suggestedModels: ["meta-llama/Llama-3.1-8B-Instruct"],
    capabilities: CAPS(),
    keyHint: "hf_…",
    docs: "https://huggingface.co/docs/api-inference/",
  },
  {
    id: "cohere",
    label: "Cohere",
    protocol: "cohere",
    auth: "bearer",
    baseUrl: "https://api.cohere.com/v2",
    modelsPath: "/models",
    chatPath: "/chat",
    suggestedModels: ["command-r-plus", "command-r"],
    capabilities: {
      ...CAPS({ streaming: false }),
      structured: false,
    },
    keyHint: "API key from dashboard.cohere.com",
    docs: "https://docs.cohere.com/reference/chat",
    note: "Streaming is disabled for this adapter; responses arrive complete.",
  },
  {
    id: "perplexity",
    label: "Perplexity",
    ...OPENAI_COMPAT,
    baseUrl: "https://api.perplexity.ai",
    suggestedModels: ["sonar", "sonar-pro"],
    capabilities: { ...CAPS(), tools: false },
    keyHint: "pplx-…",
    docs: "https://docs.perplexity.ai/api-reference/chat-completions",
    note: "Online search is provider-native; use the web-search tool for other providers.",
  },
  {
    id: "qwen",
    label: "Alibaba Qwen / DashScope",
    ...OPENAI_COMPAT,
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    suggestedModels: ["qwen-plus", "qwen-max"],
    capabilities: CAPS({ vision: true }),
    keyHint: "sk-…",
    docs: "https://www.alibabacloud.com/help/en/model-studio/",
    note: "International compatible-mode endpoint. Mainland accounts may need the cn region URL.",
  },
  {
    id: "moonshot",
    label: "Moonshot AI / Kimi",
    ...OPENAI_COMPAT,
    baseUrl: "https://api.moonshot.ai/v1",
    suggestedModels: ["moonshot-v1-8k"],
    capabilities: CAPS(),
    keyHint: "sk-…",
    docs: "https://platform.moonshot.ai/docs",
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    ...OPENAI_COMPAT,
    baseUrl: "https://api.siliconflow.cn/v1",
    suggestedModels: ["Qwen/Qwen2.5-72B-Instruct"],
    capabilities: CAPS({ vision: true }),
    keyHint: "sk-…",
    docs: "https://docs.siliconflow.cn/",
  },
  {
    id: "deepinfra",
    label: "DeepInfra",
    ...OPENAI_COMPAT,
    baseUrl: "https://api.deepinfra.com/v1/openai",
    suggestedModels: ["meta-llama/Meta-Llama-3.1-70B-Instruct"],
    capabilities: CAPS({ vision: true }),
    keyHint: "API key from deepinfra.com",
    docs: "https://deepinfra.com/docs/openai_api",
  },
];

/** Owner-defined endpoint. Fields are filled in from the settings screen. */
export const CUSTOM_PROVIDER: ProviderDef = {
  id: "custom",
  label: "Custom (OpenAI-compatible)",
  ...OPENAI_COMPAT,
  baseUrl: "",
  suggestedModels: [],
  capabilities: CAPS(),
  keyHint: "Key for your endpoint",
  docs: "Provider documentation",
  custom: true,
  note: "Any Chat Completions-compatible endpoint. Insecure HTTP is refused unless explicitly allowed.",
};

export function providerById(id: string): ProviderDef | undefined {
  if (id === CUSTOM_PROVIDER.id) return CUSTOM_PROVIDER;
  return PROVIDERS.find((p) => p.id === id);
}

/** Join a base URL and a path without doubling or dropping the slash. */
export function joinUrl(base: string, path: string): string {
  const cleanBase = (base || "").replace(/\/+$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${cleanBase}${cleanPath}`;
}

/**
 * Normalise a pasted base URL. Returns "" when it cannot be a provider origin.
 * Paths are preserved (some providers live under /v1/openai).
 */
export function normalizeBaseUrl(input: string): string {
  const raw = (input || "").trim();
  if (!raw) return "";
  let withScheme = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) withScheme = `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (!url.hostname || url.hostname.includes(" ")) return "";
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host.toLowerCase()}${url.port ? `:${url.port}` : ""}${path}`;
  } catch {
    return "";
  }
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|10\.0\.2\.2)$/i;

/**
 * Transport policy. Remote endpoints must be HTTPS: a phone on a café Wi-Fi
 * must not send an API key over cleartext. Loopback and private LAN hosts are
 * allowed only when the owner explicitly enabled insecure development mode.
 */
export function isEndpointAllowed(url: string, allowInsecure = false): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  if (!allowInsecure) return false;
  const host = parsed.hostname;
  return LOOPBACK.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

/** Ordered fallback of an OpenAI-compatible message role for storage. */
export const PROVIDER_COUNT = PROVIDERS.length;
