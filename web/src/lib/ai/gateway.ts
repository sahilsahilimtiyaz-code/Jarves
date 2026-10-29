/**
 * On-device provider gateway.
 *
 * The phone talks to providers directly: no PC, no Python server, no proxy.
 * Keys live in Android Keystore-backed storage (native `JarvisSecureStore`)
 * and are read only to build a request; they never reach the database, the
 * Zustand store, logs or the export file.
 *
 * Transport is native (HttpURLConnection) because provider APIs do not send
 * CORS headers — a WebView `fetch` would be blocked. On desktop/web the same
 * gateway falls back to `fetch`, where CORS may still refuse; that failure is
 * reported honestly rather than hidden.
 */
import * as native from "../../platform/native";
import { isEndpointAllowed, providerById, normalizeBaseUrl, type ProviderDef } from "./catalog";
import {
  buildChatRequest,
  buildModelsRequest,
  createStreamAccumulator,
  describeHttpError,
  parseChatResponse,
  parseModels,
} from "./protocols";
import { selectChain } from "./router";
import type { MemoryStore } from "./store";
import {
  AiError,
  errorCodeForStatus,
  type ChatOptions,
  type ChatOutcome,
  type HttpRequest,
  type HttpResult,
  type KeyVault,
  type ProviderConfig,
  type RoleKey,
  type Transport,
} from "./types";

const CONFIG_KEY = "ai.providers.v1";
const VAULT_PREFIX = "jarvis.provider.";

// ── Vault ──────────────────────────────────────────────────────────────────

const memoryKeys = new Map<string, string>();

function memoryVault(): KeyVault {
  return {
    kind: "memory",
    async set(id, key) {
      memoryKeys.set(id, key);
    },
    async get(id) {
      return memoryKeys.get(id) || "";
    },
    async remove(id) {
      memoryKeys.delete(id);
    },
  };
}

function keystoreVault(): KeyVault {
  return {
    kind: "android-keystore",
    async set(id, key) {
      await native.secureSet(`${VAULT_PREFIX}${id}`, key);
    },
    async get(id) {
      const result = await native.secureGet(`${VAULT_PREFIX}${id}`);
      return result?.value || "";
    },
    async remove(id) {
      await native.secureRemove(`${VAULT_PREFIX}${id}`);
    },
  };
}

// ── Transport ──────────────────────────────────────────────────────────────

function nativeTransport(): Transport {
  return {
    kind: "native",
    async request(req: HttpRequest): Promise<HttpResult> {
      const res = await native.httpRequest({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body ?? "",
        timeoutMs: req.timeoutMs ?? 60_000,
        allowInsecure: Boolean(req.allowInsecure),
      });
      return { status: Number(res?.status) || 0, body: String(res?.body ?? "") };
    },
    stream(req, onChunk, registerAbort) {
      return new Promise<HttpResult>(async (resolve, reject) => {
        let streamId = "";
        const offs: (() => void)[] = [];
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          for (const off of offs) off();
          fn();
        };
        try {
          const started = await native.httpStreamStart({
            url: req.url,
            method: req.method,
            headers: req.headers,
            body: req.body ?? "",
            timeoutMs: req.timeoutMs ?? 120_000,
            allowInsecure: Boolean(req.allowInsecure),
          });
          streamId = String(started?.streamId || "");
          if (!streamId) throw new Error("The native stream did not return an id.");
        } catch (e) {
          reject(new AiError("network", e instanceof Error ? e.message : "The native network layer is unavailable."));
          return;
        }
        registerAbort?.(() => {
          void native.httpAbort({ streamId }).catch(() => undefined);
        });
        let body = "";
        offs.push(
          native.onNative("httpChunk", (data: any) => {
            if (data?.streamId !== streamId) return;
            const chunk = String(data.chunk ?? "");
            body += chunk;
            try {
              onChunk(chunk);
            } catch {
              /* consumer failures must not kill the socket */
            }
          }),
        );
        offs.push(
          native.onNative("httpDone", (data: any) => {
            if (data?.streamId !== streamId) return;
            finish(() => resolve({ status: Number(data.status) || 0, body }));
          }),
        );
        offs.push(
          native.onNative("httpError", (data: any) => {
            if (data?.streamId !== streamId) return;
            finish(() => reject(new AiError("network", String(data.message || "The streaming request failed."))));
          }),
        );
      });
    },
  };
}

