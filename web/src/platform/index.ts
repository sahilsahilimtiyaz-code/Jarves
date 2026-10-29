/**
 * Platform adapter entry — one source of truth for where a capability runs.
 *
 * Choosing the adapter:
 *   - "electron" only if the preload bridge exists (identical desktop path)
 *   - "android"  only when the Capacitor runtime reports a native platform
 *   - otherwise plain web (the original backend-served behaviour)
 *
 * Capability rules honoured by every implementation:
 *   - NEVER fake results: unsupported APIs resolve false and the caller
 *     surfaces a visible reason (no silent mock).
 */
import { detectPlatform } from "./detect";
import type { PlatformAdapter } from "./types";
import { WebAdapter } from "./web";
import { AndroidAdapter } from "./android";

let current: PlatformAdapter | null = null;

export function getAdapter(): PlatformAdapter {
  if (!current) {
    current =
      detectPlatform() === "android" ? new AndroidAdapter() : new WebAdapter();
  }
  return current;
}

/** True when this page runs inside the Capacitor Android WebView. */
export function isAndroid(): boolean {
  return detectPlatform() === "android";
}

/**
 * Intercept user clicks on links the OS should handle:
 *  - target="_blank" links (page cards, reader, search results)
 *  - absolute http(s) URLs that leave the app shell
 * Works from within the existing DOM (no component edits needed); desktop
 * does NOT install it, so desktop behaviour is untouched.
 */
export function installAndroidLinkInterceptor(): () => void {
  const onClick = (ev: MouseEvent) => {
    const el = (ev.target as Element | null)?.closest?.("a");
    if (!el) return;
    const href = el.getAttribute("href");
    if (!href) return;
    let url: URL | null = null;
    try {
      url = new URL(href, location.href);
    } catch {
      return;
    }
    const external =
      (el.target === "_blank" && (url.protocol === "https:" || url.protocol === "http:")) ||
      (url.hostname !== location.hostname &&
        (url.protocol === "https:" || url.protocol === "http:") &&
        !href.startsWith("/"));
    if (!external) return;
    ev.preventDefault();
    void getAdapter().openExternal(url.toString());
  };
  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}

export type { PlatformAdapter } from "./types";
export { detectPlatform, type Platform } from "./detect";
