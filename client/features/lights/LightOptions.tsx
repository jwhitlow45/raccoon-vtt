import { useStore } from "zustand";
import { useScoped } from "../../state/scope.ts";
import { ChoiceRows, PickCloses, ValueChip } from "../measure/controls.tsx";
import { PLACED_LIGHTS } from "../vision/presets.ts";
import { lightModeSlot } from "./store.ts";

/** The chip's short word for a long name: "Lantern" for the Hooded Lantern (docs/design-v1-tool-options.md 6.2). */
const SHORT: Partial<Record<string, string>> = { "Hooded Lantern": "Lantern" };

/** Light mode's chip in the builder's row: the SRD source a tap places (docs/design-v1-maps-vision.md section 4.3.1), its rows keeping the whole names. */
export function LightChip() {
  const store = useScoped(lightModeSlot).store;
  const preset = useStore(store, (s) => s.preset);
  return (
    <ValueChip label="Light to place" kind="choice" value={preset} valueName={preset} options={PLACED_LIGHTS.map((p) => ({ key: p.name, words: SHORT[p.name] ?? p.name }))}>
      <PickCloses>
        <ChoiceRows<string> label="Light to place" value={preset} options={PLACED_LIGHTS.map((p) => ({ value: p.name, label: p.name }))} onChange={(name) => store.setState({ preset: name })} />
      </PickCloses>
    </ValueChip>
  );
}
