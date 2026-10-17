import { useMemo } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { batchRolls } from "#shared/dice/batch.ts";
import { advantageFields, applyMode, FORMULA_ERRORS, parseFormula, type AdvantageSource } from "#shared/dice/formula.ts";
import { uuidv7 } from "#shared/ids.ts";
import type { DiceRollInput } from "#shared/protocol.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { NEEDS_CONNECTION, sendRoll, useRollSender, type RollSender } from "./send.ts";

/**
 * The Dice panel's one-roll choices and its newest roll
 * (docs/design-v1-dice.md 8.2 and 8.4), in a room-scoped store, so a fight
 * alert card or the tracker rolls through the panel's rules whether the
 * panel is mounted or not.
 *
 * Adv, Dis and Secret belong to the tap that rolls: a panel roll takes them
 * the moment it is sent and puts them back to their start, so two taps
 * never share one Advantage, and a late answer never clears a newer choice.
 * If nothing went or the roll was refused, they come back, but only while
 * they still stand at their start: a choice pressed since is never undone.
 * `version` moves on every change of them, which is how a give-back knows.
 */
export type PanelRoll = Omit<DiceRollInput, "mode" | "cancelled"> & {
  /** The roll's own advantage sources, unresolved: a preset's, typed words. */
  sources?: AdvantageSource[];
};

/** A panel roll, as the sticky line shows it and Again sends it again. */
export type LastRoll =
  | { tag: string; rolls: DiceRollInput[]; to: "all" | "dm"; dc?: number; ac?: number }
  /** A roll that never went: its formula did not split, or the socket was not open. */
  | { error: string; at: number };

export type DiceState = {
  adv: boolean;
  dis: boolean;
  /** Null is the role's start: pressed for a DM, whose rolls are behind the screen, not for a player. */
  secret: boolean | null;
  version: number;
  last: LastRoll | null;
};

export const diceChoicesSlot = scopeSlot(() => createStore<DiceState>(() => ({ adv: false, dis: false, secret: null, version: 0, last: null })));

export type Taken = {
  sources: AdvantageSource[];
  secret: boolean;
  /** Gives the choices back, only while they stand at their start since the take. */
  restore(): void;
};

export type DicePanelApi = {
  /** The one-roll choices as they stand. */
  adv: boolean;
  dis: boolean;
  secret: boolean;
  /** The choices as sources, reset at once. */
  take(): Taken;
  /**
   * Rolls on the server. With no `to` it is a panel roll: it takes the
   * choices, goes under the taken Secret, and becomes the sticky line. With
   * `to` it goes under that visibility with only its own sources. Returns
   * its tag, or null when nothing was sent.
   */
  roll(rolls: PanelRoll[], opts?: { dc?: number; ac?: number; to?: "all" | "dm" }): string | null;
  /** A chip's tap. Adv and Dis are never pressed together. */
  press(choice: "adv" | "dis" | "secret"): void;
  /** Again: rolls exactly what was rolled, under its own visibility, taking no choice. */
  again(rolls: readonly DiceRollInput[], to: "all" | "dm"): string | null;
};

function take(store: StoreApi<DiceState>, dm: boolean): Taken {
  const before = store.getState();
  const sources: AdvantageSource[] = [];
  if (before.adv) sources.push({ kind: "adv", from: "pressed" });
  if (before.dis) sources.push({ kind: "dis", from: "pressed" });
  const secret = before.secret ?? dm;
  const version = before.version + 1;
  store.setState({ adv: false, dis: false, secret: null, version });
  return {
    sources,
    secret,
    restore() {
      if (store.getState().version !== version) return;
      store.setState({ adv: before.adv, dis: before.dis, secret: before.secret, version: version + 1 });
    },
  };
}

/** Whether a formula has the one plain d20 a mode applies to (3.4). */
function hasOneD20(formula: string): boolean {
  const parsed = parseFormula(formula);
  return parsed.ok && applyMode(parsed.formula, "adv").ok;
}

/**
 * Sends a group of rolls as one tag, split by the splitter. Every op goes,
 * or none does. `onRefused` hears once if any part is refused.
 */
