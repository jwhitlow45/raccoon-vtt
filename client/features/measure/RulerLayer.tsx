import type Konva from "konva";
import { memo, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Circle, Group, Line } from "react-konva";
import { useStore } from "zustand";
import type { Drawing, RoomState, Token } from "#shared/model.ts";
import { useDelayed } from "../../components/Loading.tsx";
import { footprint, snapPosition } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import type { DragPreview } from "../../state/types.ts";
import { useRoomView } from "../../state/view.ts";
import { turnMoverId } from "../attach/turns.ts";
import type { LayerProps } from "../layers.ts";
import { dropView, type DropView, type Role } from "../movement/drop.ts";
import { groupReading } from "../movement/preview.ts";
import { routeSlot, type DragRoute } from "../movement/store.ts";
import { markOwner } from "../pings/who.ts";
import { dragLabel, remoteReading, type DragRead, type SpeedLeft, type Speeds } from "./movement.ts";
import { Pill, PillStack } from "./Pill.tsx";
import { drawnPoints, formatFeet, keptStops, measureStops, type DistanceRules, type Point, type RulerStop } from "./ruler.ts";
import { useWalkMeasure } from "./useWalkMeasure.ts";
import { walkText, type WalkInput, type WalkMeasure } from "./walkRuler.ts";
import { useTrapCrossing } from "../traps/Crossing.tsx";

/**
 * Rulers and the distance a dragged token travels (design sections 7.6 and
 * 9.2), on the overlay layer.
 *
 * Every ruler in the store is drawn the same way, this device's own
 * included (the store echoes it), each in its measurer's color. The server
 * has already dropped any ruler frame anchored on a token this viewer may
 * not see, so whatever arrives may be drawn above the fog.
 *
 * Kept rulers are drawings of kind `ruler` in the room state, drawn here
 * the same way with a solid line, and faded on a DM's screen while only
 * DMs see them. The projection holds back from players any kept ruler on
 * a token they cannot see (design 7.3), so these may be drawn above the
 * fog too.
 *
 * Labels keep one size on screen at any zoom: they sit in groups scaled by
 * the inverse of the camera zoom.
 *
 * A dragged creature's line and label take the color of the speed band its
 * move falls in (features section 4): green within its speed, yellow within
 * a Dash, red past both. During a fight that is the active creature's path
 * this turn plus the leg being dragged (movement.ts dragReading). The label
 * says the same in words, so the color is never the only sign (dragColor).
 */

const EMPTY_TOKENS: Record<string, Token> = {};
const EMPTY_DRAWINGS: RoomState["drawings"] = {};
const LINE_PX = 3;
const HALO_PX = 6;
/** A leg shorter than this on screen gets no label of its own: the total says enough. */
const LEG_LABEL_MIN_PX = 56;

/** Green, yellow and red, as features section 4 names them, whatever the viewer's accent. */
const BAND_COLOR: Record<SpeedLeft["band"], string> = { walk: theme.color.success, dash: theme.color.crest, over: theme.color.danger };

/** A drag's line and label: its speed band's color, or the text color with no band to show, never the member's, whose crest yellow would read as a Dash. */
export function dragColor(left: SpeedLeft | null | undefined): string {
  return left ? BAND_COLOR[left.band] : theme.color.text;
}

type ReadDrag = (token: Token, to: Point, walk?: { corners: readonly Point[]; costFt?: number }) => DragRead;

