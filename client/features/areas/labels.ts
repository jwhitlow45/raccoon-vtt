import type { AreaShape, AreaTemplate } from "#shared/model.ts";

export const SHAPES: readonly { value: AreaShape; label: string }[] = [
  { value: "cone", label: "Cone" },
  { value: "sphere", label: "Sphere" },
  { value: "cylinder", label: "Cylinder" },
  { value: "cube", label: "Cube" },
  { value: "line", label: "Line" },
  { value: "emanation", label: "Emanation" },
];

export function shapeName(shape: AreaShape): string {
  return SHAPES.find((s) => s.value === shape)?.label ?? shape;
}

/** "Fireball", or "20 ft sphere" for an area with no spell. */
export function areaTitle(t: Pick<AreaTemplate, "shape" | "size"> & { spell?: string | null; label?: string | null }): string {
  return t.spell || t.label || `${t.size} ft ${shapeName(t.shape).toLowerCase()}`;
}
