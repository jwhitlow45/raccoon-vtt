import { useEffect, useRef } from "react";
import { Button } from "../../../components/Button.tsx";
import { nearInScrollBox } from "../../../lib/reveal.ts";
import { theme } from "../../../lib/theme.ts";
import { APPLYING } from "./chain.ts";
import { AskAnswers, discardQuestion } from "./GroupSave.tsx";
import { useGroupSave } from "./store.ts";

/**
 * What a start says when a group save is already open (5.1), the same for
 * every start: "Discard the Dexterity save for 6?" with Discard, which
 * closes its requests (start.ts), and Keep it. While the open one is
 * applying it cannot go, so only Keep it is offered.
 *
 * It opens where the start was pressed, which can be at the panel's foot,
 * so it scrolls itself into view and takes focus. Otherwise the press
 * seemed to do nothing (LP27-A-GS-1). Focus goes to Keep it, the choice
 * that loses nothing, so a second Enter never discards.
 */
export function ReplaceConfirm(props: { onDiscard(): void; onKeep(): void }) {
  const open = useGroupSave((s) => s.page);
  const applying = open?.phase === "applying";
  const box = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (box.current) nearInScrollBox(box.current);
    keep.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div ref={box} role="alert" style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap", alignItems: "center" }}>
      <span>{applying ? APPLYING : open ? discardQuestion(open) : "Discard the group save?"}</span>
      <AskAnswers>
        {applying ? null : (
          <Button variant="danger" onClick={props.onDiscard}>
            Discard
          </Button>
        )}
        <Button ref={keep} onClick={props.onKeep}>{applying ? "OK" : "Keep it"}</Button>
      </AskAnswers>
    </div>
  );
}
