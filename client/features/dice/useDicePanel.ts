import { useMemo } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { batchRolls } from "#shared/dice/batch.ts";
import { advantageFields, FORMULA_ERRORS, type AdvantageSource } from "#shared/dice/formula.ts";
import { startsSecret } from "#shared/dice/secret.ts";
import { uuidv7 } from "#shared/ids.ts";
import type { ActorTarget, DiceRollInput } from "#shared/protocol.ts";
import type { RoomView } from "../../state/types.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import { useRoomStore, useRoomView } from "../../state/view.ts";
import { NEEDS_CONNECTION, sendRoll, useRollSender, type RollSender } from "./send.ts";
import { acceptsRollMode, overrideRollSources, rollModeTo, type RollModeOverride } from "./rollMode.ts";
import { throwHooksSlot } from "./throw/hooks.ts";
import type { ThrowOrigin } from "./throw/store.ts";

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
  /** Damage never accepts d20 modes, even when its formula contains a d20. */
  modeEligible?: boolean;
};

/** A panel roll, as the sticky line shows it and Again sends it again. */
export type LastRoll =
  | { tag: string; rolls: DiceRollInput[]; to: "all" | "dm"; dc?: number; ac?: number }
  /**
   * A roll the panel cannot send again as it went: a request's answer or a
   * death save (LP7-DICE-10, docs/design-v1-dice-ui.md 4.1). The sticky
   * line shows it with no Again, named by `label` where its line has none.
   */
  | { tag: string; once: true; label: string }
  /** A roll that never went: its formula did not split, or the socket was not open. */
  | { error: string; at: number };

/**
 * What Again sends for the newest roll, or null where it has none: a
 * refusal before sending, and an answer or a death save, which cannot go
 * again as it went (LP7-DICE-10).
 */
export function againOf(last: LastRoll | null): Extract<LastRoll, { rolls: DiceRollInput[] }> | null {
  return last !== null && "rolls" in last ? last : null;
}

export type DiceState = {
  adv: boolean;
  dis: boolean;
  /**
   * Null is the roll's own start (`startsSecret`): pressed for a DM's roll
   * for a monster, and not for a free formula, a creature a player plays,
   * or any player's roll.
   */
  secret: boolean | null;
  /**
   * The DM's panel creatures a pressed Secret was pressed for (panelKey).
   * The chip follows the selection: a press belongs to the creatures it
   * was made for, so another selection reads Secret's own start again, and
   * a goblin's un-pressed Secret never carries over to the next monster.
   * Absent is the same as "", nothing selected, which a player's panel
   * always has.
   */
  secretFor?: string;
  version: number;
  last: LastRoll | null;
};

/** Secret as it stands for the panel's creatures now: the press made for them, else the start. */
export function secretNow(s: Pick<DiceState, "secret" | "secretFor">, key: string, start: boolean): boolean {
  return s.secret !== null && (s.secretFor ?? "") === key ? s.secret : start;
}

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
  /** The choices as sources, reset at once. `creatures` are the ones the roll is for, which set Secret's start. */
  take(creatures?: readonly ActorTarget[]): Taken;
  /** Read current choices without consuming them. The restore function does nothing. */
  peek(creatures?: readonly ActorTarget[]): Taken;
  /**
   * Rolls on the server. With no `to` it is a panel roll: it takes the
   * choices, goes under the taken Secret, and becomes the sticky line. With
   * `to` it goes under that visibility with only its own sources. Returns
   * its tag, or null when nothing was sent. With `origin`, a Dice panel
   * control's tap, its dice may be thrown (docs/design-v1-roll-animation.md 3.1).
   * An override reads choices without taking them and keeps the sticky
   * result when `to` is absent. A supplied `to` keeps its fixed envelope.
   * `parts` hears how many batches the roll went in, before it returns, so
   * an ask for saves can name the roll whole (docs/design-v1-player-save-spell.md 5.3).
   */
  roll(rolls: PanelRoll[], opts?: { override?: RollModeOverride; dc?: number; ac?: number; to?: "all" | "dm"; tag?: string; origin?: ThrowOrigin; parts?(n: number): void }): string | null;
  /** A chip's tap. Adv and Dis are never pressed together. */
  press(choice: "adv" | "dis" | "secret"): void;
  /** Again: rolls exactly what was rolled, under its own visibility, taking no choice. */
  again(rolls: readonly DiceRollInput[], to: "all" | "dm", origin?: ThrowOrigin): string | null;
  /** An answer or a death save the panel sent with its own op becomes the sticky line, with no Again. */
  noted(tag: string, label: string, origin?: ThrowOrigin): void;
};

