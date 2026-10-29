/**
 * Pure cloud-TTS protocol layer (no browser, no native imports).
 *
 * Kept separate from `tts.ts` so request building and response parsing can be
 * unit-tested in Node without a WebView, audio element or Keystore.
 */

export type TtsProtocol =
  | "eleven"
  | "fish"
  | "openai"
  | "google"
  | "deepgram"
  | "azure"
  | "playht"
  | "cartesia"
  | "custom";

export interface TtsProviderDef {
  id: string;
  label: string;
  protocol: TtsProtocol;
  baseUrl: string;
  auth: "xi-api-key" | "bearer" | "x-goog-api-key" | "token" | "azure" | "playht" | "cartesia" | "none";
  keyHint: string;
  docs: string;
  voiceExamples: string[];
  defaultModel?: string;
  note?: string;
  custom?: boolean;
  accountHint?: string;
}

export const TTS_PROVIDERS: TtsProviderDef[] = [
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    protocol: "eleven",
    baseUrl: "https://api.elevenlabs.io/v1",
    auth: "xi-api-key",
    keyHint: "sk_…",
    docs: "https://elevenlabs.io/docs/api-reference/text-to-speech",
    voiceExamples: ["21m00Tcm4TlvDq8ikWAM", "EXAVITQu4vr4xnSDxMaL"],
    defaultModel: "eleven_multilingual_v2",
    note: "Paste a voice ID from your ElevenLabs library.",
  },
  {
    id: "fish",
    label: "Fish Audio",
    protocol: "fish",
    baseUrl: "https://api.fish.audio",
    auth: "bearer",
    keyHint: "Fish Audio API key",
    docs: "https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech",
    voiceExamples: ["reference id or voice id"],
    defaultModel: "speech-1.5",
    note: "Reference model ID from your Fish Audio library; blank uses the default voice.",
  },
  {
    id: "openai",
    label: "OpenAI Speech",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    auth: "bearer",
    keyHint: "sk-…",
    docs: "https://platform.openai.com/docs/api-reference/audio/createSpeech",
    voiceExamples: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
    defaultModel: "gpt-4o-mini-tts",
  },
  {
    id: "google",
    label: "Google Cloud TTS",
    protocol: "google",
    baseUrl: "https://texttospeech.googleapis.com/v1",
    auth: "x-goog-api-key",
    keyHint: "AIza…",
    docs: "https://cloud.google.com/text-to-speech/docs/reference/rest/v1/text/synthesize",
    voiceExamples: ["en-GB-Neural2-B", "en-US-Neural2-F"],
    note: "Neural2/Studio voices require the API enabled in your Cloud project.",
  },
  {
    id: "deepgram",
    label: "Deepgram Aura",
    protocol: "deepgram",
    baseUrl: "https://api.deepgram.com",
    auth: "token",
    keyHint: "Deepgram API key",
    docs: "https://developers.deepgram.com/docs/text-to-speech",
    voiceExamples: ["aura-asteria-en", "aura-orion-en", "aura-luna-en"],
    note: "The voice field is the Aura model name.",
  },
  {
    id: "azure",
    label: "Azure Speech",
    protocol: "azure",
    baseUrl: "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1",
    auth: "azure",
    keyHint: "Azure Speech key",
    docs: "https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech",
    voiceExamples: ["en-GB-RyanNeural", "en-US-AriaNeural"],
    note: "Change the region in the base URL to your Azure Speech region.",
  },
  {
    id: "playht",
    label: "PlayHT",
    protocol: "playht",
    baseUrl: "https://api.play.ht/api/v2",
    auth: "playht",
    keyHint: "PlayHT secret key",
    docs: "https://docs.play.ht/reference/api-generate-tts-audio-stream",
    voiceExamples: ["s3://voice-cloning-zero-shot/…"],
    note: "PlayHT also needs your user ID (account field).",
    accountHint: "PlayHT user ID",
  },
  {
    id: "cartesia",
    label: "Cartesia Sonic",
    protocol: "cartesia",
    baseUrl: "https://api.cartesia.ai",
    auth: "cartesia",
    keyHint: "Cartesia API key",
    docs: "https://docs.cartesia.ai/api-reference/tts/bytes",
    voiceExamples: ["a0e99841-438c-4a64-b679-ae501e7d6091"],
    defaultModel: "sonic-2",
  },
];

