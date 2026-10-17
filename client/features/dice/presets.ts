import type { D20Test } from "#shared/dice/bonus.ts";
import type { Actor } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { findEntryFor } from "#shared/rules/durations.ts";
import { reminderPreset, type RollPreset } from "#shared/rules/rollReminders.ts";
import { creatureRolls, type CreatureRolls, type DiceView } from "./creature.ts";

/**
 * The preset every d20 roll in the app takes (docs/design-v1-roll-options.md
 * 3.2): the option buttons, doc 4's card and live card, the group save's
 * rows, the save-ends and concentration cards, death saves, and initiative,
 * single, from the tracker and auto. Each reads it here, at the tap, from
 * the creature's effects in the viewer's view and its Magic Resistance then,
 * and combines its sources with its own once, as it builds the op
 * (docs/design-v1-dice.md 3.3).
 */

function actorOf(dice: DiceView, creature: ActorTarget): Actor | undefined {
  const state = dice.view;
  if ("characterId" in creature) return state.characters[creature.characterId]?.actor;
  const token = state.tokens[creature.tokenId];
  if (!token) return undefined;
  return "inline" in token.actor ? token.actor.inline : state.characters[token.actor.ref]?.actor;
}

/**
 * A creature's preset for one test. `rolls` saves reading the creature
 * again where the caller has it. While the block that says whether it has
 * Magic Resistance is still loading, it has none, so a surface that rolls
 * against a spell waits for creatureRolls first. On initiative, the DM's
 * mark on the creature's tracker row replaces the tracker's hint.
 */
export function presetFor(dice: DiceView, creature: ActorTarget, test: D20Test, ctx: { rolls?: CreatureRolls | null } = {}): RollPreset {
  const rolls = ctx.rolls !== undefined ? ctx.rolls : creatureRolls(dice, creature);
  const mark = test.kind === "initiative" ? findEntryFor(dice.view, creature)?.advantage : undefined;
  return reminderPreset(actorOf(dice, creature)?.effects ?? [], test, { magicResistance: rolls?.magicResistance ?? false, ...(mark ? { mark } : {}) });
}
