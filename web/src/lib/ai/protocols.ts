/**
 * Wire-format adapters for the four protocol families the catalogue uses.
 *
 * Everything here is pure: build a request from neutral messages, parse a
 * response into neutral text + tool calls, and account for token usage. That
 * makes provider behaviour testable in Node without a phone or a network, and
 * keeps `if (provider === …)` out of the UI.
 *
 * Supported:
 *  - openai    : Chat Completions (OpenAI, OpenRouter, Groq, xAI, DeepSeek,
 *                Mistral, Together, Fireworks, Cerebras, NVIDIA NIM, HF router,
 *                Z.ai, Qwen compatible-mode, Moonshot, SiliconFlow, DeepInfra,
 *                Perplexity)
 *  - anthropic : Messages API (Claude)
 *  - gemini    : generateContent / streamGenerateContent
 *  - cohere    : v2 chat (non-streaming, tool calls supported)
 *
 * NOT supported: the OpenAI Responses API. It has a different item model; the
 * settings UI therefore requires a Chat Completions base URL.
 */
import { joinUrl, type ProviderDef } from "./catalog";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type WireMessage =
  | { role: "system"; text: string }
  | { role: "user"; text: string; images?: string[] }
  | { role: "assistant"; text?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; results: { id: string; name: string; content: string }[] };

export interface ChatRequest {
  model: string;
  system?: string;
  messages: WireMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: { input: number; output: number };
  model: string;
}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

const JSON_HEADERS = (): Record<string, string> => ({
  "Content-Type": "application/json",
  Accept: "application/json",
});

/** Attach the key using the provider's documented header. */
export function authHeaders(def: ProviderDef, key: string): Record<string, string> {
  const headers = JSON_HEADERS();
  const value = (key || "").trim();
  if (value) {
    if (def.auth === "bearer") headers.Authorization = `Bearer ${value}`;
    else if (def.auth === "x-api-key") headers["x-api-key"] = value;
    else if (def.auth === "x-goog-api-key") headers["x-goog-api-key"] = value;
  }
  for (const [name, headerValue] of Object.entries(def.headers || {})) {
    headers[name] = headerValue;
  }
  return headers;
}

/** Parse a data: URL into mime + base64 (used by Anthropic/Gemini image parts). */
export function splitDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl || "");
  if (!match) return null;
  const mime = match[1] || "image/jpeg";
  if (match[2] === ";base64") return { mime, base64: match[3] };
  try {
    const bytes = new TextEncoder().encode(decodeURIComponent(match[3]));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { mime, base64: btoa(binary) };
  } catch {
    return null;
  }
}

// ── Request building ───────────────────────────────────────────────────────

