import { memo, useContext, useMemo } from "react";
import { Circle, Group, Line } from "react-konva";
import type { AreaTemplate, DiagonalRule, RoomState, Token } from "#shared/model.ts";
import { PREVIEW_SAMPLES, resolveArea, type AreaContext, type AreaTemplateInput, type CoverageResult } from "#shared/rules/aoe.ts";
import { boxDistanceFt, pointCellBox, tokenCellBox } from "#shared/rules/distance.ts";
import { footprintRect } from "#shared/rules/footprint.ts";
import type { Grid } from "#shared/rules/grid.ts";
import { Lift, MarkPill } from "../../canvas/IsoParts.tsx";
import { useIsoGround, useTreeShownStore, useTreeShownView } from "../../canvas/relief/context.ts";
import type { FogView } from "../../canvas/relief/fogView.ts";
import { UprightDash, WholeVolume } from "../../canvas/relief/VolumeShape.tsx";
import { useViewerFog } from "../../canvas/viewerFog.ts";
import { theme } from "../../lib/theme.ts";
import type { AoePreview } from "../../state/types.ts";
import type { LayerProps } from "../layers.ts";
import { formatFeet } from "../measure/ruler.ts";
import { cachedCoverage, caughtTokens, contextFrom, shadingClip } from "./coverage.ts";
import { useLiveGround } from "./liveGround.ts";
import { OutlineShape, Shading, TokenRing } from "./draw.tsx";
import { Clipped, IsoAreasContext, useRingsUp } from "./TemplateLayer.tsx";
import { areaGrips, areaOutline, draftTemplate, frameTemplate, handlePoint, liveOrigin, outlineTop, usesFrom } from "./placement.ts";
import { canEdit, HANDLE_GAP_PX, samplesNow, useAreaScope, type AreaToolState } from "./store.ts";
import { useLiveTokens } from "./useLiveTokens.ts";

/**
 * Areas being aimed, on the overlay layer above the fog (design 13.3): this
 * device's own draft or the placed area it picked, with the creatures it
 * catches ringed and, where this viewer may change it, its grips
 * (placement.ts areaGrips), and the previews other members chose to share,
 * which carry geometry only.
 *
 * This device's own preview comes from the area tool's state rather than
 * from the ephemeral store's echo, because only the tool knows its caster
 * and whom it leaves out. While the finger moves, the shading samples
 * boundary cells at 4x4, and it refines to 16x16 when the finger rests.
 *
 * In Isometric an area being aimed draws in the drag layer on the ground,
 * lifted to the drawn height at its origin, its pills standing
 * (docs/design-v1-isometric-view.md 5.3). Its real shape stands with it
 * (docs/design-v1-iso-area-shapes.md 4.5): coarse and whole in the drag
 * layer while the finger moves, and once it rests the board stands it in
 * the depth list instead (relief/IsoBoard.tsx), with the rings of the
 * creatures it catches at their bases. Other members' previews stand
 * coarse and whole, never in the depth list. Each by the stand rule.
 *
 * Both views draw it above a player's fog. On a player's device it reads
 * only the walls they could know (coverage.ts heldWalls), and its shading
 * shows only on the sub-cells their fog reveals (coverage.ts shadingClip).
 * Its outline and grips read no wall and draw whole.
 */

const EMPTY_CHUNKS: RoomState["buildChunks"] = {};
const EMPTY_TEMPLATES: RoomState["templates"] = {};
const EMPTY_CASTS: RoomState["casts"] = {};

