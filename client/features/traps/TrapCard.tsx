import { useLayoutEffect, useRef, useState } from "react";
import type { LogEntry, Trap, TrapDue } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { Icon } from "../../components/Icon.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { cardStyle } from "../rolls/parts.tsx";
import { Note as Caution } from "../../components/Panel.tsx";
import { Note } from "../tokens/ui.tsx";
import { didLines, hiddenLine, KNOWN, lineOf, whoLines } from "./desk.ts";
import { TrapSaveStart } from "./TrapSaveStart.tsx";
import { useLabels } from "../../state/labels.ts";

const NO_LOG: LogEntry[] = [];

/**
 * A springing waiting for the DM, on the DM desk (docs/design/design-v1-traps.md
 * 4.3) in and out of fights: who set it off and who it hits, frozen when it
 * went off, what it did and could not do, and the DM note. One that went
 * off out of the players' sight in a player's op says so, and offers Do its
 * effects and Mark sprung. Save and damage opens the group save on the
 * creatures it hits, whose Apply settles those it reached, and Dismiss settles it unapplied. A second DM device's answer
 * that came first is refused, "It was settled meanwhile.", and said here.
 *
 * A creature it hits that is on another scene stays on the card, named as
 * this device last read it, until Apply reaches it there (6.2). With every
 * one it names away, Save and damage hides, since its page would hold no
 * row, and shows again once one is back. Hidden while it held keyboard
 * focus, as when another device moved the last one away, it hands focus to
 * the card's toggle, so focus never falls to the page.
 */
export function TrapCard(props: { trap: Trap; due: TrapDue; open: boolean; onToggle(): void; toggleRef(el: HTMLButtonElement | null): void }) {
  const labels = useLabels();
  const { trap, due } = props;
  const view = useRoomView((s) => s.view);
  const trapLog = useRoomView((s) => s.view?.trapLog ?? NO_LOG);
  const actions = useRoomActions();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveButton = useRef<HTMLButtonElement | null>(null);
  const toggle = useRef<HTMLButtonElement | null>(null);
  const who = view ? whoLines(view, due, labels, KNOWN) : null;
  const rig = trap.rig;
  // With no save the page opens on No save, so conditions with no save apply in one tap.
  const effects = rig?.save !== undefined || rig?.damage !== undefined || rig?.conditions !== undefined;
  const offersSave = effects && who?.reaches === true;
  // Read as this render takes the button away, while the page still holds it and its focus: after, focus is on the page.
  const lostFocus = !offersSave && saveButton.current !== null && saveButton.current.ownerDocument.activeElement === saveButton.current;
  useLayoutEffect(() => {
    if (lostFocus) toggle.current?.focus();
  }, [lostFocus]);
  if (!view || !who) return null;
  const applyWord = rig?.save || rig?.damage ? "Save and damage" : "Apply";
  const line = lineOf(trapLog, due.id);
  const did = line ? didLines(trap, line.did, view, labels) : [];
  const title = `${trap.name} went off`;

  const send = (key: string, op: ClientOp) => {
    setError(null);
    setBusy(key);
    const n = actions.dispatch(op, {
      quiet: true,
      onAnswer: (answer, refusal) => {
        setBusy(null);
        if (answer === "refused") setError(refusal?.text || refusal?.message || "It was refused.");
        else if (answer === "unknown") setError("This may have happened. Check the log.");
      },
    });
    if (n === null) {
      setBusy(null);
      setError("This needs a connection.");
    }
  };

  return (
    <section role="group" aria-label={title} style={{ ...cardStyle, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
      <button
        ref={(el) => {
          toggle.current = el;
          props.toggleRef(el);
        }}
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.open}
        style={{
          minWidth: 0,
          minHeight: theme.touch,
          display: "flex",
          alignItems: "center",
          gap: theme.space(1),
          padding: 0,
          background: "transparent",
          border: "none",
          color: theme.color.text,
          fontFamily: theme.font.body,
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <Icon name={props.open ? "chevronDown" : "chevronRight"} size="sm" />
        <span style={{ flex: 1, minWidth: 0, fontWeight: theme.weight.bold, fontSize: theme.font.body14 }}>{title}</span>
      </button>
      {props.open ? (
        <>
          {/* Out of the players' sight it is still armed for them, which the DM must weigh: a warning, not muted help. */}
          {due.hidden ? <Caution>{hiddenLine(view, due, labels)}</Caution> : <span style={{ fontSize: theme.font.small }}>{who.by}</span>}
          <span style={{ fontSize: theme.font.small }}>{who.hits}</span>
          {/* What it could not do takes the error's color from the line's own outcome, not from its words. */}
          {did.map((d, i) =>
            line?.did[i]?.ok === false ? (
              <Note key={i} tone="error">
                {d}
              </Note>
            ) : (
              <span key={i} style={{ fontSize: theme.font.small }}>
                {d}
              </span>
            ),
          )}
          {trap.rig?.note ? <span style={{ fontSize: theme.font.small, color: theme.color.textMuted, whiteSpace: "pre-wrap" }}>{trap.rig.note}</span> : null}
          {saving ? <TrapSaveStart trap={trap} due={due} onDone={() => setSaving(false)} /> : null}
          <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
            {offersSave ? (
              <Button ref={saveButton} size="sm" variant="primary" onClick={() => setSaving(true)}>
                {applyWord}
              </Button>
            ) : null}
            {due.hidden && !due.acted ? (
              <>
                <Button size="sm" busy={busy === "act"} onClick={() => send("act", { t: "trap.act", trapId: trap.id, due: due.id })}>
                  Do its effects
                </Button>
                <Button size="sm" busy={busy === "sprung"} onClick={() => send("sprung", { t: "trap.settle", trapId: trap.id, due: due.id, sprung: true })}>
                  Mark sprung
                </Button>
              </>
            ) : null}
            <Button size="sm" busy={busy === "dismiss"} aria-label={`Dismiss ${title}`} onClick={() => send("dismiss", { t: "trap.settle", trapId: trap.id, due: due.id })}>
              Dismiss
            </Button>
          </div>
          {error ? (
            <div role="alert">
              <Note tone="error">{error}</Note>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
