import { CREATURE_HOMES, MODULES, modulesFor, moduleById, needsOf, simpleFor, type ClaimKind, type ConditionName, type Holder, type Home, type ModuleDef, type ModuleId, type Role } from "./registry.ts";
import { featureChoices, NO_CHOICES, ownShown, type FeatureChoices, type Preset } from "./store.ts";

/**
 * The one guard every entry point asks (docs/design/design-v1-features.md 8,
 * D-261127-125): whether a part shows for a role, and whether a registry
 * entry it claims does. Pure, and free of React and the room, so the
 * registries (features/panels.ts, features/tools.ts, state/shortcuts.ts,
 * the search index, the top bar's fit, the builder's modes) and the room
 * store call it. Gate.tsx holds the hooks and components.
 *
 * Every function takes the choices, defaulting to this device's, so a test
 * or the property can pass its own and a preview or a table display can
 * pass EVERYTHING (D-261127-126).
 */

/** No choices: every part shows. A "view as a player" preview and a table display use it. */
export const EVERYTHING: FeatureChoices = NO_CHOICES;

const hiddenCache = new WeakMap<FeatureChoices, Partial<Record<Role, ReadonlySet<ModuleId>>>>();

/**
 * The parts hidden for a role: each the role has whose own choice is off
 * or one of whose needs is hidden (D-261127-115). Own choices are kept, so
 * showing a need again shows a dependent that was left on.
 */
export function hiddenModules(role: Role, choices: FeatureChoices = featureChoices()): ReadonlySet<ModuleId> {
  const cached = hiddenCache.get(choices)?.[role];
  if (cached) return cached;
  const hidden = new Set<ModuleId>();
  for (const m of modulesFor(role)) {
    if (!ownShown(choices, role, m.id) || needsOf(m.id).some((n) => !ownShown(choices, role, n))) hidden.add(m.id);
  }
  hiddenCache.set(choices, { ...hiddenCache.get(choices), [role]: hidden });
  return hidden;
}

export function moduleShown(id: ModuleId, role: Role, choices: FeatureChoices = featureChoices()): boolean {
  return !hiddenModules(role, choices).has(id);
}

/** The parts `id` needs that are hidden now, which its Show turns on too (D-261127-308). */
export function unmetNeeds(id: ModuleId, role: Role, choices: FeatureChoices = featureChoices()): ModuleId[] {
  return needsOf(id).filter((n) => !ownShown(choices, role, n));
}

/** What a named condition is where the caller knows it. One left out does not hold, so its claims leave their entries shown. */
export type ClaimConditions = Partial<Record<ConditionName, boolean>>;

/** The part that claims a registry entry, and the condition it claims it under, or null for core. */
export function ownerOf(kind: ClaimKind, id: string): { module: ModuleId; when?: ConditionName } | null {
  for (const m of MODULES) {
    for (const c of m.claims) if (c.kind === kind && claimMatches(kind, c.id, id)) return { module: m.id, ...(c.when ? { when: c.when } : null) };
  }
  return null;
}

/** A search claim names a prefix of entry ids. Every other claim names its entry exactly. */
function claimMatches(kind: ClaimKind, claimed: string, id: string): boolean {
  return kind === "search" ? id.startsWith(claimed) : claimed === id;
}

/** Whether a registry entry shows for a role: no hidden part claims it, under a condition that holds. */
export function claimShown(kind: ClaimKind, id: string, role: Role, choices: FeatureChoices = featureChoices(), conditions: ClaimConditions = {}): boolean {
  const hidden = hiddenModules(role, choices);
  if (hidden.size === 0) return true;
  for (const m of MODULES) {
    if (!hidden.has(m.id)) continue;
    for (const c of m.claims) {
      if (c.kind !== kind || !claimMatches(kind, c.id, id)) continue;
      if (c.when === undefined || conditions[c.when] === true) return false;
    }
  }
  return true;
}

/**
 * Whether a tool shows for a role. `borrowed` is a tool serving another
 * part's draft while its own part is hidden, the Area tool aiming a trap's
 * rig (D-261127-303), which shows until that draft is saved or cancelled.
 */
export function toolShown(toolId: string, role: Role, choices: FeatureChoices = featureChoices(), borrowed = false): boolean {
  return borrowed || claimShown("tool", toolId, role, choices);
}

/** The search's key for an entry id: a creature's field `field:<holder>:<key>` reads as `field:<key>`, so one claim covers every creature. */
export function searchKey(entryId: string): string {
  if (!entryId.startsWith("field:")) return entryId;
  return `field:${entryId.slice(entryId.lastIndexOf(":") + 1)}`;
}

/**
 * The parts hidden at a home for a role, in registry order. On a creature
 * home a part is named only where the creature holds it (D-261127-391).
 */
export function hiddenAt(home: Home, role: Role, choices: FeatureChoices = featureChoices(), holder?: Holder): ModuleDef[] {
  const hidden = hiddenModules(role, choices);
  return modulesFor(role).filter((m) => {
    if (!hidden.has(m.id) || !m.roles[role]?.homes.includes(home)) return false;
    return !CREATURE_HOMES.has(home) || !m.holds || (holder !== undefined && m.holds(holder));
  });
}

/** "a", "a and b", "a, b and c". */
function listed(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** A way back's words: "Show Sound", or "Show Dungeon generator and Map builder" where a need is hidden too (D-261127-308). */
export function showLabel(id: ModuleId, role: Role, choices: FeatureChoices = featureChoices()): string {
  return `Show ${listed([moduleById(id).name, ...unmetNeeds(id, role, choices).map((n) => moduleById(n).name)])}`;
}

/** The preset the role's parts match now, or null for the viewer's own choice. */
export function presetOf(role: Role, choices: FeatureChoices = featureChoices()): Preset | null {
  const hidden = hiddenModules(role, choices);
  if (hidden.size === 0) return "everything";
  const keeps = simpleFor(role);
  const simple = modulesFor(role).filter((m) => !keeps.has(m.id));
  return simple.length === hidden.size && simple.every((m) => hidden.has(m.id)) ? "simple" : null;
}

/**
 * The mark a gated component spreads on its own root, so the markup test
 * and the e2e probes find the part's controls (D-261127-399, 424). `<Module>`
 * puts it on a single DOM child itself.
 */
export function partMark(id: ModuleId): { "data-part": ModuleId } {
  return { "data-part": id };
}