export const AreaPreviewLayer = memo(function AreaPreviewLayer(props: LayerProps) {
  const { scene, scale } = props;
  const aoes = useTreeShownView((s) => s.ephemeral.aoes);
  // Tokens being dragged count where they would drop, so an aimed area's targets follow them.
  const dragged = useLiveTokens();
  const tokens = dragged.tokens;
  const buildChunks = useTreeShownView((s) => s.view?.buildChunks ?? EMPTY_CHUNKS);
  const templates = useTreeShownView((s) => s.view?.templates ?? EMPTY_TEMPLATES);
  const settings = useTreeShownView((s) => s.view?.meta.settings);
  const members = useTreeShownView((s) => s.view?.members);
  const tool = useTreeShownView((s) => s.local.tool);
  const areaStore = useAreaScope().store;
  const draft = useTreeShownStore(areaStore, (s) => s.draft);
  const selectedId = useTreeShownStore(areaStore, (s) => s.selectedId);
  const live = useTreeShownStore(areaStore, (s) => s.live);
  const moving = useTreeShownStore(areaStore, (s) => s.moving);
  const role = useTreeShownView((s) => s.you?.role ?? "player");
  const youId = useTreeShownView((s) => s.you?.memberId ?? "");
  const casts = useTreeShownView((s) => s.view?.casts ?? EMPTY_CASTS);
  const fog = useViewerFog(props);
  const ground = useLiveGround(props.fog ? scene : undefined, role);

  // On a player's device the walls are the ones they could know (coverage.ts heldWalls), and the rings go only to creatures whose rays lie on their live ground (raysLive).
  const fine = useMemo(() => (settings ? contextFrom({ tokens, buildChunks, settings, live: ground }, scene, undefined, fog) : null), [tokens, buildChunks, settings, scene, fog, ground]);
  const coarse = useMemo(
    () => (settings ? contextFrom({ tokens, buildChunks, settings, live: ground }, scene, PREVIEW_SAMPLES, fog) : null),
    [tokens, buildChunks, settings, scene, fog, ground],
  );
  if (!fine || !coarse || !settings) return null;
  const aiming = samplesNow(moving || dragged.moving) === PREVIEW_SAMPLES;
  const ctx = aiming ? coarse : fine;

  const active = aimedArea({ tool, draft, selectedId, live, templates, sceneId: scene.id, tokens, grid: ctx.grid, feetPerCell: settings.feetPerCell, role, youId, casts });

  const remote = Object.entries(aoes).filter(([, a]) => !a.local);
  if (!active && remote.length === 0) return null;

  return (
    <Group listening={false}>
      {remote.map(([key, a]) => (
        <RemotePreview key={key} preview={a} id={key} ctx={coarse} fog={fog} scale={scale} color={members?.[a.from]?.color ?? theme.color.crest} name={members?.[a.from]?.name} />
      ))}
      {active ? <ActiveArea {...active} ctx={ctx} fog={fog} scale={scale} sceneId={scene.id} tokens={tokens} diagonal={settings.diagonal} aiming={aiming} /> : null}
    </Group>
  );
});

/** The area this device aims or edits with the Area tool: its draft, or the placed area it picked with any move or turn in progress. */
export type AimedArea = { t: AreaTemplateInput; color: string; shade: boolean; casterId?: string; pointShape: boolean; editable: boolean; id: string };

export function aimedArea(input: {
  tool: string;
  draft: AreaToolState["draft"];
  selectedId: string | null;
  live: AreaToolState["live"];
  templates: RoomState["templates"];
  sceneId: string;
  tokens: Record<string, Token>;
  grid: AreaContext["grid"];
  feetPerCell: number;
  role: "dm" | "player";
  youId: string;
  casts: RoomState["casts"];
}): AimedArea | null {
  const { tool, draft, selectedId, live } = input;
  if (tool === "area" && draft) {
    const t = draftTemplate(input.grid, draft, input.tokens, input.feetPerCell);
    return t ? { t, color: draft.color, shade: true, casterId: draft.casterId, pointShape: !usesFrom(draft.shape), editable: true, id: "draft" } : null;
  }
  if (tool === "area" && selectedId) {
    const placed = input.templates[selectedId];
    if (placed && placed.sceneId === input.sceneId) {
      const t = live ? ({ ...placed, ...live } as AreaTemplate) : placed;
      return { t, color: t.color, shade: !!live, pointShape: false, editable: canEdit({ role: input.role, youId: input.youId, view: { casts: input.casts } }, placed), id: placed.id };
    }
  }
  return null;
}

