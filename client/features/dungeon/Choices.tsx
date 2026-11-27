import { useId, type ReactNode } from "react";
import type { PartyGroup } from "#shared/model.ts";
import { LEVEL_BANDS, type LevelBand } from "#shared/srd/traps.ts";
import { DIFFICULTIES, type Difficulty } from "#shared/srd/xp-budget.ts";
import { DIFFICULTY_LABEL, partyBudgets } from "../encounters/budget.ts";
import { Button } from "../../components/Button.tsx";
import { Input } from "../../components/Field.tsx";
import { Held } from "../../components/Held.tsx";
import { Help } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { Switch } from "../../components/Switch.tsx";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { copyText } from "../../lib/clipboard.ts";
import { theme } from "../../lib/theme.ts";
import { NumberInput } from "../scenes/controls.tsx";
import { BAND_NAMES } from "../traps/rules.ts";
import { PresetSlider, type Preset } from "./PresetSlider.tsx";
import { formatSeed, parseSeed, type Seed } from "./seed.ts";
import {
  CHOICE_NAMES,
  clampRooms,
  DRESSINGS,
  HEIGHT_PRESETS,
  HEIGHTS_MAX,
  HEIGHTS_STEP,
  isHexGrid,
  LIT_MAX,
  LIT_PRESETS,
  LIT_STEP,
  MIN_ROOMS,
  MONSTER_PRESETS,
  MONSTERS_MAX,
  MONSTERS_STEP,
  roomCap,
  SECRET_PRESETS,
  SECRETS_MAX,
  THEMES,
  TRAP_PRESETS,
  TRAPS_MAX,
  type DungeonSettings,
  type GridKind,
  type StockChoices,
} from "./settings.ts";
import {
  DEAD_ENDS_HELP,
  DENSITY_HELP,
  difficultyHelp,
  DRESSING_HELP,
  HEIGHTS_HELP,
  heightsWords,
  HEX_THEME_NOTE,
  KEY_FULL,
  KEY_HELP,
  LIT_HELP,
  litWords,
  LOOPS_HELP,
  MONSTERS_HELD,
  MONSTERS_HELP,
  MONSTERS_THEME,
  monstersWords,
  NO_ROOM_FOR_MONSTERS,
  overLimitLine,
  PARTY_LEVEL_HELP,
  roomsHint,
  SECRETS_CAVE,
  SECRETS_HELP,
  secretsWords,
  SEED_BAD,
  SEED_HELP,
  SEED_HELP_STOCKED,
  SEED_OTHER_VERSION,
  THEME_HELP,
  TRAPS_HELP,
  trapsWords,
  WIDE_HELP,
  WIDE_HELP_HEX,
  WING_FLAT,
} from "./words.ts";

/*
 * The generator's choice rows (docs/design: dungeon generator phase 3, 3.3,
 * D-261110-239), shared by the Generate a dungeon dialog and the wing pane,
 * so both speak the same words and neither copies the other. The rows
 * read and write `DungeonSettings` alone: the dialog's Size row, its light
 * line and its seed come in through the optional slots, and the pane
 * leaves what it has no use for. The seam the wing pane builds on is the
 * five props it passes (`value`, `onChange`, `held`, `grid`, `wing`).
 */

const HEIGHT_MARKS: readonly Preset[] = Object.entries(HEIGHT_PRESETS).map(([label, value]) => ({ label, value }));
const TRAP_MARKS: readonly Preset[] = Object.entries(TRAP_PRESETS).map(([label, value]) => ({ label, value }));
const SECRET_MARKS: readonly Preset[] = Object.entries(SECRET_PRESETS).map(([label, value]) => ({ label, value }));
const LIT_MARKS: readonly Preset[] = Object.entries(LIT_PRESETS).map(([label, value]) => ({ label, value }));
const MONSTER_MARKS: readonly Preset[] = Object.entries(MONSTER_PRESETS).map(([label, value]) => ({ label, value }));

/**
 * The Monsters rows (docs/design/design-v1-dungeon-stock.md 1): the
 * choices, which sit beside the settings, the party they budget for, and
 * whether Monsters is held at None for a party with no level. `party` is
 * the party editor, and `below` what stands under the rows: the list's
 * load failing, and the creature limit.
 */
export type StockRow = {
  value: StockChoices;
  onChange(next: StockChoices): void;
  held: boolean;
  /** The party is the dialog's own edit, so its rows stay while it is edited, Monsters at None too. */
  edited: boolean;
  groups: readonly PartyGroup[];
  party: ReactNode;
  below?: ReactNode;
};

