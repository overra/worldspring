import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useUIStore } from "@/client/state/store";

/** Red vignette whenever hp drops vs the previous render. */
export function DamageFlash(): ReactElement | null {
  const hp = useUIStore((s) => s.vitals.hp);
  const prevHp = useRef(hp);
  const [flash, setFlash] = useState(0);

  useEffect(() => {
    if (hp < prevHp.current) setFlash((f) => f + 1);
    prevHp.current = hp;
  }, [hp]);

  if (flash === 0) return null;
  // Remounting via key restarts the 250ms fade-out animation on every hit.
  return <div key={flash} className="hud-damage-flash" />;
}
