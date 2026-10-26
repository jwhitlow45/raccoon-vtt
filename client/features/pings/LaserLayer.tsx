import { memo } from "react";
import { Group, Shape } from "react-konva";
import { theme } from "../../lib/theme.ts";
import { useLowPower } from "../device/settings.ts";
import { LASER_FADE_MS } from "../../state/ephemeral.ts";
import type { LaserTrail } from "../../state/types.ts";
import { useTreeShownView } from "../../canvas/relief/context.ts";
import type { LayerProps } from "../layers.ts";
import { Pill } from "../measure/Pill.tsx";
import { useFrameNow } from "./frameClock.ts";
import { markOwner } from "./who.ts";

/**
 * The laser pointer on the overlay layer (features section 12): each
 * member's recent points as a glowing stroke in their color whose tail
 * fades over the store's fade time, with their name at the tip when it is
 * someone else's. Nothing is saved. The store drops faded points, and
 * this layer animates by the board's one frame clock (frameClock.ts),
 * which runs in the ping controller only while some trail still has
 * points. In low power (docs/design-v1-dm-tools.md 3.15) the trail does
 * not fade: it draws whole with no loop, and each point goes when the
 * store drops it.
 */

const CORE_PX = 3;
const GLOW_PX = 9;

export const LaserLayer = memo(function LaserLayer(props: LayerProps) {
  const lasers = useTreeShownView((s) => s.ephemeral.lasers);
  const members = useTreeShownView((s) => s.view?.members);
  const trails = Object.values(lasers).filter((t) => t.points.length > 0);
  const still = useLowPower();
  const now = useFrameNow(trails.length > 0 && !still);
  if (trails.length === 0) return null;
  return (
    <Group listening={false}>
      {trails.map((t) => {
        const color = members?.[t.from]?.color ?? theme.color.danger;
        const name = t.on ? markOwner(t, members) : null;
        const head = t.points[t.points.length - 1];
        return (
          <Group key={t.from}>
            <Trail trail={t} now={now} still={still} scale={props.scale} color={color} />
            {name && head ? <Pill x={head.x} y={head.y} scale={props.scale} name={name} size="map" color={color} small offsetPx={12} /> : null}
          </Group>
        );
      })}
    </Group>
  );
});

function Trail(props: { trail: LaserTrail; now: number; still: boolean; scale: number; color: string }) {
  const { trail, now, still, scale, color } = props;
  const pts = trail.points;
  return (
    <Shape
      listening={false}
      perfectDrawEnabled={false}
      sceneFunc={(ctx) => {
        ctx.setAttr("lineCap", "round");
        ctx.setAttr("lineJoin", "round");
        const alpha = (at: number) => (still ? 1 : Math.max(0, 1 - (now - at) / LASER_FADE_MS));
        // The core was white for everyone, so two lasers looked the same.
        // A dark halo under the colored core keeps it readable on any map.
        for (const [width, style, strength] of [
          [GLOW_PX, color, 0.35],
          [CORE_PX + 2, theme.color.textHalo, 0.5],
          [CORE_PX, color, 0.95],
        ] as const) {
          ctx.setAttr("lineWidth", width / scale);
          ctx.setAttr("strokeStyle", style);
          for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1]!;
            const b = pts[i]!;
            ctx.setAttr("globalAlpha", alpha(b.at) * strength);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
          const head = pts[pts.length - 1]!;
          if (trail.on && pts.length >= 1) {
            ctx.setAttr("globalAlpha", alpha(head.at) * strength);
            ctx.beginPath();
            ctx.arc(head.x, head.y, (width * 0.8) / scale, 0, Math.PI * 2);
            ctx.setAttr("fillStyle", style);
            ctx.fill();
          }
        }
        ctx.setAttr("globalAlpha", 1);
      }}
    />
  );
}