function fetchTransport(): Transport {
  return {
    kind: "fetch",
    async request(req) {
      if (!isEndpointAllowed(req.url, req.allowInsecure)) {
        throw new AiError("blocked", "That endpoint uses insecure HTTP. Enable the development option or use HTTPS.");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 60_000);
      try {
        const response = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body || undefined,
          signal: controller.signal,
        });
        return { status: response.status, body: await response.text() };
      } catch (e) {
        throw new AiError("network", e instanceof Error ? e.message : "The request failed.");
      } finally {
        clearTimeout(timer);
      }
    },
    async stream(req, onChunk, registerAbort) {
      if (!isEndpointAllowed(req.url, req.allowInsecure)) {
        throw new AiError("blocked", "That endpoint uses insecure HTTP. Enable the development option or use HTTPS.");
      }
      const controller = new AbortController();
      registerAbort?.(() => controller.abort());
      const response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body || undefined,
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      if (!reader) return { status: response.status, body: await response.text() };
      const decoder = new TextDecoder();
      let body = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        body += chunk;
        onChunk(chunk);
      }
      return { status: response.status, body };
    },
  };
}

// ── Gateway ────────────────────────────────────────────────────────────────

export interface UpsertProviderInput {
  id?: string;
  provider: string;
  label?: string;
  baseUrl?: string;
  model: string;
  roles?: RoleKey[];
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
  allowFallback?: boolean;
  allowInsecure?: boolean;
  enabled?: boolean;
  apiKey?: string;
}

export interface ConnectionTest {
  ok: boolean;
  message: string;
  latencyMs: number | null;
  models?: { id: string; label: string }[];
}

export class AIGateway {
  private configs: ProviderConfig[] = [];
  private loaded = false;
  private vaultPromise: Promise<KeyVault> | null = null;
  private transportPromise: Promise<Transport> | null = null;
  private activeAbort: (() => void) | null = null;

  constructor(private readonly store: MemoryStore) {}

  private async vault(): Promise<KeyVault> {
    if (!this.vaultPromise) {
      this.vaultPromise = (async () => {
        const available = await native.nativeAvailable().catch(() => false);
        return available ? keystoreVault() : memoryVault();
      })();
    }
    return this.vaultPromise;
  }

  private async transport(): Promise<Transport> {
    if (!this.transportPromise) {
      this.transportPromise = (async () => {
        const available = await native.nativeAvailable().catch(() => false);
        return available ? nativeTransport() : fetchTransport();
      })();
    }
    return this.transportPromise;
  }

  /** Honest storage label for the settings screen. */
  async storageKind(): Promise<"android-keystore" | "memory"> {
    return (await this.vault()).kind;
  }

  async load(force = false): Promise<ProviderConfig[]> {
    if (this.loaded && !force) return this.configs;
    const stored = await this.store.getSetting<ProviderConfig[]>(CONFIG_KEY, []);
    this.configs = Array.isArray(stored) ? stored.filter((config) => config && config.id && config.model) : [];
    this.loaded = true;
    return this.configs;
  }

  list(): ProviderConfig[] {
    return [...this.configs];
  }

  find(id: string | undefined): ProviderConfig | undefined {
    return this.configs.find((config) => config.id === id);
  }

