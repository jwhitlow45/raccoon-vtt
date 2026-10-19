import { useState, type ReactNode } from "react";
import type { Actor } from "#shared/model.ts";
import type { ActorPatch } from "#shared/protocol.ts";
import { Switch } from "../../components/Switch.tsx";
import { theme } from "../../lib/theme.ts";
import { validSheetUrl } from "./statSummary.ts";
import { FieldRow, Note, NumberField, Section, Stepper, TextField } from "./ui.tsx";

/**
 * The light stat card (features section 15): AC, speeds, initiative,
 * passive Perception, senses, creature type and notes, plus the DM's
 * fields. It is not a character sheet: the D&D Beyond link is for that.
 *
 * Fields the viewer may not change show as text. Fields the projection did
 * not send are left out entirely.
 */

type Speeds = Actor["speeds"];
const SPEED_KEYS = ["walk", "fly", "swim", "climb", "burrow"] as const;
type SpeedKey = (typeof SPEED_KEYS)[number];
type OtherSpeed = Exclude<SpeedKey, "walk">;
const OTHER_SPEEDS: readonly OtherSpeed[] = ["fly", "swim", "climb", "burrow"];
const SPEED_LABELS: Record<SpeedKey, string> = { walk: "Walk", fly: "Fly", swim: "Swim", climb: "Climb", burrow: "Burrow" };

/**
 * Which speeds stand in "Other speeds" (docs/design-v1-look-pass.md 3.1):
 * every one not set, so a walker's Stats shows Walk alone rather than four
 * rows of "none". `held` is what the fold held as it opened, kept while it
 * stays open, so a speed typed there stays under the field's own label
 * rather than jumping out of the fold, and taking focus with it, once it
 * is set. Null while it is folded.
 */
export function foldedSpeeds(speeds: Speeds, held: readonly OtherSpeed[] | null): readonly OtherSpeed[] {
  return held ?? OTHER_SPEEDS.filter((key) => speeds[key] === undefined);
}

export { validSheetUrl } from "./statSummary.ts";

/** The card's notes, which the DM and the card's owners read: a field where the viewer may write them, else the text. */
export function CardNotesField(props: { actor: Partial<Actor>; editable: boolean; onPatch(patch: ActorPatch): void; label?: string; rows?: number }) {
  if (props.editable) {
    return (
      <TextField
        label={props.label ?? "Notes"}
        multiline
        rows={props.rows}
        value={props.actor.notes ?? ""}
        maxLength={4000}
        placeholder="Notes everyone with this card can read"
        onCommit={(v) => props.onPatch({ notes: v })}
      />
    );
  }
  return <Note>{props.actor.notes || "No notes."}</Note>;
}

