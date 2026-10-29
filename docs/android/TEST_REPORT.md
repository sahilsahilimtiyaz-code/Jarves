# JARVIS Android — Test Report

Honest record of what was verified for this Android/Capacitor port, when,
and how. Where a check could not run in the working environment (a phone
with neither Android SDK nor Gradle installed), it is stated, and CI is the
arbiter.

## Environment of the checks performed

- Android phone (this device) running the app's Linux environment:
  Node 24 / npm 11, TypeScript 5.6, Vite 5.4, no Java, no Android SDK,
  ~1.4 GB free RAM — Gradle/AVD workloads are therefore reserved for GitHub
  Actions hardware, where the APK artifact is produced.
- The repository was audited, edited and re-tested around this
  environment; `web/android` is the standard Capacitor 7 wrapper verified
  against the installed `@capacitor/*` 7.6.10 packages.

## Checks actually executed locally — all green

| Check | Command | Result |
|-------|---------|--------|
| Type check of the whole front-end (incl. platform adapter, mobile sheets, backend resolver, ws plumbing) | `npm run build`'s `tsc -b` step, executed in the tree | ✅ 0 errors (several iterations) |
| Production web build (this is what the APK embeds) | `npm run build` (Vite) | ✅ 437 modules, main chunk 437 KB / 134 KB gzip; lazy chunks for Lightbox/Model3DViewer/ArticleReader/NeuralGalaxy intact |
| Backend resolver & platform adapter unit tests | `npm test` (`node --test`) | ✅ 20/20 pass — 12 new (`tests/platform.test.mjs`) + 8 pre-existing wake-word tests |
| Wake word suite (pre-existing) | included above | ✅ pass |
| Android project structure sanity | listing/diff discipline of `web/android` | ✅ wrapper jar+properties, manifests (main/debug), res values, mipmaps, capacitor module wiring present; generated dirs excluded per `android/.gitignore` |
| Icon/splash assets | PIL-generated, visually reviewed launcher, adaptive foreground and splash (portrait and land) | ✅ art centred, densities present |
| Node-version consistency | `node/` v24 local; CI pins Node 20 for the web build; `package-lock.json` locked and committed | ✅ |

Notable build details:
- The single known Vite warning is the pre-existing voice.ts double
  (dynamic+static) import notice; harmless, module stays in the main chunk.
- `cap add/sync android` produced **no** plugin list changes (the port's
  Android adapter uses the `@capacitor/core` runtime only).

## Checks delegated to GitHub Actions (cannot run here)

| Check | Where it runs | What proves it |
|-------|---------------|----------------|
| Full APK build (`web/android` `gradlew assembleDebug`, JDK 21, Gradle 8.11.1, AGP 8.7.2) | Actions runner `ubuntu-latest` | workflow executes `npm ci && npm test && npm run build`, `npx cap sync android`, then the Gradle build; failure surfaces as a red run (no fake success path) |
| APK existence/size assertion | `Verify the APK really exists...` step | refuses to upload a missing/truncated APK (`<200 KB` treated as suspicious) |
| Artifact publication | `actions/upload-artifact@v4` | artifact `JARVIS-Android-debug-APK` contains exactly `app-debug.apk` from `web/android/app/build/outputs/apk/debug/` |

If the workflow output above holds, the produced artifact is a real APK; the
verification step and Gradle's output are the receipts. There is no
circumstance in this design where a red run still yields the artifact.

## Test coverage map for the new Android pieces

| New behaviour | Test |
|---------------|------|
| `normalizeBackendUrl` (LAN address auto-`http://`, trailing path strip, invalid input → `""`) | `platform.test.mjs::normalizeBackendUrl:*` |
| `apiUrl` empty-base == same-origin (identical desktop behaviour) | `platform.test.mjs::apiUrl:*` |
| `wsUrl` configured base → `ws(s)://` rewrite | `platform.test.mjs` (base and no-backend cases) |
| `wsBackoffDelay` ramp + cap | `platform.test.mjs::wsBackoffDelay` |
| `detectPlatform` electron/android/web precedence | 4 dedicated cases |

Front-end interactions that run only in a real WebView (actual mic/camera
permission prompts, resume reconnect, share-sheet downloads) are exercised
manually on-device and are marked as behavioral notes, not automated tests —
stated here so that no assumption is silent.

## Known limitations recorded for QA

1. Wake word only while app is foreground (no background mic listening).
2. Debug APK permits cleartext for LAN backends; release build must require
   HTTPS.
3. `speechSynthesis` voices vary per WebView; the app relies on the backend
   TTS in that case (documented in FEATURE_PARITY.md §Voice).
4. The backend's `permissions.mode: bypass`, default `config.yaml`, implies
   silent CAUTION/DANGEROUS execution on an open port — ops/consider a
   firewall/tunnel (BACKEND.md §Transport).

## Sign-off

Deferred, as designed: the APK artifact itself is produced and verified by
GitHub Actions on the first run of `android-apk.yml`. Please treat the
Actions run summary — not this file — as the final build receipt.