export function buildChatRequest(
  def: ProviderDef,
  baseUrl: string,
  key: string,
  req: ChatRequest,
): BuiltRequest {
  const base = (baseUrl || def.baseUrl).replace(/\/+$/, "");
  const headers = authHeaders(def, key);
  const stream = req.stream === true && def.capabilities.streaming;

  if (def.protocol === "anthropic") {
    const messages: unknown[] = [];
    for (const message of req.messages) {
      if (message.role === "system") continue;
      if (message.role === "user") {
        const content: unknown[] = [];
        if (message.text) content.push({ type: "text", text: message.text });
        for (const image of message.images || []) {
          const parsed = splitDataUrl(image);
          if (parsed) {
            content.push({
              type: "image",
              source: { type: "base64", media_type: parsed.mime, data: parsed.base64 },
            });
          }
        }
        messages.push({ role: "user", content: content.length ? content : [{ type: "text", text: " " }] });
      } else if (message.role === "assistant") {
        const content: unknown[] = [];
        if (message.text) content.push({ type: "text", text: message.text });
        for (const call of message.toolCalls || []) {
          content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
        }
        messages.push({ role: "assistant", content });
      } else {
        messages.push({
          role: "user",
          content: message.results.map((result) => ({
            type: "tool_result",
            tool_use_id: result.id,
            content: result.content,
          })),
        });
      }
    }
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      messages,
    };
    if (req.system || req.messages.some((m) => m.role === "system")) {
      body.system =
        req.system ||
        (req.messages.find((m) => m.role === "system") as { text: string } | undefined)?.text ||
        "";
    }
    if (typeof req.temperature === "number") body.temperature = req.temperature;
    if (req.tools?.length) {
      body.tools = req.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }
    body.stream = stream;
    return {
      url: joinUrl(base, def.chatPath || "/messages"),
      headers,
      body: JSON.stringify(body),
    };
  }

  if (def.protocol === "gemini") {
    const contents: unknown[] = [];
    for (const message of req.messages) {
      if (message.role === "system") continue;
      if (message.role === "user") {
        const parts: unknown[] = [];
        if (message.text) parts.push({ text: message.text });
        for (const image of message.images || []) {
          const parsed = splitDataUrl(image);
          if (parsed) parts.push({ inlineData: { mimeType: parsed.mime, data: parsed.base64 } });
        }
        contents.push({ role: "user", parts: parts.length ? parts : [{ text: " " }] });
      } else if (message.role === "assistant") {
        const parts: unknown[] = [];
        if (message.text) parts.push({ text: message.text });
        for (const call of message.toolCalls || []) {
          parts.push({ functionCall: { name: call.name, args: call.args } });
        }
        contents.push({ role: "model", parts: parts.length ? parts : [{ text: " " }] });
      } else {
        contents.push({
          role: "user",
          parts: message.results.map((result) => ({
            functionResponse: { name: result.name, response: { result: result.content } },
          })),
        });
      }
    }
    const systemText =
      req.system ||
      (req.messages.find((m) => m.role === "system") as { text: string } | undefined)?.text ||
      "";
    const body: Record<string, unknown> = { contents };
    if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
    const generationConfig: Record<string, unknown> = {};
    if (typeof req.temperature === "number") generationConfig.temperature = req.temperature;
    if (req.maxTokens) generationConfig.maxOutputTokens = req.maxTokens;
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    if (req.tools?.length) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        },
      ];
    }
    const modelPath = req.model.startsWith("models/") ? req.model : `models/${req.model}`;
    const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    return {
      url: `${base}/${modelPath}:${action}`,
      headers,
      body: JSON.stringify(body),
    };
  }

  if (def.protocol === "cohere") {
    const messages: unknown[] = [];
    for (const message of req.messages) {
      if (message.role === "system") messages.push({ role: "system", content: message.text });
      else if (message.role === "user") messages.push({ role: "user", content: message.text });
      else if (message.role === "assistant") {
        const entry: Record<string, unknown> = { role: "assistant" };
        const content: unknown[] = [];
        if (message.text) content.push({ type: "text", text: message.text });
        entry.content = content;
        if (message.toolCalls?.length) {
          entry.tool_calls = message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          }));
        }
        messages.push(entry);
      } else {
        for (const result of message.results) {
          messages.push({ role: "tool", tool_call_id: result.id, content: result.content });
        }
      }
    }
    const body: Record<string, unknown> = { model: req.model, messages, stream: false };
    if (typeof req.temperature === "number") body.temperature = req.temperature;
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.tools?.length) {
      body.tools = req.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
    }
    return {
      url: joinUrl(base, def.chatPath || "/chat"),
      headers,
      body: JSON.stringify(body),
    };
  }

  // OpenAI-compatible Chat Completions.
  const messages: unknown[] = [];
  for (const message of req.messages) {
    if (message.role === "system") {
      messages.push({ role: "system", content: message.text });
    } else if (message.role === "user") {
      if (message.images?.length) {
        const content: unknown[] = [{ type: "text", text: message.text || " " }];
        for (const image of message.images) content.push({ type: "image_url", image_url: { url: image } });
        messages.push({ role: "user", content });
      } else {
        messages.push({ role: "user", content: message.text });
      }
    } else if (message.role === "assistant") {
      const entry: Record<string, unknown> = { role: "assistant", content: message.text || null };
      if (message.toolCalls?.length) {
        entry.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        }));
      }
      messages.push(entry);
    } else {
      for (const result of message.results) {
        messages.push({ role: "tool", tool_call_id: result.id, content: result.content });
      }
    }
  }
  const body: Record<string, unknown> = { model: req.model, messages };
  if (typeof req.temperature === "number") body.temperature = req.temperature;
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  if (req.tools?.length) {
    body.tools = req.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  if (stream) body.stream = true;
  return { url: joinUrl(base, def.chatPath || "/chat/completions"), headers, body: JSON.stringify(body) };
}

export function buildModelsRequest(def: ProviderDef, baseUrl: string, key: string): BuiltRequest {
  const base = (baseUrl || def.baseUrl).replace(/\/+$/, "");
  const path = def.modelsPath || "/models";
  if (def.protocol === "gemini") {
    return { url: joinUrl(base, "/models"), headers: authHeaders(def, key), body: "" };
  }
  return { url: joinUrl(base, path), headers: authHeaders(def, key), body: "" };
}

