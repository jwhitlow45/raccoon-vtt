import { memo, useMemo } from "react";
import { Group } from "react-konva";
import type { AreaTemplate, RoomState, Token } from "#shared/model.ts";
import type { CoverageResult } from "#shared/rules/aoe.ts";
import { footprintRect, type FootprintToken } from "#shared/rules/footprint.ts";
import { cachedCoverage, caughtTokens, coveredWindow } from "../features/areas/coverage.ts";
import { ringReach } from "../features/areas/draw.tsx";
import { useLiveTokens } from "../features/areas/useLiveTokens.ts";
import { CAUGHT_RING, Clipped, PlacedArea, useAreaParts } from "../features/areas/TemplateLayer.tsx";
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
import { sceneGrid, type Grid } from "#shared/rules/grid.ts";

const EMPTY_TEMPLATES: RoomState["templates"] = {};
const EMPTY_TOKENS: RoomState["tokens"] = {};
/** How far past an aura's covered window its outline and its stroke can reach, in cells. */
const AURA_MARGIN = 2;

/**
 * The box an aura moving with a dragged token paints, in cells: its covered
 * window grown by its outline's reach, and each creature it catches, whose
 * ring can stand cells past the window (a Gargantuan caught by one corner
 * cell), with the ring's gap and stroke at this zoom. An aura shows whole
 * only when every sub-cell of it is revealed (markStand.ts auraClip).
 */
export function auraBox(cov: Pick<CoverageResult, "x0" | "y0" | "w" | "h" | "hexes">, caught: readonly FootprintToken[], scale: number, grid: Grid): CellBox {
  // On hexes the window is where the covered hexes lie (coverage.ts coveredWindow).
  const win = coveredWindow(cov, grid);
  const box = { x0: win.x0 - AURA_MARGIN, y0: win.y0 - AURA_MARGIN, x1: win.x0 + win.w + AURA_MARGIN, y1: win.y0 + win.h + AURA_MARGIN };
  const reach = ringReach(scale, CAUGHT_RING.widthPx, CAUGHT_RING.gapPx);
  for (const t of caught) {
    const r = footprintRect(grid, t);
    box.x0 = Math.min(box.x0, r.x - reach);
    box.y0 = Math.min(box.y0, r.y - reach);
    box.x1 = Math.max(box.x1, r.x + r.w + reach);
    box.y1 = Math.max(box.y1, r.y + r.h + reach);
  }
  return box;
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
 */
export const DragMarks = memo(function DragMarks(props: { tokenIds: readonly string[]; iso: IsoGround; layer: LayerProps }) {
  const { iso, layer } = props;
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
  const lines = useMemo(() => (ids.size === 0 ? [] : tethers(tokens, layer.scene.id).filter((l) => ids.has(l.id) || ids.has(l.holderId))), [tokens, layer.scene.id, ids]);
  // The scene's grid, as Top-down's marks read it (hex grids 4.2).
  const grid = sceneGrid(layer.scene);
  if (ids.size === 0 || !areas) return null;
  const groundOf = (t: Token) => {
    const r = footprintRect(grid, t);
    return boxGround(iso, { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });
  };
  const moving = [...ids].flatMap((id) => {
    const t = tokens[id];
    return t && t.sceneId === layer.scene.id ? [t] : [];
  });
  return (
    <IsoGroundContext.Provider value={upright}>
      <Group listening={false}>
        {moving.map((t) => {
          const z = groundOf(t);
          const attached = Object.values(templates).filter((a): a is AreaTemplate => !!a && a.sceneId === layer.scene.id && a.attachedTo === t.id);
          return (
            <Group key={t.id}>
              {attached.map((a) => {
                const caught = caughtTokens(a, areas.ctx, layer.scene.id).flatMap((id) => areas.ctx.tokens?.[id] ?? []);
                const box = auraBox(cachedCoverage(a, areas.ctx), caught, layer.scale, grid);
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
              {(t.rangeRings?.length ?? 0) > 0 ? (
                <>
                  <Lift z={z}>
                    <TokenRings token={t} rules={rules} bounds={layer.scene.bounds} scale={layer.scale} part="rings" />
                  </Lift>
                  <TokenRings token={t} rules={rules} bounds={layer.scene.bounds} scale={layer.scale} part="labels" z={z} />
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
