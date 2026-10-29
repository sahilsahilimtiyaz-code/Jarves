/**
 * Device telemetry hook — genuine values only.
 *
 * Android APK: native BatteryManager / ActivityManager / Build / procfs via
 * JarvisNativePlugin. Browser fallback: the Battery Status API when the
 * browser exposes it; otherwise the hook reports "unavailable" and the UI
 * shows nothing rather than a fabricated figure.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getDeviceInfo, nativeAvailable, type NativeDeviceInfo } from "../platform/native";

export interface DeviceSnapshot {
  source: "phone" | "browser";
  info: Partial<NativeDeviceInfo>;
  error: string | null;
  at: number;
}

interface BatteryLike extends EventTarget {
  level: number;
  charging: boolean;
}

export function useDeviceInfo(active = true, intervalMs = 15_000) {
  const [snapshot, setSnapshot] = useState<DeviceSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (!active) return;
    setLoading(true);
    try {
      if (await nativeAvailable()) {
        const info = await getDeviceInfo();
        if (!mounted.current) return;
        setSnapshot({ source: "phone", info, error: null, at: Date.now() });
      } else {
        const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
        if (typeof nav.getBattery === "function") {
          const battery = await nav.getBattery();
          if (!mounted.current) return;
          setSnapshot({
            source: "browser",
            info: {
              batteryPercent: Math.round(battery.level * 100),
              charging: battery.charging,
            },
            error: null,
            at: Date.now(),
          });
        } else {
          if (!mounted.current) return;
          setSnapshot({
            source: "browser",
            info: {},
            error: "Device sensors are available in the Android app build only.",
            at: Date.now(),
          });
        }
      }
    } catch (e) {
      if (!mounted.current) return;
      setSnapshot({
        source: "browser",
        info: {},
        error: e instanceof Error ? e.message : "Device information unavailable",
        at: Date.now(),
      });
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [active]);

  useEffect(() => {
    mounted.current = true;
    if (!active) return;
    void refresh();
    const id = setInterval(() => void refresh(), intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, intervalMs, refresh]);

  return { snapshot, loading, refresh };
}

/** Human-readable device line, honest about what is missing. */
export function describeDevice(snapshot: DeviceSnapshot | null): string {
  if (!snapshot) return "Reading device…";
  const info = snapshot.info;
  if (snapshot.source === "browser") {
    return info.batteryPercent !== undefined
      ? `Browser session · battery ${info.batteryPercent}%${info.charging ? " · charging" : ""}`
      : "Device stats unavailable in this runtime";
  }
  const parts: string[] = [];
  if (info.manufacturer || info.model) parts.push(`${info.manufacturer ?? ""} ${info.model ?? ""}`.trim());
  if (info.androidRelease) parts.push(`Android ${info.androidRelease}`);
  if (info.cpuCores) parts.push(`${info.cpuCores} cores`);
  if (typeof info.batteryPercent === "number" && info.batteryPercent >= 0) {
    parts.push(`${info.batteryPercent}%${info.charging ? " charging" : ""}`);
  }
  return parts.join(" · ") || "Device stats unavailable";
}

export function formatMb(mb?: number): string {
  if (typeof mb !== "number" || !isFinite(mb) || mb < 0) return "—";
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