export const RulerLayer = memo(function RulerLayer(props: LayerProps) {
  const rulers = useRoomView((s) => s.ephemeral.rulers);
  const drags = useRoomView((s) => s.ephemeral.drags);
  const tokens = useRoomView((s) => s.view?.tokens ?? EMPTY_TOKENS);
  const members = useRoomView((s) => s.view?.members);
  const settings = useRoomView((s) => s.view?.meta.settings);
  const youId = useRoomView((s) => s.you?.memberId ?? null);
  const encounter = useRoomView((s) => s.view?.encounter);
  const drawings = useRoomView((s) => s.view?.drawings ?? EMPTY_DRAWINGS);
  const characters = useRoomView((s) => s.view?.characters);
  const role = useRoomView((s) => s.you?.role ?? "player");
  // Walking rulers search the room itself, so only they read the whole view.
  const anyWalk = useRoomView((s) => Object.values(s.ephemeral.rulers).some((r) => r.walk) || Object.values(s.view?.drawings ?? {}).some((d) => d?.kind === "ruler" && d.walk === true));
  const view = useRoomView((s) => (anyWalk ? s.view : null));
  const groupRef = useRef<Konva.Group>(null);
  const localDrag = useLocalDrag(groupRef);
  // Only this device's own drag reads the room, for where its token lands: by its holder while it sits on one every player sees.
  const dragRoom = useRoomView((s) => (localDrag ? s.view : null));
  const dropRoom = useMemo(() => (dragRoom ? dropView(dragRoom, role) : undefined), [dragRoom, role]);
  const feetPerCell = settings?.feetPerCell ?? 5;
  const diagonal = settings?.diagonal ?? "five";
  const rules = useMemo<DistanceRules>(() => ({ feetPerCell, diagonal }), [feetPerCell, diagonal]);
  const route = useStore(useScoped(routeSlot), (s) => s.route);
  // The turn's walker: the active creature, or the controlled mount sharing its turn (docs/design-v1-attach.md 7.2).
  const activeTokenId = useRoomView((s) => turnMoverId(s.view) ?? null);
  const read = useMemo<ReadDrag>(() => {
    return (token, to, walk) => {
      // Speeds are the actor's, which only the DM and the creature's owners receive.
      const speeds: Speeds | undefined = "inline" in token.actor ? token.actor.inline.speeds : characters?.[token.actor.ref]?.actor.speeds;
      return remoteReading({ token, to, encounter, activeTokenId, speeds, rules, role }, walk);
    };
  }, [encounter, activeTokenId, characters, rules, role]);
  if (!settings) return <Group ref={groupRef} listening={false} />;
  const colorOf = (id: string) => members?.[id]?.color ?? theme.color.crest;
  const kept = Object.values(drawings).filter((d): d is Drawing => !!d && d.kind === "ruler" && d.sceneId === props.scene.id);

  return (
    <Group ref={groupRef} listening={false}>
      {kept.map((d) => (
        <KeptRuler
          key={d.id}
          drawing={d}
          tokens={tokens}
          rules={rules}
          scale={props.scale}
          color={members?.[d.ownerId]?.color ?? d.style.stroke}
          owner={markOwner({ from: d.ownerId, local: d.ownerId === youId }, members)}
          walk={d.walk && view ? { view, sceneId: props.scene.id, viewer: { role }, everything: role === "dm" && d.visibility === "dm" } : undefined}
        />
      ))}
      {Object.entries(rulers).map(([key, r]) =>
        r.walk && view ? (
          // Only the DM's own ruler, before it is shared, may read what players cannot see (docs/design-v1-movement.md 3.3).
          <WalkRuler
            key={key}
            stops={r.points}
            walk={{ view, sceneId: props.scene.id, viewer: { role }, everything: role === "dm" && r.local && !r.shared }}
            live={r.local}
            scale={props.scale}
            color={colorOf(r.from)}
            owner={markOwner(r, members)}
          />
        ) : (
          <Ruler key={key} stops={r.points} tokens={tokens} rules={rules} scale={props.scale} color={colorOf(r.from)} owner={markOwner(r, members)} />
        ),
      )}
      {Object.entries(drags).map(([key, d]) =>
        // This device's own drag is measured from Konva's node below. Another device of the same member counts as remote.
        d.ended || d.tokenId === localDrag?.tokenId ? null : (
          <RemoteDragMeasure key={key} drag={d} token={tokens[d.tokenId]} read={read} scale={props.scale} />
        ),
      )}
      {/* The route is this drag's, set as it starts: a rider's drag walks its mount, whose route and cost these are (docs/design-v1-attach.md 4.2). */}
      {route && tokens[route.tokenId] && (route.waiting || localDrag !== null) ? (
        <RouteMeasure route={route} token={tokens[route.tokenId]!} scale={props.scale} />
      ) : localDrag && tokens[localDrag.tokenId] ? (
        <DragMeasure
          token={tokens[localDrag.tokenId]!}
          to={snapPosition(localDrag.x, localDrag.y, footprint(tokens[localDrag.tokenId]!))}
          group={dropRoom ? { room: dropRoom, role } : undefined}
          read={read}
          scale={props.scale}
        />
      ) : null}
    </Group>
  );
});

type WalkSource = Omit<WalkInput, "stops">;