function take(store: StoreApi<DiceState>, start: boolean, key: string): Taken {
  const before = store.getState();
  const sources: AdvantageSource[] = [];
  if (before.adv) sources.push({ kind: "adv", from: "pressed" });
  if (before.dis) sources.push({ kind: "dis", from: "pressed" });
  const secret = secretNow(before, key, start);
  const version = before.version + 1;
  store.setState({ adv: false, dis: false, secret: null, version });
  return {
    sources,
    secret,
    restore() {
      if (store.getState().version !== version) return;
      store.setState({ adv: before.adv, dis: before.dis, secret: before.secret, secretFor: before.secretFor, version: version + 1 });
    },
  };
}

/**
 * Sends a group of rolls as one tag, split by the splitter. Every op goes,
 * or none does. `onRefused` hears once if any part is refused.
 */
function send(sender: RollSender, rolls: DiceRollInput[], envelope: { to: "all" | "dm"; dc?: number; ac?: number }, onRefused: () => void, given?: string): { ok: true; tag: string; parts: number } | { ok: false; error: string } {
  // A group save names its tag before it sends, so its page can keep the tag with the rows it rolls (docs/design-v1-roll-options.md 5.2).
  const tag = given ?? uuidv7();
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
  return { ok: true, tag, parts: batched.ops.length };
}

/** What every panel surface calls, without React: the hook below, and the flow test that drives it against a fake server. */
export type DicePanelActions = Omit<DicePanelApi, "adv" | "dis" | "secret">;

/**
 * `secretStart` gives Secret's start for a roll for these creatures, and
 * with none, for the panel's own: a DM's Dice panel opened for a monster
 * starts pressed, so the chip shows what its next roll does, a free
 * formula typed there included. `panelKey` names the panel's creatures
 * now (panelKeyIn), which a press of Secret belongs to.
 */
