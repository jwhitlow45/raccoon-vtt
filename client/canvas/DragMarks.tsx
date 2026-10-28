import { memo, useContext, useMemo } from "react";
import { Group } from "react-konva";
import type { AreaTemplate, RoomState, Scene, Token } from "#shared/model.ts";
import type { AreaContext, CoverageResult } from "#shared/rules/aoe.ts";
import { footprintRect, type FootprintToken } from "#shared/rules/footprint.ts";
import { cachedCoverage, caughtTokens, coveredWindow } from "../features/areas/coverage.ts";
import { ringReach } from "../features/areas/draw.tsx";
import { areaOutline, type Outline } from "../features/areas/placement.ts";
import { useLiveTokens } from "../features/areas/useLiveTokens.ts";
import { CAUGHT_RING, Clipped, IsoAreasContext, PlacedArea, useAreaParts } from "../features/areas/TemplateLayer.tsx";
import { tethers } from "../features/attach/groups.ts";
import { TetherLine, tetherPx } from "../features/attach/TetherLayer.tsx";
import type { LayerProps } from "../features/layers.ts";
import { TokenRings } from "../features/measure/RangeRingLayer.tsx";
import type { DistanceRules } from "../features/measure/ruler.ts";
import { Lift } from "./IsoParts.tsx";
import { boxGround } from "./isoPlace.ts";
import { auraClip, tetherShows } from "./markStand.ts";
import { IsoGroundContext, useTreeShownView, type IsoGround } from "./relief/context.ts";
import type { CellBox } from "./relief/fogView.ts";
import { sortKey } from "./relief/pieces.ts";
import { WholeVolume } from "./relief/VolumeShape.tsx";
import { footprint } from "../lib/scene.ts";
import { sceneGrid, type Grid } from "#shared/rules/grid.ts";

const EMPTY_TEMPLATES: RoomState["templates"] = {};
const EMPTY_TOKENS: RoomState["tokens"] = {};
/** How far past an aura's covered window the box reaches, in cells: room the square path has always kept. */
const AURA_MARGIN = 2;
/** The outline's stroke in screen pixels, as PlacedArea draws it (TemplateLayer.tsx), all of it counted past the outline's line. */
const OUTLINE_PX = 2;

/**
 * The box an aura moving with a dragged token paints, in cells: its covered
 * window and a margin, its outline's own bounds and stroke, and each
 * creature it catches, whose ring can stand cells past the window (a
 * Gargantuan caught by one corner cell), with the ring's gap and stroke at
 * this zoom. The outline is counted on its own since it can run well past
 * the shading: a thin line under "center" covers few hexes or none, and an
 * empty window says nothing of where the area lies. An aura shows whole
 * only when every sub-cell of it is revealed (markStand.ts auraClip).
 */
export function auraBox(cov: Pick<CoverageResult, "x0" | "y0" | "w" | "h" | "hexes">, outline: Outline | null, caught: readonly FootprintToken[], scale: number, grid: Grid): CellBox {
  let box: CellBox | null = null;
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    box = box ? { x0: Math.min(box.x0, x0), y0: Math.min(box.y0, y0), x1: Math.max(box.x1, x1), y1: Math.max(box.y1, y1) } : { x0, y0, x1, y1 };
  };
  // On hexes the window is where the covered hexes lie (coverage.ts coveredWindow), which may be none.
  const win = coveredWindow(cov, grid);
  if (win.w > 0 && win.h > 0) add(win.x0 - AURA_MARGIN, win.y0 - AURA_MARGIN, win.x0 + win.w + AURA_MARGIN, win.y0 + win.h + AURA_MARGIN);
  if (outline) {
    const b = outlineBounds(outline);
    const stroke = OUTLINE_PX / scale;
    add(b.x0 - stroke, b.y0 - stroke, b.x1 + stroke, b.y1 + stroke);
  }
  const reach = ringReach(scale, CAUGHT_RING.widthPx, CAUGHT_RING.gapPx);
  for (const t of caught) {
    const r = footprintRect(grid, t);
    add(r.x - reach, r.y - reach, r.x + r.w + reach, r.y + r.h + reach);
  }
  return box ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
}

/** An outline's bounds in cells, without its stroke. */
function outlineBounds(o: Outline): CellBox {
  switch (o.kind) {
    case "circle":
      return { x0: o.x - o.r, y0: o.y - o.r, x1: o.x + o.r, y1: o.y + o.r };
    case "roundRect":
      return { x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.h };
    case "poly": {
      const xs = o.points.filter((_, i) => i % 2 === 0);
      const ys = o.points.filter((_, i) => i % 2 === 1);
      return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    }
  }
}

/** The clip box of an attached area moving with a dragged token, on its scene's grid: the box DragMarks clips it by. */
export function movingAuraBox(a: AreaTemplate, ctx: AreaContext, scene: Pick<Scene, "id" | "gridShape">, scale: number): CellBox {
  const caught = caughtTokens(a, ctx, scene.id).flatMap((id) => ctx.tokens?.[id] ?? []);
  return auraBox(cachedCoverage(a, ctx), areaOutline(a, ctx), caught, scale, sceneGrid(scene));
}