/** The Party level row while it follows the party (D-261127-219, 229): held, with where its band came from. */
export type BandRow = { held: boolean; lines: readonly string[] };

/** The seed row: the text as typed, and what stands under it while edits stand (the edits line). */
export type SeedRow = { text: string; onChange(text: string): void; below?: ReactNode };

export type ChoicesProps = {
  value: DungeonSettings;
  onChange(next: DungeonSettings): void;
  /** Every row held, as while Make or Add the wing sends. */
  held: boolean;
  grid: GridKind;
  /** The rows speak of a wing's area rather than a map's size. */
  wing: boolean;
  /** The dialog's Size row, under Theme. */
  size?: ReactNode;
  /** Under Lit rooms while it is above None: the dialog's light line. */
  light?: ReactNode;
  /** The journal has no room for a key: DM key reads off and is held. */
  keyHeld?: boolean;
  /** A wing on a scene whose stairs make no walls is flat (3.2, D-261110-235): Heights is held at Flat with its line. */
  flat?: boolean;
  /** The seed row, last. Left out, there is none. */
  seed?: SeedRow;
  /** The Monsters rows, after Dressing. Left out, there are none. */
  stock?: StockRow;
  /** The Party level row's hold while it follows the party. */
  band?: BandRow;
};

/** The most rooms the rows offer: the size's cap, and on hexes at most MAX_HEX_ROOMS (2.5). */
export function roomsLimit(value: Pick<DungeonSettings, "w" | "h">, grid: GridKind): number {
  return roomCap(value.w, value.h, grid);
}