function ActiveArea(props: {
  t: AreaTemplateInput;
  color: string;
  shade: boolean;
  casterId?: string;
  pointShape: boolean;
  editable: boolean;
  id: string;
  ctx: AreaContext;
  fog: FogView;
  scale: number;
  sceneId: string;
  tokens: Record<string, Token>;
  diagonal: DiagonalRule;
  aiming: boolean;
}) {
  const { t, color, ctx, scale } = props;
  const outline = areaOutline(t, ctx);
  const iso = useIsoGround();
  const board = useContext(IsoAreasContext);
  // At rest its rings go to the bases of the creatures the board stands them at.
  const up = useRingsUp();
  const caught = caughtTokens(t, ctx, props.sceneId).filter((id) => !up.has(`${props.id}|${id}`));
  const o = liveOrigin(t, ctx);
  const grips = areaGrips(t.shape, props.editable);
  const handle = grips.handle ? handlePoint(t, ctx, HANDLE_GAP_PX / scale) : null;
  const caster = props.pointShape && props.casterId ? props.tokens[props.casterId] : undefined;
  const z = iso ? iso.ground(o.x, o.y) : 0;
  // The origin's own height, which the grip on the drawn ground below it reaches up to.
  const originZ = iso && grips.origin ? (resolveArea(t, ctx)?.originZ ?? z) : z;
  let range: { from: { x: number; y: number }; ft: number } | null = null;
  if (caster) {
    const r = footprintRect(ctx.grid, caster);
    const fpc = ctx.settings.feetPerCell;
    range = { from: { x: r.x + r.w / 2, y: r.y + r.h / 2 }, ft: boxDistanceFt(tokenCellBox(ctx.grid, caster, fpc), pointCellBox(ctx.grid, t.origin, fpc), { feetPerCell: fpc, diagonal: props.diagonal }) };
  }
  return (
    <>
      <Lift z={z}>
        {props.shade ? <ShadingAboveFog cov={cachedCoverage(t, ctx)} grid={ctx.grid} fog={props.fog} color={color} opacity={0.3} /> : null}
      </Lift>
      {iso && board?.world && props.aiming ? <WholeVolume req={{ template: t, ctx, banded: false }} id={props.id} look={{ color, dm: false, selected: true, preview: false }} turn={iso.turn} world={board.world} /> : null}
      {iso && originZ > z ? <UprightDash x={o.x} y={o.y} z0={z} z1={originZ} turn={iso.turn} color={color} /> : null}
      <Lift z={z}>
        {outline ? <OutlineShape outline={outline} color={theme.color.textHalo} widthPx={5} opacity={0.5} /> : null}
        {outline ? <OutlineShape outline={outline} color={color} widthPx={2.5} /> : null}
        {caught.map((id) => {
          const token = ctx.tokens?.[id];
          return token ? <TokenRing key={id} token={token} grid={ctx.grid} color={color} scale={scale} widthPx={3} gapPx={4} /> : null;
        })}
        {range ? <Line points={[range.from.x, range.from.y, o.x, o.y]} stroke={color} strokeWidth={2} strokeScaleEnabled={false} dash={[6, 5]} /> : null}
        {grips.origin ? <Circle x={o.x} y={o.y} radius={4 / scale} fill={color} stroke={theme.color.textHalo} strokeWidth={1.5} strokeScaleEnabled={false} /> : null}
        {handle ? (
          <>
            <Line points={[o.x, o.y, handle.x, handle.y]} stroke={color} strokeWidth={1.5} strokeScaleEnabled={false} dash={[3, 4]} opacity={0.8} />
            <Circle x={handle.x} y={handle.y} radius={11 / scale} fill={theme.color.overlay} stroke={color} strokeWidth={2.5} strokeScaleEnabled={false} />
            <Circle x={handle.x} y={handle.y} radius={4 / scale} fill={color} />
          </>
        ) : null}
      </Lift>
      {range ? <MarkPill x={(range.from.x + o.x) / 2} y={(range.from.y + o.y) / 2} z={z} scale={scale} value={formatFeet(range.ft)} size="map" color={color} small /> : null}
    </>
  );
}

function RemotePreview(props: { preview: AoePreview; id: string; ctx: AreaContext; fog: FogView; scale: number; color: string; name?: string }) {
  const { preview, ctx, scale, color } = props;
  const t = frameTemplate(preview);
  const outline = areaOutline(t, ctx);
  const iso = useIsoGround();
  const board = useContext(IsoAreasContext);
  const o = liveOrigin(t, ctx);
  const z = iso ? iso.ground(o.x, o.y) : 0;
  return (
    <>
      <Lift z={z}>
        <ShadingAboveFog cov={cachedCoverage(t, ctx)} grid={ctx.grid} fog={props.fog} color={color} opacity={0.18} />
        {outline ? <OutlineShape outline={outline} color={color} widthPx={2} dash={[8, 5]} /> : null}
      </Lift>
      {iso && board?.world ? <WholeVolume req={{ template: t, ctx, banded: false }} id={`preview:${props.id}`} look={{ color, dm: false, selected: false, preview: true }} turn={iso.turn} world={board.world} /> : null}
      {props.name && outline ? <MarkPill {...outlineTop(outline)} z={z} scale={scale} name={props.name} size="map" color={color} small above /> : null}
    </>
  );
}

/** An aimed area's shading, shown only on the sub-cells this viewer's fog reveals. */
function ShadingAboveFog(props: { cov: CoverageResult; grid: Grid; fog: FogView; color: string; opacity: number }) {
  const clip = shadingClip(props.fog, props.cov, props.grid);
  const shading = <Shading cov={props.cov} grid={props.grid} color={props.color} opacity={props.opacity} />;
  return clip ? <Clipped rects={clip}>{shading}</Clipped> : shading;
}
