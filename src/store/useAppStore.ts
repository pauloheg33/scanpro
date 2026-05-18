import { create } from "zustand";
import type { PendingScan } from "../types";

type AppState = {
  selectedLotId: string;
  pendingScan: PendingScan | null;
  setSelectedLotId: (value: string) => void;
  setPendingScan: (value: PendingScan | null) => void;
};

export const useAppStore = create<AppState>((set) => ({
  selectedLotId: "",
  pendingScan: null,
  setSelectedLotId: (value) => set({ selectedLotId: value }),
  setPendingScan: (value) => set({ pendingScan: value })
}));

