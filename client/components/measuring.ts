import { createContext, useContext } from "react";

/**
 * Whether a control is a hidden copy drawn only so its width can be read:
 * the tool options' measuring layer (features/measure/controls.tsx
 * OptionsStrip, docs/design-v1-tool-options.md 6.2). Such a copy draws
 * exactly as the control does, with no radio name, no id, no handler, no
 * live region and no effect, so it never joins the real control's radio
 * group and unchecks its choice, nor arms a timer or speaks.
 */
export const MeasuringContext = createContext(false);

export function useMeasuring(): boolean {
  return useContext(MeasuringContext);
}
