package com.jarvis.local;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Local JARVIS memory database (SQLite, app-private storage).
 *
 * The schema is owned by the TypeScript memory layer
 * (web/src/lib/ai/store.ts) — this class only opens the file and executes
 * parameterised statements over a narrow bridge. Statements are app-supplied,
 * never model-supplied: no tool can reach this API.
 */
public class JarvisDb extends SQLiteOpenHelper {

    private static final String NAME = "jarvis_mind.db";
    private static final int VERSION = 1;

    private static final String[] SCHEMA = new String[]{
        "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT)",
        "CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL, provider TEXT, model TEXT, tool_calls TEXT, status TEXT, attachments TEXT)",
        "CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, ts)",
        "CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts)",
        "CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, layer TEXT NOT NULL, category TEXT NOT NULL, content TEXT NOT NULL, source_ref TEXT, created_at INTEGER NOT NULL, confirmed_at INTEGER, confidence REAL NOT NULL DEFAULT 0.7, sensitivity TEXT NOT NULL DEFAULT 'normal', expires_at INTEGER, visible INTEGER NOT NULL DEFAULT 1, superseded_by TEXT, deleted INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0)",
        "CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer, deleted)",
        "CREATE TABLE IF NOT EXISTS episodes (id TEXT PRIMARY KEY, goal TEXT NOT NULL, context TEXT, actions TEXT, tools TEXT, result TEXT, error TEXT, feedback TEXT, outcome TEXT NOT NULL, lesson TEXT, created_at INTEGER NOT NULL)",
        "CREATE INDEX IF NOT EXISTS idx_episodes_ts ON episodes(created_at)",
        "CREATE TABLE IF NOT EXISTS procedures (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, purpose TEXT NOT NULL, prerequisites TEXT, permissions TEXT, steps TEXT NOT NULL, expected TEXT, failures TEXT, verification TEXT, status TEXT NOT NULL, version INTEGER NOT NULL, parent_version INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, test_result TEXT)",
        "CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT, ts INTEGER NOT NULL)",
        "CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)",
        "CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, role TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0)",
    };

    public JarvisDb(Context context) {
        super(context.getApplicationContext(), NAME, null, VERSION);
    }

    @Override
    public void onConfigure(SQLiteDatabase db) {
        super.onConfigure(db);
        db.setForeignKeyConstraintsEnabled(true);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        for (String statement : SCHEMA) db.execSQL(statement);
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // Version 1 is the first schema. Future migrations are additive and
        // must never drop user memory; the JS layer owns PRAGMA user_version
        // migrations and this method only receives Android-level upgrades.
        for (String statement : SCHEMA) db.execSQL(statement);
    }

    /** Only read statements may use this entry point. */
    public static JSONArray query(SQLiteDatabase db, String sql, JSONArray args) throws Exception {
        String head = sql.trim().toLowerCase();
        if (!(head.startsWith("select") || head.startsWith("pragma"))) {
            throw new IllegalArgumentException("dbQuery only accepts SELECT/PRAGMA statements");
        }
        String[] bind = bindArgs(args);
        List<JSONObject> rows = new ArrayList<>();
        Cursor cursor = db.rawQuery(sql, bind);
        try {
            String[] names = cursor.getColumnNames();
            while (cursor.moveToNext()) {
                JSONObject row = new JSONObject();
                for (int i = 0; i < names.length; i++) {
                    switch (cursor.getType(i)) {
                        case Cursor.FIELD_TYPE_NULL:
                            row.put(names[i], JSONObject.NULL);
                            break;
                        case Cursor.FIELD_TYPE_INTEGER:
                            row.put(names[i], cursor.getLong(i));
                            break;
                        case Cursor.FIELD_TYPE_FLOAT:
                            row.put(names[i], cursor.getDouble(i));
                            break;
                        default:
                            row.put(names[i], cursor.getString(i));
                    }
                }
                rows.add(row);
            }
        } finally {
            cursor.close();
        }
        JSONArray out = new JSONArray();
        for (JSONObject row : rows) out.put(row);
        return out;
    }

    /** INSERT/UPDATE/DELETE/CREATE/ALTER are allowed; ATTACH/DETACH are not. */
    public static int exec(SQLiteDatabase db, String sql, JSONArray args) throws Exception {
        String head = sql.trim().toLowerCase();
        String[] denied = new String[]{"attach", "detach", "load_extension"};
        for (String word : denied) {
            if (head.startsWith(word)) throw new IllegalArgumentException("statement not permitted");
        }
        if (head.startsWith("insert") || head.startsWith("update") || head.startsWith("delete") || head.startsWith("replace")) {
            db.execSQL(sql, bindArgs(args));
            return 0;
        }
        db.execSQL(sql);
        return 0;
    }

    /** Convenience for the wake-word/model bookkeeping (not reachable from JS). */
    public static void setLocalFlag(SQLiteDatabase db, String key, String value) {
        ContentValues values = new ContentValues();
        values.put("key", key);
        values.put("value", value);
        values.put("updated_at", System.currentTimeMillis());
        db.insertWithOnConflict("settings", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    private static String[] bindArgs(JSONArray args) {
        if (args == null) return new String[0];
        List<String> values = new ArrayList<>();
        for (int i = 0; i < args.length(); i++) {
            Object value = args.opt(i);
            if (value == null || value == JSONObject.NULL) values.add(null);
            else if (value instanceof Boolean) values.add(((Boolean) value) ? "1" : "0");
            else values.add(String.valueOf(value));
        }
        return values.toArray(new String[0]);
    }
}