// ── Response parsing ───────────────────────────────────────────────────────

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

export function parseChatResponse(def: ProviderDef, json: any): ChatResult {
  const usage = { input: 0, output: 0 };
  if (def.protocol === "anthropic") {
    const blocks = asArray(json?.content);
    const text = blocks.filter((b) => b?.type === "text").map((b) => textOf(b.text)).join("");
    const toolCalls: ToolCall[] = blocks
      .filter((b) => b?.type === "tool_use")
      .map((b, index) => ({
        id: String(b.id || `call_${index}`),
        name: String(b.name || ""),
        args: parseArgs(b.input),
      }))
      .filter((call) => call.name);
    usage.input = Number(json?.usage?.input_tokens) || 0;
    usage.output = Number(json?.usage?.output_tokens) || 0;
    return {
      text,
      toolCalls,
      finishReason: String(json?.stop_reason || ""),
      usage,
      model: String(json?.model || ""),
    };
  }

  if (def.protocol === "gemini") {
    const candidate = asArray(json?.candidates)[0];
    const parts = asArray(candidate?.content?.parts);
    const text = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
    const toolCalls: ToolCall[] = parts
      .filter((p) => p?.functionCall?.name)
      .map((p, index) => ({
        id: String(p.functionCall.id || `call_${index}_${Date.now().toString(36)}`),
        name: String(p.functionCall.name),
        args: parseArgs(p.functionCall.args),
      }));
    usage.input = Number(json?.usageMetadata?.promptTokenCount) || 0;
    usage.output = Number(json?.usageMetadata?.candidatesTokenCount) || 0;
    return {
      text,
      toolCalls,
      finishReason: String(candidate?.finishReason || ""),
      usage,
      model: String(json?.modelVersion || ""),
    };
  }

  if (def.protocol === "cohere") {
    const content = asArray(json?.message?.content);
    const text = content.map((part) => textOf(part?.text)).join("");
    const toolCalls: ToolCall[] = asArray(json?.message?.tool_calls)
      .map((call, index) => ({
        id: String(call?.id || `call_${index}`),
        name: String(call?.function?.name || ""),
        args: parseArgs(call?.function?.arguments),
      }))
      .filter((call) => call.name);
    usage.input = Number(json?.usage?.tokens?.input_tokens) || Number(json?.usage?.billed_units?.input_tokens) || 0;
    usage.output = Number(json?.usage?.tokens?.output_tokens) || Number(json?.usage?.billed_units?.output_tokens) || 0;
    return {
      text,
      toolCalls,
      finishReason: String(json?.finish_reason || ""),
      usage,
      model: String(json?.model || ""),
    };
  }

  const choice = asArray(json?.choices)[0];
  const message = choice?.message || {};
  const toolCalls: ToolCall[] = asArray(message.tool_calls)
    .map((call, index) => ({
      id: String(call?.id || `call_${index}`),
      name: String(call?.function?.name || ""),
      args: parseArgs(call?.function?.arguments),
    }))
    .filter((call) => call.name);
  usage.input = Number(json?.usage?.prompt_tokens) || 0;
  usage.output = Number(json?.usage?.completion_tokens) || 0;
  return {
    text: textOf(message.content),
    toolCalls,
    finishReason: String(choice?.finish_reason || ""),
    usage,
    model: String(json?.model || ""),
  };
}

