import { advantageFields, applyMode, parseFormula, type AdvantageSource } from "#shared/dice/formula.ts";

/** An invocation value. Never store this in panel choices or card chips. */
export type RollModeOverride = "adv" | "dis" | "secret" | "normal";
export type RollVisibility = "selectable" | "request" | "creature" | "repeat";
export type RollModeCapability = { d20: boolean; visibility: RollVisibility; damage?: boolean; batch?: boolean; repeat?: boolean };
export const NORMAL_HELP = "Ignore manual modes for this roll. Creature effects and default visibility still apply.";
export const REPEAT_HELP = "Repeats the recorded formula with your chosen mode. Current effects are not rebuilt.";
export const BATCH_HELP = "Applies to server rolls only. Players choose their own modes.";
export const FIXED_VISIBILITY = {
  request: "Request answers keep the request's visibility.",
  creature: "This roll's visibility is set by the creature.",
  repeat: "This repeat keeps its recorded visibility.",
} as const;

export function acceptsRollMode(formula: string): boolean {
  const parsed = parseFormula(formula);
  return parsed.ok && applyMode(parsed.formula, "adv").ok;
}

export function hasRollModeMenu(capability: RollModeCapability): boolean {
  return (capability.d20 && !capability.damage) || capability.visibility === "selectable";
}

/** Manual sources are separate so presets with several opposing sources resolve only once. */
export function rollModeSources(preset: readonly AdvantageSource[], manual: readonly AdvantageSource[], override?: RollModeOverride): AdvantageSource[] {
  return [...preset, ...(override === "normal" ? [] : override === "adv" || override === "dis" ? [{ kind: override, from: "roll-menu" }] : manual)];
}

/** A formula's words and the panel's presses are manual. All other sources are creature presets. */
export function overrideRollSources(sources: readonly AdvantageSource[], manual: readonly AdvantageSource[], override?: RollModeOverride): AdvantageSource[] {
  const preset = sources.filter((s) => s.from !== "typed" && s.from !== "pressed");
  const words = sources.filter((s) => s.from === "typed" || s.from === "pressed");
  return rollModeSources(preset, [...words, ...manual], override);
}

export function rollModeTo(ordinary: "all" | "dm", baseline: "all" | "dm", override?: RollModeOverride): "all" | "dm" {
  return override === "normal" ? baseline : override === "secret" ? "dm" : ordinary;
}

export type RollModeItem = { id: RollModeOverride; title: string; kind: "action"; disabled?: boolean; description?: string };
export function rollModeItems(capability: RollModeCapability, dm: boolean): RollModeItem[] {
  if (!hasRollModeMenu(capability)) return [];
  const items: RollModeItem[] = [];
  if (capability.d20 && !capability.damage) items.push({ id: "adv", title: "Roll with Advantage", kind: "action" }, { id: "dis", title: "Roll with Disadvantage", kind: "action" });
  items.push({ id: "secret", title: "Roll secretly", kind: "action", disabled: capability.visibility !== "selectable", description: capability.visibility === "selectable" ? dm ? "Hide the dice from players." : "You and the DM see the result." : FIXED_VISIBILITY[capability.visibility] });
  items.push({ id: "normal", title: "Roll normally", kind: "action", description: capability.repeat ? "Ignore the recorded mode. Formula and visibility stay." : NORMAL_HELP });
  return items;
}

export function rollModeHint(capability: RollModeCapability): string | undefined {
  if (!hasRollModeMenu(capability)) return undefined;
  const choices = [...(capability.d20 && !capability.damage ? ["Advantage", "Disadvantage"] : []), ...(capability.visibility === "selectable" ? ["Secret"] : []), "Normal"];
  return `Hold, right-click or Shift+F10 for ${choices.slice(0, -1).join(", ")} or Normal.`;
}

/** Effective words come from returned dice, never the picked item. */
export function effectiveRollMode(roll: { formula: string; mode?: "adv" | "dis"; cancelled?: boolean }, secret = false): string {
  const mode = roll.mode === "adv" ? "Advantage" : roll.mode === "dis" ? "Disadvantage" : roll.cancelled ? "Normal: Advantage and Disadvantage cancelled" : acceptsRollMode(roll.formula) ? "Normal" : "";
  return [mode, secret ? "Secret" : ""].filter(Boolean).join(", ");
}

export const resolveRollMode = (preset: readonly AdvantageSource[], manual: readonly AdvantageSource[], override?: RollModeOverride) => advantageFields(rollModeSources(preset, manual, override));
