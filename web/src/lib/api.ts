import type { Health, SystemStats } from "./store";
import { apiUrl } from "./backend";
import type { ChatAttachment } from "./store";

// Re-export for HUD components that build backend URLs for media surfaces.
export { apiUrl };

/** Resolve a (possibly relative) backend-hosted media URL for display. */
export function backendUrl(maybeRelative?: string | null): string | undefined {
  if (!maybeRelative) return undefined;
  // data URLs and absolute URLs pass through; bare paths get the base.
  if (/^(data:|blob:|http:|https:)/i.test(maybeRelative)) return maybeRelative;
  return apiUrl(maybeRelative.startsWith("/") ? maybeRelative : `/${maybeRelative}`);
}

export async function getHealth(): Promise<Health> {
  const r = await fetch(apiUrl("/api/health"));
  if (!r.ok) throw new Error(`Health request failed: ${r.status}`);
  return r.json();
}

export async function getStats(): Promise<SystemStats> {
  const r = await fetch(apiUrl("/api/stats"));
  return r.json();
}

export async function getProcesses(limit = 12) {
  const r = await fetch(apiUrl(`/api/processes?limit=${limit}`));
  return r.json();
}

export async function searchMemory(q: string) {
  const r = await fetch(apiUrl(`/api/memory/search?q=${encodeURIComponent(q)}`));
  return r.json();
}

export async function getAgents() {
  const r = await fetch(apiUrl("/api/agents"));
  return r.json();
}

export async function getTools() {
  const r = await fetch(apiUrl("/api/tools"));
  return r.json();
}

export async function getPlugins() {
  const r = await fetch(apiUrl("/api/plugins"));
  return r.json();
}

export async function cleanSlate() {
  const r = await fetch(apiUrl("/api/cleanslate"), { method: "POST" });
  return r.json();
}

export interface ImageModelInfo {
  key: string;
  label: string;
  family: string;
  description: string;
  repo: string;
  file: string;
  base_repo: string;
  local_path: string;
  downloaded: boolean;
  loaded: boolean;
  default_steps: number;
  default_guidance: number;
}

export async function getImageModels(): Promise<{ selected: string; models: ImageModelInfo[] }> {
  const r = await fetch(apiUrl("/api/image-models"));
  return r.json();
}

export async function selectImageModel(model: string): Promise<{ ok: boolean; selected?: string; error?: string }> {
  const r = await fetch(apiUrl("/api/image-models/select"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  return r.json();
}

// ── Image analysis / img2img / image→3D ─────────────────────────────────

/**
 * Upload an image file to the server.
 * Returns { ok, name, url, data_url, size, mime }.
 */
export async function uploadImage(file: File): Promise<{
  ok: boolean;
  name: string;
  url: string;
  data_url?: string;
  size: number;
  mime: string;
}> {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch(apiUrl("/api/upload"), { method: "POST", body: form });
  const out = await r.json();
  if (out?.url) out.url = backendUrl(out.url);
  return out;
}

/**
 * Send an image to the LLM for vision analysis.
 * Returns { ok, analysis }.
 */
export async function analyzeImage(
  file: File,
  prompt?: string
): Promise<{ ok: boolean; analysis?: string; error?: string }> {
  const form = new FormData();
  form.append("file", file);
  if (prompt) form.append("prompt", prompt);
  const r = await fetch(apiUrl("/api/analyze-image"), { method: "POST", body: form });
  return r.json();
}

/**
 * Convert an image to a 3D model via SF3D / TripoSR.
 * Returns { ok, result }.
 */
export async function imageTo3D(
  file: File
): Promise<{ ok: boolean; result?: string; error?: string }> {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch(apiUrl("/api/image-to-3d"), { method: "POST", body: form });
  const out = await r.json();
  if (out?.url) out.url = backendUrl(out.url);
  return out;
}

/**
 * Image-to-image generation: upload an init image + prompt, returns a new
 * image generated using FLUX img2img mode.
 * Returns { ok, result }.
 */
export async function img2img(
  file: File,
  prompt: string,
  strength = 0.65,
  steps = 4,
  guidance = 4.0
): Promise<{ ok: boolean; result?: string; error?: string }> {
  const form = new FormData();
  form.append("file", file);
  form.append("prompt", prompt);
  form.append("strength", String(strength));
  form.append("steps", String(steps));
  form.append("guidance_scale", String(guidance));
  const r = await fetch(apiUrl("/api/img2img"), { method: "POST", body: form });
  const out = await r.json();
  if (out?.url) out.url = backendUrl(out.url);
  return out;
}
