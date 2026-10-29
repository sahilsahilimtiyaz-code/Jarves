/**
 * Platform detection — never removes desktop behaviour, only extends it.
 *
 *   "electron"  — window.jarvis preload bridge present (original desktop shell)
 *   "android"   — running inside the Capacitor Android WebView
 *   "web"       — plain browser tab served by the FastAPI backend
 */
export type Platform = "electron" | "android" | "web";

/** Avoid static imports of @capacitor/core so desktop bundles stay identical. */
export function detectPlatform(): Platform {
  if (typeof window === "undefined") return "web";
  const w = window as any;
  if (w.jarvis) return "electron";
  const cap = w.Capacitor;
  if (cap) {
    try {
      if (cap.isNativePlatform && cap.isNativePlatform()) {
        return cap.getPlatform?.() === "android" ? "android" : cap.getPlatform() || "android";
      }
    } catch { /* not initialized yet */ }
    if (cap.getPlatform?.() === "android") return "android";
  }
  return "web";
}