/** The card's numbers as fields where the viewer may change them, else as text, and nothing the projection did not send. */
export function StatsFields(props: {
  actor: Partial<Actor>;
  canEdit(field: keyof ActorPatch): boolean;
  onPatch(patch: ActorPatch): void;
  dm: boolean;
  /** No AC to show while `hpLess` holds, an effect's stored AC included (docs/design-v1-combat-flow.md 3.6.6). */
  noAc?: boolean;
  /**
   * The character's stat block gives its initiative and Passive Perception
   * (docs/design-v1-pc-stats.md 7.1), so they show as text that says so,
   * for the DM too, and are changed in the block.
   */
  fromBlock?: boolean;
}) {
  const { actor, canEdit, onPatch, dm } = props;
  const fromBlock = props.fromBlock === true;
  const speeds: Speeds = actor.speeds ?? { walk: 30 };

  const setSpeed = (key: SpeedKey, value: number | null) => {
    const next: Speeds = { ...speeds };
    if (key === "walk") next.walk = value ?? 0;
    else if (value === null || value === 0) delete next[key];
    else next[key] = value;
    onPatch({ speeds: next });
  };
  const editSpeeds = canEdit("speeds");
  // Only a viewer who may set a speed has anything to fold: the rest read only the speeds that are set.
  const [held, setHeld] = useState<readonly OtherSpeed[] | null>(null);
  const folded = editSpeeds ? foldedSpeeds(speeds, held) : [];
  const speedRow = (key: SpeedKey) => (
    <Stat key={key} label={`${SPEED_LABELS[key]} Speed`} value={speeds[key] === undefined ? undefined : `${speeds[key]} ft`} editable={editSpeeds}>
      <NumberField
        label={`${SPEED_LABELS[key]} Speed`}
        value={speeds[key]}
        min={0}
        max={1000}
        nullable={key !== "walk"}
        placeholder="none"
        onCommit={(n) => setSpeed(key, n)}
      />
      <span style={{ color: theme.color.textMuted, fontSize: theme.font.small }}>ft</span>
    </Stat>
  );

  return (
    <>
      {props.noAc ? null : (
        <Stat label="Armor Class" value={actor.ac} editable={canEdit("ac")}>
          <NumberField label="Armor Class" value={actor.ac} min={0} max={100} onCommit={(n) => n !== null && onPatch({ ac: n })} />
        </Stat>
      )}
      {speedRow("walk")}
      {OTHER_SPEEDS.filter((key) => !folded.includes(key)).map(speedRow)}
      {editSpeeds ? (
        <Section
          title="Other speeds"
          fold={{
            open: held !== null,
            onToggle: () => setHeld(held === null ? foldedSpeeds(speeds, null) : null),
            // Folded, a speed it holds is never set, so Hovers is the one thing it may hide.
            summary: held === null && speeds.hover ? <span style={{ color: theme.color.textMuted, fontSize: theme.font.small }}>Hovers</span> : undefined,
          }}
        >
          {folded.map(speedRow)}
          <Switch
            checked={speeds.hover === true}
            onChange={(on) => {
              const next: Speeds = { ...speeds };
              if (on) next.hover = true;
              else delete next.hover;
              onPatch({ speeds: next });
            }}
            label="Hovers"
          />
        </Section>
      ) : speeds.hover ? (
        <Note>Hovers.</Note>
      ) : null}
      <Stat label="Initiative bonus" value={fromBlock ? withSource(signed(actor.initBonus)) : signed(actor.initBonus)} editable={!fromBlock && canEdit("initBonus")}>
        <Stepper label="Initiative bonus" value={actor.initBonus ?? 0} step={1} min={-20} max={40} onChange={(n) => onPatch({ initBonus: n })} />
      </Stat>
      {dm || actor.initScore !== undefined ? (
        <Stat
          label="Initiative score"
          hint="10 + DEX modifier, used when the room uses scores for monsters"
          value={actor.initScore}
          editable={canEdit("initScore")}
        >
          <NumberField
            label="Initiative score"
            value={actor.initScore}
            min={-20}
            max={60}
            nullable
            placeholder="none"
            onCommit={(n) => onPatch({ initScore: n })}
          />
        </Stat>
      ) : null}
      <Stat label="Passive Perception" value={fromBlock ? withSource(actor.passivePerception) : actor.passivePerception} editable={!fromBlock && canEdit("passivePerception")}>
        <NumberField
          label="Passive Perception"
          value={actor.passivePerception}
          min={0}
          max={60}
          onCommit={(n) => n !== null && onPatch({ passivePerception: n })}
        />
      </Stat>
      <Stat label="Senses" value={actor.senses || "None"} editable={canEdit("senses")} wide>
        <TextField label="Senses" value={actor.senses ?? ""} maxLength={80} placeholder="Darkvision 60 ft." onCommit={(v) => onPatch({ senses: v.trim() })} />
      </Stat>
      {dm || actor.creatureType ? (
        <Stat label="Creature type" value={actor.creatureType} editable={canEdit("creatureType")} wide>
          <TextField
            label="Creature type"
            value={actor.creatureType ?? ""}
            maxLength={80}
            placeholder="Humanoid"
            onCommit={(v) => onPatch({ creatureType: v.trim() || null })}
          />
        </Stat>
      ) : null}
      {actor.cr !== undefined || dm ? (
        <Stat label="Challenge rating" value={actor.cr === undefined ? undefined : `${actor.cr}${actor.xp !== undefined ? ` (${actor.xp.toLocaleString()} XP)` : ""}`} editable={canEdit("cr")}>
          <TextField label="Challenge rating" value={actor.cr ?? ""} maxLength={8} placeholder="1/4" onCommit={(v) => onPatch({ cr: v.trim() || null })} style={{ maxWidth: 96 }} />
        </Stat>
      ) : null}
      {dm ? <LegendaryFields actor={actor} onPatch={onPatch} /> : null}
    </>
  );
}

