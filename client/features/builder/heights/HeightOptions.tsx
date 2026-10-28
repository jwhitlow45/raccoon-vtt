import { useMemo, type ReactNode } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { AutoWalls } from "#shared/model.ts";
import { isHex, SQUARES, type Grid } from "#shared/rules/grid.ts";
import { Icon } from "../../../components/Icon.tsx";
import { OptSegmented, Stepper, type Slot } from "../../measure/controls.tsx";
import { HEX_FACING_ARROWS, stairChoiceOn } from "./facings.ts";
import { heightHint, roughHint } from "./hint.ts";
import { HEIGHT_MAX_FT, HEIGHT_MIN_FT, HEIGHT_STEP_FT, heightName, stepHeight, useHeightStore, type HeightPaint, type HeightShape, type RoughChoice, type StairChoice } from "./store.ts";

const SHAPES: readonly { value: HeightShape; label: string; title: string }[] = [
  { value: 1, label: "1", title: "Brush, one square" },
  { value: 2, label: "2", title: "Brush, two squares" },
  { value: 3, label: "3", title: "Brush, three squares" },
  { value: "area", label: "Area", title: "Drag from corner to corner" },
];

/** The brush on a hex scene, in hexes: 1, then the hexes within one and two steps (builder/hexBuild.ts hexBrush). */
export const HEX_SHAPES: readonly { value: HeightShape; label: string; title: string }[] = [
  { value: 1, label: "1", title: "Brush, one hex" },
  { value: 2, label: "2", title: "Brush, a hex and the six around it" },
  { value: 3, label: "3", title: "Brush, two hexes out" },
  { value: "area", label: "Area", title: "Drag from corner to corner" },
];

/**
 * The arrow buttons of section 4.2, for stairs the rule cannot settle, and
 * a button to take marks away. The arrows are directions, so they stay
 * text. Each is named by its title.
 */
const STAIR_CHOICES: readonly { value: StairChoice; label: ReactNode; title: string }[] = [
  { value: "a", label: "Auto", title: "Point each stair toward its one higher neighbor" },
  { value: "n", label: "↑", title: "Up to the north" },
  { value: "e", label: "→", title: "Up to the east" },
  { value: "s", label: "↓", title: "Up to the south" },
  { value: "w", label: "←", title: "Up to the west" },
  { value: "remove", label: <Icon name="close" size="sm" />, title: "Remove stairs" },
];

/** The Stairs point choices on a grid: the compass arrows on squares, the six facings on hexes, each with Auto first and Remove last. */
function stairChoices(g: Grid): readonly { value: StairChoice; label: ReactNode; title: string }[] {
  if (!isHex(g)) return STAIR_CHOICES;
  return [
    STAIR_CHOICES[0]!,
    ...HEX_FACING_ARROWS[g.orient].map(([arrow, name], i) => ({ value: String(i) as StairChoice, label: arrow, title: `Up to the ${name}` })),
    STAIR_CHOICES[STAIR_CHOICES.length - 1]!,
  ];
}


/**
 * Height mode's slots in the builder's row (Options.tsx,
 * docs/design-v1-tool-options.md 9.9): what to paint, the brush, and the
 * height or the stairs' direction. The stepper's − and + repeat while held,
 * so 100 ft is one hold away from the default 10 ft rather than eighteen
 * taps (docs/design-v1-heights-readout.md section 5), and its value is
 * spoken once a hold ends. A typed number would open the keyboard over the
 * map being painted.
 */
export function useHeightSlots(rough = false, grid: Grid = SQUARES): Slot[] {
  const store = useHeightStore();
  const s = useStore(
    store,
    useShallow((h) => ({ paint: h.paint, shape: h.shape, height: h.height, stairs: h.stairs, rough: h.rough })),
  );
  const set = store.setState;
  // What a press the browser cancels puts back (OptButton `repeatValue`).
  const height = useMemo(() => ({ read: () => store.getState().height, write: (v: number) => store.setState({ height: v }) }), [store]);
  const shapes = isHex(grid) ? HEX_SHAPES : SHAPES;
  // Difficult ground mode (docs/design-v1-movement.md 3.4): the same brush and area, marking or clearing.
  if (rough) {
    return [
      {
        id: "rough",
        priority: 1,
        compact: true,
        control: (
          <OptSegmented<RoughChoice>
            label="Difficult ground"
            value={s.rough}
            onChange={(choice) => set({ rough: choice })}
            options={[
              { value: "mark", label: "Mark", title: "Mark difficult ground" },
              { value: "clear", label: "Clear", title: "Clear difficult ground" },
            ]}
          />
        ),
      },
      { id: "heightBrush", priority: 3, compact: true, control: <OptSegmented<HeightShape> label="Brush" value={s.shape} onChange={(shape) => set({ shape })} options={shapes} /> },
    ];
  }
  return [
    {
      id: "paint",
      priority: 2,
      compact: true,
      control: (
        <OptSegmented<HeightPaint>
          label="Paint"
          value={s.paint}
          onChange={(paint) => set({ paint })}
          options={[
            { value: "height", label: "Height", title: "Paint a height" },
            { value: "stairs", label: "Stairs", title: "Mark stairs" },
          ]}
        />
      ),
    },
    { id: "heightBrush", priority: 3, compact: true, control: <OptSegmented<HeightShape> label="Brush" value={s.shape} onChange={(shape) => set({ shape })} options={shapes} /> },
    s.paint === "height"
      ? {
          id: "height",
          priority: 1,
          control: (
            <Stepper
              label="Height"
              value={s.height}
              step={HEIGHT_STEP_FT}
              min={HEIGHT_MIN_FT}
              max={HEIGHT_MAX_FT}
              format={heightName}
              widest={[heightName(0)]}
              less={`${HEIGHT_STEP_FT} ft lower`}
              more={`${HEIGHT_STEP_FT} ft higher`}
              repeat
              repeatValue={height}
              onStep={(direction) => stepHeight(store, direction * HEIGHT_STEP_FT)}
              onChange={(v) => set({ height: v })}
              live
              valueWidth={112}
            />
          ),
        }
      : {
          id: "stairs",
          priority: 1,
          compact: true,
          control: <OptSegmented<StairChoice> label="Stairs point" value={stairChoiceOn(grid, s.stairs)} onChange={(stairs) => set({ stairs })} options={stairChoices(grid)} />,
        },
  ];
}

/** Height mode's hint for the scene, or Difficult ground mode's, following the mode's choices. */
export function useHeightHint(autoWalls: AutoWalls | undefined, rough = false, grid: Grid = SQUARES): string {
  const s = useStore(
    useHeightStore(),
    useShallow((h) => ({ paint: h.paint, shape: h.shape, height: h.height, stairs: h.stairs, rough: h.rough })),
  );
  return rough ? roughHint(s) : heightHint(s, autoWalls, grid);
}
