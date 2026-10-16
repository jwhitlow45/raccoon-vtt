import type { Token } from "#shared/model.ts";
import { MAX_RANGE_RINGS, MAX_RANGE_RING_FT, type TokenPatch } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { Chip, ChipRow } from "../../components/Chip.tsx";
import { FieldRow } from "../../components/Field.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { NumberField } from "../tokens/ui.tsx";
import { RING_PRESETS, ringsText } from "./rings.ts";

/**
 * The token menu's range rings (features section 4): common ranges to tap
 * on and off, any other distance typed in, at most four. The DM and the
 * token's owners set them, and everyone who sees the token sees them.
 *
 * The presets are Chips (docs/design-v1-visual.md 2.3), quick picks that
 * show pressed while their ring is on. Each is named by its distance, a
 * name that stays the same on and off (3.7), in a group named "Range
 * rings in feet".
 */
export function RangeRingsSection(props: { token: Pick<Token, "rangeRings">; canEdit: boolean; update(patch: TokenPatch): void }) {
  const rings = props.token.rangeRings ?? [];
  if (!props.canEdit) {
    return rings.length > 0 ? (
      <Section label="Range rings">
        <Help>{ringsText(rings)}</Help>
      </Section>
    ) : null;
  }
  const full = rings.length >= MAX_RANGE_RINGS;
  const set = (next: number[]) => props.update({ rangeRings: [...new Set(next)].sort((a, b) => a - b) });
  const toggle = (ft: number) => set(rings.includes(ft) ? rings.filter((r) => r !== ft) : [...rings, ft]);
  const custom = rings.filter((ft) => !(RING_PRESETS as readonly number[]).includes(ft));
  return (
    <Section
      label="Range rings"
      action={
        rings.length > 0 ? (
          <Button size="sm" variant="danger" aria-label="Remove every range ring" title="Remove every range ring" onClick={() => set([])}>
            Clear
          </Button>
        ) : null
      }
    >
      <ChipRow label="Range rings in feet">
        {[...RING_PRESETS, ...custom].map((ft) => {
          const on = rings.includes(ft);
          return (
            <Chip key={ft} pressed={on} disabled={!on && full} title={`A ring at ${ft} ft`} onClick={() => toggle(ft)}>
              {ft}
            </Chip>
          );
        })}
      </ChipRow>
      <FieldRow label="Another distance" hint={`${full ? `At most ${MAX_RANGE_RINGS} rings.` : "Feet."} Everyone who can see this token sees its rings.`}>
        {/* Keyed by the rings, so the field empties once its distance is added. */}
        <NumberField key={rings.join(",")} label="Another range ring in feet" value={undefined} min={5} max={MAX_RANGE_RING_FT} disabled={full} onCommit={(ft) => ft !== null && set([...rings, ft])} />
      </FieldRow>
    </Section>
  );
}
