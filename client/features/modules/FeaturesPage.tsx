import { useId, useState, type ReactNode } from "react";
import { Icon } from "../../components/Icon.tsx";
import { Input } from "../../components/Field.tsx";
import { Group, Help } from "../../components/Panel.tsx";
import { RadioCards } from "../../components/RadioCards.tsx";
import { Row } from "../../components/Row.tsx";
import { Switch } from "../../components/Switch.tsx";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { featuresFoldsSlot, useFolds, type FeaturesSection } from "../../lib/folds.ts";
import { theme } from "../../lib/theme.ts";
import { ConfirmButton } from "../scenes/controls.tsx";
import { hiddenModules, moduleShown, presetOf, unmetNeeds } from "./gate.ts";
import { useFeaturesHere } from "./Gate.tsx";
import { CORE_PARTS, helpFor, MODULE_GROUPS, modulesFor, moduleById, type ModuleDef, type ModuleId, type Role } from "./registry.ts";
import { applyPreset, resetAllFeatures, setModuleShown, showModule, useFeatureChoices, type FeatureChoices, type Preset } from "./store.ts";

/*
 * Menu, This device, Features (docs/design/design-v1-features.md 5): the
 * parts of the app this device may hide, for the role it has in the room,
 * each with its switch, two presets to start from, a search over the
 * parts, the list of what always shows and Reset all. It writes this
 * device's choices alone (store.ts), so nothing here reaches the room.
 */

/** Each part's switch, by the room search's anchor (features/search/entry.ts), written whole so the catalog's scan pairs each with its "Show" result (modules/search.ts). */
export const SWITCH_ANCHORS: Readonly<Record<ModuleId, { search: string }>> = {
  spellSlots: { search: "menu.this-device.features.spell-slots" },
  hitDice: { search: "menu.this-device.features.hit-dice" },
  classResources: { search: "menu.this-device.features.class-resources" },
  companions: { search: "menu.this-device.features.companions" },
  ddb: { search: "menu.this-device.features.ddb" },
  ruler: { search: "menu.this-device.features.ruler" },
  areas: { search: "menu.this-device.features.areas" },
  draw: { search: "menu.this-device.features.draw" },
  ping: { search: "menu.this-device.features.ping" },
  pins: { search: "menu.this-device.features.pins" },
  traps: { search: "menu.this-device.features.traps" },
  opportunity: { search: "menu.this-device.features.opportunity" },
  builder: { search: "menu.this-device.features.builder" },
  dungeon: { search: "menu.this-device.features.dungeon" },
  floors: { search: "menu.this-device.features.floors" },
  sound: { search: "menu.this-device.features.sound" },
  time: { search: "menu.this-device.features.time" },
  journal: { search: "menu.this-device.features.journal" },
  encounters: { search: "menu.this-device.features.encounters" },
  outliner: { search: "menu.this-device.features.outliner" },
  tableDisplay: { search: "menu.this-device.features.table-display" },
  isometric: { search: "menu.this-device.features.isometric" },
  weather: { search: "menu.this-device.features.weather" },
  diceAnimation: { search: "menu.this-device.features.dice-animation" },
};

/** The page's words (section 5), here so the page's test reads them whole. */
export const FEATURES_WORDS = {
  rowHelp: "Hide the parts you don't use, on this device.",
  help: "Hide the parts of the app you don't use. Only this device changes. Everyone else, the game and its rules stay as they are.",
  role: { dm: "For your DM rooms on this device.", player: "For the rooms you play in on this device." },
  startFrom: "Start from",
  everything: "Everything",
  everythingHelp: "Every part shows.",
  simple: "Simple",
  simpleHelp: {
    dm: "The map, tokens, monsters, fog, dice and turns, with Ruler, Areas, Draw and Ping.",
    player: "Your character's HP, conditions and rolls, turns, Ruler and Ping, and what the DM shares.",
  },
  find: "Find a part",
  core: "Always shown",
  reset: "Reset all",
  resetConfirm: "Tap again to show every part, as the DM and as a player",
  resetHelp: "Shows every part again on this device, for the DM and for players.",
} as const;

/** "1 part" or "3 parts". */
export function partsWord(n: number): string {
  return `${n} part${n === 1 ? "" : "s"}`;
}

