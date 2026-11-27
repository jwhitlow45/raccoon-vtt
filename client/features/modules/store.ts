import { setting } from "../device/settings.ts";
import { modulesFor, moduleById, needsOf, simpleFor, isModuleId, type ModuleId, type Role } from "./registry.ts";

/**
 * This device's choices of which parts show (docs/design/design-v1-features.md 9):
 * one `rvtt.features` key in local storage, per role and for every room,
 * a co-DM's as the DM's (D-261127-113). Only changed choices are stored,
 * so a part added later takes its registry default, and ids this build
 * does not know are kept for a build that does (D-261127-114).
 *
 * Only client/features/modules/ reads this file or the key: a source scan
 * (modules.scan.test.ts) holds every other reader to the gate, which knows
 * a part's needs, the preview and the table display.
 */

export const FEATURES_KEY = "rvtt.features";

/** The old Roll animation key, read once for the migration and never written again, so an older build reads what it read (D-261127-301, 310). */
const OLD_ROLL_ANIMATION_KEY = "rvtt.rollAnimation";

/** One role's changed choices: false hides the part, true shows it. */
export type RoleChoices = Readonly<Record<string, boolean>>;

export type FeatureChoices = { readonly dm: RoleChoices; readonly player: RoleChoices };

export const NO_CHOICES: FeatureChoices = Object.freeze({ dm: Object.freeze({}), player: Object.freeze({}) });

export type Preset = "everything" | "simple";

const ID = /^[a-z][a-zA-Z0-9]{0,31}$/;
export const MAX_CHOICES_PER_ROLE = 64;

function parseRole(raw: unknown): RoleChoices {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  let n = 0;
  for (const [id, value] of Object.entries(raw)) {
    if (n >= MAX_CHOICES_PER_ROLE) break;
    if (!ID.test(id) || typeof value !== "boolean") continue;
    out[id] = value;
    n++;
  }
  return out;
}

/** The stored choices, or none for a missing or malformed value. */
export function parseFeatures(raw: string | null): FeatureChoices {
  if (raw === null) return NO_CHOICES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NO_CHOICES;
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { v?: unknown }).v !== 1) return NO_CHOICES;
  const { dm, player } = parsed as { dm?: unknown; player?: unknown };
  return { dm: parseRole(dm), player: parseRole(player) };
}

export function formatFeatures(choices: FeatureChoices): string {
  return JSON.stringify({ v: 1, dm: choices.dm, player: choices.player });
}

/** A part's registry default for a role. A part the role lacks, or one this build does not know, shows. */
export function defaultShown(id: string, role: Role): boolean {
  return isModuleId(id) ? (moduleById(id).roles[role]?.shown ?? true) : true;
}

/** The role's own choice for a part, its default where none is stored. */
export function ownShown(choices: FeatureChoices, role: Role, id: ModuleId): boolean {
  return choices[role][id] ?? defaultShown(id, role);
}

function withRole(choices: FeatureChoices, role: Role, next: RoleChoices): FeatureChoices {
  return role === "dm" ? { dm: next, player: choices.player } : { dm: choices.dm, player: next };
}

/** One switch: the part's own choice, stored only while it differs from the default. A dependent's own choice stays (D-261127-308). */
export function withChoice(choices: FeatureChoices, role: Role, id: ModuleId, shown: boolean): FeatureChoices {
  const { [id]: _was, ...rest } = choices[role];
  return withRole(choices, role, shown === defaultShown(id, role) ? rest : { ...rest, [id]: shown });
}

/** A Show: the part and every part it needs turn on (D-261127-308). */
export function withShow(choices: FeatureChoices, role: Role, id: ModuleId): FeatureChoices {
  let next = withChoice(choices, role, id, true);
  for (const need of needsOf(id)) next = withChoice(next, role, need, true);
  return next;
}

/** A preset for one role: every part shows, or only what Simple keeps. It sets the role's whole list, ids this build does not know included, since Everything means every part. */
export function withPreset(choices: FeatureChoices, role: Role, preset: Preset): FeatureChoices {
  const keeps = simpleFor(role);
  const next: Record<string, boolean> = {};
  if (preset === "simple") {
    for (const m of modulesFor(role)) if (!keeps.has(m.id) && defaultShown(m.id, role)) next[m.id] = false;
  }
  return withRole(choices, role, next);
}

/**
 * The migration (section 9): a device whose Roll animation was off, with
 * no choices stored yet, starts with Dice animation hidden for both roles,
 * which is the same behavior. Run once, when the key is first missing.
 */
export function migratedChoices(features: string | null, rollAnimation: string | null): FeatureChoices | null {
  if (features !== null || rollAnimation !== "off") return null;
  return { dm: { diceAnimation: false }, player: { diceAnimation: false } };
}

function read(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

const featuresSetting = setting(FEATURES_KEY, parseFeatures, formatFeatures);

{
  const migrated = migratedChoices(read(FEATURES_KEY), read(OLD_ROLL_ANIMATION_KEY));
  if (migrated) featuresSetting.set(migrated);
}

/** This device's choices now. */
export const featureChoices = featuresSetting.get;
/** The choices, followed: a change here or in another window renders again. */
export const useFeatureChoices = featuresSetting.use;
export const subscribeFeatureChoices = featuresSetting.subscribe;

export function setModuleShown(id: ModuleId, role: Role, shown: boolean): void {
  featuresSetting.set(withChoice(featureChoices(), role, id, shown));
}

/** A way back's Show: the part and what it needs. */
export function showModule(id: ModuleId, role: Role): void {
  featuresSetting.set(withShow(featureChoices(), role, id));
}

export function applyPreset(role: Role, preset: Preset): void {
  featuresSetting.set(withPreset(featureChoices(), role, preset));
}

/** Reset all: every part shows again on this device, for the DM and for players. */
export function resetAllFeatures(): void {
  featuresSetting.set(NO_CHOICES);
}

/**
 * Another window of the app that changes a choice writes storage, and the
 * browser tells this one with a `storage` event, so its parts hide or show
 * at once (section 5, Effect). A cleared storage puts every default back.
 */
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.key === FEATURES_KEY || event.key === null) featuresSetting.adopt(event.key === null ? null : event.newValue);
  });
}
