import { ABILITY_KEYS, type AbilityKey, type Effect } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import { ABILITY_NAMES } from "#shared/rules/skills.ts";
import { Checkbox } from "../../components/Checkbox.tsx";
import { theme } from "../../lib/theme.ts";
import { FieldRow, NumberField, Select } from "./ui.tsx";

/**
 * "A Wisdom save at the end of each of its turns ends it"
 * (docs/design-v1-roll-options.md 6.1): the DM's switch, ability, DC and
 * "Against a spell" on one creature's effect form, and on the group save's
 * conditions (5.4), one form for both.
 */
export type SaveEndsForm = { on: boolean; ability: AbilityKey; dc: number | null; spell: boolean };

export function saveEndsForm(save: Effect["save"] | undefined, fill?: Partial<SaveEndsForm>): SaveEndsForm {
  if (save) return { on: true, ability: save.ability, dc: save.dc, spell: save.spell === true };
  return { on: false, ability: "wis", dc: null, spell: false, ...fill };
}

/** The effect's save from the form, null for none, or a reason it cannot be sent. */
export function saveOf(form: SaveEndsForm): { ok: true; save: Effect["save"] | null } | { ok: false; error: string } {
  if (!form.on) return { ok: true, save: null };
  if (form.dc === null) return { ok: false, error: "Give the save that ends it a DC." };
  return { ok: true, save: { ability: form.ability, dc: form.dc, ...(form.spell ? { spell: true as const } : {}) } };
}

/** Whether two saves are the same, so a form left as it was sends no change. */
export function sameSave(a: Effect["save"] | null | undefined, b: Effect["save"] | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.ability === b.ability && a.dc === b.dc && (a.spell === true) === (b.spell === true);
}

/** The words a player reads on the effect, with no DC, which stays the DM's. */
export function saveEndsText(save: Pick<NonNullable<Effect["save"]>, "ability">): string {
  return `A ${ABILITY_NAMES[save.ability]} save at the end of each of its turns ends it.`;
}

const ABILITY_OPTIONS = ABILITY_KEYS.map((key) => ({ value: key, label: ABILITY_NAMES[key] }));

export function SaveEndsFields(props: { form: SaveEndsForm; onChange(form: SaveEndsForm): void }) {
  const { form } = props;
  return (
    <div style={{ display: "grid", gap: theme.space(1) }}>
      <Checkbox
        checked={form.on}
        onChange={(on) => props.onChange({ ...form, on })}
        label={`A ${ABILITY_NAMES[form.ability]} save at the end of each of its turns ends it`}
        help="Its turn end reminds you with Roll, or asks a player's creature's player."
      />
      {form.on ? (
        <>
          <FieldRow label="Save">
            <Select<AbilityKey> label="Save that ends it" value={form.ability} options={ABILITY_OPTIONS} onChange={(ability) => props.onChange({ ...form, ability })} />
          </FieldRow>
          <FieldRow label="DC">
            <NumberField label="DC of the save that ends it" value={form.dc ?? undefined} min={LIMITS.rollDcMin} max={LIMITS.rollDcMax} nullable placeholder="15" onCommit={(dc) => props.onChange({ ...form, dc })} width={88} />
          </FieldRow>
          <Checkbox checked={form.spell} onChange={(spell) => props.onChange({ ...form, spell })} label="Against a spell" help="A creature with Magic Resistance makes it with advantage." />
        </>
      ) : null}
    </div>
  );
}