/** The Features row's value and the page's own choice line: the preset its parts match, else how many hide. */
export function featuresValue(role: Role, choices: FeatureChoices): string {
  const preset = presetOf(role, choices);
  if (preset === "everything") return FEATURES_WORDS.everything;
  if (preset === "simple") return FEATURES_WORDS.simple;
  return `${hiddenModules(role, choices).size} hidden`;
}

/** Neither preset matched: "Your own choice: 3 parts hidden." */
export function ownChoiceLine(role: Role, choices: FeatureChoices): string | null {
  return presetOf(role, choices) === null ? `Your own choice: ${partsWord(hiddenModules(role, choices).size)} hidden.` : null;
}

/** A switch's help: the part's own, or, while a part it needs is hidden, what turning it on shows too (D-261127-308). */
export function switchHelp(m: ModuleDef, role: Role, choices: FeatureChoices): string {
  const unmet = unmetNeeds(m.id, role, choices);
  if (unmet.length === 0) return helpFor(m, role);
  return `Turning it on shows ${unmet.map((n) => moduleById(n).name).join(" and ")} too.`;
}

/** A group's folded summary: "All shown" or "2 hidden". */
export function groupSummary(parts: readonly ModuleDef[], role: Role, choices: FeatureChoices): string {
  const hidden = parts.filter((m) => !moduleShown(m.id, role, choices)).length;
  return hidden === 0 ? "All shown" : `${hidden} hidden`;
}

/** The search's words for a part or a core name: lowercase, letters and digits, single spaces. */
function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The parts a search finds, by name, help and other names, in registry order. Empty words find every part. */
export function partsMatching(role: Role, query: string): ModuleDef[] {
  const q = plain(query);
  if (q === "") return modulesFor(role);
  return modulesFor(role).filter((m) => [m.name, helpFor(m, role), ...(m.names ?? [])].some((words) => plain(words).includes(q)));
}

/** A core part a search names, "The X-card always shows.", or null. A part's own name wins over a core one. */
export function coreMatching(query: string): string | null {
  const q = plain(query);
  if (q.length < 2) return null;
  for (const part of CORE_PARTS) {
    const name = part.names.find((n) => plain(n) === q || plain(n).startsWith(q));
    if (name) return `The ${name} always shows.`;
  }
  return null;
}

/**
 * Menu, This device's first row (section 5): Features, its help, what its
 * parts are now and a chevron. It opens the Features page, a subpage of
 * This device, whose Back comes back to it.
 */
export function FeaturesRow(props: { onOpen(): void }) {
  const { role } = useFeaturesHere();
  const choices = useFeatureChoices();
  return (
    <Row
      leading={<Icon name="hidden" style={{ color: theme.color.textMuted }} />}
      title="Features"
      detail={<span style={{ whiteSpace: "normal" }}>{FEATURES_WORDS.rowHelp}</span>}
      trailing={
        <>
          <span style={{ fontSize: theme.font.small, color: theme.color.textMuted, whiteSpace: "nowrap" }}>{featuresValue(role ?? "player", choices)}</span>
          <Icon name="chevronRight" style={{ color: theme.color.textMuted }} />
        </>
      }
      opener="menu-features"
      onClick={props.onOpen}
    />
  );
}

/**
 * This device's Roll animation switch, bound to the role's Dice animation
 * (D-261127-301, 310): the stored value behind it is the part's choice now,
 * and the old key is never written again.
 */
export function useDiceAnimationSwitch(): { on: boolean; set(on: boolean): void } {
  const { role } = useFeaturesHere();
  const choices = useFeatureChoices();
  const at = role ?? "player";
  return { on: moduleShown("diceAnimation", at, choices), set: (on) => (on ? showModule("diceAnimation", at) : setModuleShown("diceAnimation", at, false)) };
}

/** A part's switch: on shows it and every part it needs, off hides it alone, so a part that needs it keeps its own choice (D-261127-308). */
function PartSwitch(props: { part: ModuleDef; role: Role; choices: FeatureChoices }) {
  const { part, role, choices } = props;
  return (
    <Switch
      label={part.name}
      search={SWITCH_ANCHORS[part.id].search}
      help={switchHelp(part, role, choices)}
      checked={moduleShown(part.id, role, choices)}
      onChange={(on) => (on ? showModule(part.id, role) : setModuleShown(part.id, role, false))}
    />
  );
}

