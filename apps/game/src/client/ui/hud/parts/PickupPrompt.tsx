import type { ReactElement } from "react";
import { useUIStore } from "@/client/state/store";

export function PickupPrompt(): ReactElement | null {
  const prompt = useUIStore((s) => s.prompt);
  if (prompt === null) return null;
  return (
    <div className="hud-prompt">
      <span className="ui-key">E</span>
      <span className="hud-prompt-text">{prompt}</span>
    </div>
  );
}