function KeptRuler(props: { drawing: Drawing; tokens: Record<string, Token>; rules: DistanceRules; scale: number; color: string; owner: string | null; walk: WalkSource | undefined }) {
  const { drawing } = props;
  const stops = useMemo(() => keptStops(drawing), [drawing]);
  return (
    <Group opacity={drawing.visibility === "dm" ? 0.6 : 1}>
      {props.walk ? (
        <WalkRuler stops={stops} walk={props.walk} scale={props.scale} color={props.color} owner={props.owner} kept />
      ) : (
        <Ruler stops={stops} tokens={props.tokens} rules={props.rules} scale={props.scale} color={props.color} owner={props.owner} kept />
      )}
    </Group>
  );
}

/**
 * What a walking ruler's total and the Ruler's line say while its walk is
 * worked out, as a drag's label does (docs/design-v1-look-pass-2.md D16): a
 * walk still searching keeps the last walk's reading, and only once the
 * search has run past the shared loading delay (`slow`) does it wait grey,
 * "Finding the way…". So a ruler dragged over a large map never blinks.
 * `held` is the last walk this ruler finished, null before its first.
 */
export function walkShown(m: WalkMeasure, held: WalkMeasure | null, slow: boolean): { reading: WalkMeasure | null; finding: boolean } {
  if (!m.searching) return { reading: m, finding: false };
  if (slow) return { reading: null, finding: true };
  return { reading: held, finding: false };
}

/** The last walk a ruler finished, kept while a later one searches (walkShown). */
export function useHeldWalk(m: WalkMeasure | null): WalkMeasure | null {
  const held = useRef<WalkMeasure | null>(null);
  // Read and written in the render on purpose: it follows `m` and never asks for a render of its own.
  if (m && !m.searching) held.current = m;
  return held.current;
}

/**
 * A walking ruler (docs/design-v1-movement.md 3.3): each leg along the
 * route the creature would walk, between its footprint's centers, with a
 * dot at each stop, each leg's cost, and "Walking 40 ft" at the end with
 * what terrain added. A leg with no route runs straight in red, "No way
 * through". While a leg's search runs it is drawn straight, and the total
 * keeps the last walk (walkShown). Past the shared loading delay the leg
 * waits grey and the label says "Finding the way…", as a drag's does.
 */
function WalkRuler(props: { stops: readonly RulerStop[]; walk: WalkSource; scale: number; color: string; owner: string | null; kept?: boolean; live?: boolean }) {
  const { stops, walk, scale, color } = props;
  const m = useWalkMeasure({ ...walk, stops }, props.live === true);
  const slow = useDelayed(m?.searching === true);
  const held = useHeldWalk(m);
  if (!m) return <Ruler stops={stops} tokens={walk.view.tokens} rules={walk.view.meta.settings} scale={scale} color={color} owner={props.owner} kept={props.kept === true} />;
  const shown = walkShown(m, held, slow);
  const mid = (p: Point) => ({ x: p.x + m.size.w / 2, y: p.y + m.size.h / 2 });
  const last = mid(m.legs[m.legs.length - 1]!.to);
  return (
    <>
      {m.legs.map((leg, i) => {
        const pts = [leg.from, ...leg.corners, leg.to].map(mid);
        const flat = pts.flatMap((p) => [p.x, p.y]);
        const stroke = leg.searching && shown.finding ? theme.color.textMuted : leg.none ? theme.color.danger : color;
        const a = pts[0]!;
        const b = pts[pts.length - 1]!;
        const labelled = !leg.searching && (leg.none || (m.legs.length > 1 && Math.hypot(b.x - a.x, b.y - a.y) * scale >= LEG_LABEL_MIN_PX));
        return (
          <Group key={i}>
            <Line points={flat} stroke={theme.color.textHalo} opacity={0.45} strokeWidth={HALO_PX} strokeScaleEnabled={false} lineCap="round" lineJoin="round" perfectDrawEnabled={false} />
            <Line points={flat} stroke={stroke} strokeWidth={LINE_PX} strokeScaleEnabled={false} lineCap="round" lineJoin="round" dash={props.kept ? undefined : [10, 6]} perfectDrawEnabled={false} />
            {labelled ? <Pill x={(a.x + b.x) / 2} y={(a.y + b.y) / 2} scale={scale} value={leg.none ? "No way through" : formatFeet(leg.ft)} size="screen" color={stroke} small /> : null}
          </Group>
        );
      })}
      {[m.legs[0]!.from, ...m.legs.map((l) => l.to)].map((p, i) => {
        const c = mid(p);
        return <Circle key={i} x={c.x} y={c.y} radius={(i === 0 || i === m.legs.length ? 5 : 4) / scale} fill={color} stroke={theme.color.textHalo} strokeWidth={1.5} strokeScaleEnabled={false} />;
      })}
      {shown.finding ? (
        <Pill x={last.x} y={last.y} scale={scale} name={props.owner} value="Finding the way…" size="screen" color={theme.color.textMuted} offsetPx={18} />
      ) : shown.reading ? (
        <Pill x={last.x} y={last.y} scale={scale} name={props.owner} value={walkText(shown.reading)} size="screen" color={color} offsetPx={18} />
      ) : null}
    </>
  );
}

