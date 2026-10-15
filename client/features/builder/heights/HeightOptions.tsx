import { useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { AutoWalls } from "#shared/model.ts";
import { Icon } from "../../../components/Icon.tsx";
import { Segmented } from "../../../components/Segmented.tsx";
import { theme } from "../../../lib/theme.ts";
import { OptButton, StepValue } from "../../measure/controls.tsx";
import { heightHint } from "./hint.ts";
import { HEIGHT_MAX_FT, HEIGHT_MIN_FT, HEIGHT_STEP_FT, heightName, stepHeight, useHeightStore, type HeightPaint, type HeightShape, type StairChoice } from "./store.ts";

const SHAPES: readonly { value: HeightShape; label: string; title: string }[] = [
  { value: 1, label: "1", title: "Brush, one square" },
  { value: 2, label: "2", title: "Brush, two squares" },
  { value: 3, label: "3", title: "Brush, three squares" },
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

/**
 * Height mode's part of the builder's bar (Options.tsx). The stepper's − and
 * + repeat while held, so 100 ft is one hold away from the default 10 ft
 * rather than eighteen taps (docs/design-v1-heights-readout.md section 5).
 * A typed number would open the keyboard over the map being painted.
 */
export function HeightOptions() {
  const store = useHeightStore();
  const s = useStore(
    store,
    useShallow((h) => ({ paint: h.paint, shape: h.shape, height: h.height, stairs: h.stairs })),
  );
  const set = store.setState;
  const [holding, setHolding] = useState(false);
  return (
    <>
      <Segmented<HeightPaint>
        label="Paint"
        value={s.paint}
        onChange={(paint) => set({ paint })}
        options={[
          { value: "height", label: "Height", title: "Paint a height" },
          { value: "stairs", label: "Stairs", title: "Mark stairs" },
        ]}
      />
      <Segmented<HeightShape> label="Brush" value={s.shape} onChange={(shape) => set({ shape })} options={SHAPES} />
      {s.paint === "height" ? (
        <div role="group" aria-label="Height" style={{ display: "flex", alignItems: "center", gap: theme.space(1), flex: "none" }}>
          <OptButton
            icon="minus"
            label={`${HEIGHT_STEP_FT} ft lower`}
            disabled={s.height <= HEIGHT_MIN_FT}
            repeat
            onHold={setHolding}
            onClick={() => stepHeight(store, -HEIGHT_STEP_FT)}
          />
          <StepValue minWidth={112} live hushed={holding}>
            {heightName(s.height)}
          </StepValue>
          <OptButton
            icon="plus"
            label={`${HEIGHT_STEP_FT} ft higher`}
            disabled={s.height >= HEIGHT_MAX_FT}
            repeat
            onHold={setHolding}
            onClick={() => stepHeight(store, HEIGHT_STEP_FT)}
          />
        </div>
      ) : (
        <Segmented<StairChoice> label="Stairs point" value={s.stairs} onChange={(stairs) => set({ stairs })} options={STAIR_CHOICES} />
      )}
    </>
  );
}

/** Height mode's hint for the scene, following the mode's choices. */
export function useHeightHint(autoWalls: AutoWalls | undefined): string {
  const s = useStore(
    useHeightStore(),
    useShallow((h) => ({ paint: h.paint, shape: h.shape, height: h.height, stairs: h.stairs })),
  );
  return heightHint(s, autoWalls);
}
