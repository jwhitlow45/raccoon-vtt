import { useMemo } from "react";
import type { LimitedUse } from "#shared/dice/uses.ts";
import { healRevivesDead } from "#shared/migrate.ts";
import type { RoomState } from "#shared/model.ts";
import { useRoomView } from "../../state/view.ts";
import { entryName, playerOwnedEntry } from "../encounter/logic.ts";
import {
  actorOf,
  answersFor,
  characterIdOf,
  promptsOf,
  turnParticipants,
  usesCount,
  usesRows,
  type DeathSavePrompt,
  type Participant,
  type RechargePromptState,
  type RegenerationPrompt,
} from "./logic.ts";
import { promptId, regenerationIn, turnId, useCreaturesUses, useDismissed } from "./state.ts";

/*
 * The cards a turn start brings to this device's alerts column
 * (docs/design-v1-combat-controls.md 4), from state alone, so a reload, a
 * second DM device and a late join show the same cards with the same
 * results: each creature of the turn this viewer answers for, its
 * Regeneration, death save and recharge prompts, and the turn card with
 * its uses. A card this device dismissed stays away for this turn.
 */

export type PromptCard<P> = { id: string; participant: Participant; record: number; prompt: P };

export type TurnCardModel = {
  id: string;
  /** Whose turn it is: the landing row's creature, or its row's name when only other creatures of the turn are this viewer's. */
  name: string;
  blocks: { participant: Participant; uses: readonly LimitedUse[] | null; count: number }[];
  count: number;
  loading: boolean;
  failed: boolean;
};

export type CombatAlerts = {
  regenerations: PromptCard<RegenerationPrompt>[];
  deathSaves: (PromptCard<DeathSavePrompt> & { waits: boolean })[];
  recharges: PromptCard<RechargePromptState>[];
  turn: TurnCardModel | null;
  revives: boolean;
};

const NONE: CombatAlerts = { regenerations: [], deathSaves: [], recharges: [], turn: null, revives: false };

type You = { role: "dm" | "player"; memberId: string };

export function useCombatAlerts(): CombatAlerts {
  const view = useRoomView((s) => s.view);
  const you = useRoomView((s) => s.you);
  const local = useDismissed();
  const all = useMemo(() => (view ? turnParticipants(view) : []), [view]);
  // The DM also gets a player's character's death save card (4.1), so the DM reads every creature of the turn.
  const shown = useMemo(() => (view && you ? all.filter((p) => answersFor(view, you, p.target) || (you.role === "dm" && p.record?.life === "dying")) : []), [view, you, all]);
  const targets = useMemo(() => shown.map((p) => p.target), [shown]);
  const read = useCreaturesUses(targets);
  if (!view || !you || shown.length === 0) return NONE;
  return combatAlerts({ view, you, participants: shown, uses: read.uses, loading: read.loading, failed: read.failed, dismissed: local.dismissed });
}

/** The cards of the turn now for this viewer, free of React for its tests. */
export function combatAlerts(input: {
  view: Pick<RoomState, "tokens" | "characters" | "encounter" | "meta">;
  you: You;
  participants: readonly Participant[];
  uses: readonly (readonly LimitedUse[] | null)[];
  loading: boolean;
  failed: boolean;
  dismissed: ReadonlySet<string>;
}): CombatAlerts {
  const { view, you, dismissed } = input;
  const out: CombatAlerts = { regenerations: [], deathSaves: [], recharges: [], turn: null, revives: healRevivesDead(view.meta.settings) };
  const blocks: TurnCardModel["blocks"] = [];
  input.participants.forEach((p, i) => {
    const uses = input.uses[i] ?? null;
    const actor = actorOf(view, p.target);
    const answers = answersFor(view, you, p.target);
    if (p.record && actor) {
      const record = p.record;
      const prompts = promptsOf({ record, actor: { life: actor.life, hp: actor.hp, uses: actor.uses }, regeneration: regenerationIn(uses), uses });
      const keep = (what: string, settled: { state: string } | undefined) => settled?.state !== "skipped" && !dismissed.has(promptId(p.holder, record.id, what));
      const card = <P extends { what: string }>(prompt: P) => ({ id: promptId(p.holder, record.id, prompt.what), participant: p, record: record.id, prompt });
      const regen = prompts.regeneration;
      if (answers && regen && keep(regen.what, regen.settled)) out.regenerations.push(card(regen));
      const death = prompts.deathSave;
      // A player's character's card reaches the DM too, but a creature the DM plays never reaches a player.
      if (death && (answers || (you.role === "dm" && playerOwnedEntry(view, p.target))) && keep(death.what, death.settled)) {
        const waits = regen !== null && regen.settled === undefined && !dismissed.has(promptId(p.holder, record.id, "regeneration"));
        out.deathSaves.push({ ...card(death), waits });
      }
      if (answers) for (const r of prompts.recharges) if (keep(r.what, r.settled)) out.recharges.push(card(r));
    }
    if (!answers) return;
    const rows = usesRows({ form: "card", uses, actor, ownTurn: true, record: p.record });
    const characterId = characterIdOf(view, p.target);
    const resources = characterId !== undefined ? view.characters[characterId]?.resources : undefined;
    const count = usesCount(rows, resources);
    const skipped = rows.some((r) => r.kind === "skipped");
    if (count > 0 || skipped || (uses === null && (input.loading || input.failed))) blocks.push({ participant: p, uses, count });
  });
  const encounter = view.encounter;
  if (blocks.length > 0 && encounter?.activeEntryId) {
    const id = turnId(encounter.activeEntryId, encounter.round);
    if (!dismissed.has(id)) {
      const landing = input.participants.find((p) => p.landing);
      const entry = encounter.entries.find((e) => e.id === encounter.activeEntryId);
      const name = landing?.name ?? (entry ? entryName(view, entry) : "This");
      out.turn = { id, name, blocks, count: blocks.reduce((n, b) => n + b.count, 0), loading: input.loading, failed: input.failed };
    }
  }
  return out;
}
