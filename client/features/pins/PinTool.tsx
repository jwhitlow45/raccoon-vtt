import { useStore } from "zustand";
import { LIMITS } from "#shared/limits.ts";
import type { Pin } from "#shared/model.ts";
import { TAP_SLOP_PX } from "../../lib/gestures.ts";
import { memberColorName } from "../../components/Swatches.tsx";
import { MEMBER_COLORS, theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomUi, useRoomView } from "../../state/view.ts";
import { OptButton, OptionsStrip, PopoverSwatches, ValueChip } from "../measure/controls.tsx";
import type { ToolContext, ToolDef, ToolPointer } from "../tools.ts";
import { pinAt, pinToolTap } from "./rules.ts";
import { pinSlot } from "./store.ts";
import { TOOL_ORDER } from "../toolbarOrder.ts";

/**
 * The Pin tool (docs/design-v1-dm-tools.md 3.8), the DM's: a tap places a
 * pin and opens its pane, a tap on a pin opens its pane, and a drag moves
 * one. A journal page's "Pin to the map" picks this tool with the page
 * waiting, and the next tap places a pin linked to it.
 */

const round = (v: number) => Math.round(v * 100) / 100;

function scenePins(ctx: ToolContext): Pin[] {
  const pins = ctx.getState().view?.pins ?? {};
  return Object.values(pins).filter((p) => p.sceneId === ctx.scene.id);
}

function memberColor(ctx: ToolContext): string {
  const s = ctx.getState();
  return (s.you && s.view?.members[s.you.memberId]?.color) || theme.color.crest;
}

function place(ctx: ToolContext, p: ToolPointer, pageId: string | null): void {
  const tool = ctx.scope.get(pinSlot).store;
  const st = tool.getState();
  if (scenePins(ctx).length >= LIMITS.pinsPerScene) {
    ctx.ui.notify(`A scene holds at most ${LIMITS.pinsPerScene} pins. Delete one to place another.`, "error");
    return;
  }
  const id = ctx.actions.newId();
  const pin = {
    id,
    sceneId: ctx.scene.id,
    x: round(p.world.x),
    y: round(p.world.y),
    color: st.color ?? memberColor(ctx),
    // A linked pin starts visible, and its page decides who sees it.
    visibility: pageId !== null || !st.dmOnly ? ("all" as const) : ("dm" as const),
    ...(pageId !== null ? { pageId } : {}),
  };
  if (ctx.actions.dispatch({ t: "pin.put", pin }) === null) return;
  // One thing floats over the map at a time: the pane, or a token's bar.
  ctx.ui.select(null);
  tool.setState({ paneId: id, placing: null });
}

function onDown(p: ToolPointer, ctx: ToolContext): void {
  const slot = ctx.scope.get(pinSlot);
  const placing = slot.store.getState().placing !== null;
  const hit = placing ? null : pinAt(scenePins(ctx), ctx.camera(), p.screen);
  slot.gesture = { start: p.screen, hit: hit?.id ?? null, grab: hit ? { dx: p.world.x - hit.x, dy: p.world.y - hit.y } : null, moved: false };
}

function onMove(p: ToolPointer, ctx: ToolContext): void {
  const slot = ctx.scope.get(pinSlot);
  const g = slot.gesture;
  if (!g) return;
  if (!g.moved && Math.hypot(p.screen.x - g.start.x, p.screen.y - g.start.y) < TAP_SLOP_PX) return;
  g.moved = true;
  if (g.hit && g.grab) slot.store.setState({ drag: { id: g.hit, x: round(p.world.x - g.grab.dx), y: round(p.world.y - g.grab.dy) } });
}

