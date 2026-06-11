// Proximity text chat (bottom-left, above the vitals): a rolling log whose
// lines fade out 8s after arrival, plus an input row while chatOpen. The fade
// is a CSS opacity transition driven by a 1s interval re-render scoped to
// THIS panel — UI-rate, never per-frame. InputController owns the opening
// keybind (Enter) and gates game keys off while chatOpen; this component owns
// closing: Enter sends, Escape cancels, click-outside cancels (same backdrop
// pattern as the inventory panel / escape menu).

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { CHAT_MAX_LENGTH } from "@/shared/constants";
import { sendChat } from "@/client/net/connection";
import { useUIStore } from "@/client/state/store";
import "./ui.css";

/** How many of the newest lines are shown. */
const VISIBLE_LINES = 6;
/** A line starts fading this long after receipt (ms). */
const FADE_AFTER_MS = 8000;

function ChatInputRow(): ReactElement {
  const [text, setText] = useState("");
  const closeChat = useUIStore((s) => s.closeChat);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    // Swallow everything typed here: stopping propagation at the React root
    // keeps WASD/Tab/digits from reaching InputController's document-level
    // listener (which also gates on chatOpen — belt and suspenders).
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return; // mid-IME Enter composes, not sends
    if (e.key === "Enter") {
      e.preventDefault();
      sendChat(text); // trims + drops empty lines itself
      // InputController's store subscription re-locks the pointer on close.
      closeChat();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeChat(); // close without sending
    }
  };

  return (
    <div className="chat-input-row">
      <input
        className="chat-input"
        type="text"
        autoFocus
        value={text}
        maxLength={CHAT_MAX_LENGTH}
        placeholder="say something…"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

export function ChatPanel(): ReactElement {
  const chatOpen = useUIStore((s) => s.chatOpen);
  const chatLog = useUIStore((s) => s.chatLog);
  const closeChat = useUIStore((s) => s.closeChat);
  const [, setTick] = useState(0);

  // 1s heartbeat: re-renders this panel only, so lines pick up the faded
  // class as they cross the threshold and the CSS transition takes over.
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const now = performance.now();
  const lines = chatLog.slice(-VISIBLE_LINES);

  return (
    <>
      {/* Full-screen click catcher (same pattern as .hud-inv-backdrop): any
          click outside the panel closes without sending. The panel renders
          after it, so clicks on the panel never reach the backdrop. */}
      {chatOpen && <div className="chat-backdrop" onClick={() => closeChat()} />}
      <div className={chatOpen ? "hud-chat hud-chat--open" : "hud-chat"}>
        <div className="chat-log">
          {lines.map((line) => (
            <div
              key={line.id}
              className={
                !chatOpen && now - line.at > FADE_AFTER_MS
                  ? "chat-line chat-line--faded"
                  : "chat-line" // open chat shows history un-faded
              }
            >
              <span className="chat-name">{line.name}</span>{" "}
              <span className="chat-text">{line.text}</span>
            </div>
          ))}
        </div>
        {chatOpen && <ChatInputRow />}
      </div>
    </>
  );
}
