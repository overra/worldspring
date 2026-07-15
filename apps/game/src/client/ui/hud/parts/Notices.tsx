import type { ReactElement } from "react";
import { useUIStore } from "@/client/state/store";

export function Notices(): ReactElement {
  const notices = useUIStore((s) => s.notices);
  return (
    <div className="hud-notices">
      {notices.slice(-5).map((n) => (
        <div key={n.id} className="hud-notice">
          {n.msg}
        </div>
      ))}
    </div>
  );
}
