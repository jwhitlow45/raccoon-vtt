import { useId, type ReactNode } from "react";
import type { Scene } from "#shared/model.ts";
import { gridOfShape, switchRefusal } from "#shared/rules/grid.ts";
import { Help } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { SettingRow } from "../../components/SettingRow.tsx";
import { theme } from "../../lib/theme.ts";
import { SHAPE_CHOICES, storedShape, type ShapeChoice } from "./words.ts";

/**
 * A grid shape choice (docs/design-v1-hex-grids.md section 8): Squares,
 * Hex rows and Hex columns as one radio group, which wraps onto two lines
 * on a narrow phone at a large size rather than cut a word. A choice the
 * scene cannot take is off, and the reason shows under the group and
 * describes it, so focus stays on the chosen radio and a screen reader
 * hears why. `refused` holds each choice's reason, `note` a line about
 * the choice as a whole, such as a limit the picked shape brings.
 */
export function ShapeRow(props: {
  name: string;
  help?: string;
  value: ShapeChoice;
  refused?: Partial<Record<ShapeChoice, string>>;
  note?: ReactNode;
  disabled?: boolean;
  onChange(value: ShapeChoice): void;
}) {
  const reasonId = useId();
  const noteId = useId();
  const reasons = shapeReasons(props.refused, props.value);
  return (
    <SettingRow name={props.name} help={props.help} wide>
      {(ids) => (
        <div style={{ display: "grid", gap: theme.space(1), minWidth: 0, width: "100%" }}>
          <Segmented<ShapeChoice>
            labelledBy={ids.nameId}
            describedBy={[ids.helpId, reasons.length > 0 ? reasonId : null, props.note ? noteId : null].filter(Boolean).join(" ")}
            value={props.value}
            disabled={props.disabled}
            options={SHAPE_CHOICES.map((c) => ({ ...c, disabled: props.refused?.[c.value] !== undefined && c.value !== props.value }))}
            onChange={props.onChange}
          />
          {reasons.length > 0 ? <Help id={reasonId}>{reasons.join(" ")}</Help> : null}
          {props.note ? <Help id={noteId}>{props.note}</Help> : null}
        </div>
      )}
    </SettingRow>
  );
}

/** The distinct reasons the other choices are off, once each: both hex shapes are usually refused in the same words. */
export function shapeReasons(refused: Partial<Record<ShapeChoice, string>> | undefined, value: ShapeChoice): string[] {
  const out: string[] = [];
  for (const c of SHAPE_CHOICES) {
    const why = refused?.[c.value];
    if (c.value !== value && why !== undefined && !out.includes(why)) out.push(why);
  }
  return out;
}

/**
 * Why a scene cannot take a shape, in the reducer's own words
 * (shared/rules/grid.ts `switchRefusal`), or null when it can: the Grid
 * shape choice reads the room as the server will.
 */
export function shapeRefusal(state: Parameters<typeof switchRefusal>[0], scene: Pick<Scene, "id" | "gridShape" | "gridFromFile" | "map">, choice: ShapeChoice): string | null {
  return switchRefusal(state, scene, gridOfShape(storedShape(choice)));
}
