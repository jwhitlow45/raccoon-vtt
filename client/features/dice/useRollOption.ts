import { useContext, useEffect, useMemo } from "react";
import type { D20Test } from "#shared/dice/bonus.ts";
import { advantageFields } from "#shared/dice/formula.ts";
import { uuidv7 } from "#shared/ids.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import type { DiceRoll, RollTest } from "#shared/model.ts";
import type { RollPreset } from "#shared/rules/rollReminders.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomView } from "../../state/view.ts";
import { PreviewContext } from "../dm/previewContext.ts";
import { openAsk } from "../rolls/open.ts";
import { rollsOf } from "./logic.ts";
import { d20Roll, initiativeOp, routeOf, targetRef } from "./options.ts";
import { logSeq, remembered, rowTag, useOption, useOptionStore } from "./optionState.ts";
import { useReceipt, type ReceiptState } from "./useReceipt.ts";
import { NEEDS_CONNECTION, sendRoll, useRollSender } from "./send.ts";
import { useDicePanel, type PanelRoll } from "./useDicePanel.ts";

/** The words on every option while a roll cannot go: no connection, or a preview, whose actions are refused. */
export const IN_PREVIEW = "Rolls are not sent from a preview.";

export function useRollBlocked(): string | null {
  const preview = useContext(PreviewContext) !== null;
  const connected = useRoomView((s) => s.connection === "open");
  return preview ? IN_PREVIEW : connected ? null : NEEDS_CONNECTION;
}

/** A save or check as the request sheet's test (docs/design-v1-roll-request.md 4.8 fill). */
function rollTestOf(test: Extract<D20Test, { kind: "save" | "check" }>): RollTest {
  if (test.kind === "save") return { kind: "save", choices: [{ ability: test.ability }] };
  return { kind: "check", choices: [test.skill ? { ability: test.ability, skill: test.skill } : { ability: test.ability }] };
}

/**
 * How every roll option sends (docs/design-v1-roll-options.md 4.2 and
 * 4.3), the Dice panel's and any surface that rolls the same way, such as
 * the tracker's value box: a d20 tap goes by its route, any other roll is a
 * panel roll, and each remembers its tag on its row so the row shows its
 * result in place.
 */
export function useRollOption() {
  const panel = useDicePanel();
  const sender = useRollSender();
  const scope = useRoomScope();
  const store = useOptionStore();
  const room = useRoomStore();
  const actions = useRoomActions();
  const dm = useRoomView((s) => s.you?.role === "dm");
  return useMemo(() => {
    const remember = (row: string, tag: string | null) => {
      if (tag) store.setState((s) => remembered(s, row, tag, logSeq(room.getState().view?.log)));
      return tag;
    };
    return {
      /** A save, check, initiative or attack. Returns the row's new tag, "asked" for an opened request sheet, or null for nothing sent. */
      d20(input: {
        creature: ActorTarget;
        test: D20Test;
        bonus: number;
        preset: RollPreset;
        label: string;
        row: string;
        played: boolean;
        ask: boolean;
        /** The token a DM's Ask names, when the creature is on the map. */
        tokenId?: string;
        critOn?: 18 | 19;
      }): string | "asked" | null {
        const state = room.getState().view;
        if (!state) return null;
        const route = routeOf({ state, creature: input.creature, test: input.test, dm, played: input.played, ask: input.ask });
        if (route.kind === "ask" && (input.test.kind === "save" || input.test.kind === "check") && input.tokenId) {
          openAsk(scope, { kind: "selection", tokenIds: [input.tokenId], fill: { test: rollTestOf(input.test) } });
          return "asked";
        }
        if (route.kind === "answer") {
          // The taken choices belong to this tap, as a panel roll's do, and come back if nothing went.
          const taken = panel.take();
          const tag = uuidv7();
          const extra = input.preset.extra.join("").replace(/^\+/, "");
          const n = sendRoll(
            sender,
            {
              t: "roll.dice",
              tag,
              rollId: route.request.id,
              target: targetRef(route.target),
              ...(route.request.test.choices.length > 1 ? { choice: route.choice === 1 ? (1 as const) : (0 as const) } : {}),
              ...advantageFields([...input.preset.sources, ...taken.sources]),
              ...(extra ? { extra } : {}),
              ...(dm ? { unanswered: true as const } : {}),
            },
            { onAnswer: (answer) => answer === "refused" && taken.restore() },
          );
          if (n === null) {
            taken.restore();
            return null;
          }
          return remember(input.row, tag);
        }
        return remember(input.row, panel.roll([d20Roll(input.creature, input.bonus, input.preset, input.label, input.critOn)]));
      },
      /** A death save, counted by the server from the state then (4.3). */
      deathSave(creature: ActorTarget, preset: RollPreset, row: string): string | null {
        const taken = panel.take();
        const tag = uuidv7();
        const extra = preset.extra.join("").replace(/^\+/, "");
        const n = sendRoll(
          sender,
          { t: "actor.deathRoll", tag, target: creature, ...advantageFields([...preset.sources, ...taken.sources]), ...(extra ? { extra } : {}) },
          { onAnswer: (answer) => answer === "refused" && taken.restore() },
        );
        if (n === null) {
          taken.restore();
          return null;
        }
        return remember(row, tag);
      },
      /** A monster's initiative score set on its row without a roll (4.2), as a typed value goes. */
      setInitiative(entryId: string, value: number, asDm: boolean): void {
        actions.dispatch(asDm ? { t: "encounter.setValues", values: [{ entryId, value }] } : { t: "encounter.setValue", entryId, value });
      },
      /** Damage, healing, a plain roll or a recharge, as panel rolls. */
      rolls(rolls: PanelRoll[], row: string): string | null {
        if (rolls.length === 0) return null;
        return remember(row, panel.roll(rolls));
      },
    };
  }, [panel, sender, scope, store, room, actions, dm]);
}

