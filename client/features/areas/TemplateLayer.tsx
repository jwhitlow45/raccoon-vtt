import { memo, useMemo } from "react";
import { Group } from "react-konva";
import type { AreaTemplate, RoomState } from "#shared/model.ts";
import type { AreaContext } from "#shared/rules/aoe.ts";
import { useRoomView } from "../../state/view.ts";
import type { LayerProps } from "../layers.ts";
import { useBoardPillsExcept, usePublishPills } from "../../canvas/boardView.ts";
import { measureLabel } from "../../canvas/measureText.ts";
import { Pill, pillGeometry, pillReach } from "../measure/Pill.tsx";
import { areaTitle } from "./labels.ts";
import { cachedCoverage, caughtTokens, contextFrom } from "./coverage.ts";
import { OutlineShape, Shading, TokenRing } from "./draw.tsx";
import { areaLabelSpot, foggedCells, tokenBoxes, type Box } from "./labelSpot.ts";
import { areaOutline, liveOrigin, outlineBottom, outlineTop, type Outline } from "./placement.ts";
import { samplesNow, useAreaTool } from "./store.ts";
import { useLiveTokens } from "./useLiveTokens.ts";

/**
 * Placed areas on the board layer (design section 14.2): each one's
 * covered cells shaded under the room's coverage rule, its outline, a ring
 * around every creature it catches, and its name.
 *
 * The board sits under the tokens and under the fog, so the rings show
 * around the tokens rather than over them, and a player never sees shading
 * through fogged ground. Shading is cached per coverage key (coverage.ts),
 * so moving a token redraws only the areas attached to it. A token being
 * dragged, here or on another device, counts at the cell it would drop on
 * (useLiveTokens.ts), so an aura and its rings follow it during the drag.
 *
 * It only draws. The reminders that an area hits a creature again, and
 * the count of selection changes for the area tool, run in the board's
 * area controller (AreaController.ts), mounted once outside both drawing
 * trees (docs/design-v1-isometric-view.md 5.1).
 */

const EMPTY_TEMPLATES: RoomState["templates"] = {};
const EMPTY_CHUNKS: RoomState["buildChunks"] = {};
const EMPTY_TILES: RoomState["fogTiles"] = {};

export const TemplateLayer = memo(function TemplateLayer(props: LayerProps) {
  const { scene, scale, role, fog } = props;
  const templates = useRoomView((s) => s.view?.templates ?? EMPTY_TEMPLATES);
  // Tokens being dragged count where they would drop, so an aura follows its token during the drag.
  const { tokens, moving } = useLiveTokens();
  const buildChunks = useRoomView((s) => s.view?.buildChunks ?? EMPTY_CHUNKS);
  const settings = useRoomView((s) => s.view?.meta.settings);
  // The template being moved or turned is drawn by the preview layer until its update lands.
  const editing = useAreaTool((s) => (s.live ? s.selectedId : null));
  const ctx = useMemo(
    () => (settings ? contextFrom({ tokens, buildChunks, settings }, scene, samplesNow(moving)) : null),
    [tokens, buildChunks, settings, scene, moving],
  );
  /*
   * Where the tokens and their names are on screen, and the other layers'
   * pills such as the move marker, so area names keep clear of them
   * (labelSpot.ts). Never other areas' names, and the marker never reads
   * area pills either, so no two pills chase each other.
   */
  const others = useBoardPillsExcept("area:");
  const avoid = useMemo(
    () => [
      ...tokenBoxes(Object.values(tokens).filter((t) => !!t && t.sceneId === scene.id), scale, measureLabel),
      // Each where the view could slide it (Pill.tsx pillReach), so a name never lands on a trap's name slid in from the edge.
      ...others.map((spec) => pillReach({ ...spec, scale })),
    ],
    [tokens, scene.id, scale, others],
  );
  // A player's names keep off the opaque fog as well, which would cut them off. The DM sees through it.
  const fogTiles = useRoomView((s) => s.view?.fogTiles ?? EMPTY_TILES);
  const fogged = useMemo(() => (role === "player" && fog ? foggedCells(fogTiles, scene.id, scene.bounds) : undefined), [role, fog, fogTiles, scene.id, scene.bounds]);
  if (!ctx) return null;
  const list = Object.values(templates).filter((t): t is AreaTemplate => !!t && t.sceneId === scene.id && t.id !== editing);
  if (list.length === 0) return null;
  return (
    <Group listening={false}>
      {list.map((t) => (
        <PlacedArea key={t.id} template={t} ctx={ctx} scale={scale} sceneId={scene.id} dm={role === "dm"} avoid={avoid} fogged={fogged} />
      ))}
    </Group>
  );
});

