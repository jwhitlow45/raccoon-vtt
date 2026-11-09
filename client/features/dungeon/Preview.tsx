import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import type { RoomState, Trap } from "#shared/model.ts";
import { Loading } from "../../components/Loading.tsx";
import { BOARD_SCOPE, boardTheme, theme } from "../../lib/theme.ts";
import { findDoor } from "../doors/doors.ts";
import { exportContent } from "../mapexport/content.ts";
import { renderMapPng } from "../mapexport/render.ts";
import { encodeThumb } from "../scenes/thumbnail.ts";
import type { DungeonPlan } from "./plan.ts";
import { lightMarks, LIGHT_RING, NUMBER_SIZE, numberMarks, RING_OUTLINE, RING_RADIUS } from "./marks.ts";
import { DRAWING } from "./words.ts";

/** What a preview draws: the plan, and the scratch room its ops made (client.ts `preview`). */
export type Drawn = { plan: DungeonPlan; room: RoomState; name: string };

/** About this many pixels on the long side: sharp on a 2x screen at the half card's width, light to encode. */
const LONG_SIDE_PX = 800;

/**
 * The preview (docs/design/design-v1-dungeon-generator.md 4.3): the DM's view
 * of the scratch room, drawn by the map export's renderer, so it is the
 * dungeon Make sends and not a separate drawing of the plan. Over it, out
 * of the reading order, the armed traps hatched in the trap red and a ring
 * on the entrance room. The picture is an `img` named by the summary.
 * The picture, its ground and the marks over it keep the board's dark look
 * in either theme, as the map does, and the marks are SVG presentation
 * attributes, which cannot read a CSS variable, so they take `boardTheme`.
 * What stands in its corner keeps the dark look too (`CORNER_SLOT`).
 *
 * The previous picture stays while the next one draws, so a choice that
 * changes nothing much never flashes the box empty. The dialog hears when
 * each picture is in, and keeps Make off until the one on screen is the
 * dungeon Make would send.
 */