/**
 * A row's newest roll as it stands: its tag, its receipt, the rolls it
 * landed, and whether it waits. With `after`, only a roll sent at or after
 * that room seq counts (rowTag).
 */
export function useRowResult(row: string, after?: number): { tag: string | null; receipt: ReceiptState | null; rolls: DiceRoll[]; waiting: boolean } {
  const tag = useOption((s) => rowTag(s, row, after));
  const receipt = useReceipt(tag);
  const rolls = useMemo(() => (receipt?.state === "committed" ? rollsOf(receipt.lines) : []), [receipt]);
  const waiting = receipt !== null && (receipt.state === "sending" || receipt.state === "checking");
  return { tag, receipt, rolls, waiting };
}

/**
 * Runs `act` once for a tag whose lines landed, on any surface that shows
 * it, so a result is acted on once however many rows show it: initiative
 * written, a critical pressed, Used cleared.
 */
export function useActOnce(tag: string | null, rolls: readonly DiceRoll[], act: (rolls: readonly DiceRoll[]) => void): void {
  const store = useOptionStore();
  useEffect(() => {
    if (!tag || rolls.length === 0 || store.getState().acted[tag]) return;
    store.setState((s) => ({ acted: { ...s.acted, [tag]: true } }));
    act(rolls);
    // `act` is the caller's closure of the tap's values, read once when the line lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag, rolls, store]);
}

/** The words when initiative landed after the row was changed by hand (4.3). */
export const ROW_CHANGED = "Not set: the row changed meanwhile.";

/**
 * Initiative's roll written to its row once it lands (4.3), only while the
 * row still holds the value it had at the tap. Returns the words when it
 * could not be written, for the row to show.
 */
export function useInitiativeWrite(tag: string | null, rolls: readonly DiceRoll[], at: { entryId: string; before: number | null } | null): string | null {
  const actions = useRoomActions();
  const room = useRoomStore();
  const dm = useRoomView((s) => s.you?.role === "dm");
  const store = useOptionStore();
  const changed = useOption((s) => (tag ? s.acted[`${tag}:changed`] === true : false));
  // Only a surface that holds the tap's row and value writes, so one that shows the same row without them never spends the tag.
  useActOnce(at ? tag : null, rolls, (landed) => {
    const state = room.getState().view;
    const total = landed[0]?.total;
    if (!state || !at || total === undefined) return;
    const op = initiativeOp(state, at.entryId, at.before, total, dm);
    if (op) actions.dispatch(op);
    else store.setState((s) => ({ acted: { ...s.acted, [`${tag}:changed`]: true } }));
  });
  return changed ? ROW_CHANGED : null;
}
