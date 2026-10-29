# On-device memory architecture

The phone keeps its own memory; it is not a mirror of the Python backend and
never writes to the backend's `data/memory.db`.

```
Android app (WebView)
  ├─ web/src/lib/ai/store.ts        schema, repositories, retrieval, extraction
  ├─ web/src/lib/ai/runtime.ts      one MemoryStore + gateway instance
  └─ native bridge
       ├─ dbQuery / dbExec          parameterised SQL only (SELECT… / INSERT…)
       └─ JarvisDb                  SQLiteOpenHelper → app-private jarvis_mind.db
```

## Layers

| Table | Purpose | Key fields |
| --- | --- | --- |
| `memories` | Curated profile facts (semantic) | `layer`, `category`, `content`, `source_ref`, `confidence`, `confirmed_at`, `superseded_by`, `deleted` |
| `messages` | Transcript (episodic) | `conversation_id`, `role`, `text`, `ts`, `provider`, `model`, `tool_calls`, `status` |
| `conversations` | Session boundaries | `id`, `title`, `started_at`, `updated_at` |
| `episodes` | Task outcomes and lessons | `goal`, `tools`, `result`, `error`, `outcome`, `lesson` |
| `procedures` | Versioned reusable workflows | `name` (unique), `status`, `version`, `parent_version`, `test_result` |
| `events` | Evolution timeline | `kind`, `summary`, `detail`, `ts` |
| `usage` | Token accounting | `provider`, `model`, `role`, `input_tokens`, `output_tokens` |
| `settings` | JSON preferences | `key`, `value` |

`PRAGMA user_version` migrations are additive; nothing drops user rows. The
first schema is created with `CREATE TABLE IF NOT EXISTS`, so an upgrade over an
existing install does not reset it.

## Write path

1. The owner utterance is stored in `messages` (when retention is on).
2. `extractMemoryCandidates()` recognises explicit memory phrasing only; it
   never infers biography from ordinary conversation.
3. `sanitizeMemory()` rejects credential-shaped text (`sk-…`, `AIza…`,
   `password: …`, private-key blocks) before the insert.
4. Duplicate `(layer, category, content)` rows are confirmed (confidence +0.05)
   instead of multiplied. A new `address` supersedes the previous one so the
   assistant never sees two conflicting names.
5. "Forget that …" performs a hard `DELETE` and clears supersession links.
   Deleting a conversation removes its messages.

## Read path (before each model request)

`retrieveContext(store, query, { budget })`:

1. ranks profile facts by keyword hits, recency, confidence and category
   (identity/address/style weighted) and excludes superseded rows;
2. adds episodes matching the task (`goal`, `lesson`, `error`);
3. adds procedures only in `TESTED` / `APPROVED` / `VALIDATED` state;
4. adds the last turns of the conversation;
5. adds exact earlier messages only when the request asks for a quotation, a
   previous instruction or a date ("exactly", "quote", "what did I say",
   "previously");
6. truncates to a character budget (~4 chars/token) so the archive is never
   sent wholesale.

The result is labelled in the system prompt as *data*, with provenance, and the
model is told to admit when no memory matched.

## Retention and deletion

Controls in the Memory tab: full-retention toggle, extraction toggle, spoken
greetings, quiet hours, daily token budget, export (JSON to clipboard), erase
memory (facts/episodes/procedures/events) and erase archive (messages). Both
erase actions require a confirmation dialog and remove derived retrieval rows,
not just UI entries.

## Security boundaries

- Provider keys: Android Keystore only (`JarvisSecureStore`); excluded from the
  memory DB, exports, logs and crash text.
- `JarvisDb.exec` refuses `ATTACH`/`DETACH`/`load_extension`; `dbQuery` accepts
  only `SELECT`/`PRAGMA`. The API is reachable from trusted app code, never from
  a model tool.
- The bridge is local; there is no network surface for the database.

## Known limitations

- No embeddings: ranking is lexical + recency + confidence. That is deliberate
  (no extra provider bill) and documented in the UI copy.
- No automatic consolidation job yet; the schema and manual review screen exist.
- Data lives in app-private storage; uninstalling or clearing app data removes
  it. Export before wiping.
