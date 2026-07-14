import type { ReactElement } from "react";
import type { ChannelKind } from "@worldspring/shared/protocol";
import { useUIStore } from "@/client/state/store";
import { Bar } from "./Bar";

interface ChannelBarProps {
  /** Cast-bar copy for the kinds this mode uses; a kind the mode does not name
   * falls back to the wire's own word rather than inventing one. */
  labels?: Partial<Record<ChannelKind, string>>;
}

// Server-authoritative, render-only: the bar fills toward totalS and vanishes
// the instant a snapshot arrives with you.action absent (a cook cancel's "you
// stepped out of range" feedback). A channel is a fixed-duration cast that
// auto-cancels — never a hold, so there is no "hold to continue" caption.
export function ChannelBar({ labels }: ChannelBarProps): ReactElement | null {
  const action = useUIStore((s) => s.channelAction);
  if (!action) return null;
  const elapsed = Math.max(0, action.totalS - action.remainingS);
  return (
    <div className="hud-channel">
      <Bar
        label={labels?.[action.kind] ?? action.kind}
        value={elapsed}
        max={action.totalS}
        fillClass="bar-fill--channel"
        valueText={null}
      />
      <div className="hud-channel-times">
        <span>{elapsed.toFixed(1)}s</span>
        <span>{action.totalS.toFixed(1)}s</span>
      </div>
    </div>
  );
}
