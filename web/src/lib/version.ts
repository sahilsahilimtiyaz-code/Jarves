/**
 * The build stamp shown in the app and in diagnostics.
 *
 * Keep this in sync with `versionName` in android/app/build.gradle. It exists
 * so an installed APK can be identified without opening Android settings: if
 * the device does not show this value, it is not running this build.
 */
export const APP_BUILD = "0.8.0";
export const APP_BUILD_LABEL = `v${APP_BUILD}`;
