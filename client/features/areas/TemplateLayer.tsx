import { memo, useMemo, type ReactNode } from "react";
import { Group } from "react-konva";
import type { AreaTemplate, RoomState, Token } from "#shared/model.ts";
import type { AreaContext } from "#shared/rules/aoe.ts";
import type { LayerProps } from "../layers.ts";
import { useBoardPillsExcept, usePublishPills } from "../../canvas/boardView.ts";
import { useDraggedIds } from "../../canvas/draggedIds.ts";
import { Lift, MarkPill } from "../../canvas/IsoParts.tsx";
import { drawsHere } from "../../canvas/isoPlace.ts";
import { pillStands } from "../../canvas/markStand.ts";
import { measureLabel } from "../../canvas/measureText.ts";
import type { FogView } from "../../canvas/relief/fogView.ts";
import { useIsoGround, useTreeShownStore, useTreeShownView } from "../../canvas/relief/context.ts";
import { Pill, pillGeometry, pillReach } from "../measure/Pill.tsx";
import { areaTitle } from "./labels.ts";
import { cachedCoverage, caughtTokens, contextFrom } from "./coverage.ts";
import { OutlineShape, Shading, TokenRing } from "./draw.tsx";
import { areaLabelSpot, foggedCells, tokenBoxes, type Box } from "./labelSpot.ts";
import { areaOutline, liveOrigin, outlineBottom, outlineTop, type Outline } from "./placement.ts";
import { samplesNow, useAreaScope } from "./store.ts";
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
 * In Isometric an area lies on the ground stage, and its name stands on the
 * overlay by the stand rule, else lies flat under the fog with the area
 * (docs/design-v1-isometric-view.md 5.2 and 5.3). An area attached to a
 * token being dragged leaves the ground for the drag's moving marks until
 * the drop (canvas/DragMarks.tsx), so a drag never redraws the ground.
 *
 * It only draws. The reminders that an area hits a creature again, and
 * the count of selection changes for the area tool, run in the board's
 * area controller (AreaController.ts), mounted once outside both drawing
 * trees (docs/design-v1-isometric-view.md 5.1).
 */

const EMPTY_TEMPLATES: RoomState["templates"] = {};
const EMPTY_TOKENS: RoomState["tokens"] = {};
const EMPTY_CHUNKS: RoomState["buildChunks"] = {};
const EMPTY_TILES: RoomState["fogTiles"] = {};

export const TemplateLayer = memo(function TemplateLayer(props: LayerProps) {
  const { scene, scale, role } = props;
  const templates = useTreeShownView((s) => s.view?.templates ?? EMPTY_TEMPLATES);
  // The template being moved or turned is drawn by the preview layer until its update lands.
  const editing = useTreeShownStore(useAreaScope().store, (s) => (s.live ? s.selectedId : null));
  const iso = useIsoGround();
  // In Isometric what moves with a dragged token draws as the drag's moving marks instead (canvas/DragMarks.tsx).
  const dragged = useDraggedIds();
  const list = useMemo(
    () => Object.values(templates).filter((t): t is AreaTemplate => !!t && t.sceneId === scene.id && t.id !== editing && !(iso && t.attachedTo !== undefined && dragged.all.has(t.attachedTo))),
    [templates, scene.id, editing, iso, dragged],
  );
  // In Isometric the still areas read where tokens stand, not where drags would drop them, so a drag changes nothing on the ground stage.
  const areas = useAreaParts(props, iso === null ? "live" : "stored", iso ? dragged.all : null);
  if (!areas || list.length === 0) return null;
  const mode = iso ? iso.place : "topDown";
  return (
    <Group listening={false}>
      {list.map((t) => (
        <PlacedArea key={t.id} template={t} {...areas} scale={scale} sceneId={scene.id} dm={role === "dm"} mode={mode} fog={iso?.fog ?? null} />
      ))}
    </Group>
  );
});

/**
 * What every placed area reads to draw and to place its name: the coverage
 * context, and where names keep off. Null until the room's settings
 * arrive. `tokens` "live" counts tokens being dragged where they would
 * drop, so an aura and its rings follow the drag, as Top-down draws them.
 * "stored" reads where they stand, sampled finely, for the isometric
 * ground stage, which a drag must not redraw: there the dragged tokens'
 * own rings in still areas wait for the drop (`hide`), and their attached
 * areas move with the drag (canvas/DragMarks.tsx).
 */