export function parseModels(def: ProviderDef, json: any): { id: string; label: string }[] {
  if (def.protocol === "gemini") {
    return asArray(json?.models)
      .map((model) => String(model?.name || "").replace(/^models\//, ""))
      .filter(Boolean)
      .map((id) => ({ id, label: id }));
  }
  if (def.protocol === "cohere") {
    return asArray(json?.models)
      .map((model) => String(model?.name || ""))
      .filter(Boolean)
      .map((id) => ({ id, label: id }));
  }
  return asArray(json?.data)
    .map((model) => String(model?.id || model?.name || ""))
    .filter(Boolean)
    .map((id) => ({ id, label: id }));
}

/** Human-readable provider error, never including the API key. */
export function describeHttpError(status: number, body: string): string {
  let detail = "";
  try {
    const parsed = JSON.parse(body);
    detail =
      parsed?.error?.message ||
      parsed?.error?.detail ||
      parsed?.message ||
      (typeof parsed?.error === "string" ? parsed.error : "") ||
      "";
  } catch {
    detail = "";
  }
  if (!detail) detail = (body || "").slice(0, 200).replace(/\s+/g, " ").trim();
  const head =
    status === 401
      ? "The provider rejected the API key (401)"
      : status === 403
        ? "The provider refused access to this model or key (403)"
        : status === 404
          ? "Model or endpoint not found (404)"
          : status === 429
            ? "Rate limit or quota exhausted (429)"
            : status === 400
              ? "The provider rejected the request (400)"
              : status >= 500
                ? `Provider server error (${status})`
                : `Provider request failed (${status})`;
  return detail ? `${head}: ${detail}` : head;
}

// ── Streaming ──────────────────────────────────────────────────────────────

export interface StreamAccumulator {
  /** Feed one SSE `data:` payload. Returns newly visible text, if any. */
  push(payload: string): { text?: string; done?: boolean; error?: string };
  result(): ChatResult;
}

/**
 * Provider-specific SSE accumulator. Chunks are incremental: the caller appends
 * `text` to the message bubble and reads tool calls from `result()` at the end.
 */
export function createStreamAccumulator(def: ProviderDef, model: string): StreamAccumulator {
  let text = "";
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let finish = "";
  let usage = { input: 0, output: 0 };

  const setCall = (index: number, id: string, name: string, args: string) => {
    const existing = calls.get(index) || { id: "", name: "", args: "" };
    calls.set(index, {
      id: id || existing.id || `call_${index}`,
      name: name || existing.name,
      args: args || existing.args,
    });
  };

  return {
    push(payload: string) {
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        return {};
      }
      if (json?.error) {
        return { error: String(json.error.message || json.error) };
      }

      if (def.protocol === "anthropic") {
        if (json.type === "content_block_start" && json.content_block?.type === "tool_use") {
          setCall(Number(json.index) || 0, String(json.content_block.id || ""), String(json.content_block.name || ""), "");
        }
        if (json.type === "content_block_delta") {
          if (json.delta?.type === "text_delta" && json.delta.text) {
            text += json.delta.text;
            return { text: String(json.delta.text) };
          }
          if (json.delta?.type === "input_json_delta" && json.delta.partial_json) {
            const index = Number(json.index) || 0;
            const existing = calls.get(index) || { id: `call_${index}`, name: "", args: "" };
            setCall(index, existing.id, existing.name, existing.args + json.delta.partial_json);
          }
        }
        if (json.type === "message_delta") {
          finish = String(json.delta?.stop_reason || finish);
          usage.output = Number(json.usage?.output_tokens) || usage.output;
        }
        if (json.type === "message_start") {
          usage.input = Number(json.message?.usage?.input_tokens) || usage.input;
        }
        return { done: json.type === "message_stop" };
      }

      if (def.protocol === "gemini") {
        const candidate = asArray(json?.candidates)[0];
        let delta = "";
        for (const part of asArray(candidate?.content?.parts)) {
          if (typeof part?.text === "string") delta += part.text;
          if (part?.functionCall?.name) {
            const index = calls.size;
            setCall(index, `call_${index}_${Date.now().toString(36)}`, String(part.functionCall.name), JSON.stringify(part.functionCall.args || {}));
          }
        }
        usage.input = Number(json?.usageMetadata?.promptTokenCount) || usage.input;
        usage.output = Number(json?.usageMetadata?.candidatesTokenCount) || usage.output;
        finish = String(candidate?.finishReason || finish);
        if (delta) {
          text += delta;
          return { text: delta };
        }
        return {};
      }

      // OpenAI-compatible.
      const choice = asArray(json?.choices)[0];
      if (json?.usage) {
        usage.input = Number(json.usage.prompt_tokens) || usage.input;
        usage.output = Number(json.usage.completion_tokens) || usage.output;
      }
      if (choice?.finish_reason) finish = String(choice.finish_reason);
      const delta = choice?.delta || {};
      for (const [position, call] of asArray(delta.tool_calls).entries()) {
        const index = typeof call?.index === "number" ? call.index : position;
        const existing = calls.get(index) || { id: "", name: "", args: "" };
        setCall(
          index,
          String(call?.id || existing.id),
          String(call?.function?.name || existing.name),
          existing.args + String(call?.function?.arguments || ""),
        );
      }
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        return { text: delta.content };
      }
      return { done: false };
    },
    result(): ChatResult {
      return {
        text,
        toolCalls: [...calls.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, call]) => ({ id: call.id, name: call.name, args: parseArgs(call.args) }))
          .filter((call) => call.name),
        finishReason: finish,
        usage,
        model,
      };
    },
  };
}
