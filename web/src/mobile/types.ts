export type MobileTab = "home" | "chat" | "tools" | "memory" | "settings";

export interface ScreenProps {
  onNavigate: (tab: MobileTab) => void;
}