  async upsert(input: UpsertProviderInput): Promise<ProviderConfig> {
    await this.load();
    const def = providerById(input.provider);
    if (!def) throw new AiError("config", `Unknown provider “${input.provider}”.`);
    const model = (input.model || "").trim();
    if (!model) throw new AiError("config", "Choose a model ID before saving.");

    const allowInsecure = Boolean(input.allowInsecure);
    const base = normalizeBaseUrl(input.baseUrl || def.baseUrl);
    if (!base) {
      throw new AiError("config", "Enter a valid base URL (https unless you enabled the development HTTP option).");
    }
    if (!isEndpointAllowed(base, allowInsecure)) {
      throw new AiError(
        "blocked",
        "Provider endpoints must use HTTPS. Cleartext HTTP is only accepted for loopback/LAN development when explicitly enabled.",
      );
    }
    if (def.custom && !/^https?:\/\//i.test(base)) {
      throw new AiError("config", "Custom providers need a full base URL.");
    }

    const existing = input.id ? this.find(input.id) : undefined;
    const config: ProviderConfig = {
      id: existing?.id || `cfg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      provider: def.id,
      label: (input.label || def.label).trim().slice(0, 60),
      baseUrl: base,
      model,
      roles: (input.roles && input.roles.length ? input.roles : ["default"]).filter(Boolean) as RoleKey[],
      stream: input.stream ?? existing?.stream ?? def.capabilities.streaming,
      maxTokens: input.maxTokens ?? existing?.maxTokens,
      temperature: input.temperature ?? existing?.temperature,
      allowFallback: input.allowFallback ?? existing?.allowFallback ?? false,
      allowInsecure,
      enabled: input.enabled ?? existing?.enabled ?? true,
      lastTest: existing?.lastTest,
    };

    const next = existing
      ? this.configs.map((candidate) => (candidate.id === config.id ? config : candidate))
      : [...this.configs, config];
    await this.save(next);
    if (input.apiKey !== undefined) {
      const key = input.apiKey.trim();
      if (key) await (await this.vault()).set(config.id, key);
      else await (await this.vault()).remove(config.id);
    }
    await this.store.logEvent("provider", `Provider ${existing ? "updated" : "added"}: ${config.label}`, config.model);
    return config;
  }

  private async save(configs: ProviderConfig[]): Promise<void> {
    this.configs = configs;
    this.loaded = true;
    await this.store.setSetting(CONFIG_KEY, configs);
  }

  async remove(id: string): Promise<void> {
    await this.load();
    await (await this.vault()).remove(id);
    await this.save(this.configs.filter((config) => config.id !== id));
    await this.store.logEvent("provider", "Provider removed", id);
  }

  async hasKey(id: string): Promise<boolean> {
    return Boolean((await (await this.vault()).get(id)).trim());
  }

  async setKey(id: string, key: string): Promise<void> {
    const clean = key.trim();
    if (!clean) await (await this.vault()).remove(id);
    else await (await this.vault()).set(id, clean);
  }

  async clearKey(id: string): Promise<void> {
    await (await this.vault()).remove(id);
  }

  private def(config: ProviderConfig): ProviderDef {
    const def = providerById(config.provider);
    if (!def) throw new AiError("config", `Provider “${config.provider}” is no longer supported.`);
    return def;
  }

  private async keyFor(config: ProviderConfig, def: ProviderDef): Promise<string> {
    const key = (await (await this.vault()).get(config.id)).trim();
    if (!key && def.auth !== "none") {
      throw new AiError("config", `No API key is stored for ${config.label}. Add one in Provider settings.`);
    }
    return key;
  }

  private async guardUrl(url: string, allowInsecure: boolean): Promise<void> {
    if (!isEndpointAllowed(url, allowInsecure)) {
      throw new AiError("blocked", "That endpoint uses insecure HTTP. Use HTTPS (or enable the development option for LAN hosts).");
    }
  }

  async discoverModels(id: string): Promise<{ id: string; label: string }[]> {
    await this.load();
    const config = this.find(id);
    if (!config) throw new AiError("config", "That provider is not configured.");
    const def = this.def(config);
    const key = await this.keyFor(config, def);
    const built = buildModelsRequest(def, config.baseUrl, key);
    await this.guardUrl(built.url, config.allowInsecure);
    const response = await (await this.transport()).request({
      url: built.url,
      method: "GET",
      headers: built.headers,
      allowInsecure: config.allowInsecure,
      timeoutMs: 25_000,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new AiError(
        errorCodeForStatus(response.status),
        describeHttpError(response.status, response.body),
        { status: response.status },
      );
    }
    try {
      return parseModels(def, JSON.parse(response.body));
    } catch {
      throw new AiError("provider", "The provider returned a model list this adapter could not read.");
    }
  }

  async test(id: string): Promise<ConnectionTest> {
    await this.load();
    const config = this.find(id);
    if (!config) throw new AiError("config", "That provider is not configured.");
    const started = Date.now();
    let result: ConnectionTest;
    try {
      let models: { id: string; label: string }[] = [];
      try {
        models = await this.discoverModels(id);
        result = {
          ok: true,
          latencyMs: Date.now() - started,
          models,
          message:
            models.length > 0
              ? `Connected. ${models.length} models listed.`
              : "Connected. The provider listed no models; enter a model ID manually.",
        };
      } catch (discoveryError) {
        // Some compatible endpoints expose no /models. Prove the key+model with
        // a one-token request instead of pretending discovery worked.
        const outcome = await this.attempt(config, {
          messages: [{ role: "user", text: "ping" }],
          maxTokens: 1,
          temperature: 0,
        });
        result = {
          ok: true,
          latencyMs: Date.now() - started,
          models: [],
          message: `Model list unavailable (${discoveryError instanceof Error ? discoveryError.message : "unknown"}). A one-token request to ${outcome.result.model || config.model} succeeded.`,
        };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "The connection test failed.";
      result = { ok: false, latencyMs: Date.now() - started, message };
    }
    const updated = this.configs.map((candidate) =>
      candidate.id === config.id
        ? { ...candidate, lastTest: { ok: result.ok, at: Date.now(), message: result.message, latencyMs: result.latencyMs ?? undefined } }
        : candidate,
    );
    await this.save(updated);
    return result;
  }

  async chat(options: ChatOptions): Promise<ChatOutcome> {
    await this.load();
    const role: RoleKey = options.role || "default";
    const chain = options.configId
      ? this.configs.filter((config) => config.id === options.configId && config.enabled)
      : selectChain(this.configs, role, Boolean(options.allowFallback));
    if (!chain.length) {
      throw new AiError("config", "No model is configured for that role. Add a provider in Settings → AI Providers.");
    }

    const budget = await this.store.getSetting<number>("ai.budget.dailyTokens", 0);
    if (budget > 0) {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      const used = await this.store.usageSince(midnight.getTime());
      if (used.input + used.output >= budget) {
        throw new AiError("budget", `Today's token budget (${budget}) is exhausted. Raise it in Settings or wait until tomorrow.`);
      }
    }

