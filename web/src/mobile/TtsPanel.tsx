/**
 * Neural voice settings: ElevenLabs, Fish Audio, OpenAI, Google, Deepgram,
 * Azure, PlayHT, Cartesia and a custom JSON endpoint.
 *
 * Keys go straight into the Keystore; the form never displays a stored key.
 */
import { useCallback, useEffect, useState } from "react";
import { TTS_PROVIDERS, ttsProvider, ttsService } from "../lib/ai/tts";
import type { TtsConfig } from "../lib/ai/ttsProtocols";
import { Card, Chip, EmptyState, Section } from "./ui";

interface Draft {
  id?: string;
  provider: string;
  voice: string;
  model: string;
  language: string;
  account: string;
  baseUrl: string;
  key: string;
}

const EMPTY: Draft = {
  provider: "elevenlabs",
  voice: "",
  model: "",
  language: "en-GB",
  account: "",
  baseUrl: "",
  key: "",
};

export default function TtsPanel() {
  const [configs, setConfigs] = useState<TtsConfig[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storedKey, setStoredKey] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await ttsService.load(true);
      setConfigs(list);
      setError(null);
      return list;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Voice settings are unavailable in this runtime.");
      return [];
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const config = configs.find((candidate) => candidate.id === draft.id);
    setStoredKey(Boolean(config && config.id));
  }, [configs, draft.id]);

  const def = ttsProvider(draft.provider);

  const run = async (label: string, task: () => Promise<string | null>) => {
    setBusy(label);
    setNotice(null);
    try {
      const message = await task();
      if (message) setNotice(message);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "That voice operation failed.");
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run("save", async () => {
      await ttsService.upsert({
        id: draft.id,
        provider: draft.provider,
        voice: draft.voice,
        model: draft.model || undefined,
        language: draft.language || undefined,
        account: draft.account || undefined,
        baseUrl: draft.baseUrl || undefined,
        apiKey: draft.key,
      });
      await refresh();
      setDraft(EMPTY);
      return "Voice saved. Replies now use this engine when it is enabled.";
    });

  const test = (config: TtsConfig) =>
    run(`test:${config.id}`, async () => {
      const result = await ttsService.test(config.id);
      await refresh();
      return result.ok ? `✔ ${result.message}` : `✖ ${result.message}`;
    });

  const setEnabled = (config: TtsConfig) =>
    run(`enable:${config.id}`, async () => {
      await ttsService.upsert({
        id: config.id,
        provider: config.provider,
        enabled: true,
        voice: config.voice,
        label: config.label,
      });
      await refresh();
      return `${config.label} is now the active voice.`;
    });

  const remove = (config: TtsConfig) =>
    run(`remove:${config.id}`, async () => {
      await ttsService.remove(config.id);
      await refresh();
      return "Voice removed and its stored key deleted.";
    });

  return (
    <Section title="Neural voice" action={<span className="m-row-sub">cloud TTS</span>}>
      {error && <p className="m-small mb-2" style={{ color: "#fecdd3" }}>{error}</p>}
      {notice && <p className="m-small mb-2" style={{ color: "#d7f2ff" }}>{notice}</p>}

      <Card className="mb-3">
        <div className="m-label mb-2">{draft.id ? "Edit voice" : "Add a voice"}</div>
        <select
          className="m-input"
          value={draft.provider}
          onChange={(event) => setDraft({ ...draft, provider: event.target.value, voice: "" })}
          aria-label="Voice provider"
        >
          {TTS_PROVIDERS.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}
            </option>
          ))}
          <option value="custom">Custom (JSON → audio)</option>
        </select>

        {def?.custom && (
          <input
            className="m-input mt-2"
            placeholder="HTTPS endpoint that returns audio"
            inputMode="url"
            autoCapitalize="none"
            value={draft.baseUrl}
            onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
          />
        )}

        <input
          className="m-input mt-2"
          placeholder={def ? `Voice ID (e.g. ${def.voiceExamples[0]})` : "Voice ID"}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={draft.voice}
          onChange={(event) => setDraft({ ...draft, voice: event.target.value })}
        />
        <input
          className="m-input mt-2"
          placeholder={def?.defaultModel ? `Model (default ${def.defaultModel})` : "Model (optional)"}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={draft.model}
          onChange={(event) => setDraft({ ...draft, model: event.target.value })}
        />
        {def?.accountHint && (
          <input
            className="m-input mt-2"
            placeholder={def.accountHint}
            autoCapitalize="none"
            value={draft.account}
            onChange={(event) => setDraft({ ...draft, account: event.target.value })}
          />
        )}
        <div className="mt-2 flex gap-2">
          <input
            className="m-input"
            placeholder="Language (en-GB)"
            autoCapitalize="none"
            value={draft.language}
            onChange={(event) => setDraft({ ...draft, language: event.target.value })}
            aria-label="Language"
          />
        </div>
        <input
          className="m-input mt-2"
          type="password"
          placeholder={storedKey ? "Key stored — paste a new one to replace" : def?.keyHint || "API key"}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={draft.key}
          onChange={(event) => setDraft({ ...draft, key: event.target.value })}
        />

        <div className="mt-2 flex gap-2">
          <button type="button" className="m-btn flex-1" data-variant="primary" disabled={busy !== null} onClick={() => void save()}>
            {busy === "save" ? "Saving…" : "Save voice"}
          </button>
          <button type="button" className="m-btn" disabled={busy !== null} onClick={() => setDraft(EMPTY)}>
            Clear
          </button>
        </div>

        {def?.voiceExamples.length ? (
          <div className="mt-3">
            <div className="m-label mb-1">Example voices</div>
            <div className="flex flex-wrap gap-2">
              {def.voiceExamples.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="m-chip"
                  data-tone={draft.voice === example ? "accent" : undefined}
                  onClick={() => setDraft((current) => ({ ...current, voice: example }))}
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <p className="m-row-sub mt-2">
          Requests go directly from the phone to the provider. Keys are encrypted with Android Keystore and are never
          shown again, logged, exported or stored in the memory database.
        </p>
        {def?.note ? <p className="m-row-sub mt-1">{def.note}</p> : null}
      </Card>

      {configs.length === 0 ? (
        <EmptyState
          title="No cloud voice yet"
          body="Android TextToSpeech is used until you add a provider. ElevenLabs and Fish Audio give the most natural JARVIS-style delivery."
        />
      ) : (
        configs.map((config) => (
          <Card key={config.id} className="mb-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="m-row-title truncate">{config.label}</div>
                <div className="m-row-sub truncate">
                  {config.voice || "default voice"}
                  {config.model ? ` · ${config.model}` : ""}
                </div>
              </div>
              <Chip tone={config.enabled ? "ok" : "warn"}>{config.enabled ? "active" : "inactive"}</Chip>
            </div>
            {config.lastTest && (
              <div className="m-small mt-2" style={{ color: config.lastTest.ok ? "#a7f3d0" : "#fecdd3" }}>
                {config.lastTest.ok ? "✔ " : "✖ "}
                {config.lastTest.message}
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="m-btn" data-size="sm" disabled={busy !== null} onClick={() => void test(config)}>
                {busy === `test:${config.id}` ? "Speaking…" : "Test voice"}
              </button>
              {!config.enabled && (
                <button type="button" className="m-btn" data-size="sm" disabled={busy !== null} onClick={() => void setEnabled(config)}>
                  Use this voice
                </button>
              )}
              <button
                type="button"
                className="m-btn"
                data-size="sm"
                onClick={() =>
                  setDraft({
                    id: config.id,
                    provider: config.provider,
                    voice: config.voice,
                    model: config.model || "",
                    language: config.language || "en-GB",
                    account: config.account || "",
                    baseUrl: config.baseUrl || "",
                    key: "",
                  })
                }
              >
                Edit
              </button>
              <button type="button" className="m-btn" data-size="sm" data-variant="danger" disabled={busy !== null} onClick={() => void remove(config)}>
                Remove
              </button>
            </div>
          </Card>
        ))
      )}
    </Section>
  );
}
