import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { TAP_SLOP_PX } from "../../lib/gestures.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import type { ToolContext, ToolDef, ToolPointer } from "../tools.ts";
import { OptButton, OptionsStrip } from "../measure/controls.tsx";
import { setSoundEnabled, usePingSound } from "./feedback.ts";
import { lookHereEvent } from "./lookHere.ts";
import { TOOL_ORDER } from "../toolbarOrder.ts";

/**
 * Pings, the laser pointer and the DM's "look here" (features section 12,
 * design 7.6): a tap pings the spot for everyone on the scene, and a drag
 * points with the laser, a stroke that fades on its own and is never
 * saved. With Look here on, the DM's tap also moves every player's view to
 * the spot. A press held still on empty map with the select tool pings too
 * (PingLayer.tsx).
 */

/** One Room page's ping tool: its options and the gesture in progress. */
const pingSlot = scopeSlot(() => ({
  store: createStore<{ lookHere: boolean }>(() => ({ lookHere: false })),
  gesture: null as { screen: { x: number; y: number }; last: { x: number; y: number }; laser: boolean } | null,
}));

function onDown(p: ToolPointer, ctx: ToolContext): void {
  ctx.scope.get(pingSlot).gesture = { screen: p.screen, last: p.world, laser: false };
}

function onMove(p: ToolPointer, ctx: ToolContext): void {
  const g = ctx.scope.get(pingSlot).gesture;
  if (!g) return;
  if (!g.laser) {
    if (Math.hypot(p.screen.x - g.screen.x, p.screen.y - g.screen.y) < TAP_SLOP_PX) return;
    g.laser = true;
    ctx.actions.sendEph({ k: "laser", x: g.last.x, y: g.last.y, on: true });
  }
  g.last = p.world;
  ctx.actions.sendEph({ k: "laser", x: p.world.x, y: p.world.y, on: true });
}

function onUp(p: ToolPointer, ctx: ToolContext): void {
  const tool = ctx.scope.get(pingSlot);
  const g = tool.gesture;
  tool.gesture = null;
  if (!g) return;
  if (g.laser) {
    ctx.actions.sendEph({ k: "laser", x: p.world.x, y: p.world.y, on: false });
    return;
  }
  ctx.actions.sendEph({ k: "ping", x: p.world.x, y: p.world.y });
  if (ctx.role === "dm" && tool.store.getState().lookHere) {
    ctx.actions.sendEph(lookHereEvent(p.world, ctx.camera().scale));
  }
}

function onCancel(ctx: ToolContext): void {
  const tool = ctx.scope.get(pingSlot);
  const g = tool.gesture;
  tool.gesture = null;
  if (g?.laser) ctx.actions.sendEph({ k: "laser", x: g.last.x, y: g.last.y, on: false });
}

/** The ping tool's options (docs/design-v1-tool-options.md 9.5): Look here for the DM, and Ping sound. */
function PingOptions(props: { role: "dm" | "player" }) {
  const pingStore = useScoped(pingSlot).store;
  const lookHere = useStore(pingStore, (s) => s.lookHere);
  const sound = usePingSound();
  return (
    <OptionsStrip
      tool="Ping"
      line={{ tone: "hint", content: `Tap to ping. Drag to point with the laser.${props.role === "dm" && lookHere ? " Your taps also move every player's view." : ""}` }}
      slots={[
        props.role === "dm" && {
          id: "lookHere",
          priority: 1,
          control: (
            <OptButton pressed={lookHere} label="Taps move every player's view to the spot" onClick={() => pingStore.setState({ lookHere: !lookHere })}>
              Look here
            </OptButton>
          ),
        },
        {
          id: "sound",
          priority: 1,
          control: (
            // The same setting, and the same fixed name, as This device's "Ping sound" (docs/design-v1-visual.md 3.7).
            <OptButton pressed={sound} label="Play a sound for pings on this device" onClick={() => setSoundEnabled(!sound)}>
              Ping sound
            </OptButton>
          ),
        },
      ]}
    />
  );
}

export const pingTool: ToolDef = {
  id: "ping",
  label: "Ping",
  icon: { path: "M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 4.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6z" },
  roles: ["dm", "player"],
  order: TOOL_ORDER.ping,
  cursor: "pointer",
  pointer: { down: onDown, move: onMove, up: onUp, cancel: onCancel },
  deactivate(ctx) {
    onCancel(ctx);
  },
  Options: PingOptions,
  optionsAt: "foot",
};
