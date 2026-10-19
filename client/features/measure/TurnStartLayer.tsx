import { memo, useMemo } from "react";
import { Circle, Ellipse, Group, Line } from "react-konva";
import { footprintRect } from "#shared/rules/footprint.ts";
import { halvedAt, speedAreas } from "#shared/rules/walkWorld.ts";
import { usePublishPills } from "../../canvas/boardView.ts";
import { measureLabel } from "../../canvas/measureText.ts";
import { boardSizes } from "../../lib/boardScale.ts";
import { overlaps, type Box } from "../../lib/boardText.ts";
import { displayName } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import type { LayerProps } from "../layers.ts";
import { ellipseExit, halvedSpeeds, movementText, speedsLeft, turnTrail, type MovingToken, type Speeds, type TurnTrail } from "./movement.ts";
import { Pill, pillPlace } from "./Pill.tsx";
import type { DistanceRules, Point } from "./ruler.ts";

/**
 * Where the active creature has been this turn (features sections 4 and
 * 10), on the overlay layer: a ring where its turn began, a dashed line
 * through every stop with a dot at each corner, and how far it has moved
 * with what is left of its speeds. The table reads off it which squares
 * the creature crossed, for opportunity attacks.
 *
 * The path comes from the shared state, so every device and a reload draw
 * the same trail. The server sends a player a path only for a creature
 * they see now, on a turn whose row they see, and only the stops they
 * could see (design 7.3), so whatever arrives may be drawn above the fog.
 * It clears when the turn passes, because the path then belongs to an
 * earlier turn.
 *
 * A leg marked as not counting, such as a shove, is drawn faint and left
 * out of the distance.
 *
 * Speeds are on the creature's actor, which only the DM and its owners
 * receive (design 7.3), so everyone else reads only the feet moved. They
 * also read what the turn used where it differs ("Moved 25 ft, used 35
 * ft"), and what is left by the Speed the creature has where it stands,
 * halved inside a Half Speed area that affects it
 * (docs/design-v1-movement.md 3.2 and 4.2).
 */

const LINE_PX = 2.5;
const HALO_PX = 5;
const DOT_PX = 3.5;
/** How faint a leg that does not count is drawn. */
const UNCOUNTED_OPACITY = 0.4;

export const TurnStartLayer = memo(function TurnStartLayer(props: LayerProps) {
  const encounter = useRoomView((s) => s.view?.encounter);
  const role = useRoomView((s) => s.you?.role ?? "player");
  const activeTokenId = useRoomView((s) => {
    const e = s.view?.encounter;
    return e?.entries.find((entry) => entry.id === e.activeEntryId)?.tokenId;
  });
  const token = useRoomView((s) => (activeTokenId ? s.view?.tokens[activeTokenId] : undefined));
  const speeds = useRoomView((s): Speeds | undefined => {
    if (!token) return undefined;
    return "inline" in token.actor ? token.actor.inline.speeds : s.view?.characters[token.actor.ref]?.actor.speeds;
  });
  const feetPerCell = useRoomView((s) => s.view?.meta.settings.feetPerCell ?? 5);
  const diagonal = useRoomView((s) => s.view?.meta.settings.diagonal ?? "five");
  const rules = useMemo<DistanceRules>(() => ({ feetPerCell, diagonal }), [feetPerCell, diagonal]);
  const trail = useMemo(() => turnTrail({ encounter, sceneId: props.scene.id, token, rules, role }), [encounter, props.scene.id, token, rules, role]);
  const templates = useRoomView((s) => s.view?.templates);
  const halved = useRoomView((s) => {
    // Only a viewer who knows the speeds reads them, and a Half Speed area halves them where the creature stands.
    if (!s.view || !token || !speeds || !templates || !Object.values(templates).some((t) => t?.slows?.kind === "halfSpeed")) return false;
    return halvedAt(speedAreas(s.view, token, { role }), token, token) !== null;
  });
  const scale = props.scale;
  const marker = useMemo(() => {
    if (!trail || !token) return null;
    const value = movementText(trail.movedFt, speedsLeft(halved ? halvedSpeeds(speeds) : speeds, token.elevation, trail.usedFt), trail.usedFt);
    return markerPlace({ from: trail.from, token, value, scale });
  }, [trail, token, speeds, halved, scale]);
  // Token labels keep off the marker (useBoardText.ts).
  const spec = marker ? { x: marker.x, y: marker.y, value: marker.value, size: "screen" as const, small: true, below: marker.below, above: !marker.below } : null;
  const specKey = spec ? JSON.stringify(spec) : "";
  usePublishPills("turnStart", useMemo(() => (spec ? [spec] : []), [specKey]));
  if (!trail || !token || !marker) return null;

  const { from } = trail;
  const color = theme.color.accentSoft;
  return (
    <>
      <Ellipse
        x={from.x + from.w / 2}
        y={from.y + from.h / 2}
        radiusX={from.w / 2}
        radiusY={from.h / 2}
        stroke={color}
        strokeWidth={LINE_PX}
        strokeScaleEnabled={false}
        dash={[6, 4]}
        listening={false}
      />
      <TrailLines trail={trail} color={color} scale={scale} />
      <Pill x={marker.x} y={marker.y} scale={scale} value={marker.value} size="screen" color={color} small below={marker.below} above={!marker.below} />
    </>
  );
});