export function Choices(props: ChoicesProps) {
  const { value, grid } = props;
  const set = (patch: Partial<DungeonSettings>) => props.onChange({ ...value, ...patch });
  const hex = isHexGrid(grid);
  const cave = value.theme === "cave";
  const limit = roomsLimit(value, grid);
  const rooms = clampRooms(value.rooms, value.w, value.h, grid);
  const flat = props.flat === true;
  const keyHeld = props.keyHeld === true;
  return (
    <div data-dungeon-choices="" style={{ display: "grid", gap: theme.space(4), minWidth: 0 }}>
      {/* Held while Make sends and once a scene exists, so no choice draws a preview Make can no longer send. */}
      <Held held={props.held} style={{ display: "grid", gap: theme.space(4), minWidth: 0 }}>
        <div data-choice="theme">
          <Choice<DungeonSettings["theme"]>
            name="Theme"
            value={value.theme}
            onChange={(theme) => set({ theme })}
            options={THEMES.map((v) => ({ value: v, label: CHOICE_NAMES.theme[v] }))}
            help={THEME_HELP[value.theme]}
          >
            {hex ? <Help>{HEX_THEME_NOTE}</Help> : null}
          </Choice>
        </div>
        {props.size}
        <Named name="Rooms" help={roomsHint(limit, props.wing)}>
          {(nameId, helpId) => (
            <div role="group" aria-labelledby={nameId} aria-describedby={helpId}>
              <NumberInput label="Rooms" value={rooms} min={MIN_ROOMS} max={limit} onChange={(rooms) => set({ rooms })} />
            </div>
          )}
        </Named>
        <Choice<DungeonSettings["density"]>
          name="Density"
          value={value.density}
          onChange={(density) => set({ density })}
          options={[
            { value: "sparse", label: "Sparse" },
            { value: "normal", label: "Normal" },
            { value: "dense", label: "Dense" },
          ]}
          help={DENSITY_HELP}
        />
        <Choice<DungeonSettings["corridors"]>
          name="Corridors"
          value={value.corridors}
          onChange={(corridors) => set({ corridors })}
          options={[
            { value: "straight", label: "Straight" },
            { value: "bending", label: "Bending" },
            { value: "winding", label: "Winding" },
          ]}
        />
        <Choice<"narrow" | "wide">
          name="Corridor width"
          value={value.wide ? "wide" : "narrow"}
          onChange={(v) => set({ wide: v === "wide" })}
          options={[
            { value: "narrow", label: "Narrow" },
            { value: "wide", label: "Wide" },
          ]}
          help={hex ? WIDE_HELP_HEX : WIDE_HELP}
        />
        <Switch label="Extra ways around" help={LOOPS_HELP} checked={value.loops} onChange={(loops) => set({ loops })} />
        <Switch label="Dead ends" help={DEAD_ENDS_HELP} checked={value.deadEnds} onChange={(deadEnds) => set({ deadEnds })} />
        {/* A flat wing keeps the DM's own pick, which comes back on a scene whose stairs make walls. */}
        <Held held={flat} style={{ display: "grid", minWidth: 0 }}>
          <PresetSlider
            name="Heights"
            value={flat ? 0 : value.heights}
            min={0}
            max={HEIGHTS_MAX}
            step={HEIGHTS_STEP}
            presets={HEIGHT_MARKS}
            words={heightsWords(flat ? 0 : value.heights, rooms)}
            help={flat ? WING_FLAT : HEIGHTS_HELP}
            onChange={(heights) => set({ heights })}
          />
        </Held>
        <PresetSlider
          name="Traps"
          value={value.traps}
          min={0}
          max={TRAPS_MAX}
          step={1}
          presets={TRAP_MARKS}
          words={trapsWords(value.traps, rooms)}
          help={value.traps === 0 ? undefined : TRAPS_HELP}
          onChange={(traps) => set({ traps })}
        />
        {value.traps === 0 ? null : (
          // While Monsters is on, the band is the party's, so the traps and the fights are for one party (D-261127-217).
          <Held held={props.band?.held === true} style={{ display: "grid", minWidth: 0 }}>
            <Choice<LevelBand>
              name="Party level"
              value={value.band}
              onChange={(band) => set({ band })}
              options={LEVEL_BANDS.map((b) => ({ value: b, label: BAND_NAMES[b].replace("Levels ", ""), title: BAND_NAMES[b] }))}
              help={PARTY_LEVEL_HELP}
            >
              {props.band?.held ? props.band.lines.map((line) => <Help key={line}>{line}</Help>) : null}
            </Choice>
          </Held>
        )}
        {/* Caves have no doors. The DM's own pick stays in the choices and comes back with the next theme. */}
        <Held held={cave} style={{ display: "grid", minWidth: 0 }}>
          <PresetSlider
            name="Secret doors"
            value={cave ? 0 : value.secrets}
            min={0}
            max={SECRETS_MAX}
            step={1}
            presets={SECRET_MARKS}
            words={secretsWords(cave ? 0 : value.secrets, rooms)}
            help={cave ? SECRETS_CAVE : value.secrets === 0 ? undefined : SECRETS_HELP}
            onChange={(secrets) => set({ secrets })}
          />
        </Held>
        <PresetSlider
          name="Lit rooms"
          value={value.lit}
          min={0}
          max={LIT_MAX}
          step={LIT_STEP}
          presets={LIT_MARKS}
          words={litWords(value.lit, rooms)}
          help={LIT_HELP[value.theme]}
          onChange={(lit) => set({ lit })}
        />
        {value.lit > 0 ? props.light : null}
        <Choice<DungeonSettings["dressing"]>
          name="Dressing"
          value={value.dressing}
          onChange={(dressing) => set({ dressing })}
          options={DRESSINGS.map((v) => ({ value: v, label: CHOICE_NAMES.dressing[v] }))}
          help={DRESSING_HELP}
        />
        {props.stock ? <StockRows row={props.stock} theme={value.theme} rooms={rooms} /> : null}
        <Switch label="DM key" help={keyHeld ? KEY_FULL : KEY_HELP} checked={value.key && !keyHeld} disabled={keyHeld} onChange={(key) => set({ key })} />
      </Held>
      {props.seed ? <SeedField row={props.seed} disabled={props.held} stocked={props.stock !== undefined && !props.stock.held && props.stock.value.monsters > 0} /> : null}
    </div>
  );
}

export default Choices;

/** The creature limit's words: the count past it, else whether the scene had no room for creatures within it (`full`), else none. */
export function limitWords(over: number, full = false): string {
  return over > 0 ? overLimitLine(over) : full ? NO_ROOM_FOR_MONSTERS : "";
}

/**
 * The creature limit's line (D-261127-280). Its polite live region always
 * stands, out of the layout, so a screen reader hears the count as edits
 * move it without an alert's interruption, and the line shows only past
 * the limit, or on a wing whose creatures found no room (`full`,
 * D-261127-602), so otherwise the rows keep their spacing.
 */
export function LimitLine(props: { over: number; full?: boolean }) {
  const line = limitWords(props.over, props.full);
  return (
    <>
      <span aria-live="polite" style={VISUALLY_HIDDEN}>
        {line}
      </span>
      {line ? (
        <p aria-hidden data-stock-limit="" style={{ margin: 0, color: theme.color.dangerText, fontSize: theme.font.body14, lineHeight: theme.leading.body }}>
          {line}
        </p>
      ) : null}
    </>
  );
}