export function createDicePanel(deps: {
  store: StoreApi<DiceState>;
  sender: RollSender;
  secretStart(creatures: readonly ActorTarget[]): boolean;
  panelKey?(): string;
  /** The throw's store, which every roll from a Dice panel control is told of with its origin. */
  registerThrow?(tag: string, origin: ThrowOrigin): void;
}): DicePanelActions {
  const { store, sender, secretStart } = deps;
  const panelKey = deps.panelKey ?? (() => "");
  const thrown = (tag: string, origin: ThrowOrigin | undefined) => {
    if (origin) deps.registerThrow?.(tag, origin);
  };
  const fail = (error: string) => store.setState({ last: { error, at: Date.now() } });
  return {
    take: (creatures = []) => take(store, secretStart(creatures), panelKey()),
    peek: (creatures = []) => {
      const state = store.getState();
      return { sources: [...(state.adv ? [{ kind: "adv" as const, from: "pressed" }] : []), ...(state.dis ? [{ kind: "dis" as const, from: "pressed" }] : [])], secret: secretNow(state, panelKey(), secretStart(creatures)), restore() {} };
    },
    press(choice) {
      const s = store.getState();
      const version = s.version + 1;
      const key = panelKey();
      if (choice === "secret") store.setState({ secret: !secretNow(s, key, secretStart([])), secretFor: key, version });
      else if (choice === "adv") store.setState({ adv: !s.adv, dis: false, version });
      else store.setState({ dis: !s.dis, adv: false, version });
    },
    roll(rolls, opts = {}) {
      const panel = opts.to === undefined;
      const baseline = secretStart(rolls.flatMap((r) => r.creature ? [r.creature] : []));
      const state = store.getState();
      const taken = panel && !opts.override ? take(store, baseline, panelKey()) : null;
      const manual = taken?.sources ?? (panel && opts.override ? [...(state.adv ? [{ kind: "adv" as const, from: "pressed" }] : []), ...(state.dis ? [{ kind: "dis" as const, from: "pressed" }] : [])] : []);
      const ordinary = (taken?.secret ?? secretNow(state, panelKey(), baseline)) ? "dm" : "all";
      const to = opts.to ?? rollModeTo(ordinary, baseline ? "dm" : "all", opts.override);
      const inputs: DiceRollInput[] = [];
      for (const roll of rolls) {
        const { sources = [], modeEligible, ...rest } = roll;
        const resolved = overrideRollSources(sources, manual, opts.override);
        // A roll with no d20, such as damage, never gets a source: a typed one there is refused, the panel's left out.
        if (!acceptsRollMode(roll.formula) || modeEligible === false) {
          if (advantageFields(sources).mode && (!opts.override || opts.override === "secret")) {
            taken?.restore();
            if (panel) fail(FORMULA_ERRORS.mode);
            return null;
          }
          inputs.push(rest);
          continue;
        }
        inputs.push({ ...rest, ...advantageFields(resolved) });
      }
      const envelope = { to, ...(opts.dc !== undefined ? { dc: opts.dc } : {}), ...(opts.ac !== undefined ? { ac: opts.ac } : {}) };
      const sent = send(sender, inputs, envelope, () => taken?.restore(), opts.tag);
      if (!sent.ok) {
        taken?.restore();
        if (panel) fail(sent.error);
        return null;
      }
      if (panel) store.setState({ last: { tag: sent.tag, rolls: inputs, ...envelope } });
      thrown(sent.tag, opts.origin);
      opts.parts?.(sent.parts);
      return sent.tag;
    },
    noted(tag, label, origin) {
      store.setState({ last: { tag, once: true, label } });
      thrown(tag, origin);
    },
    again(rolls, to, origin) {
      const sent = send(sender, [...rolls], { to }, () => undefined);
      if (!sent.ok) {
        fail(sent.error);
        return null;
      }
      store.setState({ last: { tag: sent.tag, rolls: [...rolls], to } });
      thrown(sent.tag, origin);
      return sent.tag;
    },
  };
}

/** The creatures a DM's Dice panel is opened for: the selected tokens, whose options it lists (docs/design-v1-roll-options.md 4). */
function panelCreatures(s: Pick<RoomView, "local">): ActorTarget[] {
  return s.local.selectedIds.map((tokenId) => ({ tokenId }));
}

/** The DM's panel creatures as one key, which a press of Secret belongs to. A player's panel has none: their press stands until a roll takes it. */
export function panelKeyIn(s: Pick<RoomView, "you" | "local">): string {
  return s.you?.role === "dm" ? [...s.local.selectedIds].sort().join(" ") : "";
}

/** Secret's start for a roll for these creatures, or with none for the panel's own (createDicePanel). */
export function secretStartIn(s: Pick<RoomView, "view" | "you" | "local">, creatures: readonly ActorTarget[]): boolean {
  if (!s.view || s.you?.role !== "dm") return false;
  return startsSecret(s.view, true, creatures.length > 0 ? creatures : panelCreatures(s));
}

/** The panel's rolls and choices for any surface that rolls (8.4). */
export function useDicePanel(): DicePanelApi {
  const store = useScoped(diceChoicesSlot);
  const sender = useRollSender();
  const room = useRoomStore();
  const throws = useScoped(throwHooksSlot);
  const start = useRoomView((s) => secretStartIn(s, []));
  const key = useRoomView(panelKeyIn);
  const adv = useStore(store, (s) => s.adv);
  const dis = useStore(store, (s) => s.dis);
  const secret = useStore(store, (s) => secretNow(s, key, start));
  const actions = useMemo(
    () =>
      createDicePanel({
        store,
        sender,
        secretStart: (creatures) => secretStartIn(room.getState(), creatures),
        panelKey: () => panelKeyIn(room.getState()),
        registerThrow: (tag, origin) => throws.current?.register(tag, origin),
      }),
    [store, sender, room, throws],
  );
  return useMemo(() => ({ ...actions, adv, dis, secret }), [actions, adv, dis, secret]);
}

/** The newest panel roll, for the sticky line (8.2). */
export function useLastRoll(): LastRoll | null {
  const store = useScoped(diceChoicesSlot);
  return useStore(store, (s) => s.last);
}
