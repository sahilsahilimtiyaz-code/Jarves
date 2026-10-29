/**
 * Backend connection resolution.
 *
 * Desktop (Electron / the backend-served web UI): the base URL is "" — every
 * endpoint is same-origin exactly as the original JARVIS desktop build, so
 * desktop behaviour is byte-for-byte unchanged.
 *
 * Android (Capacitor): the HUD is served from the app shell itself
 * (capacitor://https://localhost), so the FastAPI backend lives on a
 * different host and must be configured by the user, e.g.
 *   - same-LAN desktop:  http://192.168.1.20:7341
 *   - Android emulator → host:  http://10.0.2.2:7341
 *   - hosted backend:      https://jarvis.example.com
 *
 * The configured URL is stored in localStorage under "jarvis.backend.url".
 * An empty value means "no backend configured": the app still boots
 * (Android Mode C) and every backend-dependent surface reports the
 * requirement instead of failing silently.
 */
import type { Health } from "./store";

const KEY = "jarvis.backend.url";

let base: string = "";
let initialized = false;
const listeners = new Set<(base: string) => void>();

function safeGet(): string {
  try {
    return localStorage.getItem(KEY) || "";
  } catch {
    return "";
  }
}

/**
 * Normalize a user-entered backend address.
 *
 * Rules:
 *  - trims whitespace
 *  - adds http:// when no scheme was typed (allows typing 192.168.1.20:7341)
 *  - strips any trailing slashes and a trailing /ws or /api
 *  - rejects obviously invalid values (random text without host)
 * Returns the normalized URL, or "" when the value is empty/invalid.
 * Exported for tests.
 */
export function normalizeBackendUrl(input: string): string {
  const raw = (input || "").trim();
  if (!raw) return "";
  let url = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, "");
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (!u.hostname) return "";
    // Strip any path the user may have pasted — JARVIS lives at the root.
    const origin = u.origin;
    // Rebuild without default ports of the other scheme and keep explicit port.
    return origin;
  } catch {
    return "";
  }
}

/** Synchronous accessor for pre-init code paths (returns last-known base). */
export function backendBase(): string {
  return base;
}

export function backendConfigured(): boolean {
  return base !== "";
}

export function subscribeBackend(fn: (base: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function setBackendBase(input: string): Promise<string> {
  const next = normalizeBackendUrl(input);
  base = next;
  try {
    if (next) localStorage.setItem(KEY, next);
    else localStorage.removeItem(KEY);
  } catch { /* storage unavailable — keep in-memory only */ }
  for (const fn of listeners) fn(base);
  return base;
}

/** Fetch wrapper used by the settings panel to validate a backend address. */
export async function probeBackend(url: string, timeoutMs = 6000): Promise<Health | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`${url}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return (await r.json()) as Health;
  } catch {
    return null;
  }
}

/**
 * Full URL for an HTTP endpoint on the backend.
 * path must start with "/" (e.g. "/api/health", "/media/foo.png").
 */
export function apiUrl(path: string): string {
  if (!path.startsWith("/")) path = `/${path}`;
  return `${base}${path}`;
}

/** Convert a full backend HTTP URL into the matching WebSocket URL. */
export function toWebSocketUrl(url: string): string {
  return url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

/** WebSocket endpoint for the backend chat channel (same-origin fallback). */
export function wsUrl(): string {
  if (base) return `${toWebSocketUrl(base)}/ws`;
  // Same-origin fallback — identical to the original desktop build's dial:
  // ws:// under an http page, wss:// under https. In a real browser
  // `location` always exists; the globalThis form merely keeps SSR-style
  // environments (and the Node tests) from throwing.
  const proto = typeof location !== "undefined" && location.protocol === "https:" ? "wss:" : "ws:";
  const host = (globalThis.location?.host as string | undefined) ?? "";
  return `${proto}//${host}/ws`;
}

/** Called once at app bootstrap. Returns the persisted base URL, if any. */
export function initBackend(): string {
  if (initialized) return base;
  initialized = true;
  base = safeGet();
  return base;
}
