import type { ReactNode } from "react";
import { Group } from "react-konva";
import { Pill, PillStack, type PillProps, type StackPill } from "../features/measure/Pill.tsx";
import { groundGroups } from "../lib/view.ts";
import { liftInPlane, liftView, viewPointOf } from "./isoPlace.ts";
import { useIsoGround } from "./relief/context.ts";

/**
 * The pieces a renderer draws its marks with so they land where the
 * isometric view puts them (docs/design-v1-isometric-view.md 5.1 and 5.3,
 * isoPlace.ts), and draw exactly as before in Top-down, where each is its
 * children or today's pill.
 */

/**
 * Children in cells, on the ground plane at `z` cells of height: lifted in
 * the drag layer, carried onto a lifted plane from the overlay, and as
 * they are on the ground stage, whose raised tops copy them up already.
 */
export function Lift(props: { z: number; children: ReactNode }) {
  const iso = useIsoGround();
  if (!iso || iso.place === "ground") return <>{props.children}</>;
  if (iso.place === "moving") {
    const d = liftInPlane(iso.turn, props.z);
    return (
      <Group x={d.x} y={d.y} listening={false}>
        {props.children}
      </Group>
    );
  }
  const g = groundGroups(iso.turn);
  return (
    <Group y={-liftView(props.z)} listening={false}>
      <Group scaleY={g.outer.scaleY}>
        <Group rotation={g.inner.rotation}>{props.children}</Group>
      </Group>
    </Group>
  );
}

/** Children in view units, standing up: from inside the ground plane through its inverse, and as they are on the overlay. Top-down's view units are its cells. */
export function Upright(props: { children: ReactNode }) {
  const iso = useIsoGround();
  if (!iso || iso.place === "upright") return <>{props.children}</>;
  const u = groundGroups(iso.turn).upright;
  return (
    <Group rotation={u.rotation} scaleY={u.scaleY} listening={false}>
      {props.children}
    </Group>
  );
}

/**
 * A pill on its point in cells: as Top-down draws it, upright at the
 * point's drawn height in Isometric (or at `z` cells of height), and flat
 * on the ground stage, where it keeps to its point rather than slide along
 * the screen's edge. Where it draws, by the stand rule, is the caller's
 * (isoPlace.ts drawsHere).
 */
export function MarkPill(props: PillProps & { z?: number }) {
  const { z, ...pill } = props;
  const iso = useIsoGround();
  if (!iso) return <Pill {...pill} />;
  if (iso.place === "ground") return <Pill {...pill} slide={false} />;
  const v = viewPointOf(iso, pill, z);
  return (
    <Upright>
      <Pill {...pill} x={v.x} y={v.y} />
    </Upright>
  );
}

/** A stack of readouts on its point in cells, as MarkPill places one pill. */
export function MarkPillStack(props: { x: number; y: number; scale: number; offsetPx?: number; pills: readonly (StackPill | null | false)[]; z?: number }) {
  const { z, ...stack } = props;
  const iso = useIsoGround();
  if (!iso) return <PillStack {...stack} />;
  if (iso.place === "ground") return <PillStack {...stack} slide={false} />;
  const v = viewPointOf(iso, stack, z);
  return (
    <Upright>
      <PillStack {...stack} x={v.x} y={v.y} />
    </Upright>
  );
}