/**
 * `owner` names whoever is measuring, on someone else's ruler (pings/who.ts).
 * A kept ruler draws its line solid, so it never reads as one being measured now.
 */
function Ruler(props: { stops: readonly RulerStop[]; tokens: Record<string, Token>; rules: DistanceRules; scale: number; color: string; owner: string | null; kept?: boolean }) {
  const { stops, tokens, rules, scale, color } = props;
  const { points, totalFt, legsFt } = useMemo(() => {
    const m = stops.length > 1 ? measureStops(stops, tokens, rules) : { totalFt: 0, legsFt: [] };
    return { points: drawnPoints(stops, tokens), ...m };
  }, [stops, tokens, rules]);
  const flat = points.flatMap((p) => [p.x, p.y]);
  const last = points[points.length - 1];
  if (!last) return null;
  return (
    <>
      {points.length > 1 ? (
        <>
          <Line points={flat} stroke={theme.color.textHalo} opacity={0.45} strokeWidth={HALO_PX} strokeScaleEnabled={false} lineCap="round" lineJoin="round" perfectDrawEnabled={false} />
          <Line points={flat} stroke={color} strokeWidth={LINE_PX} strokeScaleEnabled={false} lineCap="round" lineJoin="round" dash={props.kept ? undefined : [10, 6]} perfectDrawEnabled={false} />
        </>
      ) : null}
      {points.map((p, i) => (
        <Circle key={i} x={p.x} y={p.y} radius={(i === 0 || i === points.length - 1 ? 5 : 4) / scale} fill={color} stroke={theme.color.textHalo} strokeWidth={1.5} strokeScaleEnabled={false} />
      ))}
      {legsFt.length > 1
        ? legsFt.map((ft, i) => {
            const a = points[i]!;
            const b = points[i + 1]!;
            if (Math.hypot(b.x - a.x, b.y - a.y) * scale < LEG_LABEL_MIN_PX) return null;
            return <Pill key={i} x={(a.x + b.x) / 2} y={(a.y + b.y) / 2} scale={scale} value={formatFeet(ft)} size="screen" color={color} small />;
          })
        : null}
      {points.length > 1 ? (
        <Pill x={last.x} y={last.y} scale={scale} name={props.owner} value={formatFeet(totalFt)} size="screen" color={color} offsetPx={18} />
      ) : null}
    </>
  );
}

/**
 * A line from where a token stood to where it is being dropped, through
 * the corners of the route it would walk, with a dot at each, in the color
 * of the speed band, and the label at its end. A creature whose space the
 * walk would end in is named under it in amber, and so is a trap it
 * crosses, the three placed as one stack (Pill.tsx PillStack). While the
 * search runs past the shared loading delay, the line waits grey and
 * straight and the label says "Finding the way…", as it does at the ghost
 * of a drop that waits.
 */
function RouteMeasure(props: { route: DragRoute; token: Token; scale: number }) {
  const { route, token, scale } = props;
  const slow = useDelayed(route.searching);
  const fp = footprint(token);
  const to = route.to;
  const finding = route.waiting || slow;
  const corners = finding ? [] : route.corners;
  const crossing = useTrapCrossing(token, [token, ...corners, to]);
  if (to.x === token.x && to.y === token.y && !route.waiting) return null;
  const left = route.read.left;
  const color = finding ? theme.color.textMuted : dragColor(left);
  const flat = [token, ...corners, to].flatMap((p) => [p.x + fp.w / 2, p.y + fp.h / 2]);
  const text = finding ? "Finding the way…" : dragLabel(route.read);
  return (
    <>
      <Line points={flat} stroke={theme.color.textHalo} opacity={0.45} strokeWidth={HALO_PX} strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
      <Line points={flat} stroke={color} strokeWidth={LINE_PX} strokeScaleEnabled={false} lineCap="round" lineJoin="round" dash={[10, 6]} />
      {corners.map((c, i) => (
        <Circle key={i} x={c.x + fp.w / 2} y={c.y + fp.h / 2} radius={3.5 / scale} fill={color} stroke={theme.color.textHalo} strokeWidth={1.5} strokeScaleEnabled={false} />
      ))}
      <PillStack
        x={to.x + fp.w}
        y={to.y + fp.h}
        scale={scale}
        offsetPx={4}
        pills={[
          { value: text, size: "screen", color },
          !finding && route.endsIn ? { value: `Ends in ${route.endsIn}'s space`, size: "screen", color: theme.color.warning, small: true } : null,
          !finding && crossing,
        ]}
      />
    </>
  );
}

