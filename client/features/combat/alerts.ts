import { useMemo } from "react";
import type { NamedRoll } from "#shared/dice/bonus.ts";
import type { LimitedUse } from "#shared/dice/uses.ts";
import { healRevivesDead } from "#shared/migrate.ts";
import type { RoomState } from "#shared/model.ts";
import { useRoomView } from "../../state/view.ts";
import { creatureRolls } from "../dice/creature.ts";
import { useDiceView } from "../dice/useDiceView.ts";
import { entryName, playerOwnedEntry } from "../encounter/logic.ts";
import {
  actorOf,
  answersFor,
  characterIdOf,
  promptsOf,
  turnParticipants,
  turnSince,
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
 * (docs/design/design-v1-combat-controls.md 4), from state alone, so a reload, a
 * second DM device and a late join show the same cards with the same
 * results: each creature of the turn this viewer answers for, its
 * Regeneration, death save and recharge prompts, and the turn card with
 * its uses. A card this device dismissed stays away for this turn.
 * A creature with attacks gets the card too, which lists them above its
 * uses (QOL audit Q1), so a goblin with no uses to spend has one.
 */

/** The attacks a turn card lists (QOL audit Q1): a creature's named rolls with an attack bonus in Actions and Bonus Actions, in its block's order. */
export function cardAttacks(named: readonly NamedRoll[]): NamedRoll[] {
  return named.filter((r) => r.attack !== undefined && (r.section === "actions" || r.section === "bonusActions"));
}

export type PromptCard<P> = { id: string; participant: Participant; record: number; prompt: P };

export type TurnCardModel = {
  id: string;
  /** Whose turn it is: the landing row's creature, or its row's name when only other creatures of the turn are this viewer's. */
  name: string;
  /** Each creature of the turn this viewer answers for: its uses, their count, and how many attacks it lists (cardAttacks). */
  blocks: { participant: Participant; uses: readonly LimitedUse[] | null; count: number; attacks: number }[];
  count: number;
  /** The attacks of every block, for the folded row's words. */
  attacks: number;
  /**
   * The room seq the attacks' results count from (logic.ts turnSince).
   * Infinite when nothing in this view names the turn's start, so no
   * result shows rather than an earlier turn's with its chips.
   */
  since: number;
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
  // The attacks need the SRD's rolls table as well as its blocks, which the uses alone never wait on.
  const rolls = useDiceView(targets);
  const attacks = useMemo(() => targets.map((t) => (rolls.dice ? (creatureRolls(rolls.dice, t)?.named ?? null) : null)), [targets, rolls.dice]);
  if (!view || !you || shown.length === 0) return NONE;
  return combatAlerts({
    view,
    you,
    participants: shown,
    uses: read.uses,
    attacks: attacks.map((named) => (named ? cardAttacks(named).length : null)),
    loading: read.loading || rolls.loading,
    failed: read.failed,
    dismissed: local.dismissed,
  });
}

/** The cards of the turn now for this viewer, free of React for its tests. */
export function combatAlerts(input: {
  view: Pick<RoomState, "tokens" | "characters" | "encounter" | "meta" | "log">;
  you: You;
  participants: readonly Participant[];
  uses: readonly (readonly LimitedUse[] | null)[];
  /** How many attacks each lists, null while its rolls load. Left out, none do. */
  attacks?: readonly (number | null)[];
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
    const attacks = input.attacks?.[i] ?? 0;
    // A card whose attacks still load keeps its place, so it never goes and comes back as the rolls table lands.
    const attacksWait = input.attacks !== undefined && input.attacks[i] === null && input.loading;
    if (count > 0 || skipped || attacks > 0 || attacksWait || (uses === null && (input.loading || input.failed))) blocks.push({ participant: p, uses, count, attacks });
  });
  const encounter = view.encounter;
  if (blocks.length > 0 && encounter?.activeEntryId) {
    const id = turnId(encounter.activeEntryId, encounter.round);
    if (!dismissed.has(id)) {
      const landing = input.participants.find((p) => p.landing);
      const entry = encounter.entries.find((e) => e.id === encounter.activeEntryId);
      const name = landing?.name ?? (entry ? entryName(view, entry) : "This");
      const since = turnSince(view, input.participants) ?? Number.POSITIVE_INFINITY;
      out.turn = { id, name, blocks, count: blocks.reduce((n, b) => n + b.count, 0), attacks: blocks.reduce((n, b) => n + b.attacks, 0), since, loading: input.loading, failed: input.failed };
    }
  }
  return out;
}
