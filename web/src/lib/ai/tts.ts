/**
 * Cloud voice engine (ElevenLabs, Fish Audio, OpenAI, Google, Deepgram,
 * Azure, PlayHT, Cartesia, custom).
 *
 * Keys live in the Android Keystore, requests go through the native bridge
 * (providers send no CORS headers, and audio is binary), and playback drives a
 * real WebAudio analyser so the core reacts to the actual voice amplitude.
 */
import * as native from "../../platform/native";
import { useStore } from "../store";
import { getJarvisAI } from "./runtime";
import {
  buildTtsRequest,
  parseTtsResponse,
  ttsProvider,
  type TtsConfig,
  type TtsProviderDef,
} from "./ttsProtocols";

export {
  TTS_PROVIDERS,
  CUSTOM_TTS,
  ttsProvider,
  buildTtsRequest,
  parseTtsResponse,
} from "./ttsProtocols";
export type { TtsConfig, TtsProviderDef, TtsProtocol } from "./ttsProtocols";

const CONFIG_KEY = "ai.tts.v1";
const KEY_PREFIX = "jarvis.tts.";

export interface TtsTestResult {
  ok: boolean;
  message: string;
  latencyMs: number | null;
}

let currentAudio: HTMLAudioElement | null = null;
let currentContext: AudioContext | null = null;

function setLevel(value: number): void {
  try {
    (useStore.getState() as any).setAudioLevel?.(value);
  } catch {
    /* noop */
  }
}

function stopPlayback(): void {
  if (currentAudio) {
    try {
      currentAudio.pause();
      currentAudio.removeAttribute("src");
      currentAudio.load();
    } catch {
      /* noop */
    }
    currentAudio = null;
  }
  if (currentContext) {
    void currentContext.close().catch(() => undefined);
    currentContext = null;
  }
  setLevel(0);
}

/**
 * Play base64 audio and feed its RMS amplitude to the store. Resolves only when
 * playback actually finishes, so the UI can keep the SPEAKING state honest.
 */
async function playBase64(base64: string, mime: string): Promise<void> {
  stopPlayback();
  const audio = new Audio(`data:${mime || "audio/mpeg"};base64,${base64}`);
  currentAudio = audio;
  audio.preload = "auto";

  try {
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (Ctor) {
      const context: AudioContext = new Ctor();
      currentContext = context;
      await context.resume().catch(() => undefined);
      const source = context.createMediaElementSource(audio);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analyser.connect(context.destination);
      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (currentAudio !== audio) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) {
          const normalized = (value - 128) / 128;
          sum += normalized * normalized;
        }
        setLevel(Math.min(1, Math.sqrt(sum / data.length) * 3.2));
        if (!audio.paused && !audio.ended) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  } catch {
    // Amplitude is a bonus; playback still works if WebAudio is unavailable.
  }

  await new Promise<void>((resolve, reject) => {
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error("The synthesized audio could not be played on this device."));
    audio.play().catch((error) => reject(error instanceof Error ? error : new Error("Autoplay was blocked.")));
  });
  setLevel(0);
}

class TtsService {
  private configs: TtsConfig[] = [];
  private loaded = false;

  async load(force = false): Promise<TtsConfig[]> {
    if (this.loaded && !force) return this.configs;
    try {
      const stored = await getJarvisAI().store.getSetting<TtsConfig[]>(CONFIG_KEY, []);
      this.configs = Array.isArray(stored) ? stored.filter((config) => config && config.id && config.provider) : [];
    } catch {
      this.configs = [];
    }
    this.loaded = true;
    return this.configs;
  }

  list(): TtsConfig[] {
    return [...this.configs];
  }

  active(): TtsConfig | null {
    return this.configs.find((config) => config.enabled) || null;
  }

  private async save(configs: TtsConfig[]): Promise<void> {
    this.configs = configs;
    this.loaded = true;
    await getJarvisAI().store.setSetting(CONFIG_KEY, configs);
  }

