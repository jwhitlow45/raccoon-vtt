import { memo, useMemo } from "react";
import { Circle } from "react-konva";
import { useStore } from "zustand";
import type { BuildChunk, FogTile } from "#shared/model.ts";
import type { ViewToken } from "../lib/scene.ts";
import { localDragSlot } from "../state/localDrags.ts";
import { useScoped } from "../state/scope.ts";
import { useRoomView } from "../state/view.ts";
import { dropLanding, dropView } from "../features/movement/drop.ts";
import { useTreeShown } from "./relief/context.ts";
import { seenChunks } from "./relief/seenChunks.ts";
import { SHADOW_CORE, shadowShape, tokenLift } from "./tokenShadow.ts";

const EMPTY: Record<string, BuildChunk> = {};
const NO_TILES: Record<string, FogTile> = {};
const NO_BOUNDS = { w: 0, h: 0 };

/**
 * A token's shadow when it is above the ground (tokenShadow.ts), drawn in
 * the token's own group so it follows a drag. A token on the ground draws
 * nothing and keeps no node.
 *
 * The tokens layer draws token after token, and a shadow drawn in its
 * token's turn would fall over every token drawn before it. So the shadow
 * draws with "destination-over": under everything already on the layer's
 * canvas, and every token body drawn after it lands on top. Every shadow is
 * then under every body, and over the map, which is on a layer below.
 *
 * `at` is where a ghost of another member's drag stands. This device's own
 * drag is read from the cell its token is over (state/localDrags.ts), so the
 * shadow says what height the token would land at.
 *
 * A player reads only the ground they have seen (relief/seenChunks.ts), as
 * the height readout does, so a shadow never tracks heights under the fog.
 */
export const TokenShadow = memo(function TokenShadow(props: { token: ViewToken; w: number; h: number; at?: { x: number; y: number } }) {
  const { token, w, h } = props;
  const chunks = useRoomView((s) => s.view?.buildChunks ?? EMPTY);
  // In a hidden tree (relief/context.ts) a drag's cell is never read, so the drag does no landing search there.
  const shown = useTreeShown();
  const spot = useStore(useScoped(localDragSlot), (s) => (shown ? s.spots[token.id] : undefined));
  const at = props.at ?? spot;
  const ax = at?.x;
  const ay = at?.y;
  // Only a token being dragged reads the room, for the drop's landing: by its holder while it sits on one every player sees.
  const view = useRoomView((s) => (ax === undefined ? null : s.view));
  const role = useRoomView((s) => s.you?.role ?? "player");
  const fogged = useRoomView((s) => role === "player" && s.view?.scenes[token.sceneId]?.fogEnabled !== false);
  const tiles = useRoomView((s) => (fogged ? (s.view?.fogTiles ?? NO_TILES) : null));
  const bounds = useRoomView((s) => s.view?.scenes[token.sceneId]?.bounds ?? NO_BOUNDS);
  const lift = useMemo(() => {
    const ground = seenChunks({ chunks, sceneId: token.sceneId, bounds, fog: tiles });
    const spotAt = ax === undefined || ay === undefined ? undefined : { x: ax, y: ay };
    const landing = spotAt && view ? dropLanding({ ...dropView(view, role), buildChunks: ground }, token, spotAt) : undefined;
    return tokenLift(ground, token, spotAt, landing);
    // The fields that place the token, not the token itself, so a change of its HP reads no ground. The room only while dragged.
  }, [chunks, tiles, bounds, token.sceneId, token.x, token.y, token.size, token.w, token.h, token.squeeze, token.elevation, ax, ay, view, role]);
  const shape = shadowShape(lift, { w, h });
  if (!shape) return null;
  return (
    <Circle
      x={w / 2 + shape.offset}
      y={h / 2 + shape.offset}
      radius={1}
      scaleX={(w / 2) * shape.scale}
      scaleY={(h / 2) * shape.scale}
      rotation={Number.isFinite(token.rotation) ? token.rotation : 0}
      fillRadialGradientStartPoint={{ x: 0, y: 0 }}
      fillRadialGradientStartRadius={0}
      fillRadialGradientEndPoint={{ x: 0, y: 0 }}
      fillRadialGradientEndRadius={1}
      fillRadialGradientColorStops={[0, `rgba(0, 0, 0, ${shape.alpha})`, SHADOW_CORE, `rgba(0, 0, 0, ${shape.alpha * 0.85})`, 1, "rgba(0, 0, 0, 0)"]}
      globalCompositeOperation="destination-over"
      perfectDrawEnabled={false}
      listening={false}
    />
  );
});