export function useAreaParts(
  props: Pick<LayerProps, "scene" | "scale" | "role" | "fog">,
  which: "live" | "stored",
  hide: ReadonlySet<string> | null,
): {
  ctx: AreaContext;
  avoid: readonly Box[];
  fogged: ((cx: number, cy: number) => boolean) | undefined;
} | null {
  const { scene, scale, role, fog } = props;
  // Tokens being dragged count where they would drop, so an aura follows its token during the drag.
  const live = useLiveTokens();
  const stored = useTreeShownView((s) => s.view?.tokens ?? EMPTY_TOKENS);
  const shown = which === "live" ? live.tokens : stored;
  const moving = which === "live" && live.moving;
  const tokens = useMemo(() => (hide && hide.size > 0 ? withoutTokens(shown, hide) : shown), [shown, hide]);
  const buildChunks = useTreeShownView((s) => s.view?.buildChunks ?? EMPTY_CHUNKS);
  const settings = useTreeShownView((s) => s.view?.meta.settings);
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
  const fogTiles = useTreeShownView((s) => s.view?.fogTiles ?? EMPTY_TILES);
  const fogged = useMemo(() => (role === "player" && fog ? foggedCells(fogTiles, scene.id, scene.bounds) : undefined), [role, fog, fogTiles, scene.id, scene.bounds]);
  return useMemo(() => (ctx ? { ctx, avoid, fogged } : null), [ctx, avoid, fogged]);
}

function withoutTokens(tokens: Readonly<Record<string, Token | undefined>>, hide: ReadonlySet<string>): Record<string, Token> {
  const out: Record<string, Token> = {};
  for (const [id, t] of Object.entries(tokens)) if (t && !hide.has(id)) out[id] = t;
  return out;
}

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

/**
 * Where a placed area draws: as Top-down draws it, on the isometric
 * ground stage, its standing name on the overlay, or as a dragged token's
 * moving mark (canvas/DragMarks.tsx).
 */
export type AreaMode = "topDown" | "ground" | "upright" | "moving";

/** Shading is cached per coverage key, so a memo keeps a still area's shape, and the ground stage, from redrawing as a drag crosses cells. */
const StillShading = memo(Shading);

export const PlacedArea = memo(function PlacedArea(props: {
  template: AreaTemplate;
  ctx: AreaContext;
  scale: number;
  sceneId: string;
  dm: boolean;
  avoid: readonly Box[];
  fogged: ((cx: number, cy: number) => boolean) | undefined;
  mode: AreaMode;
  /** This viewer's fog for the stand rule, in Isometric. */
  fog: FogView | null;
  /** In the moving mode: the drawn height it moves at, and the revealed sub-cells it shows in, null when it shows whole. */
  moving?: { z: number; clip: readonly { x: number; y: number; w: number; h: number }[] | null };
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
  // Token labels keep off the name (useBoardText.ts). Every place it draws in publishes the same pill under its one key.
  usePublishPills(`area:${t.id}`, useMemo(() => [spec], [spec]));
  const iso = useIsoGround();
  const shapes = (
    <>
      <StillShading cov={cov} color={t.color} opacity={0.26} />
      {outline ? <OutlineShape outline={outline} color={t.color} widthPx={2} dash={hidden ? [6, 4] : undefined} /> : null}
      {caught.map((id) => {
        const token = ctx.tokens?.[id];
        return token ? <TokenRing key={id} token={token} color={t.color} scale={scale} widthPx={3} gapPx={3} /> : null;
      })}
    </>
  );
  if (props.mode === "topDown") {
    return (
      <Group opacity={hidden ? 0.6 : 1}>
        {shapes}
        <Pill {...spec} scale={scale} color={t.color} />
      </Group>
    );
  }
  // Top-down draws the name under the fog, so it stands only where every sub-cell its box can reach is revealed (5.2).
  const stands = props.fog ? pillStands(props.fog, { ...spec, scale }) : true;
  const pill = <MarkPill {...spec} z={props.moving?.z ?? (iso ? iso.ground(spec.x, spec.y) : 0)} scale={scale} color={t.color} />;
  if (props.mode === "moving") {
    const clip = props.moving?.clip ?? null;
    return (
      <Group opacity={hidden ? 0.6 : 1}>
        <Lift z={props.moving?.z ?? 0}>{clip ? <Clipped rects={clip}>{shapes}</Clipped> : shapes}</Lift>
        {/* A name that does not stand is left out while it moves: it cannot lie under the fog, and shows less, never more. */}
        {stands ? pill : null}
      </Group>
    );
  }
  return (
    <Group opacity={hidden ? 0.6 : 1}>
      {props.mode === "ground" ? shapes : null}
      {drawsHere({ place: props.mode }, stands) ? pill : null}
    </Group>
  );
});

/** Children shown only inside `rects`, in cells: an aura moving over fog shows only in the revealed sub-cells (canvas/markStand.ts). */
export function Clipped(props: { rects: readonly { x: number; y: number; w: number; h: number }[]; children: ReactNode }) {
  const { rects } = props;
  return (
    <Group
      listening={false}
      clipFunc={(ctx) => {
        ctx.beginPath();
        for (const r of rects) ctx.rect(r.x, r.y, r.w, r.h);
      }}
    >
      {props.children}
    </Group>
  );
}