function send(sender: RollSender, rolls: DiceRollInput[], envelope: { to: "all" | "dm"; dc?: number; ac?: number }, onRefused: () => void): { ok: true; tag: string } | { ok: false; error: string } {
  const tag = uuidv7();
  const batched = batchRolls(rolls, { tag, ...envelope });
  if (!batched.ok) return { ok: false, error: batched.error };
  if (!sender.connected()) return { ok: false, error: NEEDS_CONNECTION };
  let told = false;
  for (const op of batched.ops) {
    const n = sendRoll(sender, op, {
      onAnswer: (answer) => {
        if (answer !== "refused" || told) return;
        told = true;
        onRefused();
      },
    });
    if (n === null) return { ok: false, error: NEEDS_CONNECTION };
  }
  return { ok: true, tag };
}

/** What every panel surface calls, without React: the hook below, and the flow test that drives it against a fake server. */
export type DicePanelActions = Omit<DicePanelApi, "adv" | "dis" | "secret">;

export function createDicePanel(deps: { store: StoreApi<DiceState>; sender: RollSender; dm: boolean }): DicePanelActions {
  const { store, sender, dm } = deps;
  const fail = (error: string) => store.setState({ last: { error, at: Date.now() } });
  return {
    take: () => take(store, dm),
    press(choice) {
      const s = store.getState();
      const version = s.version + 1;
      if (choice === "secret") store.setState({ secret: !(s.secret ?? dm), version });
      else if (choice === "adv") store.setState({ adv: !s.adv, dis: false, version });
      else store.setState({ dis: !s.dis, adv: false, version });
    },
    roll(rolls, opts = {}) {
      const panel = opts.to === undefined;
      const taken = panel ? take(store, dm) : null;
      const to = opts.to ?? (taken?.secret ? "dm" : "all");
      const inputs: DiceRollInput[] = [];
      for (const roll of rolls) {
        const { sources = [], ...rest } = roll;
        // A roll with no d20, such as damage, never gets a source: a typed one there is refused, the panel's left out.
        if (!hasOneD20(roll.formula)) {
          if (advantageFields(sources).mode) {
            taken?.restore();
            if (panel) fail(FORMULA_ERRORS.mode);
            return null;
          }
          inputs.push(rest);
          continue;
        }
        inputs.push({ ...rest, ...advantageFields([...sources, ...(taken?.sources ?? [])]) });
      }
      const envelope = { to, ...(opts.dc !== undefined ? { dc: opts.dc } : {}), ...(opts.ac !== undefined ? { ac: opts.ac } : {}) };
      const sent = send(sender, inputs, envelope, () => taken?.restore());
      if (!sent.ok) {
        taken?.restore();
        if (panel) fail(sent.error);
        return null;
      }
      if (panel) store.setState({ last: { tag: sent.tag, rolls: inputs, ...envelope } });
      return sent.tag;
    },
    again(rolls, to) {
      const sent = send(sender, [...rolls], { to }, () => undefined);
      if (!sent.ok) {
        fail(sent.error);
        return null;
      }
      store.setState({ last: { tag: sent.tag, rolls: [...rolls], to } });
      return sent.tag;
    },
  };
}

/** The panel's rolls and choices for any surface that rolls (8.4). */
export function useDicePanel(): DicePanelApi {
  const store = useScoped(diceChoicesSlot);
  const sender = useRollSender();
  const dm = useRoomView((s) => s.you?.role === "dm");
  const adv = useStore(store, (s) => s.adv);
  const dis = useStore(store, (s) => s.dis);
  const secret = useStore(store, (s) => s.secret ?? dm);
  const actions = useMemo(() => createDicePanel({ store, sender, dm }), [store, sender, dm]);
  return useMemo(() => ({ ...actions, adv, dis, secret }), [actions, adv, dis, secret]);
}

/** The newest panel roll, for the sticky line (8.2). */
export function useLastRoll(): LastRoll | null {
  const store = useScoped(diceChoicesSlot);
  return useStore(store, (s) => s.last);
}
