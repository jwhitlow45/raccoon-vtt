import { useStore } from "zustand";
import { useScoped } from "../../state/scope.ts";
import { OptSelect } from "../measure/controls.tsx";
import { PLACED_LIGHTS } from "../vision/presets.ts";
import { lightModeSlot } from "./store.ts";

const CHOICES = PLACED_LIGHTS.map((p) => ({ value: p.name, label: p.name }));

/** Light mode's part of the builder's bar: the SRD source a tap places (docs/design-v1-maps-vision.md section 4.3.1). */
export function LightOptions() {
  const store = useScoped(lightModeSlot).store;
  const preset = useStore(store, (s) => s.preset);
  return <OptSelect<string> label="Light to place" value={preset} options={CHOICES} onChange={(name) => store.setState({ preset: name })} />;
}