/**
 * Monsters, its help and the theme's line, then Difficulty with the live
 * budget and the party. Held at None while the party has no level, the
 * DM's pick kept, with the party below to give it one.
 */
function StockRows(props: { row: StockRow; theme: DungeonSettings["theme"]; rooms: number }) {
  const { row } = props;
  const share = row.held ? 0 : row.value.monsters;
  const setStock = (patch: Partial<StockChoices>) => row.onChange({ ...row.value, ...patch });
  const budgets = partyBudgets(row.groups);
  return (
    <div data-choice="monsters" style={{ display: "grid", gap: theme.space(4), minWidth: 0 }}>
      <Held held={row.held} style={{ display: "grid", minWidth: 0 }}>
        <PresetSlider
          name="Monsters"
          value={share}
          min={0}
          max={MONSTERS_MAX}
          step={MONSTERS_STEP}
          presets={MONSTER_MARKS}
          words={monstersWords(share, props.rooms)}
          help={row.held ? MONSTERS_HELD : share === 0 ? undefined : `${MONSTERS_HELP} ${MONSTERS_THEME[props.theme]}`}
          onChange={(monsters) => setStock({ monsters })}
        />
      </Held>
      {share > 0 ? (
        <Choice<Difficulty>
          name="Difficulty"
          value={row.value.difficulty}
          onChange={(difficulty) => setStock({ difficulty })}
          options={DIFFICULTIES.map((d) => ({ value: d, label: DIFFICULTY_LABEL[d] }))}
          help={difficultyHelp(row.value.difficulty, budgets[row.value.difficulty], row.groups)}
        />
      ) : null}
      {/* An edited party stays, so Edit the party at None, where a held Monsters comes back, never pulls the steppers away from focus. */}
      {share > 0 || row.held || row.edited ? (
        <Named name="Party">
          {() => <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2), minWidth: 0 }}>{row.party}</div>}
        </Named>
      ) : null}
      {row.below}
    </div>
  );
}

const NAME_STYLE = { fontSize: theme.font.body14, fontWeight: theme.weight.strong } as const;

/** A name over a control the caller builds, with its help under it. */
export function Named(props: { name: string; help?: ReactNode; children: (nameId: string, helpId: string | undefined) => ReactNode }) {
  const nameId = useId();
  const helpId = useId();
  return (
    <div style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>
      <span id={nameId} style={NAME_STYLE}>
        {props.name}
      </span>
      {props.children(nameId, props.help ? helpId : undefined)}
      {props.help ? <Help id={helpId}>{props.help}</Help> : null}
    </div>
  );
}

/** A named choice with its help under it, the group named by the visible name. */
export function Choice<T extends string>(props: {
  name: string;
  value: T;
  options: readonly { value: T; label: string; title?: string; disabled?: boolean }[];
  onChange(value: NoInfer<T>): void;
  help?: ReactNode;
  children?: ReactNode;
}) {
  const nameId = useId();
  return (
    <div style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>
      <span id={nameId} style={NAME_STYLE}>
        {props.name}
      </span>
      <Segmented<T> labelledBy={nameId} value={props.value} options={props.options} onChange={props.onChange} description={props.help} />
      {props.children}
    </div>
  );
}

/** The seed's field. Copy seed copies the seed as read, in its usual form, whatever spacing or case was typed. */
function SeedField(props: { row: SeedRow; disabled: boolean; stocked: boolean }) {
  const id = useId();
  const hintId = useId();
  const parsed = parseSeed(props.row.text);
  const seed: Seed | null = parsed.ok ? parsed.seed : null;
  const error = parsed.ok ? null : SEED_BAD;
  const note = parsed.ok && parsed.otherVersion ? SEED_OTHER_VERSION : props.stocked ? SEED_HELP_STOCKED : SEED_HELP;
  const copy = () => {
    if (seed !== null) void copyText(formatSeed(seed));
  };
  return (
    <div style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>
      <label htmlFor={id} style={NAME_STYLE}>
        Seed
      </label>
      <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
        <Input
          id={id}
          value={props.row.text}
          error={!!error}
          disabled={props.disabled}
          maxLength={40}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={hintId}
          onChange={(e) => props.row.onChange(e.target.value)}
          style={{ flex: "1 1 12em", minWidth: 0, fontFamily: theme.font.mono }}
        />
        <Button onClick={copy} disabled={seed === null}>
          Copy seed
        </Button>
      </div>
      {error ? (
        <div id={hintId} role="alert" style={{ fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.dangerText }}>
          {error}
        </div>
      ) : (
        <Help id={hintId}>{note}</Help>
      )}
      {props.row.below}
    </div>
  );
}
