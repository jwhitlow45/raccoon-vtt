import { useMemo } from "react";
import type { StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import type { LogEntry, RoomState } from "#shared/model.ts";
import { isCoarsePointer } from "../../lib/device.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import { sheetOpen, type LocalUi, type RoomActions, type ToastSend, type You } from "../../state/types.ts";
import type { RoomUi } from "../../state/store.ts";
import { useRoomActions, useRoomStore } from "../../state/view.ts";
import { reasonText } from "../resources/logic.ts";
import { hpTargets, sendHpEntry } from "../tokens/groupHp.ts";
import type { HpFill } from "../tokens/hpDraft.ts";
import { parseHpInput } from "../tokens/hpInput.ts";
import { useMarkChipApplied } from "./hpChips.ts";
import type { HpChip } from "./options.ts";
import { applyTargets, chipName, rollChip, rollOrigin, type ApplyTarget } from "./targets.ts";

/*
 * What a damage roll's "Apply to" chips do (QOL audit Q2), apart from the
 * row that draws them (ApplyTo.tsx), so a toast's buttons apply the same
 * way. The DM's chips apply at once, since the DM has Undo: one `actor.hp`
 * with the roll's parts, busy until the answer, then the creature leaves
 * the roll's chips so one roll never lands twice on it (D-261106-101). A
 * player's chips fill the target's HP entry instead, its preview showing
 * before Apply (D-261106-174).
 */

/** What became of applying one roll, kept by its chip's line (targets.ts rollChip) for every surface that draws that roll's chips. */
export type RollApplied = { applied: readonly { holder: string; name: string }[]; busy: string | null; said: string | null };
export type Applies = { rolls: Readonly<Record<string, RollApplied>> };

/** Per Room page, so a turn card folded and shown again, and the Dice panel beside it, show one roll's chips alike. */
export const applySlot = scopeSlot(() => createStore<Applies>(() => ({ rolls: {} })));

export const NOTHING_YET: RollApplied = { applied: [], busy: null, said: null };

/** Words for a change whose answer was lost with the connection, as a roll's are (Roller.tsx). */
export const APPLY_UNKNOWN = "This may have happened. Check the log.";
/** A chip whose creature left the map between the draw and the tap. */
export const APPLY_GONE = "That creature is no longer on the map.";
/** A change the store would not queue. */
export const APPLY_UNSENT = "That could not be sent.";
/** A press while another chip of the same roll waits on its answer, as a toast's chip can be beside the Dice panel's. */
export const APPLY_BUSY = "Already applying this roll.";

/** What applying needs, none of it a component's, so a toast's button, which outlives every surface, applies the same way. */
export type ApplyEnv = {
  room(): { view: RoomState | null; you: You | null };
  actions: Pick<RoomActions, "dispatch" | "newId">;
  applies: StoreApi<Applies>;
  markApplied(lineIds: readonly string[]): void;
};

function setRoll(applies: StoreApi<Applies>, key: string, next: RollApplied): void {
  applies.setState((s) => ({ rolls: { ...s.rolls, [key]: next } }));
}

/**
 * A roll applied through an HP entry's filled amount, which a player's chip
 * asks for: the creatures it went to join the roll's applied ones, so the
 * chip leaves its row and the row says "Applied to Thorn." as it does after
 * the DM's chip (LP32-POLISH g). The entry goes out with no answer to wait
 * for, so it counts at once, as its own chip's mark does (hpChips.ts).
 */
export function recordApplied(applies: StoreApi<Applies>, lineId: string, to: readonly { holder: string; name: string }[]): void {
  const was = applies.getState().rolls[lineId] ?? NOTHING_YET;
  const fresh = to.filter((t) => !was.applied.some((a) => a.holder === t.holder));
  if (fresh.length === 0) return;
  setRoll(applies, lineId, { ...was, applied: [...was.applied, ...fresh.map(({ holder, name }) => ({ holder, name }))] });
}

/**
 * The DM's chip: the roll's damage to one creature at once, through the HP
 * entry's own path (groupHp.ts sendHpEntry), so its defenses count as in
 * the entry and a critical hit on a creature at 0 HP counts as the entry's
 * ticked Crit. Resolves null once the server took it, or the words of why
 * not. A press on a creature it already landed on does nothing and
 * resolves null, as taken. A press while another chip of the roll waits
 * sends nothing and says so, so a toast's chip keeps its toast rather
 * than closing it with nothing applied.
 */
export function applyNow(env: ApplyEnv, chip: HpChip, to: ApplyTarget): Promise<string | null> {
  const key = chip.lineId;
  const was = env.applies.getState().rolls[key] ?? NOTHING_YET;
  if (was.applied.some((a) => a.holder === to.holder)) return Promise.resolve(null);
  if (was.busy !== null) return Promise.resolve(APPLY_BUSY);
  const { view, you } = env.room();
  const token = view?.tokens[to.tokenId];
  if (!view || !you || !token) return Promise.resolve(APPLY_GONE);
  const parsed = parseHpInput(String(chip.amount), "damage", chip);
  if (!parsed.ok) return Promise.resolve(parsed.error);
  const targets = hpTargets([token], { role: you.role, memberId: you.memberId, characters: view.characters, playersApplyDamage: view.meta.settings.playersApplyDamage });
  setRoll(env.applies, key, { ...was, busy: to.holder, said: null });
  return new Promise((resolve) => {
    let settled = false;
    const done = (words: string | null) => {
      if (settled) return;
      settled = true;
      const now = env.applies.getState().rolls[key] ?? NOTHING_YET;
      setRoll(env.applies, key, { busy: null, said: words, applied: words === null ? [...now.applied, { holder: to.holder, name: to.name }] : now.applied });
      // As Use does: the HP entry's chip for this roll goes too.
      if (words === null) env.markApplied(chip.lineIds);
      resolve(words);
    };
    const sent = sendHpEntry(env.actions, targets, parsed.change, chip.critical, {
      quiet: true,
      onAnswer: (answer, refusal) => done(answer === "taken" ? null : answer === "refused" ? reasonText(refusal) : APPLY_UNKNOWN),
    });
    if (sent.length === 0) done(APPLY_UNSENT);
  });
}

/**
 * A player's chip: select the creature alone, open its bar, and fill its
 * HP entry there (hpDraft.ts HpFill). On a phone the open sheet closes so
 * the bar shows, and the field takes no focus, so the keyboard stays down.
 */
export function fillEntry(ui: RoomUi, local: LocalUi, askFill: (fill: HpFill) => void, chip: HpChip, to: ApplyTarget): void {
  askFill({ tokenId: to.tokenId, chip, focus: !isCoarsePointer() });
  if (local.multi) ui.setMultiSelect(false);
  ui.tap(to.tokenId);
  if (sheetOpen(local)) ui.closeSheets();
}

/** The env the room's hooks give, for a surface that applies. */
export function useApplyEnv(): ApplyEnv {
  const store = useRoomStore();
  const actions = useRoomActions();
  const applies = useScoped(applySlot);
  const markApplied = useMarkChipApplied();
  return useMemo(() => ({ room: () => store.getState(), actions, applies, markApplied }), [store, actions, applies, markApplied]);
}

/**
 * A toast's chips for someone else's damage roll on the DM's device, taken
 * when the toast comes: the same ranking as every other surface, each a
 * ToastSend that applies at once and keeps the toast until its answer.
 * None for a player, whose chips show only under their own rolls
 * (D-261106-119), or where the roll is no damage.
 */
export function toastChips(env: ApplyEnv, lines: readonly LogEntry[], at: { sceneId: string | null; selected: readonly string[] }): ToastSend[] {
  const { view, you } = env.room();
  const chip = rollChip(lines);
  if (!view || !you || you.role !== "dm" || !chip) return [];
  const applied = new Set((env.applies.getState().rolls[chip.lineId] ?? NOTHING_YET).applied.map((a) => a.holder));
  return applyTargets({ view, you, sceneId: at.sceneId, origin: rollOrigin(lines), selected: at.selected, leave: applied }).map((to) => ({
    label: to.name,
    name: chipName(chip, to.name, true),
    send: () => applyNow(env, chip, to),
  }));
}