/** "+2, from the stat block". */
function withSource(value: string | number | undefined): string | undefined {
  return value === undefined ? undefined : `${value}, from the stat block`;
}

function signed(n: number | undefined): string | undefined {
  if (n === undefined) return undefined;
  return n >= 0 ? `+${n}` : `−${-n}`;
}

function Stat(props: { label: string; value: string | number | undefined; editable: boolean; hint?: string; wide?: boolean; children: ReactNode }) {
  if (!props.editable) {
    if (props.value === undefined) return null;
    return (
      <div style={{ display: "flex", justifyContent: "space-between", gap: theme.space(3), minHeight: 32, alignItems: "center" }}>
        <span style={{ color: theme.color.textMuted }}>{props.label}</span>
        <span style={{ textAlign: "right" }}>{props.value}</span>
      </div>
    );
  }
  return (
    <FieldRow label={props.label} hint={props.hint}>
      {props.children}
    </FieldRow>
  );
}

/** Legendary action pips and Legendary Resistance uses, refilled by the tracker at the start of the monster's turn. */
function LegendaryFields(props: { actor: Partial<Actor>; onPatch(patch: ActorPatch): void }) {
  const legendary = props.actor.legendary ?? { actionsMax: 0, actionsUsed: 0, resistMax: 0, resistUsed: 0 };
  const set = (patch: Partial<typeof legendary>) => {
    const next = { ...legendary, ...patch };
    next.actionsUsed = Math.min(next.actionsUsed, next.actionsMax);
    next.resistUsed = Math.min(next.resistUsed, next.resistMax);
    props.onPatch({ legendary: next.actionsMax === 0 && next.resistMax === 0 ? null : next });
  };
  return (
    <>
      <FieldRow label="Legendary Actions" hint={legendary.actionsMax > 0 ? `${legendary.actionsUsed} of ${legendary.actionsMax} used` : undefined}>
        <Stepper label="Legendary Actions per round" value={legendary.actionsMax} step={1} min={0} max={10} onChange={(n) => set({ actionsMax: n })} />
      </FieldRow>
      {legendary.actionsMax > 0 ? (
        <FieldRow label="Actions used">
          <Stepper label="Legendary Actions used" value={legendary.actionsUsed} step={1} min={0} max={legendary.actionsMax} onChange={(n) => set({ actionsUsed: n })} />
        </FieldRow>
      ) : null}
      <FieldRow label="Legendary Resistance" hint={legendary.resistMax > 0 ? `${legendary.resistUsed} of ${legendary.resistMax} used today` : undefined}>
        <Stepper label="Legendary Resistance per day" value={legendary.resistMax} step={1} min={0} max={10} onChange={(n) => set({ resistMax: n })} />
      </FieldRow>
      {legendary.resistMax > 0 ? (
        <FieldRow label="Resistances used">
          <Stepper label="Legendary Resistance used" value={legendary.resistUsed} step={1} min={0} max={legendary.resistMax} onChange={(n) => set({ resistUsed: n })} />
        </FieldRow>
      ) : null}
    </>
  );
}

/** The sheet link as a field, for setup. The link itself is "Open the sheet" and its new tab's icon. */
export function SheetUrlField(props: { value: string; onPatch(patch: ActorPatch): void }) {
  const [error, setError] = useState(false);
  return (
    <>
      <TextField
        label="Sheet link"
        value={props.value}
        maxLength={500}
        placeholder="https://…"
        onCommit={(v) => {
          if (!v.trim()) {
            setError(false);
            props.onPatch({ sheetUrl: null });
            return;
          }
          const url = validSheetUrl(v);
          setError(!url);
          if (url) props.onPatch({ sheetUrl: url });
        }}
      />
      {error ? <Note tone="error">The link must start with https:// and be at most 500 characters.</Note> : null}
    </>
  );
}
