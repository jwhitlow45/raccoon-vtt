import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { useExpansionFocus } from "../../components/expansionFocus.ts";
import { api } from "../../lib/api.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomUi, useRoomView } from "../../state/view.ts";
import { usePreview } from "../dm/previewContext.ts";
import { sendXcard, type SendState } from "./send.ts";

/**
 * "X-card" at the top of the Menu panel (docs/design-v1-dm-tools.md 3.11).
 * One tap opens a small card that says what the X does, and a tap on its
 * large X sends it, so a stray tap never asks the table for anything.
 *
 * While the request is out, the X reads "Sending…", so the tap never looks
 * lost, and a failure says so there. On success the small card folds away
 * and the Menu's sheet closes (send.ts sendXcard): the card the whole table
 * sees arrives from the server, on this device too, over the same map.
 *
 * The small card opens with focus on its words, never on the X, so a
 * second press of Enter or Space reads what the X does instead of sending
 * it. Cancel gives focus back to the X-card button.
 */
export function XCardButton() {
  const roomId = useRoomView((s) => s.roomId);
  const ui = useRoomUi();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SendState>({ kind: "idle" });
  // "View as a player" is the DM's own device: a card sent from it would come from the DM's grant, not the player shown.
  const preview = usePreview();
  const opener = useRef<HTMLButtonElement>(null);
  const words = useRef<HTMLParagraphElement>(null);
  useExpansionFocus(open, { inside: words, opener });
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const send = async () => {
    if (state.kind === "sending") return;
    setState({ kind: "sending" });
    await sendXcard({
      post: () => api.xcard(roomId),
      closeSheet: () => ui.closePanel(),
      settle: (next) => {
        if (!live.current) return;
        setState(next);
        if (next.kind === "idle") setOpen(false);
      },
    });
  };

  if (!open) {
    return (
      <button
        ref={opener}
        type="button"
        disabled={preview !== null}
        onClick={() => {
          setState({ kind: "idle" });
          setOpen(true);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: theme.space(3),
          width: "100%",
          minHeight: theme.touch + 12,
          padding: `${theme.space(2)}px ${theme.space(3)}px`,
          borderRadius: theme.radius.md,
          border: `${theme.line.border}px solid ${theme.color.border}`,
          background: theme.color.surfaceRaised,
          // Unavailable keeps the card's shape and dims its words, never its opacity (docs/design-v1-visual.md 2.3).
          color: preview ? theme.color.textDisabled : theme.color.text,
          textAlign: "left",
          font: "inherit",
          cursor: preview ? "default" : "pointer",
        }}
      >
        <XMark size={32} />
        <span style={{ display: "grid", gap: theme.space(0.5) }}>
          <span style={{ fontSize: theme.font.input, fontWeight: theme.weight.strong }}>X-card</span>
          <span style={{ fontSize: theme.font.small, color: preview ? theme.color.textDisabled : theme.color.textMuted }}>
            {preview ? "Not available while viewing as a player." : "Ask the table to edit out what just happened. Nobody will know who."}
          </span>
        </span>
      </button>
    );
  }

  const sending = state.kind === "sending";
  return (
    <section
      aria-label="X-card"
      style={{
        display: "grid",
        justifyItems: "center",
        gap: theme.space(3),
        padding: theme.space(4),
        borderRadius: theme.radius.md,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        background: theme.color.surfaceRaised,
        textAlign: "center",
      }}
    >
      <p ref={words} tabIndex={-1} style={{ margin: 0, fontSize: theme.font.input, lineHeight: 1.4 }}>
        Tap the X to ask the table to edit out what just happened. Nobody will know who tapped it.
      </p>
      <button
        type="button"
        onClick={() => void send()}
        disabled={sending}
        aria-label={sending ? "Sending the X-card" : "Send the X-card"}
        style={{
          display: "grid",
          placeItems: "center",
          gap: theme.space(1),
          width: 132,
          height: 132,
          borderRadius: theme.radius.lg,
          border: `${theme.line.strong}px solid ${theme.color.text}`,
          background: theme.color.bg,
          color: theme.color.text,
          font: "inherit",
          cursor: sending ? "default" : "pointer",
        }}
      >
        <XMark size={sending ? 56 : 72} />
        {sending ? <span style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong }}>Sending…</span> : null}
      </button>
      {state.kind === "failed" ? (
        <p role="alert" style={{ margin: 0, fontSize: theme.font.body14, color: theme.color.dangerText }}>
          {state.message}
        </p>
      ) : null}
      <Button onClick={() => setOpen(false)} disabled={sending}>
        Cancel
      </Button>
    </section>
  );
}

/** The card's X, drawn rather than typed, so it looks the same on every device. */
export function XMark(props: { size: number }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" width={props.size} height={props.size} style={{ display: "block", flex: "none" }}>
      <path d="M5.6 4.2 12 10.6l6.4-6.4 1.4 1.4-6.4 6.4 6.4 6.4-1.4 1.4-6.4-6.4-6.4 6.4-1.4-1.4 6.4-6.4-6.4-6.4z" fill="currentColor" />
    </svg>
  );
}