export const CUSTOM_TTS: TtsProviderDef = {
  id: "custom",
  label: "Custom (JSON → audio)",
  protocol: "custom",
  baseUrl: "",
  auth: "bearer",
  keyHint: "Endpoint API key (optional)",
  docs: "Your provider's documentation",
  voiceExamples: ["voice"],
  custom: true,
  note: "POST {text, voice, model}; binary audio or JSON with audioContent/audio/audio_base64.",
};

export function ttsProvider(id: string): TtsProviderDef | undefined {
  return id === "custom" ? CUSTOM_TTS : TTS_PROVIDERS.find((provider) => provider.id === id);
}

export interface TtsConfig {
  id: string;
  provider: string;
  label: string;
  voice: string;
  model?: string;
  baseUrl?: string;
  language?: string;
  account?: string;
  enabled: boolean;
  lastTest?: { ok: boolean; at: number; message: string };
}

export interface TtsRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  response: "binary" | "base64-json";
  mime: string;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Build a provider request. Pure: identical inputs give an identical request. */
export function buildTtsRequest(def: TtsProviderDef, config: TtsConfig, key: string, text: string): TtsRequest {
  const base = (config.baseUrl || def.baseUrl).replace(/\/+$/, "");
  const voice = (config.voice || "").trim();
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "audio/mpeg" };
  if (key) {
    if (def.auth === "xi-api-key") headers["xi-api-key"] = key;
    else if (def.auth === "bearer") headers.Authorization = `Bearer ${key}`;
    else if (def.auth === "token") headers.Authorization = `Token ${key}`;
    else if (def.auth === "x-goog-api-key") headers["X-Goog-Api-Key"] = key;
    else if (def.auth === "azure") headers["Ocp-Apim-Subscription-Key"] = key;
    else if (def.auth === "cartesia") headers["X-API-Key"] = key;
    else if (def.auth === "playht") {
      headers.AUTHORIZATION = key;
      if (config.account) headers["X-USER-ID"] = config.account;
    }
  }

  if (def.protocol === "eleven") {
    return {
      url: `${base}/text-to-speech/${encodeURIComponent(voice || "21m00Tcm4TlvDq8ikWAM")}?output_format=mp3_44100_128`,
      headers,
      body: JSON.stringify({
        text,
        model_id: config.model || def.defaultModel || "eleven_multilingual_v2",
        voice_settings: { stability: 0.42, similarity_boost: 0.78, style: 0.12, use_speaker_boost: true },
      }),
      response: "binary",
      mime: "audio/mpeg",
    };
  }

  if (def.protocol === "fish") {
    return {
      url: `${base}/v1/tts`,
      headers,
      body: JSON.stringify({
        text,
        reference_id: voice || undefined,
        format: "mp3",
        mp3_bitrate: 128,
        model: config.model || def.defaultModel || "speech-1.5",
      }),
      response: "binary",
      mime: "audio/mpeg",
    };
  }

  if (def.protocol === "openai") {
    return {
      url: `${base}/audio/speech`,
      headers,
      body: JSON.stringify({
        model: config.model || def.defaultModel || "gpt-4o-mini-tts",
        voice: voice || "alloy",
        input: text,
        response_format: "mp3",
      }),
      response: "binary",
      mime: "audio/mpeg",
    };
  }

  if (def.protocol === "google") {
    return {
      url: `${base}/text:synthesize`,
      headers,
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: config.language || "en-GB", ...(voice ? { name: voice } : {}) },
        audioConfig: { audioEncoding: "MP3", speakingRate: 0.98, pitch: -1.2 },
      }),
      response: "base64-json",
      mime: "audio/mpeg",
    };
  }

  if (def.protocol === "deepgram") {
    return {
      url: `${base}/v1/speak?model=${encodeURIComponent(voice || "aura-asteria-en")}`,
      headers,
      body: JSON.stringify({ text }),
      response: "binary",
      mime: "audio/mpeg",
    };
  }

  if (def.protocol === "azure") {
    const language = config.language || "en-GB";
    const voiceName = voice || "en-GB-RyanNeural";
    return {
      url: base,
      headers: {
        ...headers,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      },
      body:
        `<speak version='1.0' xml:lang='${escapeXml(language)}'>` +
        `<voice xml:lang='${escapeXml(language)}' name='${escapeXml(voiceName)}'>` +
        `<prosody rate='-4%' pitch='-6%'>${escapeXml(text)}</prosody></voice></speak>`,
      response: "binary",
      mime: "audio/mpeg",
    };
  }

  if (def.protocol === "playht") {
    return {
      url: `${base}/tts/stream`,
      headers,
      body: JSON.stringify({
        text,
        voice,
        output_format: "mp3",
        voice_engine: config.model || "Play3.0-mini",
        quality: "medium",
      }),
      response: "binary",
      mime: "audio/mpeg",
    };
  }

  if (def.protocol === "cartesia") {
    return {
      url: `${base}/tts/bytes`,
      headers: { ...headers, "Cartesia-Version": "2024-06-10" },
      body: JSON.stringify({
        model_id: config.model || def.defaultModel || "sonic-2",
        transcript: text,
        voice: { mode: "id", id: voice },
        output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
        language: config.language || "en",
      }),
      response: "binary",
      mime: "audio/mpeg",
    };
  }

  return {
    url: base,
    headers,
    body: JSON.stringify({ text, voice, model: config.model }),
    response: "binary",
    mime: "audio/mpeg",
  };
}

