import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "../lib/backend";
import { useLocalMemory, filterNotes } from "../lib/memoryStore";
import { useBackendHealth } from "./hooks";
import { Card, ScreenHeader, Section } from "./ui";
import type { ScreenProps } from "./types";

interface BackendHit {
  text?: string;
  score?: number;
  ts?: number;
  kind?: string;
}

export default function MemoryScreen({ onNavigate }: ScreenProps) {
  const notes = useLocalMemory((s) => s.notes);
  const add = useLocalMemory((s) => s.add);
  const remove = useLocalMemory((s) => s.remove);
  const togglePin = useLocalMemory((s) => s.togglePin);
  const health = useBackendHealth(30_000);

  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [backendQuery, setBackendQuery] = useState("");
  const [hits, setHits] = useState<BackendHit[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const visible = filterNotes(notes, query);

  const searchBackend = useCallback(async () => {
    const term = backendQuery.trim();
    if (!term) return;
    if (health.status !== "online") {
      setSearchError("Backend memory search requires a configured JARVIS backend.");
      setHits([]);
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const response = await fetch(apiUrl(`/api/memory/search?q=${encodeURIComponent(term)}&limit=15`));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const raw = Array.isArray(data?.results) ? data.results : Array.isArray(data?.matches) ? data.matches : [];
      const list: BackendHit[] = raw.map((item: any) => ({
        text: typeof item === "string" ? item : item?.text || item?.content || JSON.stringify(item),
        score: typeof item?.score === "number" ? item.score : undefined,
        ts: typeof item?.ts === "number" ? item.ts : typeof item?.timestamp === "number" ? item.timestamp : undefined,
        kind: item?.kind || item?.category,
      }));
      setHits(list);
      if (list.length === 0) setSearchError(null);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : "Backend memory search failed.");
      setHits([]);
    } finally {
      setSearching(false);
    }
  }, [backendQuery, health.status]);

  useEffect(() => {
    setHits(null);
    setSearchError(null);
  }, [health.status]);

  return (
    <div className="pb-2">
      <ScreenHeader
        eyebrow="Continuity"
        title="Memory"
        subtitle="On-device notes are stored in this app. Backend memory stays in the JARVIS database."
      />

      <Section title="On this phone">
        <Card className="mb-3">
          <div className="m-label mb-2">New note</div>
          <textarea
            className="m-textarea"
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Something JARVIS should remember on this device…"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="m-btn"
              data-variant="primary"
              disabled={!draft.trim()}
              onClick={() => {
                add(draft);
                setDraft("");
              }}
            >
              Save note
            </button>
            <button type="button" className="m-btn" onClick={() => setDraft("")} disabled={!draft}>
              Clear
            </button>
          </div>
          <p className="m-row-sub mt-2">
            Local notes persist across upgrades. They are separate from the backend's long-term memory and are never uploaded automatically.
          </p>
        </Card>

        <Card>
          <div className="flex items-center gap-2">
            <input
              className="m-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter local notes"
            />
            <span className="m-row-sub">{notes.length}</span>
          </div>
          {visible.length === 0 ? (
            <p className="m-small mt-3" style={{ color: "rgba(214,235,255,0.6)" }}>
              {notes.length === 0 ? "No local notes yet. Saved notes appear here." : "No note matches that filter."}
            </p>
          ) : (
            <div className="mt-1">
              {visible.map((note) => (
                <div className="m-row" key={note.id}>
                  <div className="m-row-main">
                    <div className="m-row-title" style={{ whiteSpace: "pre-wrap" }}>{note.text}</div>
                    <div className="m-row-sub">
                      {new Date(note.ts).toLocaleString()}
                      {note.pinned ? " · pinned" : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      className="m-btn"
                      data-size="sm"
                      data-variant="ghost"
                      onClick={() => togglePin(note.id)}
                      aria-label={note.pinned ? "Unpin note" : "Pin note"}
                    >
                      {note.pinned ? "Unpin" : "Pin"}
                    </button>
                    <button
                      type="button"
                      className="m-btn"
                      data-size="sm"
                      data-variant="danger"
                      onClick={() => remove(note.id)}
                      aria-label="Delete note"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </Section>

      <Section title="JARVIS backend memory" action={<span className="m-row-sub">server database</span>}>
        <Card>
          {health.status !== "online" ? (
            <>
              <div className="m-h2">Backend memory requires a backend</div>
              <p className="m-small mt-2">
                Your existing long-term memory is preserved on the backend. Configure a connection to search it from the phone, or keep using local notes above.
              </p>
              <button type="button" className="m-btn mt-3" data-variant="primary" onClick={() => onNavigate("settings")}>
                Configure backend
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <input
                  className="m-input"
                  value={backendQuery}
                  onChange={(event) => setBackendQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void searchBackend();
                  }}
                  placeholder="Search long-term memory…"
                />
                <button type="button" className="m-btn" onClick={() => void searchBackend()} disabled={searching || !backendQuery.trim()}>
                  {searching ? "…" : "Search"}
                </button>
              </div>
              {searchError && <p className="m-small mt-2" style={{ color: "#fecdd3" }}>{searchError}</p>}
              {hits && hits.length === 0 && !searchError && (
                <p className="m-small mt-3">No backend memory matched that query.</p>
              )}
              {hits && hits.length > 0 && (
                <div className="mt-2">
                  {hits.map((hit, index) => (
                    <div className="m-row" key={`${hit.text}-${index}`}>
                      <div className="m-row-main">
                        <div className="m-row-title" style={{ whiteSpace: "pre-wrap" }}>{hit.text}</div>
                        <div className="m-row-sub">
                          {hit.kind || "memory"}
                          {typeof hit.score === "number" ? ` · score ${hit.score.toFixed(3)}` : ""}
                          {hit.ts ? ` · ${new Date(hit.ts).toLocaleDateString()}` : ""}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <p className="m-row-sub mt-2">
                Read-only search against the configured backend. Memory is never reset or overwritten by this screen.
              </p>
            </>
          )}
        </Card>
      </Section>
    </div>
  );
}
