/**
 * Local, on-device memory notes.
 *
 * This is deliberately separate from the backend's SQLite memory
 * (`data/memory.db`): the APK must never reset or overwrite the user's
 * existing JARVIS memory. The Backend also keeps its own memory; the Memory
 * screen shows both and labels which is which.
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export interface MemoryNote {
  id: string;
  text: string;
  ts: number;
  pinned?: boolean;
}

interface MemoryState {
  notes: MemoryNote[];
  add: (text: string) => MemoryNote | null;
  remove: (id: string) => void;
  togglePin: (id: string) => void;
  clear: () => void;
}

let seq = 0;
const makeId = () => `m-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export const useLocalMemory = create<MemoryState>()(
  persist(
    (set) => ({
      notes: [],
      add: (text) => {
        const clean = (text || "").trim();
        if (!clean) return null;
        const note: MemoryNote = { id: makeId(), text: clean, ts: Date.now() };
        set((state) => ({ notes: [note, ...state.notes].slice(0, 500) }));
        return note;
      },
      remove: (id) => set((state) => ({ notes: state.notes.filter((n) => n.id !== id) })),
      togglePin: (id) =>
        set((state) => ({
          notes: state.notes.map((n) => (n.id === id ? { ...n, pinned: !n.pinned } : n)),
        })),
      clear: () => set({ notes: [] }),
    }),
    {
      name: "jarvis.memory.local.v1",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ notes: state.notes }),
    },
  ),
);

/** Filter helper shared by the Memory screen (pure, testable). */
export function filterNotes(notes: MemoryNote[], query: string): MemoryNote[] {
  const q = query.trim().toLowerCase();
  const rows = q ? notes.filter((n) => n.text.toLowerCase().includes(q)) : notes;
  return [...rows].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return b.ts - a.ts;
  });
}
