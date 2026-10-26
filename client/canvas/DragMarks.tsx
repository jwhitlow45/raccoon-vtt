import { memo, useMemo } from "react";
import { Group } from "react-konva";
import type { AreaTemplate, RoomState, Token } from "#shared/model.ts";
import { footprintRect } from "#shared/rules/footprint.ts";
import { cachedCoverage } from "../features/areas/coverage.ts";
import { useLiveTokens } from "../features/areas/useLiveTokens.ts";
import { Clipped, PlacedArea, useAreaParts } from "../features/areas/TemplateLayer.tsx";
import { tethers } from "../features/attach/groups.ts";
import { TetherLine } from "../features/attach/TetherLayer.tsx";
import type { LayerProps } from "../features/layers.ts";
import { TokenRings } from "../features/measure/RangeRingLayer.tsx";
import type { DistanceRules } from "../features/measure/ruler.ts";
import { Lift } from "./IsoParts.tsx";
import { boxGround } from "./isoPlace.ts";
import { auraClip, tetherShows } from "./markStand.ts";
import { IsoGroundContext, useTreeShownView, type IsoGround } from "./relief/context.ts";

const EMPTY_TEMPLATES: RoomState["templates"] = {};
const EMPTY_TOKENS: RoomState["tokens"] = {};
/** How far past an aura's covered window its outline's stroke and its rings round caught creatures can reach, in cells. */
const AURA_MARGIN = 2;

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
  if (ids.size === 0 || !areas) return null;
  const groundOf = (t: Token) => {
    const r = footprintRect(t);
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
                const cov = cachedCoverage(a, areas.ctx);
                const box = { x0: cov.x0 - AURA_MARGIN, y0: cov.y0 - AURA_MARGIN, x1: cov.x0 + cov.w + AURA_MARGIN, y1: cov.y0 + cov.h + AURA_MARGIN };
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
          const show = tetherShows(iso.fog, l.from, l.to);
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