export default function FeaturesPage() {
  const { role: known } = useFeaturesHere();
  const role: Role = known ?? "player";
  const choices = useFeatureChoices();
  const fold = useFolds(featuresFoldsSlot);
  const [query, setQuery] = useState("");
  const findId = useId();
  const searching = plain(query) !== "";
  const found = new Set(partsMatching(role, query).map((m) => m.id));
  const core = searching ? coreMatching(query) : null;
  const preset = presetOf(role, choices);
  const groups = MODULE_GROUPS.map((g) => ({ ...g, parts: modulesFor(role).filter((m) => m.group === g.id) })).filter((g) => g.parts.length > 0);
  const shownGroups = searching ? groups.filter((g) => g.parts.some((m) => found.has(m.id))) : groups;
  // While a search runs, the groups it finds open for it alone, and the viewer's own folds come back once the field is empty.
  const groupFold = (id: FeaturesSection, summary: string) => (searching ? { summary } : { ...fold(id), summary });
  const said = searching ? (found.size > 0 ? partsWord(found.size) : core === null ? `No part matches "${query.trim()}".` : core) : "";
  return (
    <div style={{ display: "grid" }}>
      <div style={{ display: "grid", gap: theme.space(1), paddingBottom: theme.space(3) }}>
        <Help>{FEATURES_WORDS.help}</Help>
        <Help>{FEATURES_WORDS.role[role]}</Help>
      </div>
      <div style={{ paddingBottom: theme.space(3) }}>
        <RadioCards<Preset>
          legend={FEATURES_WORDS.startFrom}
          value={preset}
          options={[
            { value: "everything", label: FEATURES_WORDS.everything, help: FEATURES_WORDS.everythingHelp },
            { value: "simple", label: FEATURES_WORDS.simple, help: FEATURES_WORDS.simpleHelp[role] },
          ]}
          status={preset === null ? <Help>{ownChoiceLine(role, choices)}</Help> : undefined}
          onChange={(next) => applyPreset(role, next)}
        />
      </div>
      <div style={{ display: "grid", gap: theme.space(1), paddingBottom: theme.space(3) }}>
        <label htmlFor={findId} style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong }}>
          {FEATURES_WORDS.find}
        </label>
        <Input id={findId} type="search" enterKeyHint="search" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: "100%" }} />
        {/* How many parts the words find, said politely as they change, and shown where none or a core part is found. */}
        <p role="status" style={searching && found.size === 0 ? { margin: 0, fontSize: theme.font.small, color: theme.color.textMuted } : VISUALLY_HIDDEN}>
          {said}
        </p>
      </div>
      {shownGroups.map((g) => (
        <Group key={g.id} label={g.name} keep {...groupFold(g.id, groupSummary(g.parts, role, choices))}>
          {g.parts
            .filter((m) => !searching || found.has(m.id))
            .map((m) => (
              <PartSwitch key={m.id} part={m} role={role} choices={choices} />
            ))}
        </Group>
      ))}
      {searching ? null : (
        <Group label={FEATURES_WORDS.core} keep {...fold("core")}>
          <ul style={{ margin: 0, padding: `0 0 ${theme.space(2)}px`, listStyle: "none", display: "grid", gap: theme.space(2) }}>
            {CORE_PARTS.map((c) => (
              <li key={c.line} style={{ fontSize: theme.font.body14, lineHeight: theme.leading.body, color: theme.color.text }}>
                {c.line}
              </li>
            ))}
          </ul>
        </Group>
      )}
      <ResetAll />
    </div>
  );
}

/** Reset all (section 5, D-261127-116): both roles' choices go, after a second press. */
function ResetAll(): ReactNode {
  const helpId = useId();
  return (
    <div style={{ display: "grid", gap: theme.space(2), justifyItems: "start", paddingTop: theme.space(3), borderTop: `${theme.line.border}px solid ${theme.color.border}` }}>
      <Help id={helpId}>{FEATURES_WORDS.resetHelp}</Help>
      <ConfirmButton label={FEATURES_WORDS.reset} confirm={FEATURES_WORDS.resetConfirm} wrap onConfirm={resetAllFeatures} />
    </div>
  );
}