/**
 * The room an area's name takes for areaLabelSpot: its pill with the
 * pill's pointer, on two lines, and on one where that is shorter. The
 * pointer scales with the interface size as the pill does (pillGeometry),
 * so the spot is picked for the pill as drawn at every size.
 */
export function areaNameRoom(scale: number, name: string): { size: { width: number; height: number }; oneLineSize: { width: number; height: number } | undefined } {
  const pill = pillGeometry({ scale, name, size: "map", small: true });
  const short = pillGeometry({ scale, name, size: "map", small: true, maxLines: 1 });
  return {
    size: { width: pill.width, height: pill.height + pill.pointer },
    oneLineSize: short.height < pill.height ? { width: short.width, height: short.height + short.pointer } : undefined,
  };
}

/** How far an area's name may slide along its top or bottom edge each way, in cells: half its width. */
function outlineReach(o: Outline): number {
  if (o.kind === "circle") return o.r;
  if (o.kind === "roundRect") return o.w / 2;
  const xs = o.points.filter((_, i) => i % 2 === 0);
  return xs.length > 0 ? (Math.max(...xs) - Math.min(...xs)) / 2 : 0;
}

/**
 * The point `dx` cells along the top or bottom edge from its middle, on the
 * outline where it is round or flat. A cone or a line's name slides level,
 * since its edge is a slope.
 */
function outlineEdge(o: Outline, dx: number, side: "top" | "bottom"): { x: number; y: number } {
  const mid = side === "top" ? outlineTop(o) : outlineBottom(o);
  if (o.kind === "circle") {
    const h = Math.sqrt(Math.max(0, o.r * o.r - dx * dx));
    return { x: o.x + dx, y: side === "top" ? o.y - h : o.y + h };
  }
  return { x: mid.x + dx, y: mid.y };
}

function PlacedArea(props: {
  template: AreaTemplate;
  ctx: AreaContext;
  scale: number;
  sceneId: string;
  dm: boolean;
  avoid: readonly Box[];
  fogged: ((cx: number, cy: number) => boolean) | undefined;
}) {
  const { template: t, ctx, scale } = props;
  const cov = cachedCoverage(t, ctx);
  const outline = areaOutline(t, ctx);
  const caught = caughtTokens(t, ctx, props.sceneId);
  const hidden = t.visibility === "dm";
  const name = `${areaTitle(t)}${hidden && props.dm ? " (hidden)" : ""}`;
  const origin = liveOrigin(t, ctx);
  const room = areaNameRoom(scale, name);
  const spot = areaLabelSpot({
    top: outline ? outlineTop(outline) : origin,
    bottom: outline ? outlineBottom(outline) : origin,
    reach: outline ? outlineReach(outline) : 0,
    edge: outline ? (dx, side) => outlineEdge(outline, dx, side) : undefined,
    size: room.size,
    oneLineSize: room.oneLineSize,
    scale,
    avoid: props.avoid,
    ...(props.fogged ? { fogged: props.fogged } : {}),
  });
  const above = spot.place === "above";
  const maxLines: 1 | 2 = spot.oneLine ? 1 : 2;
  const spec = useMemo(
    () => ({ x: spot.x, y: spot.y, name, size: "map" as const, small: true, maxLines, above, below: !above }),
    [spot.x, spot.y, name, maxLines, above],
  );
  // Token labels keep off the name (useBoardText.ts).
  usePublishPills(`area:${t.id}`, useMemo(() => [spec], [spec]));
  return (
    <Group opacity={hidden ? 0.6 : 1}>
      <Shading cov={cov} color={t.color} opacity={0.26} />
      {outline ? <OutlineShape outline={outline} color={t.color} widthPx={2} dash={hidden ? [6, 4] : undefined} /> : null}
      {caught.map((id) => {
        const token = ctx.tokens?.[id];
        return token ? <TokenRing key={id} token={token} color={t.color} scale={scale} widthPx={3} gapPx={3} /> : null;
      })}
      <Pill {...spec} scale={scale} color={t.color} />
    </Group>
  );
}
