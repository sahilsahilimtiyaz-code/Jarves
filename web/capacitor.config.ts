/**
 * Capacitor configuration — Android packaging for the JARVIS HUD.
 *
 * The same React app keeps serving the Electron desktop shell; this file
 * only affects the Android shell that wraps the Vite production build.
 *
 * Key choices:
 *  - webDir "dist"           — the standard Vite output (backend + Electron
 *                              also serve web/dist; identical bundle).
 *  - androidScheme "http"    — the app shell is served from http://localhost,
 *                              so a LAN backend on plain http://192.168.x.x
 *                              is a same-scheme fetch (no mixed-content
 *                              blocking). HTTPS backends keep working; CORS
 *                              is already permissive on the FastAPI side.
 *  - backgroundColor         — matches the HUD ink so there is no white flash
 *                              while the WebView boots.
 */
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.jarvis.local",
  appName: "J.A.R.V.I.S.",
  webDir: "dist",
  android: {
    allowMixedContent: false,
  },
  server: {
    androidScheme: "http",
    // The Android WebView clears local/session storage per app uninstall,
    // and keyboard resize handling follows the OS defaults.
    // No remote URL here: the HUD ships inside the APK and connects out to
    // a user-configured backend address (see web/src/lib/backend.ts).
  },
};

export default config;
