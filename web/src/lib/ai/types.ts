/** Shared gateway types (kept separate so router/agent do not import gateway). */
import type { ChatResult, ToolSpec, WireMessage } from "./protocols";

export type RoleKey = "default" | "fast" | "reasoning" | "vision" | "fallback";

export interface ProviderConfig {
  id: string;
  /** Catalogue id (`openrouter`, `gemini`, … or `custom`). */
  provider: string;
  label: string;
  /** Base URL override; for custom providers this is required. */
  baseUrl: string;
  model: string;
  roles: RoleKey[];
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Explicit opt-in for using this config when the primary fails. */
  allowFallback: boolean;
  /** Only for loopback/LAN OpenAI-compatible endpoints during development. */
  allowInsecure: boolean;
  enabled: boolean;
  lastTest?: { ok: boolean; at: number; message: string; latencyMs?: number };
}

export interface KeyVault {
  readonly kind: "android-keystore" | "memory";
  set(id: string, key: string): Promise<void>;
  get(id: string): Promise<string>;
  remove(id: string): Promise<void>;
}

export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  allowInsecure?: boolean;
}

export interface HttpResult {
  status: number;
  body: string;
}

export interface Transport {
  readonly kind: "native" | "fetch";
  request(req: HttpRequest): Promise<HttpResult>;
  /** Streams raw bytes; resolves when the connection finishes. */
  stream(req: HttpRequest, onChunk: (chunk: string) => void, registerAbort?: (abort: () => void) => void): Promise<HttpResult>;
}

export type AiErrorCode =
  | "config"
  | "network"
  | "auth"
  | "quota"
  | "model"
  | "provider"
  | "budget"
  | "aborted"
  | "blocked";

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(code: AiErrorCode, message: string, options: { retryable?: boolean; status?: number } = {}) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.retryable = options.retryable ?? (code === "network" || code === "provider");
    this.status = options.status;
  }
}

export interface ChatOutcome {
  result: ChatResult;
  config: ProviderConfig;
  providerLabel: string;
  latencyMs: number;
  streamed: boolean;
}

export interface ChatOptions {
  configId?: string;
  role?: RoleKey;
  messages: WireMessage[];
  tools?: ToolSpec[];
  system?: string;
  onDelta?: (text: string) => void;
  maxTokens?: number;
  temperature?: number;
  /** Explicitly allow configured fallback configs for this request. */
  allowFallback?: boolean;
}

export const ROLE_LABELS: Record<RoleKey, string> = {
  default: "Conversation",
  fast: "Fast replies",
  reasoning: "Deep reasoning",
  vision: "Vision",
  fallback: "Fallback",
};

export function errorCodeForStatus(status: number): AiErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "model";
  if (status === 429) return "quota";
  if (status >= 500) return "provider";
  return "provider";
}
