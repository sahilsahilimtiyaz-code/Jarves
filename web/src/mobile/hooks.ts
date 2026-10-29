import { useCallback, useEffect, useState } from "react";
import { getHealth } from "../lib/api";
import { backendConfigured, backendBase, subscribeBackend } from "../lib/backend";
import { voicePipeline, type VoiceSnapshot } from "../lib/voicePipeline";
import { wakeWordService, type WakeSnapshot } from "../lib/wakeWordService";
import { getJarvisAI, initMind } from "../lib/ai/runtime";
import type { ProviderConfig } from "../lib/ai/types";
import { detectPlatform } from "../platform";

/** Voice status without the 60 Hz level stream (chat list must not re-render). */
export interface VoiceStatus {
  state: VoiceSnapshot["state"];
  partial: string;
  error: string | null;
  transcript: string | null;
  engine: VoiceSnapshot["engine"];
}

export function useVoiceStatus(): VoiceStatus {
  const [status, setStatus] = useState<VoiceStatus>(() => {
    const snap = voicePipeline.getSnapshot();
    return {
      state: snap.state,
      partial: snap.partial,
      error: snap.error,
      transcript: snap.transcript,
      engine: snap.engine,
    };
  });

  // Probe the real engines once per screen mount so "engine: none" only ever
  // appears when the device genuinely has no recognition/TTS service.
  useEffect(() => {
    void voicePipeline.detect();
  }, []);

  useEffect(() => {
    return voicePipeline.subscribe((snap) => {
      setStatus((prev) => {
        if (
          prev.state === snap.state &&
          prev.partial === snap.partial &&
          prev.error === snap.error &&
          prev.transcript === snap.transcript &&
          prev.engine === snap.engine
        ) {
          return prev;
        }
        return {
          state: snap.state,
          partial: snap.partial,
          error: snap.error,
          transcript: snap.transcript,
          engine: snap.engine,
        };
      });
    });
  }, []);

  return status;
}

/** Real wake-word service state, kept in sync with native broadcasts. */
export function useWakeWordStatus(): WakeSnapshot {
  const [snap, setSnap] = useState<WakeSnapshot>(() => wakeWordService.getSnapshot());
  useEffect(() => {
    void wakeWordService.init();
    return wakeWordService.subscribe(setSnap);
  }, []);
  return snap;
}

export type BackendStatus = "unconfigured" | "checking" | "online" | "offline";

export interface BackendHealthState {
  status: BackendStatus;
  latencyMs: number | null;
  name: string | null;
  model: string | null;
  provider: string | null;
  tools: number | null;
  permissionMode: string | null;
  error: string | null;
  target: string;
  checkedAt: number | null;
}

const EMPTY_BACKEND: BackendHealthState = {
  status: "checking",
  latencyMs: null,
  name: null,
  model: null,
  provider: null,
  tools: null,
  permissionMode: null,
  error: null,
  target: "",
  checkedAt: null,
};

/**
 * Real backend health probe with latency. On Android an empty backend address
 * means "not configured" and is reported as such; elsewhere the same-origin
 * backend is probed like the original desktop build does.
 */
export function useBackendHealth(intervalMs = 20_000) {
  const [state, setState] = useState<BackendHealthState>(EMPTY_BACKEND);

  useEffect(() => {
    let cancelled = false;

    const probe = async () => {
      const sameOrigin = detectPlatform() !== "android";
      if (!backendConfigured() && !sameOrigin) {
        if (cancelled) return;
        setState({
          ...EMPTY_BACKEND,
          status: "unconfigured",
          target: "",
          error: "No JARVIS backend address is configured.",
        });
        return;
      }
      setState((prev) => ({ ...prev, status: prev.status === "online" ? "online" : "checking" }));
      const started = typeof performance !== "undefined" ? performance.now() : Date.now();
      try {
        const health = await getHealth();
        const latency = Math.round(
          (typeof performance !== "undefined" ? performance.now() : Date.now()) - started,
        );
        if (cancelled) return;
        setState({
          status: "online",
          latencyMs: latency,
          name: health.name || "JARVIS",
          model: health.model?.model || null,
          provider: health.model?.provider || null,
          tools: typeof health.tools === "number" ? health.tools : null,
          permissionMode: health.permission_mode || null,
          error: null,
          target: backendBase() || (typeof location !== "undefined" ? location.origin : "same origin"),
          checkedAt: Date.now(),
        });
      } catch (e) {
        if (cancelled) return;
        setState({
          status: "offline",
          latencyMs: null,
          name: null,
          model: null,
          provider: null,
          tools: null,
          permissionMode: null,
          error:
            e instanceof Error
              ? `Backend unreachable: ${e.message}`
              : "Backend unreachable. Check the address, that the server is running, and the network.",
          target: backendBase() || (typeof location !== "undefined" ? location.origin : "same origin"),
          checkedAt: Date.now(),
        });
      }
    };

    void probe();
    const id = setInterval(() => void probe(), intervalMs);
    const unsubscribe = subscribeBackend(() => void probe());
    const onVisible = () => {
      if (document.visibilityState === "visible") void probe();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(id);
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);

  return state;
}

/** Time-based greeting text (UI copy only — never inserted into the chat). */
export function greetingFor(date = new Date()): string {
  const hour = date.getHours();
  const part = hour < 5 ? "evening" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  return `Good ${part}, sir.`;
}

export function statusLabel(health: BackendHealthState, wsConnected: boolean): string {
  if (health.status === "unconfigured") return "No backend configured";
  if (health.status === "checking") return "Contacting backend…";
  if (health.status === "offline") return "Backend offline";
  if (!wsConnected) return "Backend reachable · live channel reconnecting";
  return "All systems online";
}

// ── On-device AI provider status ────────────────────────────────────────────

export interface ProviderStatusState {
  loading: boolean;
  configs: ProviderConfig[];
  /** First enabled provider — the model that will actually answer. */
  active: ProviderConfig | null;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Reads the configured providers from the real local database. This is what the
 * UI must use to decide whether chat can answer — the optional JARVIS backend
 * is a separate capability.
 */
export function useProviderStatus(): ProviderStatusState {
  const [configs, setConfigs] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      await initMind();
      const list = await getJarvisAI().gateway.load(true);
      setConfigs(list);
      setError(null);
    } catch (e) {
      setConfigs([]);
      setError(e instanceof Error ? e.message : "Provider settings could not be read.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  return { loading, configs, active: configs.find((config) => config.enabled) ?? null, error, refresh };
}
