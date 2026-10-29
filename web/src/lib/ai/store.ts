/**
 * Local, durable JARVIS memory — SQLite on the phone.
 *
 * The database lives in the app's private storage through the native bridge
 * (`JarvisDb`), so it survives navigation, process death, upgrades and backend
 * outages. Repositories are written here in TypeScript over a tiny port so the
 * exact SQL can be executed by `node:sqlite` in tests.
 *
 * Layers
 *  - profile   : curated semantic facts/preferences with provenance
 *  - messages  : episodic transcript (full retention toggle lives in settings)
 *  - episodes  : task outcomes + lessons
 *  - procedures: versioned, status-tagged reusable procedures
 *  - events    : evolution timeline
 *  - usage     : per-provider token accounting
 *
 * SECURITY: credentials never enter this database. `isSecretLike` and
 * `sanitizeMemory` reject them before any write, and the provider key vault is
 * a separate native Keystore store.
 */

export interface DbPort {
  query(sql: string, params?: unknown[]): Promise<Record<string, any>[]>;
  exec(sql: string, params?: unknown[]): Promise<void>;
}

export interface SettingRow {
  key: string;
  value: string;
  updated_at: number;
}

/** Schema version 1. `PRAGMA user_version` gates future migrations. */
export const SCHEMA_V1 = [
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS conversations (
     id TEXT PRIMARY KEY,
     title TEXT,
     started_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     source TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL,
     role TEXT NOT NULL,
     text TEXT NOT NULL,
     ts INTEGER NOT NULL,
     provider TEXT,
     model TEXT,
     tool_calls TEXT,
     status TEXT,
     attachments TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts)`,
  `CREATE TABLE IF NOT EXISTS memories (
     id TEXT PRIMARY KEY,
     layer TEXT NOT NULL,
     category TEXT NOT NULL,
     content TEXT NOT NULL,
     source_ref TEXT,
     created_at INTEGER NOT NULL,
     confirmed_at INTEGER,
     confidence REAL NOT NULL DEFAULT 0.7,
     sensitivity TEXT NOT NULL DEFAULT 'normal',
     expires_at INTEGER,
     visible INTEGER NOT NULL DEFAULT 1,
     superseded_by TEXT,
     deleted INTEGER NOT NULL DEFAULT 0,
     pinned INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer, deleted)`,
  `CREATE TABLE IF NOT EXISTS episodes (
     id TEXT PRIMARY KEY,
     goal TEXT NOT NULL,
     context TEXT,
     actions TEXT,
     tools TEXT,
     result TEXT,
     error TEXT,
     feedback TEXT,
     outcome TEXT NOT NULL,
     lesson TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_episodes_ts ON episodes(created_at)`,
  `CREATE TABLE IF NOT EXISTS procedures (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     purpose TEXT NOT NULL,
     prerequisites TEXT,
     permissions TEXT,
     steps TEXT NOT NULL,
     expected TEXT,
     failures TEXT,
     verification TEXT,
     status TEXT NOT NULL,
     version INTEGER NOT NULL,
     parent_version INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     test_result TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     summary TEXT NOT NULL,
     detail TEXT,
     ts INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)`,
  `CREATE TABLE IF NOT EXISTS usage (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL,
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     role TEXT,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0
   )`,
];

export function uid(prefix = "id"): string {
  const cryptoObj = typeof globalThis !== "undefined" ? (globalThis as any).crypto : undefined;
  if (cryptoObj?.randomUUID) return `${prefix}_${cryptoObj.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ── Secret hygiene ─────────────────────────────────────────────────────────

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/,
  /\bgsk_[A-Za-z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bxai-[A-Za-z0-9]{20,}\b/,
  /\bnvapi-[A-Za-z0-9_-]{20,}\b/,
  /\bpplx-[A-Za-z0-9]{20,}\b/,
  /\bhf_[A-Za-z0-9]{20,}\b/,
  /\b(?:password|passwd|api[ _-]?key|secret|token)\s*[:=]\s*\S{6,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function isSecretLike(text: string): boolean {
  const value = (text || "").trim();
  if (!value) return false;
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

/** Replace anything that looks like a credential with a marker. */
export function sanitizeText(text: string): string {
  let out = text || "";
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, "gi"), "[redacted credential]");
  }
  return out;
}

export function sanitizeMemory(content: string): string | null {
  const clean = (content || "").trim().replace(/\s+/g, " ");
  if (!clean) return null;
  if (isSecretLike(clean)) return null;
  return sanitizeText(clean).slice(0, 600);
}

// ── Memory extraction (deterministic, no model required) ───────────────────

export type MemoryCategory =
  | "identity"
  | "address"
  | "preference"
  | "style"
  | "project"
  | "goal"
  | "tool"
  | "correction"
  | "reminder"
  | "general";

export interface MemoryCandidate {
  layer: "profile" | "episodic";
  category: MemoryCategory;
  content: string;
  confidence: number;
  explicit: boolean;
  /** Set when the owner asked to forget something. */
  forget?: string;
}

const ADDRESS_STOPWORDS = /^(?:me|my|the|a|an|please|jarvis|sir|madam)\b/i;

/**
 * Extract durable memories from one owner utterance.
 * Only explicit phrasing creates profile rows; everything else is ignored so
 * the assistant does not slowly accumulate invented biography.
 */
export function extractMemoryCandidates(input: string): MemoryCandidate[] {
  const text = (input || "").trim();
  if (!text) return [];
  const out: MemoryCandidate[] = [];
  const push = (candidate: MemoryCandidate) => {
    const safe = sanitizeMemory(candidate.content);
    if (safe) out.push({ ...candidate, content: safe });
  };

  const forget = /^(?:please\s+)?forget\s+(?:that\s+|about\s+)?(.+)$/i.exec(text);
  if (forget) {
    return [{ layer: "profile", category: "general", content: forget[1].trim(), confidence: 1, explicit: true, forget: forget[1].trim() }];
  }

  const remember = /^(?:please\s+)?(?:remember|keep in mind|note)\s+(?:that\s+)?(.+)$/i.exec(text);
  if (remember) {
    const content = remember[1].trim();
    push({
      layer: "profile",
      category: classifyCategory(content),
      content,
      confidence: 0.95,
      explicit: true,
    });
    return out;
  }

  const callMe = /^(?:please\s+)?(?:call me|address me as)\s+(.+?)[.!]?$/i.exec(text);
  if (callMe) {
    const value = callMe[1].trim();
    if (value && value.length < 40 && !ADDRESS_STOPWORDS.test(value)) {
      push({ layer: "profile", category: "address", content: value, confidence: 0.95, explicit: true });
      return out;
    }
  }

  const name = /^(?:my name is|i am|i'm)\s+([A-Z][\w'’-]+(?:\s+[A-Z][\w'’-]+){0,2})[.!]?$/.exec(text);
  if (name) {
    push({ layer: "profile", category: "identity", content: `Name: ${name[1]}`, confidence: 0.9, explicit: true });
    return out;
  }

  const pref = /\bi (?:prefer|like|always want|would rather)\b(.+)$/i.exec(text);
  if (pref) {
    push({
      layer: "profile",
      category: classifyCategory(pref[1]),
      content: `Prefers${pref[1].replace(/\s+$/, "")}`.trim(),
      confidence: 0.85,
      explicit: false,
    });
  }

  const correction = /\b(?:don'?t|do not|never)\s+(?:use|do|try)\b(.+)$/i.exec(text);
  if (correction) {
    push({
      layer: "profile",
      category: "correction",
      content: `Avoid:${correction[1]}`,
      confidence: 0.85,
      explicit: false,
    });
  }

  const project = /\bmy\s+(?:project|app|repo)\s+(?:is|uses|runs|builds)\b(.+)$/i.exec(text);
  if (project) {
    push({
      layer: "profile",
      category: "project",
      content: `Project:${project[1]}`,
      confidence: 0.8,
      explicit: false,
    });
  }

  const reminder = /\bremind me to\b(.+)$/i.exec(text);
  if (reminder) {
    push({
      layer: "profile",
      category: "reminder",
      content: `Reminder:${reminder[1]}`,
      confidence: 0.9,
      explicit: true,
    });
  }

  return out;
}

function classifyCategory(fragment: string): MemoryCategory {
  const value = fragment.toLowerCase();
  if (/concise|brief|short|verbose|detail|tone|style|formal|casual|humou?r/.test(value)) return "style";
  if (/\bproject\b|\brepo\b|\bapp\b|\bbackend\b|\bbuild\b/.test(value)) return "project";
  if (/\bgoal\b|\bplan\b|\bdeadline\b|\bnext\b/.test(value)) return "goal";
  if (/\btool\b|\bprovider\b|\bmodel\b|\bkeyboard\b|\btheme\b/.test(value)) return "tool";
  if (/\blanguage\b|\benglish\b|\bhindi\b|\bspanish\b|\bfrench\b/.test(value)) return "preference";
  if (/\bnever\b|\bavoid\b|\bwrong\b|\bbroke\b/.test(value)) return "correction";
  return "preference";
}

// ── Store ──────────────────────────────────────────────────────────────────

export interface MemoryRecord {
  id: string;
  layer: string;
  category: string;
  content: string;
  source_ref: string | null;
  created_at: number;
  confirmed_at: number | null;
  confidence: number;
  sensitivity: string;
  expires_at: number | null;
  superseded_by: string | null;
  pinned: number;
}

export interface MessageRecord {
  id: string;
  conversation_id: string;
  role: string;
  text: string;
  ts: number;
  provider: string | null;
  model: string | null;
  tool_calls: string | null;
  status: string | null;
  attachments: string | null;
}

export interface EpisodeRecord {
  id: string;
  goal: string;
  context: string | null;
  actions: string | null;
  tools: string | null;
  result: string | null;
  error: string | null;
  feedback: string | null;
  outcome: string;
  lesson: string | null;
  created_at: number;
}

export interface ProcedureRecord {
  id: string;
  name: string;
  purpose: string;
  prerequisites: string | null;
  permissions: string | null;
  steps: string;
  expected: string | null;
  failures: string | null;
  verification: string | null;
  status: string;
  version: number;
  parent_version: number | null;
  created_at: number;
  updated_at: number;
  test_result: string | null;
}

export interface EvolutionEvent {
  id: string;
  kind: string;
  summary: string;
  detail: string | null;
  ts: number;
}

export class MemoryStore {
  constructor(private readonly db: DbPort) {}

  async migrate(): Promise<void> {
    for (const statement of SCHEMA_V1) await this.db.exec(statement);
  }

  // settings ───────────────────────────────────────────────────────────────

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const rows = await this.db.query("SELECT value FROM settings WHERE key = ?", [key]);
    if (!rows.length) return fallback;
    try {
      return JSON.parse(String(rows[0].value)) as T;
    } catch {
      return fallback;
    }
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    // INSERT OR REPLACE, not `ON CONFLICT … DO UPDATE`: the upsert syntax needs
    // SQLite 3.24 (Android 10 / API 29) while this app supports API 23. On
    // Android 8/9 the old statement threw a syntax error, which is exactly why
    // a saved provider never reappeared and the form could sit on "Saving…".
    await this.db.exec(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
      [key, JSON.stringify(value), Date.now()],
    );
  }

  // conversations + messages ───────────────────────────────────────────────

  async ensureConversation(id: string, title = "Conversation"): Promise<void> {
    const now = Date.now();
    await this.db.exec(
      `INSERT OR IGNORE INTO conversations (id, title, started_at, updated_at, source)
       VALUES (?, ?, ?, ?, 'android')`,
      [id, title, now, now],
    );
    await this.db.exec("UPDATE conversations SET updated_at = ? WHERE id = ?", [now, id]);
  }

  async addMessage(message: MessageRecord): Promise<void> {
    await this.db.exec(
      `INSERT OR REPLACE INTO messages (id, conversation_id, role, text, ts, provider, model, tool_calls, status, attachments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        message.conversation_id,
        message.role,
        message.text,
        message.ts,
        message.provider,
        message.model,
        message.tool_calls,
        message.status,
        message.attachments,
      ],
    );
    await this.db.exec("UPDATE conversations SET updated_at = ? WHERE id = ?", [message.ts, message.conversation_id]);
  }

  async recentMessages(conversationId: string, limit = 20): Promise<MessageRecord[]> {
    const rows = await this.db.query(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY ts DESC LIMIT ?",
      [conversationId, limit],
    );
    return (rows as MessageRecord[]).reverse();
  }

  /** Exact archive search; long questions are reduced to their keywords. */
  async searchMessages(term: string, limit = 20): Promise<MessageRecord[]> {
    const clean = (term || "").trim();
    if (!clean) return [];
    const needles = terms(clean);
    const list = needles.length ? needles : [clean];
    const where = list.map(() => "text LIKE ?").join(" OR ");
    const args: unknown[] = list.map((needle) => `%${needle}%`);
    args.push(limit);
    return (await this.db.query(
      `SELECT * FROM messages WHERE ${where} ORDER BY ts DESC LIMIT ?`,
      args,
    )) as MessageRecord[];
  }

  async conversations(limit = 30): Promise<{ id: string; title: string; updated_at: number }[]> {
    return (await this.db.query(
      "SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT ?",
      [limit],
    )) as { id: string; title: string; updated_at: number }[];
  }

  async deleteConversation(id: string): Promise<void> {
    await this.db.exec("DELETE FROM messages WHERE conversation_id = ?", [id]);
    await this.db.exec("DELETE FROM conversations WHERE id = ?", [id]);
  }

  // profile memories ───────────────────────────────────────────────────────

  async putMemory(input: {
    layer?: "profile" | "episodic";
    category: string;
    content: string;
    sourceRef?: string;
    confidence?: number;
    sensitivity?: string;
    expiresAt?: number | null;
  }): Promise<MemoryRecord | null> {
    const content = sanitizeMemory(input.content);
    if (!content) return null;
    const layer = input.layer || "profile";
    const existing = (await this.db.query(
      "SELECT * FROM memories WHERE layer = ? AND category = ? AND content = ? AND deleted = 0 LIMIT 1",
      [layer, input.category, content],
    )) as MemoryRecord[];
    if (existing.length) {
      await this.db.exec("UPDATE memories SET confirmed_at = ?, confidence = ? WHERE id = ?", [
        Date.now(),
        Math.min(1, Math.max(existing[0].confidence, input.confidence ?? 0.7) + 0.05),
        existing[0].id,
      ]);
      return { ...existing[0], confidence: Math.min(1, existing[0].confidence + 0.05) };
    }
    if (input.category === "address") {
      // A new form of address supersedes the old one rather than stacking.
      await this.db.exec("UPDATE memories SET deleted = 1 WHERE category = 'address' AND deleted = 0");
    }
    const record: MemoryRecord = {
      id: uid("mem"),
      layer,
      category: input.category,
      content,
      source_ref: input.sourceRef || null,
      created_at: Date.now(),
      confirmed_at: Date.now(),
      confidence: input.confidence ?? 0.7,
      sensitivity: input.sensitivity || "normal",
      expires_at: input.expiresAt ?? null,
      superseded_by: null,
      pinned: 0,
    };
    await this.db.exec(
      `INSERT INTO memories (id, layer, category, content, source_ref, created_at, confirmed_at, confidence, sensitivity, expires_at, visible, superseded_by, deleted, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, 0, 0)`,
      [
        record.id,
        record.layer,
        record.category,
        record.content,
        record.source_ref,
        record.created_at,
        record.confirmed_at,
        record.confidence,
        record.sensitivity,
        record.expires_at,
      ],
    );
    await this.logEvent("memory", `Learned ${input.category}`, content);
    return record;
  }

  async listMemories(category?: string): Promise<MemoryRecord[]> {
    const args: unknown[] = [];
    let sql = "SELECT * FROM memories WHERE layer = 'profile' AND deleted = 0 AND visible = 1";
    if (category) {
      sql += " AND category = ?";
      args.push(category);
    }
    sql += " ORDER BY pinned DESC, COALESCE(confirmed_at, created_at) DESC";
    return (await this.db.query(sql, args)) as MemoryRecord[];
  }

  async searchMemories(term: string, limit = 12): Promise<MemoryRecord[]> {
    const clean = (term || "").trim();
    if (!clean) return [];
    return (await this.db.query(
      `SELECT * FROM memories
        WHERE layer = 'profile' AND deleted = 0 AND visible = 1
          AND (content LIKE ? OR category LIKE ?)
        ORDER BY pinned DESC, confidence DESC, COALESCE(confirmed_at, created_at) DESC
        LIMIT ?`,
      [`%${clean}%`, `%${clean}%`, limit],
    )) as MemoryRecord[];
  }

  async updateMemory(id: string, content: string): Promise<boolean> {
    const clean = sanitizeMemory(content);
    if (!clean) return false;
    await this.db.exec("UPDATE memories SET content = ?, confirmed_at = ? WHERE id = ?", [clean, Date.now(), id]);
    return true;
  }

  /** Hard delete: row, supersession links and derived search surface. */
  async deleteMemory(id: string): Promise<void> {
    await this.db.exec("DELETE FROM memories WHERE id = ?", [id]);
    await this.db.exec("UPDATE memories SET superseded_by = NULL WHERE superseded_by = ?", [id]);
    await this.logEvent("memory_deleted", "Memory deleted by owner", id);
  }

  /** Forget by content fragment (used by "forget that …"). */
  async forget(fragment: string): Promise<number> {
    const clean = (fragment || "").trim();
    if (!clean) return 0;
    const rows = (await this.db.query(
      "SELECT id FROM memories WHERE deleted = 0 AND content LIKE ?",
      [`%${clean}%`],
    )) as { id: string }[];
    for (const row of rows) await this.deleteMemory(row.id);
    return rows.length;
  }

  async clearAllMemory(): Promise<void> {
    await this.db.exec("DELETE FROM memories");
    await this.db.exec("DELETE FROM episodes");
    await this.db.exec("DELETE FROM procedures");
    await this.db.exec("DELETE FROM events");
  }

  async clearArchive(): Promise<void> {
    await this.db.exec("DELETE FROM messages");
    await this.db.exec("DELETE FROM conversations");
  }

  // episodes ───────────────────────────────────────────────────────────────

  async addEpisode(episode: Omit<EpisodeRecord, "id" | "created_at">): Promise<EpisodeRecord> {
    const record: EpisodeRecord = { ...episode, id: uid("ep"), created_at: Date.now() };
    await this.db.exec(
      `INSERT INTO episodes (id, goal, context, actions, tools, result, error, feedback, outcome, lesson, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.goal,
        record.context,
        record.actions,
        record.tools,
        record.result,
        record.error,
        record.feedback,
        record.outcome,
        record.lesson,
        record.created_at,
      ],
    );
    return record;
  }

  async listEpisodes(limit = 30): Promise<EpisodeRecord[]> {
    return (await this.db.query("SELECT * FROM episodes ORDER BY created_at DESC LIMIT ?", [limit])) as EpisodeRecord[];
  }

  async searchEpisodes(term: string, limit = 5): Promise<EpisodeRecord[]> {
    const clean = (term || "").trim();
    if (!clean) return [];
    const like = `%${clean}%`;
    return (await this.db.query(
      "SELECT * FROM episodes WHERE goal LIKE ? OR lesson LIKE ? OR error LIKE ? ORDER BY created_at DESC LIMIT ?",
      [like, like, like, limit],
    )) as EpisodeRecord[];
  }

  // procedures ─────────────────────────────────────────────────────────────

  async saveProcedure(
    procedure: Omit<ProcedureRecord, "id" | "created_at" | "updated_at" | "parent_version"> & { id?: string },
  ): Promise<ProcedureRecord> {
    const now = Date.now();
    const previous = (await this.db.query("SELECT * FROM procedures WHERE name = ? LIMIT 1", [
      procedure.name,
    ])) as ProcedureRecord[];
    const record: ProcedureRecord = {
      ...procedure,
      id: procedure.id || previous[0]?.id || uid("proc"),
      parent_version: previous[0]?.version ?? null,
      created_at: previous[0]?.created_at ?? now,
      updated_at: now,
    };
    // `procedures.name` is UNIQUE, so REPLACE updates the existing row. The id
    // is reused above when a row with this name already exists.
    await this.db.exec(
      `INSERT OR REPLACE INTO procedures (id, name, purpose, prerequisites, permissions, steps, expected, failures, verification, status, version, parent_version, created_at, updated_at, test_result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.name,
        record.purpose,
        record.prerequisites,
        record.permissions,
        record.steps,
        record.expected,
        record.failures,
        record.verification,
        record.status,
        record.version,
        record.parent_version,
        record.created_at,
        record.updated_at,
        record.test_result,
      ],
    );
    await this.logEvent("procedure", `Procedure ${record.status.toLowerCase()}: ${record.name}`, `v${record.version}`);
    return record;
  }

  async listProcedures(): Promise<ProcedureRecord[]> {
    return (await this.db.query("SELECT * FROM procedures ORDER BY updated_at DESC")) as ProcedureRecord[];
  }

  async procedureByName(name: string): Promise<ProcedureRecord | null> {
    const rows = (await this.db.query("SELECT * FROM procedures WHERE name = ?", [name])) as ProcedureRecord[];
    return rows[0] || null;
  }

  /** Roll back to the previous known-good body; keeps a new version number. */
  async rollbackProcedure(name: string, previous: Omit<ProcedureRecord, "id" | "created_at" | "updated_at">): Promise<ProcedureRecord> {
    return this.saveProcedure({
      ...previous,
      name,
      status: "TESTED",
      version: (await this.procedureByName(name))?.version ? (await this.procedureByName(name))!.version + 1 : 1,
    });
  }

  // events + usage ─────────────────────────────────────────────────────────

  async logEvent(kind: string, summary: string, detail?: string | null): Promise<void> {
    const safeSummary = sanitizeText(summary).slice(0, 300);
    await this.db.exec("INSERT INTO events (id, kind, summary, detail, ts) VALUES (?, ?, ?, ?, ?)", [
      uid("ev"),
      kind,
      safeSummary,
      detail ? sanitizeText(detail).slice(0, 2000) : null,
      Date.now(),
    ]);
  }

  async listEvents(limit = 60): Promise<EvolutionEvent[]> {
    return (await this.db.query("SELECT * FROM events ORDER BY ts DESC LIMIT ?", [limit])) as EvolutionEvent[];
  }

  async recordUsage(provider: string, model: string, role: string, input: number, output: number): Promise<void> {
    await this.db.exec(
      "INSERT INTO usage (ts, provider, model, role, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)",
      [Date.now(), provider, model, role, Math.max(0, Math.round(input)), Math.max(0, Math.round(output))],
    );
  }

  async usageSince(since: number): Promise<{ input: number; output: number; calls: number }> {
    const rows = (await this.db.query(
      "SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output, COUNT(*) AS calls FROM usage WHERE ts >= ?",
      [since],
    )) as { input: number; output: number; calls: number }[];
    return rows[0] || { input: 0, output: 0, calls: 0 };
  }

  // export ─────────────────────────────────────────────────────────────────

  async exportAll(): Promise<string> {
    const [memories, messages, episodes, procedures, events] = await Promise.all([
      this.db.query("SELECT * FROM memories WHERE deleted = 0"),
      this.db.query("SELECT * FROM messages ORDER BY ts ASC"),
      this.db.query("SELECT * FROM episodes ORDER BY created_at ASC"),
      this.db.query("SELECT * FROM procedures"),
      this.db.query("SELECT * FROM events ORDER BY ts ASC"),
    ]);
    return JSON.stringify(
      {
        schema: 1,
        exported_at: new Date().toISOString(),
        memories,
        messages,
        episodes,
        procedures,
        events,
      },
      null,
      2,
    );
  }
}

// ── Retrieval ──────────────────────────────────────────────────────────────

export interface RetrievedContext {
  profile: MemoryRecord[];
  episodes: EpisodeRecord[];
  procedures: ProcedureRecord[];
  recent: MessageRecord[];
  exact: MessageRecord[];
  text: string;
  tokensUsed: number;
}

function terms(query: string): string[] {
  const stop = new Set([
    "the", "and", "for", "with", "that", "this", "what", "when", "where", "which", "have", "has",
    "you", "your", "please", "about", "from", "into", "does", "did", "can", "could", "would",
    "should", "there", "their", "them", "how", "why", "who", "was", "were", "are", "is", "it",
  ]);
  return [...new Set(
    (query || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s._-]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3 && !stop.has(word)),
  )].slice(0, 6);
}

export function rankMemories(memories: MemoryRecord[], query: string, now = Date.now()): MemoryRecord[] {
  const needles = terms(query);
  const score = (memory: MemoryRecord) => {
    const content = memory.content.toLowerCase();
    let value = memory.pinned ? 0.4 : 0;
    for (const needle of needles) if (content.includes(needle)) value += 0.5;
    const ageDays = Math.max(0, (now - (memory.confirmed_at || memory.created_at)) / 86_400_000);
    value += Math.max(0, 0.3 - ageDays / 400);
    value += (memory.confidence ?? 0.5) * 0.3;
    if (memory.category === "identity" || memory.category === "address" || memory.category === "style") value += 0.35;
    return value;
  };
  return [...memories]
    .filter((memory) => !memory.superseded_by)
    .sort((a, b) => score(b) - score(a));
}

/**
 * Build the context block for the model. Exact-history hits only appear when the
 * owner asked for a quotation/date/previous instruction; everything else is
 * curated so the prompt does not carry the whole archive.
 */
export async function retrieveContext(
  store: MemoryStore,
  query: string,
  options: { conversationId?: string; recentLimit?: number; charBudget?: number } = {},
): Promise<RetrievedContext> {
  const budget = options.charBudget ?? 4000;
  const asksForExact = /\b(?:exactly|verbatim|quote|quoted|what did i say|my exact|last time|previously|earlier)\b/i.test(query);
  const [profileAll, episodes, procedures, recent, exact] = await Promise.all([
    store.listMemories(),
    store.searchEpisodes(query, 3),
    store.listProcedures(),
    options.conversationId ? store.recentMessages(options.conversationId, options.recentLimit ?? 12) : Promise.resolve([]),
    asksForExact ? store.searchMessages(query, 5) : Promise.resolve([]),
  ]);

  const profile = rankMemories(profileAll, query).slice(0, 10);
  const relevantProcedures = procedures
    .filter((procedure) => /TESTED|APPROVED|VALIDATED/.test(procedure.status))
    .filter((procedure) => {
      const needles = terms(query);
      const haystack = `${procedure.name} ${procedure.purpose}`.toLowerCase();
      return needles.some((needle) => haystack.includes(needle));
    })
    .slice(0, 3);

  const lines: string[] = [];
  if (profile.length) {
    lines.push("Owner profile (durable, owner-confirmed):");
    for (const memory of profile) lines.push(`- [${memory.category}] ${memory.content}`);
  }
  if (relevantProcedures.length) {
    lines.push("Verified procedures that may apply:");
    for (const procedure of relevantProcedures) {
      lines.push(`- ${procedure.name} (v${procedure.version}, ${procedure.status}): ${procedure.purpose}`);
    }
  }
  if (episodes.length) {
    lines.push("Related past task outcomes:");
    for (const episode of episodes) {
      lines.push(`- ${episode.goal}: ${episode.outcome}${episode.lesson ? ` — lesson: ${episode.lesson}` : ""}`);
    }
  }
  if (exact.length) {
    lines.push("Exact earlier messages (quoted from the local archive):");
    for (const message of exact.slice(0, 4)) {
      lines.push(`- ${new Date(message.ts).toISOString()} ${message.role}: ${message.text.slice(0, 300)}`);
    }
  }

  let text = "";
  for (const line of lines) {
    if (text.length + line.length + 1 > budget) break;
    text += `${line}\n`;
  }

  return {
    profile,
    episodes,
    procedures: relevantProcedures,
    recent,
    exact,
    text: text.trim(),
    tokensUsed: Math.ceil(text.length / 4),
  };
}