/**
 * The move marker hangs under the ring where the turn began, or over it
 * when that would cover the creature or the band its name hangs in, as
 * when it has moved one square down. The name's band is estimated from
 * the token alone, never from where its label went, since the label keeps
 * off the marker (useBoardText.ts).
 */
function markerPlace(input: { from: { x: number; y: number; w: number; h: number }; token: MovingToken & { name: string; number?: number }; value: string; scale: number }) {
  const { from, token, value, scale } = input;
  const fp = footprintRect(token);
  const sizes = boardSizes(scale);
  const nameHalf = Math.min(measureLabel(displayName(token), sizes.namePx) / 2 + 4, 120) / scale;
  const cx = fp.x + fp.w / 2;
  const band: Box = { x0: Math.min(fp.x, cx - nameHalf), y0: fp.y, x1: Math.max(fp.x + fp.w, cx + nameHalf), y1: fp.y + fp.h + (3 * sizes.namePx * 1.2 + 12) / scale };
  const at = (below: boolean) => {
    const place = pillPlace({ x: from.x + from.w / 2, y: below ? from.y + from.h : from.y, scale, value, size: "screen", small: true, below, above: !below }, null);
    return { ...place, below, value };
  };
  const under = at(true);
  if (!overlaps(under.box, band)) return under;
  const over = at(false);
  return overlaps(over.box, band) ? under : over;
}

/**
 * The legs between footprint centers, each stop's footprint at the size
 * the creature had there, through the corners of the route each walked,
 * the first and last cut back to the round edges of the start ring and the
 * token so the line never crosses their art, and a dot at each stop, never
 * at a route's corners. A resize that kept the middle leaves no line.
 */
function TrailLines(props: { trail: TurnTrail; color: string; scale: number }) {
  const { trail, color, scale } = props;
  const centers = trail.rects.map(center);
  const last = centers.length - 1;
  return (
    <>
      {trail.legs.map((leg, i) => {
        const r = trail.rects[i + 1]!;
        const bends = leg.via.map((p) => ({ x: p.x + r.w / 2, y: p.y + r.h / 2 }));
        const a = i === 0 ? ellipseExit(trail.from, bends[0] ?? centers[1]!) : centers[i]!;
        const b = i + 1 === last ? ellipseExit(trail.to, bends[bends.length - 1] ?? centers[last - 1]!) : centers[i + 1]!;
        // Overlapping footprints, as after a short step or a climb in place, leave no gap to draw a line in.
        if (bends.length === 0 && Math.hypot(b.x - a.x, b.y - a.y) <= 0.05) return null;
        const points = [a, ...bends, b].flatMap((p) => [p.x, p.y]);
        return (
          <Group key={i} opacity={leg.counted ? 1 : UNCOUNTED_OPACITY} listening={false}>
            <Line points={points} stroke={theme.color.textHalo} opacity={0.45} strokeWidth={HALO_PX} strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
            <Line points={points} stroke={color} strokeWidth={LINE_PX} strokeScaleEnabled={false} lineCap="round" lineJoin="round" dash={[2, 6]} />
          </Group>
        );
      })}
      {centers.slice(1, last).map((c, i) => (
        <Circle key={i} x={c.x} y={c.y} radius={DOT_PX / scale} fill={color} stroke={theme.color.textHalo} strokeWidth={1.5} strokeScaleEnabled={false} listening={false} />
      ))}
    </>
  );
}

function center(r: { x: number; y: number; w: number; h: number }): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}