/**
 * The moving marks of tokens being dragged (docs/design-v1-isometric-view.md
 * 5.1): each one's range rings, attached areas (auras) and tethers, which
 * leave the ground stage while it is dragged and come back at the drop.
 * Each stands at the drawn ground under its token's footprint where the
 * drag would drop it, on a ground plane lifted to that height. Rings are
 * above the fog in Top-down and draw whole. An aura or a tether lies under
 * the fog in Top-down, so it draws clipped to this viewer's revealed
 * sub-cells (canvas/markStand.ts), losing the fog's edge tint and the sight
 * shading over it, the cosmetic loss the design accepts.
 *
 * It draws in view space, in whatever group it is mounted in, given its own
 * token ids: the overlay for other members' drags, and the drag layer for
 * this device's own, under the standees the drag moves there
 * (canvas/dragLayer.ts), so its frames redraw that layer alone.
 *
 * An aura whose volume stands (docs/design-v1-iso-area-shapes.md 4.5)
 * stands with it, coarse, built again at each cell the drop crosses. Dragged
 * here it draws in two passes around the dragged standee: `side` "behind",
 * mounted under the standees, draws every flat mark and the bands behind
 * the standee's natural key, and "front", mounted over them, the bands at
 * or in front of it, so the creature reads inside its own aura. Another
 * member's drag draws it whole on the overlay.
 */
export const DragMarks = memo(function DragMarks(props: { tokenIds: readonly string[]; iso: IsoGround; layer: LayerProps; side?: "behind" | "front" }) {
  const { iso, layer, side } = props;
  const board = useContext(IsoAreasContext);
  const world = board?.world ?? null;
  // In view space whatever place mounts it, so its lifts and pills stand from there.
  const upright = useMemo<IsoGround>(() => ({ ...iso, place: "upright" }), [iso]);
  const ids = useMemo(() => new Set(props.tokenIds), [props.tokenIds]);
  // Where each drag would drop its token, as Top-down's marks follow it.
  const areas = useAreaParts(layer, "live", null);
  const { tokens } = useLiveTokens();
  const stored = useTreeShownView((s) => s.view?.tokens ?? EMPTY_TOKENS);
  const templates = useTreeShownView((s) => s.view?.templates ?? EMPTY_TEMPLATES);
  const feetPerCell = useTreeShownView((s) => s.view?.meta.settings.feetPerCell ?? 5);
  const diagonal = useTreeShownView((s) => s.view?.meta.settings.diagonal ?? "five");
  const rules = useMemo<DistanceRules>(() => ({ feetPerCell, diagonal }), [feetPerCell, diagonal]);
  // The scene's grid, as Top-down's marks read it (hex grids 4.2).
  const grid = sceneGrid(layer.scene);
  const lines = useMemo(() => (ids.size === 0 ? [] : tethers(grid, tokens, layer.scene.id).filter((l) => ids.has(l.id) || ids.has(l.holderId))), [grid, tokens, layer.scene.id, ids]);
  if (ids.size === 0 || !areas) return null;
  const groundOf = (t: Token) => {
    const r = footprintRect(grid, t);
    return boxGround(iso, { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });
  };
  const moving = [...ids].flatMap((id) => {
    const t = tokens[id];
    return t && t.sceneId === layer.scene.id ? [t] : [];
  });
  const auraOf = (t: Token, a: AreaTemplate) => {
    if (!world) return null;
    // Its standee's natural key at the cell the drag would drop it on (buckets.ts).
    const fp = footprint(t);
    const split = side ? { key: sortKey(iso.turn, t.x + fp.w / 2, t.y + fp.h / 2), part: side } : undefined;
    return <WholeVolume key={`v${a.id}`} req={{ template: a, ctx: areas.ctx, banded: side !== undefined }} id={`drag:${a.id}`} look={{ color: a.color, dm: a.visibility === "dm", selected: false, preview: false }} turn={iso.turn} world={world} {...(split ? { side: split } : {})} />;
  };
  if (side === "front") {
    return (
      <Group listening={false}>
        {moving.flatMap((t) => Object.values(templates).filter((a): a is AreaTemplate => !!a && a.sceneId === layer.scene.id && a.attachedTo === t.id).map((a) => auraOf(t, a)))}
      </Group>
    );
  }
  return (
    <IsoGroundContext.Provider value={upright}>
      <Group listening={false}>
        {moving.map((t) => {
          const z = groundOf(t);
          const attached = Object.values(templates).filter((a): a is AreaTemplate => !!a && a.sceneId === layer.scene.id && a.attachedTo === t.id);
          return (
            <Group key={t.id}>
              {attached.map((a) => {
                const box = movingAuraBox(a, areas.ctx, layer.scene, layer.scale);
                return (
                  <PlacedArea
                    key={a.id}
                    template={a}
                    {...areas}
                    scale={layer.scale}
                    sceneId={layer.scene.id}
                    dm={layer.role === "dm"}
                    mode="moving"
                    fog={iso.fog}
                    moving={{ z, clip: auraClip(iso.fog, box) }}
                  />
                );
              })}
              {attached.map((a) => auraOf(t, a))}
              {(t.rangeRings?.length ?? 0) > 0 ? (
                <>
                  <Lift z={z}>
                    <TokenRings token={t} rules={rules} grid={grid} bounds={layer.scene.bounds} scale={layer.scale} part="rings" />
                  </Lift>
                  <TokenRings token={t} rules={rules} grid={grid} bounds={layer.scene.bounds} scale={layer.scale} part="labels" z={z} />
                </>
              ) : null}
            </Group>
          );
        })}
        {lines.map((l) => {
          // At the dragged end's height: the holder's when it moves, as it carries the other.
          const lead = tokens[ids.has(l.holderId) ? l.holderId : l.id];
          // Its stroke's half width with its round caps, so neither paints over a fogged sub-cell beside the line.
          const show = tetherShows(iso.fog, l.from, l.to, tetherPx(layer.scale) / 2 / layer.scale);
          const line = <TetherLine line={l} holder={stored[l.holderId]} scale={layer.scale} />;
          return (
            <Lift key={l.id} z={lead ? groundOf(lead) : 0}>
              {show.whole ? line : <Clipped rects={show.clip}>{line}</Clipped>}
            </Lift>
          );
        })}
      </Group>
    </IsoGroundContext.Provider>
  );
});
