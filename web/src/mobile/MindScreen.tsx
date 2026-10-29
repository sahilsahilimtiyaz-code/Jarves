/**
 * Memory & Evolution Center, including on-device provider configuration.
 *
 * This screen is the owner-facing half of the local AI stack: provider keys
 * (written to the Keystore through the native gateway), the curated profile,
 * the transcript archive, learned procedures, the evolution timeline and the
 * retention controls. Every list reads the real SQLite store; when the native
 * database is unavailable the screen says so instead of showing sample data.
 */
import { useCallback, useEffect, useState } from "react";
import { PROVIDERS, providerById } from "../lib/ai/catalog";
import { getJarvisAI, initMind, storageProbe } from "../lib/ai/runtime";
import type { ProviderConfig } from "../lib/ai/types";
import type { EvolutionEvent, MemoryRecord, ProcedureRecord } from "../lib/ai/store";
import type { MindPrefs } from "../lib/ai/index";
import { useLocalMemory } from "../lib/memoryStore";
import * as native from "../platform/native";
import { Card, Chip, EmptyState, Row, ScreenHeader, Section, Toggle } from "./ui";
import type { ScreenProps } from "./types";

type Tab = "providers" | "profile" | "archive" | "skills" | "timeline" | "controls" | "notes";

const TABS: { id: Tab; label: string }[] = [
  { id: "providers", label: "Providers" },
  { id: "profile", label: "Profile" },
  { id: "archive", label: "Archive" },
  { id: "skills", label: "Skills" },
  { id: "timeline", label: "Evolution" },
  { id: "controls", label: "Controls" },
  { id: "notes", label: "Notes" },
];

interface ProviderDraft {
  id?: string;
  provider: string;
  model: string;
  baseUrl: string;
  key: string;
}

const EMPTY_DRAFT: ProviderDraft = { provider: "openrouter", model: "", baseUrl: "", key: "" };

