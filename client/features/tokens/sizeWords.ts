import type { CreatureSize } from "#shared/model.ts";

// Keep these words independent of resize state so grid words also work in Node.
export const SIZE_WORDS: Record<CreatureSize, string> = {
  tiny: "Tiny",
  small: "Small",
  medium: "Medium",
  large: "Large",
  huge: "Huge",
  gargantuan: "Gargantuan",
  custom: "Custom",
};
