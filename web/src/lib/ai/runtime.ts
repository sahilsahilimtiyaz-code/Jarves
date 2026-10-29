/**
 * Runtime wiring for the on-device AI stack.
 *
 * One process-wide instance so the provider list, SQLite handle and usage
 * accounting are shared by every screen. On a non-Android runtime there is no
 * SQLite bridge: the store raises a clear error instead of silently keeping
 * data in memory and pretending it is persistent.
 */
import * as native from "../../platform/native";
import { AIGateway } from "./gateway";
import { JarvisAI } from "./index";
import { MemoryStore, type DbPort } from "./store";

export const MEMORY_UNAVAILABLE = "On-device memory requires the Android app build (no native database in this runtime).";

class NativeDbPort implements DbPort {
  async query(sql: string, params: unknown[] = []): Promise<Record<string, any>[]> {
    const response = await native.dbQuery(sql, params);
    return Array.isArray(response?.rows) ? response.rows : [];
  }

  async exec(sql: string, params: unknown[] = []): Promise<void> {
    await native.dbExec(sql, params);
  }
}

class UnavailableDbPort implements DbPort {
  async query(): Promise<Record<string, any>[]> {
    throw new Error(MEMORY_UNAVAILABLE);
  }
  async exec(): Promise<void> {
    throw new Error(MEMORY_UNAVAILABLE);
  }
}

let instance: JarvisAI | null = null;
let migration: Promise<void> | null = null;
let nativeChecked: Promise<boolean> | null = null;

export function nativeBackend(): Promise<boolean> {
  if (!nativeChecked) nativeChecked = native.nativeAvailable().catch(() => false);
  return nativeChecked;
}

export function getJarvisAI(): JarvisAI {
  if (!instance) {
    const store = new MemoryStore(new NativeDbPort());
    instance = new JarvisAI(store, new AIGateway(store));
  }
  return instance;
}

/**
 * Create the schema once per process. Safe to call from every screen: the
 * promises are memoised, and `CREATE TABLE IF NOT EXISTS` is idempotent.
 */
export async function initMind(): Promise<void> {
  if (!migration) {
    migration = (async () => {
      if (!(await nativeBackend())) throw new Error(MEMORY_UNAVAILABLE);
      await getJarvisAI().store.migrate();
    })().catch((error) => {
      // A failed migration must be retryable: keep the reason, drop the memo.
      migration = null;
      throw error;
    });
  }
  return migration;
}

export function resetNativeCheck(): void {
  nativeChecked = null;
}

/**
 * Real read/write probe of the on-device database. The Memory screen shows the
 * outcome, so "providers do not stick" becomes a concrete message instead of
 * a silent failure.
 */
export async function storageProbe(): Promise<{ ok: boolean; message: string }> {
  try {
    await initMind();
    const store = getJarvisAI().store;
    const key = "diag.storageProbe";
    const token = `probe_${Date.now()}`;
    await store.setSetting(key, token);
    const read = await store.getSetting<string>(key, "");
    if (read !== token) {
      return {
        ok: false,
        message: `The local database accepted a write but returned “${read || "nothing"}”. On-device storage is not reliable in this build.`,
      };
    }
    return { ok: true, message: "Local SQLite read/write verified — settings, keys and memory will survive a restart." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "The local database did not respond." };
  }
}

/** Dev-only store that fails loudly (used to prove the UI never fakes data). */
export function unavailableStore(): MemoryStore {
  return new MemoryStore(new UnavailableDbPort());
}