export default function MindScreen({ onNavigate }: ScreenProps) {
  const ai = getJarvisAI();
  const [tab, setTab] = useState<Tab>("providers");
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [configs, setConfigs] = useState<ProviderConfig[]>([]);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [procedures, setProcedures] = useState<ProcedureRecord[]>([]);
  const [events, setEvents] = useState<EvolutionEvent[]>([]);
  const [conversations, setConversations] = useState<{ id: string; title: string; updated_at: number }[]>([]);
  const [prefs, setPrefs] = useState<MindPrefs | null>(null);
  const [search, setSearch] = useState("");
  const [searchHits, setSearchHits] = useState<MemoryRecord[] | null>(null);
  const [draft, setDraft] = useState<ProviderDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [vault, setVault] = useState<string>("checking");
  const [newFact, setNewFact] = useState("");

  const notes = useLocalMemory((state) => state.notes);
  const addNote = useLocalMemory((state) => state.add);
  const removeNote = useLocalMemory((state) => state.remove);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      await initMind();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Local memory is unavailable.");
      setReady(false);
      return;
    }
    const store = ai.store;
    const [configsNext, memoriesNext, proceduresNext, eventsNext, conversationsNext, prefsNext, vaultKind] =
      await Promise.all([
        ai.gateway.load(true),
        store.listMemories(),
        store.listProcedures(),
        store.listEvents(60),
        store.conversations(30),
        ai.prefs(),
        ai.gateway.storageKind(),
      ]);
    setConfigs(configsNext);
    setMemories(memoriesNext);
    setProcedures(proceduresNext);
    setEvents(eventsNext);
    setConversations(conversationsNext);
    setPrefs(prefsNext);
    setVault(vaultKind);
    setReady(true);
  }, [ai]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (label: string, task: () => Promise<string | null>) => {
    setBusy(label);
    setNotice(null);
    try {
      const message = await task();
      if (message) setNotice(message);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "That operation failed.");
    } finally {
      setBusy(null);
    }
  };

  const saveProvider = () =>
    run("save", async () => {
      // 1) The schema must exist before the first write.
      await initMind();
      const hadKey = Boolean(draft.key.trim());
      // 2) Persist config + key (config in SQLite, key in the Keystore).
      const config = await ai.gateway.upsert({
        id: draft.id,
        provider: draft.provider,
        model: draft.model,
        baseUrl: draft.baseUrl || undefined,
        apiKey: draft.key,
        roles: ["default"],
      });
      // 3) Prove it: read the provider back from the database.
      const reloaded = await ai.gateway.load(true);
      const confirmed = reloaded.find((entry) => entry.id === config.id);
      if (!confirmed) {
        throw new Error(
          "The provider was written but could not be read back from local storage. Run “Test local storage” below — the phone's database is not persisting values in this build.",
        );
      }
      setDraft(EMPTY_DRAFT);
      setModels([]);
      await refresh();
      const keyNote = hadKey
        ? await ai.gateway.hasKey(config.id)
          ? " Key stored and readable in the Android Keystore."
          : " The key was saved but could not be read back — check “Test” before relying on it."
        : " No key was entered, so this provider will fail until you add one.";
      return `${confirmed.label} · ${confirmed.model} saved and verified in on-device storage.${keyNote}`;
    });

  const testProvider = (id: string) =>
    run(`test:${id}`, async () => {
      const result = await ai.gateway.test(id);
      setModels(result.models || []);
      await refresh();
      return result.ok ? `✔ ${result.message}` : `✖ ${result.message}`;
    });

  const discover = (id: string) =>
    run(`models:${id}`, async () => {
      const list = await ai.gateway.discoverModels(id);
      setModels(list);
      return list.length ? `${list.length} models listed. Tap one to select it.` : "The provider listed no models.";
    });

  const removeProvider = (id: string) =>
    run(`remove:${id}`, async () => {
      await ai.gateway.remove(id);
      await refresh();
      return "Provider and its stored key were removed.";
    });

  const copyExport = () =>
    run("export", async () => {
      const json = await ai.store.exportAll();
      const copied = await native
        .nativeAvailable()
        .then(async (available) => {
          if (!available) return false;
          await native.clipboardWrite(json);
          return true;
        })
        .catch(() => false);
      if (!copied) {
        try {
          await navigator.clipboard.writeText(json);
          setNotice("Exported JSON copied to the clipboard.");
        } catch {
          return "Clipboard is blocked, so the export could not be copied.";
        }
      }
      return `Exported ${(json.length / 1024).toFixed(1)} KB of memory to the clipboard.`;
    });

  const updatePrefs = (patch: Partial<MindPrefs>) =>
    run("prefs", async () => {
      const next = await ai.setPrefs(patch);
      setPrefs(next);
      return null;
    });

  if (error) {
    return (
      <div className="pb-2">
        <ScreenHeader eyebrow="Continuity" title="Memory" subtitle="On-device memory and provider configuration." />
        <EmptyState
          title="Local memory needs the Android build"
          body={`${error} The desktop preview has no SQLite bridge, so nothing is stored or faked here.`}
          action={
            <button type="button" className="m-btn" data-variant="primary" onClick={() => onNavigate("settings")}>
              Open settings
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="pb-2">
      <ScreenHeader
        eyebrow="Continuity"
        title="Memory & Evolution"
        subtitle={`Local SQLite · keys in ${vault === "android-keystore" ? "Android Keystore" : "process memory only"}`}
        right={<Chip tone={configs.some((config) => config.enabled) ? "ok" : "warn"}>{configs.length} provider{configs.length === 1 ? "" : "s"}</Chip>}
      />

      <div className="mb-3 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Memory sections">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className="m-chip shrink-0"
            data-tone={tab === entry.id ? "accent" : undefined}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {notice && (
        <div className="mb-3 rounded-xl border border-sky-300/25 bg-sky-300/10 px-3 py-2">
          <span className="m-small" style={{ color: "#d7f2ff" }}>{notice}</span>
        </div>
      )}

      {tab === "providers" && (
        <>
          <Section title="Direct AI providers" action={<span className="m-row-sub">no PC required</span>}>
            <Card className="mb-3">
              <div className="m-label mb-2">{draft.id ? "Edit provider" : "Add provider"}</div>
              <select
                className="m-input"
                value={draft.provider}
                onChange={(event) => setDraft({ ...draft, provider: event.target.value, model: "" })}
              >
                {PROVIDERS.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label}
                  </option>
                ))}
                <option value="custom">Custom (OpenAI-compatible)</option>
              </select>
              {providerById(draft.provider)?.custom && (
                <input
                  className="m-input mt-2"
                  placeholder="Base URL, e.g. https://my-host/v1"
                  inputMode="url"
                  autoCapitalize="none"
                  value={draft.baseUrl}
                  onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                />
              )}
              <input
                className="m-input mt-2"
                placeholder={`Model ID (e.g. ${providerById(draft.provider)?.suggestedModels[0] || "provider model id"})`}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={draft.model}
                onChange={(event) => setDraft({ ...draft, model: event.target.value })}
              />
              <input
                className="m-input mt-2"
                placeholder={draft.id ? "Replace API key (leave blank to keep)" : "API key"}
                type="password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={draft.key}
                onChange={(event) => setDraft({ ...draft, key: event.target.value })}
              />
              {(providerById(draft.provider)?.suggestedModels ?? []).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {(providerById(draft.provider)?.suggestedModels ?? []).map((model) => (
                    <button
                      key={model}
                      type="button"
                      className="m-chip"
                      data-tone={draft.model === model ? "accent" : undefined}
                      onClick={() => setDraft((current) => ({ ...current, model }))}
                    >
                      {model}
                    </button>
                  ))}
                </div>
              )}
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className="m-btn flex-1"
                  data-variant="primary"
                  disabled={busy !== null || !draft.model.trim()}
                  onClick={() => void saveProvider()}
                >
                  {busy === "save" ? "Saving…" : "Save provider"}
                </button>
               <button type="button" className="m-btn" onClick={() => setDraft(EMPTY_DRAFT)} disabled={busy !== null}>
                  Clear
                </button>
              </div>
              <p className="m-row-sub mt-2">
                Requests go directly from this phone to the provider. HTTPS is required; a LAN HTTP endpoint needs the
                development option in the provider definition. Keys are encrypted with Android Keystore and never enter
                the memory database, logs or exports. A rooted device can still observe a key while the app uses it.
              </p>
            </Card>

            <Card className="mb-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="m-label">Active model</div>
                  <div className="m-row-title truncate">
                    {configs.find((entry) => entry.enabled)?.model ?? "None — chat cannot answer yet"}
                  </div>
                </div>
                <Chip tone={configs.some((entry) => entry.enabled) ? "ok" : "warn"}>
                  {configs.some((entry) => entry.enabled) ? "ready" : "unset"}
                </Chip>
              </div>
              <p className="m-row-sub mt-1">
                This model answers straight from the phone. Local phone actions (battery, settings, apps, clipboard) work
                even with no model and no internet.
              </p>
              <button
                type="button"
                className="m-btn mt-2"
                data-size="sm"
                disabled={busy !== null}
                onClick={() =>
                  void run("probe", async () => {
                    const result = await storageProbe();
                    return result.message;
                  })
                }
              >
                {busy === "probe" ? "Checking…" : "Test local storage"}
              </button>
            </Card>

            {configs.length === 0 ? (
              <EmptyState title="No model configured" body="Add one provider key and a model ID. Chat and voice then work without a PC. Local phone actions already work without any provider." />
            ) : (
              configs.map((config) => (
                <Card key={config.id} className="mb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="m-row-title truncate">{config.label}</div>
                      <div className="m-row-sub truncate">{config.model}</div>
                    </div>
                    <Chip tone={config.enabled ? "ok" : "danger"}>{config.enabled ? "enabled" : "disabled"}</Chip>
                  </div>
                  <div className="m-row-sub mt-1">
                    {providerById(config.provider)?.protocol || config.provider} · {config.baseUrl}
                  </div>
                  {config.lastTest && (
                    <div className="m-small mt-2" style={{ color: config.lastTest.ok ? "#a7f3d0" : "#fecdd3" }}>
                      {config.lastTest.ok ? "✔ " : "✖ "}
                      {config.lastTest.message}
                      {typeof config.lastTest.latencyMs === "number" ? ` · ${config.lastTest.latencyMs} ms` : ""}
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" className="m-btn" data-size="sm" disabled={busy !== null} onClick={() => void testProvider(config.id)}>
                      {busy === `test:${config.id}` ? "Testing…" : "Test"}
                    </button>
                    <button type="button" className="m-btn" data-size="sm" disabled={busy !== null} onClick={() => void discover(config.id)}>
                      Models
                    </button>
                    <button
                      type="button"
                      className="m-btn"
                      data-size="sm"
                      onClick={() => setDraft({ id: config.id, provider: config.provider, model: config.model, baseUrl: config.baseUrl, key: "" })}
                    >
                      Edit
                    </button>
                    <button type="button" className="m-btn" data-size="sm" data-variant="danger" disabled={busy !== null} onClick={() => void removeProvider(config.id)}>
                      Remove
                    </button>
                  </div>
                </Card>
              ))
            )}

            {models.length > 0 && (
              <Card>
                <div className="m-label mb-2">Models from the provider</div>
                <div className="flex max-h-64 flex-wrap gap-2 overflow-y-auto">
                  {models.slice(0, 80).map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      className="m-chip"
                      data-tone={draft.model === model.id ? "accent" : undefined}
                      onClick={() => setDraft((current) => ({ ...current, model: model.id }))}
                    >
                      {model.label}
                    </button>
                  ))}
                </div>
                <p className="m-row-sub mt-2">Tap a model, then Save. Nothing is sent to a model you did not select.</p>
              </Card>
            )}
          </Section>
        </>
      )}

      {tab === "profile" && (
        <>
          <Section title="Owner profile" action={<span className="m-row-sub">{memories.length} facts</span>}>
            <Card className="mb-3">
              <div className="flex gap-2">
                <input
                  className="m-input"
                  placeholder='e.g. "Prefers concise answers"'
                  value={newFact}
                  onChange={(event) => setNewFact(event.target.value)}
                />
                <button
                  type="button"
                  className="m-btn"
                  disabled={!newFact.trim() || busy !== null}
                  onClick={() =>
                    void run("fact", async () => {
                      const stored = await ai.store.putMemory({ category: "preference", content: newFact, confidence: 1 });
                      setNewFact("");
                      await refresh();
                      return stored ? "Memory saved." : "That looks like a credential, so it was not stored.";
                    })
                  }
                >
                  Add
                </button>
              </div>
              <div className="mt-2 flex gap-2">
                <input className="m-input" placeholder="Search memories" value={search} onChange={(event) => setSearch(event.target.value)} />
                <button
                  type="button"
                  className="m-btn"
                  disabled={!search.trim()}
                  onClick={() =>
                    void run("search", async () => {
                      const hits = await ai.store.searchMemories(search);
                      setSearchHits(hits);
                      return hits.length ? `${hits.length} matching memories.` : "No memory matched that search.";
                    })
                  }
                >
                  Search
                </button>
              </div>
            </Card>
            {(searchHits || memories).map((memory) => (
              <Card key={memory.id} className="mb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="m-row-title" style={{ whiteSpace: "pre-wrap" }}>{memory.content}</div>
                    <div className="m-row-sub">
                      {memory.category} · confidence {memory.confidence.toFixed(2)} ·{" "}
                      {new Date(memory.confirmed_at || memory.created_at).toLocaleDateString()}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="m-btn"
                    data-size="sm"
                    data-variant="danger"
                    onClick={() =>
                      void run(`del:${memory.id}`, async () => {
                        await ai.store.deleteMemory(memory.id);
                        setSearchHits(null);
                        await refresh();
                        return "Memory deleted from the database.";
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
              </Card>
            ))}
            {memories.length === 0 && <EmptyState title="No stored profile" body='Say "Remember that I prefer concise answers" or add a fact above. Nothing is inferred without your wording.' />}
          </Section>
        </>
      )}

      {tab === "archive" && (
        <Section title="Conversation archive" action={<span className="m-row-sub">{conversations.length} conversations</span>}>
          {conversations.length === 0 ? (
            <EmptyState title="No conversations yet" body="Chats are stored locally when full retention is enabled. Each message keeps its timestamp, provider and tool trace." />
          ) : (
            conversations.map((conversation) => (
              <Card key={conversation.id} className="mb-2">
                <Row
                  title={conversation.title || "Conversation"}
                  subtitle={new Date(conversation.updated_at).toLocaleString()}
                  right={
                    <button
                      type="button"
                      className="m-btn"
                      data-size="sm"
                      data-variant="danger"
                      onClick={() =>
                        void run(`conv:${conversation.id}`, async () => {
                          await ai.store.deleteConversation(conversation.id);
                          await refresh();
                          return "Conversation and its messages were deleted.";
                        })
                      }
                    >
                      Delete
                    </button>
                  }
                />
              </Card>
            ))
          )}
        </Section>
      )}

      {tab === "skills" && (
        <Section title="Learned procedures" action={<span className="m-row-sub">verified only</span>}>
          {procedures.length === 0 ? (
            <EmptyState title="Nothing learned yet" body="After a verified multi-step task the engine drafts a procedure, evaluates it, and lists it here as a draft. Failed attempts never become procedures." />
          ) : (
            procedures.map((procedure) => (
              <Card key={procedure.id} className="mb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="m-row-title">{procedure.name}</div>
                    <div className="m-row-sub">v{procedure.version} · {procedure.status}</div>
                  </div>
                  <Chip tone={procedure.status === "TESTED" || procedure.status === "APPROVED" ? "ok" : "warn"}>{procedure.status}</Chip>
                </div>
                <p className="m-small mt-2">{procedure.purpose}</p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className="m-btn"
                    data-size="sm"
                    disabled={busy !== null || procedure.status === "APPROVED"}
                    onClick={() =>
                      void run(`promote:${procedure.id}`, async () => {
                        await ai.store.saveProcedure({
                          ...procedure,
                          status: "APPROVED",
                          version: procedure.version + 1,
                        });
                        await refresh();
                        return "Procedure approved for reuse by the assistant.";
                      })
                    }
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="m-btn"
                    data-size="sm"
                    data-variant="danger"
                    onClick={() =>
                      void run(`retire:${procedure.id}`, async () => {
                        await ai.store.saveProcedure({ ...procedure, status: "RETIRED", version: procedure.version + 1 });
                        await refresh();
                        return "Procedure retired. It is no longer offered as verified guidance.";
                      })
                    }
                  >
                    Retire
                  </button>
                </div>
              </Card>
            ))
          )}
        </Section>
      )}

      {tab === "timeline" && (
        <Section title="Evolution timeline" action={<span className="m-row-sub">{events.length} events</span>}>
          {events.length === 0 ? (
            <EmptyState title="No evolution events" body="Memory writes, provider changes, procedure promotion and tool outcomes appear here with their evidence." />
          ) : (
            events.map((event) => (
              <Card key={event.id} className="mb-2">
                <div className="m-row-title">{event.summary}</div>
                <div className="m-row-sub">
                  {event.kind} · {new Date(event.ts).toLocaleString()}
                </div>
                {event.detail ? <p className="m-small mt-1" style={{ whiteSpace: "pre-wrap" }}>{event.detail}</p> : null}
              </Card>
            ))
          )}
        </Section>
      )}

      {tab === "controls" && prefs && (
        <>
          <Section title="Memory controls">
            <Card>
              <Toggle
                label="Full conversation retention"
                hint="Store every message locally. Turning this off stops new transcripts; existing ones remain until you delete them."
                value={prefs.retention}
                onChange={(value) => void updatePrefs({ retention: value })}
              />
              <Toggle
                label="Automatic memory extraction"
                hint="Only explicit wording creates profile facts. Credentials are always rejected."
                value={prefs.extraction}
                onChange={(value) => void updatePrefs({ extraction: value })}
              />
              <Toggle
                label="Speak greetings"
                hint="Respects quiet hours and only speaks when Android TTS is actually available."
                value={prefs.spokenGreetings}
                onChange={(value) => void updatePrefs({ spokenGreetings: value })}
              />
              <Toggle
                label="Auto-promote low-risk procedures"
                hint="Protected surfaces (permissions, credentials, automation) always require your approval."
                value={prefs.autoPromote}
                onChange={(value) => void updatePrefs({ autoPromote: value })}
              />
            </Card>
          </Section>

          <Section title="Data">
            <Card>
              <Row title="Export everything" subtitle="JSON of memories, transcripts, procedures and events — copied to the clipboard." />
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className="m-btn" disabled={busy !== null} onClick={() => void copyExport()}>
                  {busy === "export" ? "Exporting…" : "Export to clipboard"}
                </button>
                <button
                  type="button"
                  className="m-btn"
                  data-variant="danger"
                  disabled={busy !== null}
                  onClick={() => {
                    if (!window.confirm("Delete every stored memory, episode, procedure and event? Transcripts stay until you clear the archive.")) return;
                    void run("erase", async () => {
                      await ai.store.clearAllMemory();
                      await refresh();
                      return "Memory, episodes, procedures and events were deleted.";
                    });
                  }}
                >
                  Erase memory
                </button>
                <button
                  type="button"
                  className="m-btn"
                  data-variant="danger"
                  disabled={busy !== null}
                  onClick={() => {
                    if (!window.confirm("Delete the entire local conversation archive? This cannot be undone.")) return;
                    void run("eraseArchive", async () => {
                      await ai.store.clearArchive();
                      await refresh();
                      return "Conversation archive deleted.";
                    });
                  }}
                >
                  Erase archive
                </button>
              </div>
              <p className="m-row-sub mt-2">
                Deletion removes rows and derived retrieval data from the local database. It does not touch the JARVIS
                backend's own memory.
              </p>
            </Card>
          </Section>

          <Section title="Always-listening wake word">
            <Card>
              <div className="m-row-title">Not available in this build</div>
              <p className="m-small mt-1">
                The foreground microphone wake-word service is not implemented, so this build never claims to be
                listening in the background. Tap-to-talk in Chat uses the real Android speech recogniser.
              </p>
            </Card>
          </Section>
        </>
      )}

      {tab === "notes" && (
        <Section title="Quick notes" action={<span className="m-row-sub">{notes.length}</span>}>
          <Card className="mb-3">
            <div className="m-label mb-2">Add a note</div>
            <NoteComposer onAdd={(text) => addNote(text)} />
          </Card>
          {notes.map((note) => (
            <Card key={note.id} className="mb-2">
              <div className="flex items-start justify-between gap-2">
                <div className="m-row-main">
                  <div className="m-row-title" style={{ whiteSpace: "pre-wrap" }}>{note.text}</div>
                  <div className="m-row-sub">{new Date(note.ts).toLocaleString()}</div>
                </div>
                <button type="button" className="m-btn" data-size="sm" data-variant="danger" onClick={() => removeNote(note.id)}>
                  Delete
                </button>
              </div>
            </Card>
          ))}
          {notes.length === 0 && <EmptyState title="No notes" body="Notes stay on this device and are never uploaded automatically." />}
        </Section>
      )}
    </div>
  );
}

function NoteComposer({ onAdd }: { onAdd: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <>
      <textarea className="m-textarea" rows={2} value={text} onChange={(event) => setText(event.target.value)} placeholder="Something to keep on this device…" />
      <button
        type="button"
        className="m-btn mt-2"
        data-variant="primary"
        disabled={!text.trim()}
        onClick={() => {
          onAdd(text);
          setText("");
        }}
      >
        Save note
      </button>
    </>
  );
}