function onUp(p: ToolPointer, ctx: ToolContext): void {
  const slot = ctx.scope.get(pinSlot);
  const g = slot.gesture;
  slot.gesture = null;
  if (!g) return;
  const st = slot.store.getState();
  if (g.moved) {
    const drag = st.drag;
    slot.store.setState({ drag: null });
    const pin = drag ? ctx.getState().view?.pins[drag.id] : undefined;
    if (drag && pin) ctx.actions.dispatch({ t: "pin.put", pin: { ...withoutRev(pin), x: drag.x, y: drag.y } });
    return;
  }
  const tap = pinToolTap({ placing: st.placing, hit: g.hit, paneOpen: st.paneId !== null });
  switch (tap.kind) {
    case "placeLinked":
      place(ctx, p, tap.pageId);
      return;
    case "place":
      place(ctx, p, null);
      return;
    case "open":
      ctx.ui.select(null);
      slot.store.setState({ paneId: tap.pinId });
      return;
    case "close":
      slot.store.setState({ paneId: null });
      return;
  }
}

function withoutRev(pin: Pin) {
  const { rev: _rev, ...rest } = pin;
  return rest;
}

/**
 * The pin tool's options (docs/design-v1-tool-options.md 9.8): a new pin's
 * color and DM only, nothing while a pin's pane is open, or Cancel while a
 * journal page waits for its spot.
 */
function PinOptions() {
  const store = useScoped(pinSlot).store;
  const ui = useRoomUi();
  const placing = useStore(store, (s) => s.placing);
  const color = useStore(store, (s) => s.color);
  const dmOnly = useStore(store, (s) => s.dmOnly);
  const editing = useStore(store, (s) => s.paneId !== null);
  const mine = useRoomView((s) => (s.you ? s.view?.members[s.you.memberId]?.color : undefined)) ?? theme.color.crest;

  if (placing) {
    return (
      <OptionsStrip
        tool="Pin"
        task
        line={{ tone: "reading", content: `Tap the map to place the pin for ${placing.title}.` }}
        slots={[
          {
            id: "cancel",
            priority: 1,
            control: (
              <OptButton
                ends
                onClick={() => {
                  store.setState({ placing: null });
                  ui.setTool("select");
                }}
              >
                Cancel
              </OptButton>
            ),
          },
        ]}
      />
    );
  }
  // The pin's pane has its own color and DM only, so the row stands aside while it is open.
  if (editing) return <OptionsStrip tool="Pin" line={{ tone: "hint", content: "Tap another pin to edit it, or drag a pin to move it." }} slots={[]} />;
  const pinColor = color ?? mine;
  return (
    <OptionsStrip
      tool="Pin"
      line={{ tone: "hint", content: "Tap the map to place a pin. Tap a pin to edit it, or drag it to move it." }}
      slots={[
        {
          id: "color",
          priority: 1,
          control: (
            <ValueChip label="Pin color" kind="choice" value={pinColor} valueName={memberColorName(pinColor) ?? pinColor} disk={pinColor} options={MEMBER_COLORS.map((c) => ({ key: c, words: memberColorName(c) ?? c }))}>
              <PopoverSwatches label="Pin color" value={pinColor} options={MEMBER_COLORS} onChange={(c) => store.setState({ color: c })} />
            </ValueChip>
          ),
        },
        {
          id: "dmOnly",
          priority: 1,
          control: (
            <OptButton pressed={dmOnly} label="New pins start DM only" onClick={() => store.setState({ dmOnly: !dmOnly })}>
              DM only
            </OptButton>
          ),
        },
      ]}
    />
  );
}

export const pinTool: ToolDef = {
  id: "pin",
  label: "Pin",
  icon: { path: "M6 2h12v2l-2 1v6l3 3v2h-6v6l-1 1-1-1v-6H5v-2l3-3V5L6 4z" },
  roles: ["dm"],
  order: TOOL_ORDER.pin,
  cursor: "crosshair",
  pointer: {
    down: onDown,
    move: onMove,
    up: onUp,
    cancel(ctx) {
      const slot = ctx.scope.get(pinSlot);
      slot.gesture = null;
      if (slot.store.getState().drag) slot.store.setState({ drag: null });
    },
  },
  deactivate(ctx) {
    const slot = ctx.scope.get(pinSlot);
    slot.gesture = null;
    slot.store.setState({ drag: null, placing: null, paneId: null });
  },
  Options: PinOptions,
};