/** Extract audio from a response body, or throw a readable reason. */
export function parseTtsResponse(
  def: TtsProviderDef,
  response: { status: number; base64?: string; mime?: string; body?: string },
): { base64: string; mime: string } {
  if (response.status < 200 || response.status >= 300) {
    let detail = "";
    try {
      const parsed = JSON.parse(response.body || "{}");
      detail = parsed?.error?.message || parsed?.message || parsed?.detail || "";
    } catch {
      detail = (response.body || "").slice(0, 160);
    }
    const head =
      response.status === 401 || response.status === 403
        ? "The voice provider rejected the key"
        : response.status === 402
          ? "The voice provider reports insufficient credit"
          : response.status === 429
            ? "The voice provider rate-limited the request"
            : `The voice provider failed (${response.status})`;
    throw new Error(detail ? `${head}: ${detail}` : head);
  }

  const declared = (response.mime || "").split(";")[0].trim().toLowerCase();
  if (response.base64 && declared.startsWith("audio/")) {
    return { base64: response.base64, mime: declared };
  }

  if (def.protocol === "google") {
    try {
      const parsed = JSON.parse(response.body || "{}");
      const audio = parsed?.audioContent;
      if (typeof audio === "string" && audio.length > 32) return { base64: audio, mime: "audio/mpeg" };
    } catch {
      /* fall through */
    }
    throw new Error("Google returned no audioContent.");
  }

  if (response.base64) return { base64: response.base64, mime: declared || "audio/mpeg" };

  // Custom endpoints may answer with JSON even when they are not Google.
  try {
    const parsed = JSON.parse(response.body || "{}");
    const audio = parsed?.audioContent || parsed?.audio || parsed?.audio_base64;
    if (typeof audio === "string" && audio.length > 32) return { base64: audio, mime: "audio/mpeg" };
  } catch {
    /* noop */
  }
  throw new Error("The voice provider returned an empty audio response.");
}