/**
 * A straight line from where a token stood to where it is being dropped, or
 * through the corners a remote frame carries, how far that is, and what the
 * creature's speed has left after it.
 */
function DragMeasure(props: { token: Token; to: Point; read: ReadDrag; scale: number; corners?: readonly Point[]; costFt?: number; group?: { room: DropView; role: Role } | undefined }) {
  const { token, to, scale } = props;
  const fp = footprint(token);
  const corners = props.corners ?? [];
  const crossing = useTrapCrossing(token, [token, ...corners, to]);
  if (to.x === token.x && to.y === token.y) return null;
  // This device's own drag with no walk preview, a group's, reads where its token lands and its dismount, as `token.moveMany` records them.
  const read = props.group
    ? groupReading(props.group.room, token, to, props.group.role)
    : props.read(token, to, corners.length > 0 || props.costFt !== undefined ? { corners, ...(props.costFt !== undefined ? { costFt: props.costFt } : {}) } : undefined);
  const left = read.left;
  const color = dragColor(left);
  const flat = [token, ...corners, to].flatMap((p) => [p.x + fp.w / 2, p.y + fp.h / 2]);
  return (
    <>
      <Line points={flat} stroke={theme.color.textHalo} opacity={0.45} strokeWidth={HALO_PX} strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
      <Line points={flat} stroke={color} strokeWidth={LINE_PX} strokeScaleEnabled={false} lineCap="round" lineJoin="round" dash={[10, 6]} />
      {corners.map((c, i) => (
        <Circle key={i} x={c.x + fp.w / 2} y={c.y + fp.h / 2} radius={3.5 / scale} fill={color} stroke={theme.color.textHalo} strokeWidth={1.5} strokeScaleEnabled={false} />
      ))}
      <PillStack x={to.x + fp.w} y={to.y + fp.h} scale={scale} offsetPx={4} pills={[{ value: dragLabel(read), size: "screen", color }, crossing]} />
    </>
  );
}

/**
 * Another member's drag, measured from where the token stands to the
 * snapped preview point, through the route's corners its frames carry,
 * with the leg's cost they carry to the DM and the token's owners. The
 * server already dropped frames whose preview is under the fog for this
 * viewer (design 7.6), and the corners on scenes with fog or vision, so the
 * measurement shows only what the ghost token below it shows.
 */
function RemoteDragMeasure(props: { drag: DragPreview; token: Token | undefined; read: ReadDrag; scale: number }) {
  const { drag, token } = props;
  const corners = useMemo(() => {
    const out: Point[] = [];
    const path = drag.path ?? [];
    for (let k = 0; k + 1 < path.length; k += 2) out.push({ x: path[k]!, y: path[k + 1]! });
    return out;
  }, [drag.path]);
  if (!token) return null;
  return (
    <DragMeasure
      token={token}
      to={snapPosition(drag.x, drag.y, footprint(token))}
      read={props.read}
      scale={props.scale}
      corners={corners}
      {...(drag.ft !== undefined ? { costFt: drag.ft } : {})}
    />
  );
}

/**
 * This device's own token drag. Konva moves the dragged node without a
 * React render, and the canvas sends no local echo of drags, so this
 * listens to the stage's drag events, which bubble up from the token's
 * group (named "token", with the token's id).
 */
function useLocalDrag(ref: RefObject<Konva.Group | null>): { tokenId: string; x: number; y: number } | null {
  const [drag, setDrag] = useState<{ tokenId: string; x: number; y: number } | null>(null);
  useEffect(() => {
    const stage = ref.current?.getStage();
    if (!stage) return;
    const onMove = (e: Konva.KonvaEventObject<DragEvent>) => {
      const node = e.target;
      if (node.name() !== "token") return;
      setDrag({ tokenId: node.id(), x: node.x(), y: node.y() });
    };
    const onEnd = () => setDrag(null);
    stage.on("dragmove.rulerlayer", onMove);
    stage.on("dragend.rulerlayer", onEnd);
    return () => {
      stage.off("dragmove.rulerlayer");
      stage.off("dragend.rulerlayer");
    };
  }, [ref]);
  return drag;
}