export function DungeonPreview(props: {
  drawn: Drawn | null;
  width: number;
  height: number;
  drawing: boolean;
  /** Show the drawing words at once. Look closer sets it, as its render holds the page before the shared delay would end. */
  drawingNow?: boolean;
  /** The picture of `drawn` is on screen, so Make may send it (flow.ts). */
  onPictured(drawn: Drawn): void;
  /** The picture of `drawn` could not be made, so the box empties and Make stays off. */
  onPictureFailed(drawn: Drawn): void;
  /** Stands in the bottom left corner, where Look closer is (CORNER_SLOT's mirror). */
  leftCorner?: ReactNode;
  children?: ReactNode;
}) {
  const { drawn, width, height, onPictured, onPictureFailed } = props;
  const [url, setUrl] = useState<{ src: string; of: Drawn } | null>(null);
  const hatch = useId();

  useEffect(() => {
    if (!drawn) return;
    let live = true;
    const scene = Object.values(drawn.room.scenes)[0];
    if (!scene) {
      setUrl(null);
      onPictureFailed(drawn);
      return;
    }
    const long = Math.max(scene.bounds.w, scene.bounds.h);
    const pxPerCell = LONG_SIDE_PX / long;
    const size = { pxPerCell, requested: pxPerCell, width: Math.round(scene.bounds.w * pxPerCell), height: Math.round(scene.bounds.h * pxPerCell) };
    const content = exportContent({ buildChunks: drawn.room.buildChunks, labels: {}, fogTiles: {}, stamps: drawn.room.stamps, scene, view: "dm" });
    // The picture and its report land in one update, so Make never turns on a render before the picture shows.
    renderMapPng({ scene, size, content, grid: false, map: null, encode: encodeThumb }).then(
      (blob) => {
        if (!live) return;
        setUrl({ src: URL.createObjectURL(blob), of: drawn });
        onPictured(drawn);
      },
      // A canvas the device refuses empties the box rather than leave an older dungeon standing for this one.
      () => {
        if (!live) return;
        setUrl(null);
        onPictureFailed(drawn);
      },
    );
    return () => {
      live = false;
    };
    // The callbacks are the dialog's dispatch, the same on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawn]);
  // A picture's URL goes once the next one shows, or the preview closes, so the old one stays on screen while the next draws.
  useEffect(() => (url ? () => URL.revokeObjectURL(url.src) : undefined), [url]);

  const shown = url?.of ?? null;
  const plan = shown?.plan;
  const box = plan ? fitBox(plan.w, plan.h, width, height) : { width, height };
  const traps = shown ? Object.values(shown.room.traps ?? {}).filter((t): t is Trap => !!t) : [];
  const sceneId = shown ? Object.keys(shown.room.scenes)[0] ?? "" : "";

  return (
    <div
      style={{
        position: "relative",
        width,
        height,
        display: "grid",
        placeItems: "center",
        borderRadius: theme.radius.md,
        background: boardTheme.color.bg,
        overflow: "hidden",
      }}
    >
      {shown && plan ? (
        <div style={{ position: "relative", width: box.width, height: box.height }}>
          <img src={url!.src} alt={shown.name} style={{ display: "block", width: "100%", height: "100%" }} />
          <svg aria-hidden viewBox={`0 0 ${plan.w} ${plan.h}`} preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
            <defs>
              <pattern id={hatch} width={0.5} height={0.5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1={0} y1={0} x2={0} y2={0.5} stroke={boardTheme.color.danger} strokeWidth={0.18} />
              </pattern>
            </defs>
            {traps.map((t) => (
              <TrapMark key={t.id} trap={t} room={shown.room} sceneId={sceneId} hatch={hatch} />
            ))}
            <EntranceRing rect={plan.entrance} />
            {lightMarks(plan).map((m, i) => (
              <g key={`l${i}`}>
                <circle cx={m.x} cy={m.y} r={RING_RADIUS} fill="none" stroke={RING_OUTLINE} strokeWidth={4} style={THIN} />
                <circle cx={m.x} cy={m.y} r={RING_RADIUS} fill="none" stroke={LIGHT_RING} strokeWidth={2} style={THIN} />
              </g>
            ))}
            {numberMarks(plan).map((m) => (
              <text key={`n${m.n}`} x={m.x} y={m.y} textAnchor="middle" dominantBaseline="central" fontSize={NUMBER_SIZE} fontWeight={700} fontFamily="sans-serif" fill={boardTheme.color.white} stroke={RING_OUTLINE} strokeWidth={4} paintOrder="stroke" style={THIN}>
                {m.n}
              </text>
            ))}
          </svg>
        </div>
      ) : null}
      {props.children ? <div style={CORNER_SLOT}>{props.children}</div> : null}
      {props.leftCorner ? <div style={{ ...CORNER_SLOT, right: "auto", left: theme.space(2) }}>{props.leftCorner}</div> : null}
      {props.drawing ? (
        <div style={{ position: "absolute", left: theme.space(2), top: theme.space(2), padding: `${theme.space(1)}px ${theme.space(2)}px`, borderRadius: theme.radius.sm, background: theme.color.surface }}>
          <Loading text={DRAWING} delay={props.drawingNow ? 0 : undefined} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The corner slot, where the dialog puts Reroll. It stands on the board's
 * dark ground or the dark picture in either scheme, so what it holds takes
 * the dark look and the accent resolved for dark, its ring included (review
 * LTB-1: the light accent's ring read 2.5:1 there). Its text color is set
 * under the scope, as the inherited one is the page's. The picture's stone
 * can lie under the ring too, where even the dark accent can read under
 * 3:1 (review LTA-1: a blue member's 2.6:1), so the control there spreads
 * `ON_BOARD` for the dark halo under its ring, as GenerateDialog's Reroll
 * does.
 */
export const CORNER_SLOT = { ...BOARD_SCOPE, position: "absolute", right: theme.space(2), bottom: theme.space(2), color: theme.color.text } as CSSProperties;

/** The scene's shape inside the preview's box, as large as fits. */
export function fitBox(w: number, h: number, boxW: number, boxH: number): { width: number; height: number } {
  const scale = Math.min(boxW / w, boxH / h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

// Strokes stay one width whatever the preview's size, so each mark keeps its 1 px outline.
const THIN = { vectorEffect: "non-scaling-stroke" } as const;

function TrapMark(props: { trap: Trap; room: RoomState; sceneId: string; hatch: string }) {
  const { zone } = props.trap;
  if ("cells" in zone) {
    return (
      <>
        {zone.cells.map((r, i) => (
          <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={`url(#${props.hatch})`} stroke={boardTheme.color.danger} strokeWidth={1} style={THIN} />
        ))}
      </>
    );
  }
  if ("wire" in zone) {
    const [ax, ay] = zone.wire.a;
    const [bx, by] = zone.wire.b;
    return (
      <>
        <line x1={ax} y1={ay} x2={bx} y2={by} stroke={boardTheme.color.textHalo} strokeWidth={4} style={THIN} />
        <line x1={ax} y1={ay} x2={bx} y2={by} stroke={boardTheme.color.danger} strokeWidth={2} style={THIN} />
      </>
    );
  }
  const door = findDoor(props.room.buildChunks, props.sceneId, zone.door);
  if (!door) return null;
  return <rect x={door.mid.x - 0.35} y={door.mid.y - 0.35} width={0.7} height={0.7} fill={`url(#${props.hatch})`} stroke={boardTheme.color.danger} strokeWidth={1} style={THIN} />;
}

/** A white ring over a dark one, so it reads on floor and on rock alike. */
function EntranceRing(props: { rect: DungeonPlan["entrance"] }) {
  const { x, y, w, h } = props.rect;
  const ring = { x: x - 0.5, y: y - 0.5, width: w + 1, height: h + 1, rx: 0.8, fill: "none" };
  return (
    <>
      <rect {...ring} stroke={boardTheme.color.textHalo} strokeWidth={4} style={THIN} />
      <rect {...ring} stroke={boardTheme.color.white} strokeWidth={2} style={THIN} />
    </>
  );
}
