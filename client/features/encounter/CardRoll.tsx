import { useState, type ReactNode } from "react";
import type { ClientOp } from "#shared/protocol.ts";
import { Button, type ButtonVariant } from "../../components/Button.tsx";
import { Chip } from "../../components/Chip.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomStore } from "../../state/view.ts";
import { logSeq, remembered, useOptionStore } from "../dice/optionState.ts";
import { sendRoll, useRollSender, type TaggedOp } from "../dice/send.ts";
import { useDicePanel, type PanelRoll } from "../dice/useDicePanel.ts";
import type { ReceiptState } from "../dice/useReceipt.ts";
import { useRowResult } from "../dice/useRollOption.ts";
import { pressChip, type CardButton, type CardChip } from "./saveCards.ts";

/*
 * What the fight alerts' cards that roll share (docs/design-v1-roll-options.md
 * 6.3). The card's roll is kept by its tag in the roll options' store, so
 * it shows busy, then its result in place, and survives the card being
 * drawn again. Each card has its own Adv and Dis chips, and its other
 * buttons are busy until their op is answered.
 */

/**
 * A card's roll on the server under `to`, the DM's to the DM and a player's
 * in the open, with its own sources only: the Dice panel's choices are
 * neither applied nor taken (6.3), so it works with the panel closed. `row`
 * names it in the options' store, which holds its newest tag for the page.
 * `after`, a room seq, keeps a card of one moment to the rolls sent since.
 */
export function useCardRoll(row: string, after?: number) {
  const panel = useDicePanel();
  const sender = useRollSender();
  const store = useOptionStore();
  const room = useRoomStore();
  const result = useRowResult(row, after);
  const [unsent, setUnsent] = useState(false);
  const remember = (tag: string | null) => {
    setUnsent(tag === null);
    if (tag) store.setState((s) => remembered(s, row, tag, logSeq(room.getState().view?.log)));
    return tag;
  };
  return {
    ...result,
    /** The last tap sent nothing, such as a roll the splitter refused. */
    unsent,
    roll: (rolls: PanelRoll[], opts: { to: "all" | "dm"; dc?: number }) => remember(panel.roll(rolls, opts)),
    /** A request's answer rolled on the server (`roll.dice`), tracked the same way. */
    send: (op: TaggedOp) => remember(sendRoll(sender, op) === null ? null : op.tag),
  };
}

/** What a card says of its roll that did not land: a refusal, an answer lost on the way, or nothing sent. */
export function rollTrouble(receipt: ReceiptState | null, unsent: boolean): string | null {
  if (unsent) return "That roll could not be sent. Try again.";
  if (receipt?.state === "refused") return receipt.text || receipt.message;
  if (receipt?.state === "unknown") return "This may have happened. Check the log.";
  return null;
}

/** The card's own Adv and Dis, one more source each for its roll, never the panel's. */
export function CardChips(props: { chip: CardChip; onChange(chip: CardChip): void; name: string }) {
  return (
    <div role="group" aria-label={`For ${props.name}'s roll`} style={{ display: "flex", gap: theme.space(1), flexWrap: "wrap" }}>
      <Chip pressed={props.chip === "adv"} aria-label="Advantage" onClick={() => props.onChange(pressChip(props.chip, "adv"))}>
        Adv
      </Chip>
      <Chip pressed={props.chip === "dis"} aria-label="Disadvantage" onClick={() => props.onChange(pressChip(props.chip, "dis"))}>
        Dis
      </Chip>
    </div>
  );
}

/**
 * A card's ops other than its roll, each button busy until its op is
 * answered. The store applies an op at once, so most cards change or go
 * as the tap lands, and a refusal comes back as the store's toast.
 */
export function useCardSend<A extends string>() {
  const actions = useRoomActions();
  const [busy, setBusy] = useState<A | null>(null);
  const send = (action: A, ops: readonly ClientOp[]): boolean => {
    if (busy !== null || ops.length === 0) return false;
    // Several ops of one tap, such as two concentrating effects ended, are one undo.
    const group = ops.length > 1 ? actions.newId() : undefined;
    let left = ops.length;
    setBusy(action);
    for (const op of ops) {
      const n = actions.dispatch(op, {
        ...(group ? { group } : {}),
        onAnswer: () => {
          left--;
          if (left === 0) setBusy(null);
        },
      });
      if (n === null) {
        setBusy(null);
        return false;
      }
    }
    return true;
  };
  return { busy, send };
}

const PRIMARY = new Set(["ask", "roll", "resist"]);
const DANGER = new Set(["fail", "accept"]);

/**
 * A card's buttons in one wrapping row, 44 px each. The first is the
 * card's one primary when it asks, rolls or resists, and the fails are
 * red. Roll is busy while its line is on the way and disabled while no
 * roll can go, with the reason as its title.
 */
export function CardButtons<A extends string>(props: {
  buttons: readonly CardButton<A>[];
  busy: A | null;
  rollBusy: boolean;
  blocked: string | null;
  onTap(action: A): void;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
      {props.buttons.map((b, i): ReactNode => {
        const roll = b.action === "roll";
        const variant: ButtonVariant = i === 0 && PRIMARY.has(b.action) ? "primary" : DANGER.has(b.action) ? "danger" : "secondary";
        return (
          <Button
            key={b.action}
            size="sm"
            variant={variant}
            busy={roll ? props.rollBusy : props.busy === b.action}
            disabled={roll && props.blocked !== null}
            title={roll && props.blocked !== null ? props.blocked : undefined}
            onClick={() => props.onTap(b.action)}
            style={{ flex: "1 1 auto" }}
          >
            {b.text}
          </Button>
        );
      })}
    </div>
  );
}
