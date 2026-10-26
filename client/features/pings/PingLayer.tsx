import { memo } from "react";
import { Circle, Group } from "react-konva";
import { useTreeShownView } from "../../canvas/relief/context.ts";
import { boardSizes } from "../../lib/boardScale.ts";
import { useLowPower } from "../device/settings.ts";
import { theme } from "../../lib/theme.ts";
import { PING_MS } from "../../state/ephemeral.ts";
import type { Ping } from "../../state/types.ts";
import type { LayerProps } from "../layers.ts";
import { Pill } from "../measure/Pill.tsx";
import { useFrameNow } from "./frameClock.ts";
import { markOwner } from "./who.ts";

/**
 * Pings on the overlay layer (design 13.3): rings that pulse outward in the
 * pinger's color and fade within the store's 3 s, with the pinger's name
 * when it is someone else. They animate by the board's one frame clock
 * (frameClock.ts), which runs only while a ping is on screen (design
 * 14.2). In low power (docs/design-v1-dm-tools.md 3.15) a ping is one
 * still ring for its 3 s, with no loop, until the store sweeps it.
 *
 * This layer only draws. A ping's tone and buzz, the clock and the select
 * tool's hold-to-ping run in the board's ping controller
 * (PingController.ts), mounted once outside both drawing trees
 * (docs/design-v1-isometric-view.md 5.1).
 */

const PULSE_MS = 1_000;
const RING_MIN_PX = 6;
const RING_MAX_PX = 44;

export const PingLayer = memo(function PingLayer(props: LayerProps) {
  const pings = useTreeShownView((s) => s.ephemeral.pings);
  const members = useTreeShownView((s) => s.view?.members);
  const still = useLowPower();
  const now = useFrameNow(pings.length > 0 && !still);
  return (
    <Group listening={false}>
      {pings.map((p) => (
        <PingRings key={p.id} ping={p} now={now} still={still} scale={props.scale} color={members?.[p.from]?.color ?? theme.color.accentSoft} name={markOwner(p, members)} />
      ))}
    </Group>
  );
});

function PingRings(props: { ping: Ping; now: number; still: boolean; scale: number; color: string; name: string | null }) {
  // A still ping has no clock to age by. The store drops it after its 3 s.
  const age = props.still ? 0 : Math.max(0, props.now - props.ping.at);
  if (age >= PING_MS) return null;
  const fade = 1 - age / PING_MS;
  // A ping exists to be seen: its rings grow with a close zoom, up to twice their size, but never shrink below it.
  const s = Math.min(2, Math.max(1, boardSizes(props.scale).f)) / props.scale;
  const rings = props.still
    ? [{ r: ((RING_MIN_PX + RING_MAX_PX) / 2) * s, opacity: 1 }]
    : [0, PULSE_MS / 2].map((offset) => {
        const t = ((age + offset) % PULSE_MS) / PULSE_MS;
        return { r: (RING_MIN_PX + (RING_MAX_PX - RING_MIN_PX) * t) * s, opacity: (1 - t) * fade };
      });
  return (
    <>
      {rings.map((r, i) => (
        <Circle key={i} x={props.ping.x} y={props.ping.y} radius={r.r} stroke={props.color} strokeWidth={3} strokeScaleEnabled={false} opacity={r.opacity} listening={false} />
      ))}
      <Circle x={props.ping.x} y={props.ping.y} radius={5 * s} fill={props.color} stroke={theme.color.textHalo} strokeWidth={1.5} strokeScaleEnabled={false} opacity={fade} listening={false} />
      {props.name ? <Pill x={props.ping.x} y={props.ping.y} scale={props.scale} name={props.name} size="map" color={props.color} small offsetPx={14} /> : null}
    </>
  );
}
