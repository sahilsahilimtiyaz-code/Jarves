/**
 * Mobile preferences — additive and versioned so upgrades never reset the
 * existing store (`jarvis.store.v1`) or memory databases.
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type AnimationMode = "auto" | "low";
export type Accent = "cyan" | "violet";

interface PrefsState {
  animationMode: AnimationMode;
  micLanguage: string;
  accent: Accent;
  /** Persistent "Hey JARVIS" monitoring — restored on every launch. */
  wakeWordEnabled: boolean;
  setAnimationMode: (m: AnimationMode) => void;
  setMicLanguage: (lang: string) => void;
  setAccent: (a: Accent) => void;
  setWakeWordEnabled: (enabled: boolean) => void;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      animationMode: "auto",
      micLanguage: "en-US",
      accent: "cyan",
      wakeWordEnabled: false,
      setAnimationMode: (animationMode) => set({ animationMode }),
      setMicLanguage: (micLanguage) => set({ micLanguage }),
      setAccent: (accent) => set({ accent }),
      setWakeWordEnabled: (wakeWordEnabled) => set({ wakeWordEnabled }),
    }),
    {
      name: "jarvis.prefs.v1",
      version: 1,
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

/** Languages offered for Android SpeechRecognizer (BCP-47 tags). */
export const MIC_LANGUAGES: { tag: string; label: string }[] = [
  { tag: "en-US", label: "English (US)" },
  { tag: "en-GB", label: "English (UK)" },
  { tag: "en-IN", label: "English (India)" },
  { tag: "en-AU", label: "English (Australia)" },
  { tag: "de-DE", label: "German" },
  { tag: "es-ES", label: "Spanish" },
  { tag: "fr-FR", label: "French" },
  { tag: "hi-IN", label: "Hindi" },
  { tag: "it-IT", label: "Italian" },
  { tag: "ja-JP", label: "Japanese" },
  { tag: "pt-BR", label: "Portuguese (Brazil)" },
];