    const errors: string[] = [];
    for (const config of chain) {
      try {
        const outcome = await this.attempt(config, options);
        await this.store.recordUsage(
          config.provider,
          outcome.result.model || config.model,
          role,
          outcome.result.usage.input,
          outcome.result.usage.output,
        );
        return outcome;
      } catch (e) {
        if (e instanceof AiError && e.code === "aborted") throw e;
        const message = e instanceof Error ? e.message : "The request failed.";
        errors.push(`${config.label}: ${message}`);
        if (e instanceof AiError && (e.code === "config" || e.code === "blocked")) break;
      }
    }
    throw new AiError("provider", errors.join(" · ") || "The request failed.");
  }

  abort(): void {
    this.activeAbort?.();
    this.activeAbort = null;
  }

  private async attempt(config: ProviderConfig, options: ChatOptions): Promise<ChatOutcome> {
    const def = this.def(config);
    const key = await this.keyFor(config, def);
    if (options.tools?.length && !def.capabilities.tools) {
      throw new AiError("model", `${config.label} (${config.model}) does not support tool calling.`);
    }
    const stream = Boolean(config.stream && def.capabilities.streaming && options.onDelta);
    const built = buildChatRequest(def, config.baseUrl, key, {
      model: config.model,
      system: options.system,
      messages: options.messages,
      tools: options.tools,
      maxTokens: options.maxTokens ?? config.maxTokens ?? 1024,
      temperature: options.temperature ?? config.temperature,
      stream,
    });
    await this.guardUrl(built.url, config.allowInsecure);

    const started = Date.now();
    const transport = await this.transport();
    const request: HttpRequest = {
      url: built.url,
      method: "POST",
      headers: built.headers,
      body: built.body,
      allowInsecure: config.allowInsecure,
      timeoutMs: 120_000,
    };

    if (!stream) {
      const response = await transport.request(request);
      if (response.status < 200 || response.status >= 300) {
        throw new AiError(errorCodeForStatus(response.status), describeHttpError(response.status, response.body), {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }
      let json: any;
      try {
        json = JSON.parse(response.body);
      } catch {
        throw new AiError("provider", "The provider returned a body that is not JSON.");
      }
      const result = parseChatResponse(def, json);
      return {
        result,
        config,
        providerLabel: `${config.label} · ${config.model}`,
        latencyMs: Date.now() - started,
        streamed: false,
      };
    }

    const accumulator = createStreamAccumulator(def, config.model);
    let buffer = "";
    let streamError: string | null = null;
    let status = 0;
    const consume = (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        const step = accumulator.push(payload);
        if (step.error) streamError = step.error;
        if (step.text) options.onDelta?.(step.text);
      }
    };

    this.activeAbort = null;
    const response = await transport.stream(request, consume, (abort) => {
      this.activeAbort = abort;
    });
    this.activeAbort = null;
    status = response.status;
    consume("\n");
    if (streamError) throw new AiError("provider", streamError);
    if (status >= 400) {
      throw new AiError(errorCodeForStatus(status), describeHttpError(status, response.body), { status });
    }
    const result = accumulator.result();
    if (!result.text && !result.toolCalls.length) {
      throw new AiError("provider", "The provider stream ended without content.");
    }
    return {
      result,
      config,
      providerLabel: `${config.label} · ${config.model}`,
      latencyMs: Date.now() - started,
      streamed: true,
    };
  }
}
