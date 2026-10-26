import { memo, useMemo } from "react";
import { Circle, Group, Line } from "react-konva";
import type { AreaTemplate, DiagonalRule, RoomState, Token } from "#shared/model.ts";
import { PREVIEW_SAMPLES, type AreaContext, type AreaTemplateInput } from "#shared/rules/aoe.ts";
import { boxDistanceFt, pointCellBox, tokenCellBox } from "#shared/rules/distance.ts";
import { footprintRect } from "#shared/rules/footprint.ts";
import { Lift, MarkPill } from "../../canvas/IsoParts.tsx";
import { useIsoGround, useTreeShownStore, useTreeShownView } from "../../canvas/relief/context.ts";
import { theme } from "../../lib/theme.ts";
import type { AoePreview } from "../../state/types.ts";
import type { LayerProps } from "../layers.ts";
import { formatFeet } from "../measure/ruler.ts";
import { cachedCoverage, caughtTokens, contextFrom } from "./coverage.ts";
import { OutlineShape, Shading, TokenRing } from "./draw.tsx";
import { areaGrips, areaOutline, draftTemplate, frameTemplate, handlePoint, liveOrigin, outlineTop, usesFrom } from "./placement.ts";
import { canEdit, HANDLE_GAP_PX, samplesNow, useAreaScope } from "./store.ts";
import { useLiveTokens } from "./useLiveTokens.ts";
import { SQUARES } from "#shared/rules/grid.ts";

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
 * (docs/design-v1-isometric-view.md 5.3).
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

  const fine = useMemo(() => (settings ? contextFrom({ tokens, buildChunks, settings }, scene) : null), [tokens, buildChunks, settings, scene]);
  const coarse = useMemo(
    () => (settings ? contextFrom({ tokens, buildChunks, settings }, scene, PREVIEW_SAMPLES) : null),
    [tokens, buildChunks, settings, scene],
  );
  if (!fine || !coarse || !settings) return null;
  const ctx = samplesNow(moving || dragged.moving) === PREVIEW_SAMPLES ? coarse : fine;

  let active: { t: AreaTemplateInput; color: string; shade: boolean; casterId?: string; pointShape: boolean; editable: boolean } | null = null;
  if (tool === "area" && draft) {
    const t = draftTemplate(draft, tokens, settings.feetPerCell);
    if (t) active = { t, color: draft.color, shade: true, casterId: draft.casterId, pointShape: !usesFrom(draft.shape), editable: true };
  } else if (tool === "area" && selectedId) {
    const placed = templates[selectedId];
    if (placed && placed.sceneId === scene.id) {
      const t = live ? ({ ...placed, ...live } as AreaTemplate) : placed;
      active = { t, color: t.color, shade: !!live, pointShape: false, editable: canEdit({ role, youId, view: { casts } }, placed) };
    }
  }

  const remote = Object.entries(aoes).filter(([, a]) => !a.local);
  if (!active && remote.length === 0) return null;

  return (
    <Group listening={false}>
      {remote.map(([key, a]) => (
        <RemotePreview key={key} preview={a} ctx={coarse} scale={scale} color={members?.[a.from]?.color ?? theme.color.crest} name={members?.[a.from]?.name} />
      ))}
      {active ? <ActiveArea {...active} ctx={ctx} scale={scale} sceneId={scene.id} tokens={tokens} diagonal={settings.diagonal} /> : null}
    </Group>
  );
});

function ActiveArea(props: {
  t: AreaTemplateInput;
  color: string;
  shade: boolean;
  casterId?: string;
  pointShape: boolean;
  editable: boolean;
  ctx: AreaContext;
  scale: number;
  sceneId: string;
  tokens: Record<string, Token>;
  diagonal: DiagonalRule;
}) {
  const { t, color, ctx, scale } = props;
  const outline = areaOutline(t, ctx);
  const caught = caughtTokens(t, ctx, props.sceneId);
  const o = liveOrigin(t, ctx);
  const grips = areaGrips(t.shape, props.editable);
  const handle = grips.handle ? handlePoint(t, ctx, HANDLE_GAP_PX / scale) : null;
  const caster = props.pointShape && props.casterId ? props.tokens[props.casterId] : undefined;
  const iso = useIsoGround();
  const z = iso ? iso.ground(o.x, o.y) : 0;
  let range: { from: { x: number; y: number }; ft: number } | null = null;
  if (caster) {
    const r = footprintRect(SQUARES, caster);
    const fpc = ctx.settings.feetPerCell;
    range = { from: { x: r.x + r.w / 2, y: r.y + r.h / 2 }, ft: boxDistanceFt(tokenCellBox(SQUARES, caster, fpc), pointCellBox(SQUARES, t.origin, fpc), { feetPerCell: fpc, diagonal: props.diagonal }) };
  }
  return (
    <>
      <Lift z={z}>
        {props.shade ? <Shading cov={cachedCoverage(t, ctx)} color={color} opacity={0.3} /> : null}
        {outline ? <OutlineShape outline={outline} color={theme.color.textHalo} widthPx={5} opacity={0.5} /> : null}
        {outline ? <OutlineShape outline={outline} color={color} widthPx={2.5} /> : null}
        {caught.map((id) => {
          const token = ctx.tokens?.[id];
          return token ? <TokenRing key={id} token={token} color={color} scale={scale} widthPx={3} gapPx={4} /> : null;
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

function RemotePreview(props: { preview: AoePreview; ctx: AreaContext; scale: number; color: string; name?: string }) {
  const { preview, ctx, scale, color } = props;
  const t = frameTemplate(preview);
  const outline = areaOutline(t, ctx);
  const iso = useIsoGround();
  const o = liveOrigin(t, ctx);
  const z = iso ? iso.ground(o.x, o.y) : 0;
  return (
    <>
      <Lift z={z}>
        <Shading cov={cachedCoverage(t, ctx)} color={color} opacity={0.18} />
        {outline ? <OutlineShape outline={outline} color={color} widthPx={2} dash={[8, 5]} /> : null}
      </Lift>
      {props.name && outline ? <MarkPill {...outlineTop(outline)} z={z} scale={scale} name={props.name} size="map" color={color} small above /> : null}
    </>
  );
}