  async upsert(input: Partial<TtsConfig> & { provider: string; apiKey?: string }): Promise<TtsConfig> {
    await this.load();
    const def = ttsProvider(input.provider);
    if (!def) throw new Error(`Unknown voice provider “${input.provider}”.`);
    const base = (input.baseUrl || def.baseUrl).trim();
    if (def.custom && !/^https:\/\//i.test(base)) {
      throw new Error("Custom voice endpoints must use HTTPS.");
    }
    const existing = input.id ? this.configs.find((config) => config.id === input.id) : undefined;
    const config: TtsConfig = {
      id: existing?.id || `tts_${Date.now().toString(36)}`,
      provider: def.id,
      label: (input.label || def.label).slice(0, 50),
      voice: (input.voice ?? existing?.voice ?? "").trim(),
      model: input.model ?? existing?.model,
      baseUrl: base,
      language: input.language ?? existing?.language ?? "en-GB",
      account: input.account ?? existing?.account,
      enabled: input.enabled ?? existing?.enabled ?? true,
      lastTest: existing?.lastTest,
    };
    // One active engine keeps voice behaviour predictable.
    const next = existing
      ? this.configs.map((candidate) => (candidate.id === config.id ? config : { ...candidate, enabled: config.enabled ? false : candidate.enabled }))
      : [...this.configs.map((candidate) => ({ ...candidate, enabled: config.enabled ? false : candidate.enabled })), config];
    await this.save(next);
    if (input.apiKey !== undefined) {
      const key = input.apiKey.trim();
      if (key) await native.secureSet(`${KEY_PREFIX}${config.id}`, key);
      else await native.secureRemove(`${KEY_PREFIX}${config.id}`);
    }
    return config;
  }

  async remove(id: string): Promise<void> {
    await this.load();
    await native.secureRemove(`${KEY_PREFIX}${id}`).catch(() => undefined);
    await this.save(this.configs.filter((config) => config.id !== id));
  }

  async hasKey(id: string): Promise<boolean> {
    try {
      const response = await native.secureGet(`${KEY_PREFIX}${id}`);
      return Boolean(response?.value);
    } catch {
      return false;
    }
  }

  async available(): Promise<boolean> {
    await this.load();
    const config = this.active();
    if (!config) return false;
    return this.hasKey(config.id);
  }

  /** Speak through the configured engine. Resolves after playback completes. */
  async speak(text: string): Promise<{ ok: boolean; error?: string; provider?: string }> {
    await this.load();
    const config = this.active();
    if (!config) return { ok: false, error: "No cloud voice is configured." };
    const def: TtsProviderDef | undefined = ttsProvider(config.provider);
    if (!def) return { ok: false, error: "That voice provider is no longer supported." };

    const keyResponse = await native.secureGet(`${KEY_PREFIX}${config.id}`).catch(() => null);
    const key = keyResponse?.value || "";
    if (!key && def.auth !== "none") return { ok: false, error: `No key is stored for ${config.label}.` };

    const nativeAvailable = await native.nativeAvailable().catch(() => false);
    if (!nativeAvailable) return { ok: false, error: "Cloud voices require the Android app build." };

    const request = buildTtsRequest(def, config, key, text);
    try {
      const response = await native.httpRequestBase64({
        url: request.url,
        method: "POST",
        headers: request.headers,
        body: request.body,
        timeoutMs: 45_000,
      });
      const audio = parseTtsResponse(def, {
        status: Number(response?.status) || 0,
        base64: response?.base64,
        mime: response?.mime,
        body: response?.body,
      });
      await playBase64(audio.base64, audio.mime);
      return { ok: true, provider: config.label };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "The cloud voice failed." };
    }
  }

  async stop(): Promise<void> {
    stopPlayback();
  }

  isSpeaking(): boolean {
    return Boolean(currentAudio && !currentAudio.paused);
  }

  async test(id: string): Promise<TtsTestResult> {
    await this.load();
    const config = this.configs.find((candidate) => candidate.id === id);
    if (!config) return { ok: false, message: "That voice is not configured.", latencyMs: null };
    const started = Date.now();
    try {
      const result = await this.speak("JARVIS voice check. All systems nominal.");
      const latency = Date.now() - started;
      const updated = this.configs.map((candidate) =>
        candidate.id === id
          ? {
              ...candidate,
              lastTest: {
                ok: result.ok,
                at: Date.now(),
                message: result.ok ? `Spoke through ${config.label} (${latency} ms).` : result.error || "Failed.",
              },
            }
          : candidate,
      );
      await this.save(updated);
      return {
        ok: result.ok,
        message: result.ok ? `Played ${config.label} audio.` : result.error || "Voice test failed.",
        latencyMs: latency,
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "Voice test failed.", latencyMs: Date.now() - started };
    }
  }
}

export const ttsService = new TtsService();
