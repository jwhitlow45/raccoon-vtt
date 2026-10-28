import { useStore } from "zustand";
import { LIMITS } from "#shared/limits.ts";
import type { Scene, Trap, TrapAction, TrapZone } from "#shared/model.ts";
import { isHex, sceneGrid } from "#shared/rules/grid.ts";
import { LEVEL_BANDS, trapPreset, type LevelBand } from "#shared/srd/traps.ts";
import { TAP_SLOP_PX } from "../../lib/gestures.ts";
import { useRoomScope, useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { lightAt, LIGHT_REACH_PX } from "../builder/lightTap.ts";
import { sceneStamps, stampAt } from "../builder/stamps/rules.ts";
import { doorUnder, sameDoor } from "../doors/doors.ts";
import { DOOR_SLOP_PX } from "../doors/tap.ts";
import { HEX_LIMITS } from "../grid/words.ts";
import { ChoiceRows, OptButton, OptionsStrip, OptSegmented, PickCloses, ValueChip } from "../measure/controls.tsx";
import type { ToolContext, ToolDef, ToolPointer } from "../tools.ts";
import { trapCycle } from "../toolChoices.ts";
import { TOOL_ORDER } from "../toolbarOrder.ts";
import { TRAP_ICON_BOX, TRAP_ICON_PATH } from "./icon.ts";
import { BAND_NAMES, newTrapInput, rectBetween, START_ALARM, START_BLANK, startChoices, startKind, tapRect, trapAt, wireBetween, wireEnd, withRect, type ZoneKind } from "./rules.ts";
import { pickZone, trapSlot, ZONE_KINDS, type TrapDraft, type TrapPicking } from "./store.ts";

/**
 * The Trap tool (docs/design-v1-traps.md 4.1), the DM's: draw a new trap's
 * squares, drag its trip wire or tap the door it guards, and tap a trap to
 * open its pane. While the pane asks for something on the map (squares to
 * add, the squares it hits, a door, light, creature or stamp it sets), the
 * next tap or drag picks it.
 */

/** Why the Trap tool has nothing to place, or null where it works: zones are squares until a later phase of hex grids. */
export function trapToolOff(scene: Pick<Scene, "gridShape"> | undefined): string | null {
  return scene !== undefined && isHex(sceneGrid(scene)) ? HEX_LIMITS.trap : null;
}

function sceneTraps(ctx: ToolContext): Trap[] {
  const traps = ctx.getState().view?.traps ?? {};
  return Object.values(traps).filter((t) => t.sceneId === ctx.scene.id);
}

const ZONE_HINTS: Record<ZoneKind, string> = {
  squares: "Drag across the squares of a new trap, or tap to place it at its own size.",
  wire: "Drag from one end of the trip wire to the other.",
  door: "Tap a door to trap it.",
};

function trapName(ctx: ToolContext, id: string): string {
  return ctx.getState().view?.traps[id]?.name ?? "the trap";
}

/** The zone a finished gesture drew, or null with the reason told. A tap places a new trap's squares at its start's size, and adds one square to a trap's own. */
function drawnZone(ctx: ToolContext, kind: ZoneKind, p: ToolPointer, draft: TrapDraft | null, moved: boolean, startWorld: { x: number; y: number }, fresh = false): TrapZone | null {
  const bounds = ctx.scene.bounds;
  if (kind === "squares") {
    if (draft && "rect" in draft) return { cells: [draft.rect] };
    const { start, band } = ctx.scope.get(trapSlot).store.getState();
    return { cells: [fresh ? tapRect(startWorld, start, band, bounds) : rectBetween(startWorld, startWorld, bounds)] };
  }
  if (kind === "wire") {
    if (draft && "wire" in draft) return { wire: draft.wire };
    ctx.ui.notify(moved ? "A trip wire is at least half a square long." : ZONE_HINTS.wire, "info");
    return null;
  }
  if (moved) return null;
  const view = ctx.getState().view;
  const door = view ? doorUnder({ chunks: view.buildChunks, sceneId: ctx.scene.id, at: p.world, slop: DOOR_SLOP_PX / ctx.camera().scale, fog: null }) : null;
  if (!door) {
    ctx.ui.notify(ZONE_HINTS.door, "info");
    return null;
  }
  return { door: door.ref };
}

function create(ctx: ToolContext, zone: TrapZone): void {
  const view = ctx.getState().view;
  const tool = ctx.scope.get(trapSlot).store;
  if (!view) return;
  if (sceneTraps(ctx).length >= LIMITS.trapsPerScene) {
    ctx.ui.notify(`A scene holds at most ${LIMITS.trapsPerScene} traps. Delete one to make another.`, "error");
    return;
  }
  const { start, band } = tool.getState();
  const id = ctx.actions.newId();
  const trap = newTrapInput({ id, sceneId: ctx.scene.id, start, band, zone, chunks: view.buildChunks });
  if (ctx.actions.dispatch({ t: "trap.create", trap }) === null) return;
  tool.setState({ paneId: id });
}

/** Squares added to the open trap's zone, or to the squares it hits. */
function pickSquares(ctx: ToolContext, picking: TrapPicking, zone: TrapZone | null): void {
  const trap = ctx.getState().view?.traps[picking.trapId];
  const tool = ctx.scope.get(trapSlot).store;
  if (!trap?.rig || !zone || !("cells" in zone)) return;
  const rect = zone.cells[0]!;
  if (picking.what === "squares") {
    if (!("cells" in trap.zone)) return;
    const next = withRect(trap.zone.cells, rect);
    if (!next.ok) ctx.ui.notify(next.why, "error");
    else ctx.actions.dispatch({ t: "trap.update", trapId: trap.id, patch: { zone: { cells: next.rects } } });
    return;
  }
  const had = !picking.fresh && typeof trap.rig.hits === "object" && "cells" in trap.rig.hits ? trap.rig.hits.cells : [];
  const next = withRect(had, rect);
  if (!next.ok) {
    ctx.ui.notify(next.why, "error");
    return;
  }
  if (ctx.actions.dispatch({ t: "trap.update", trapId: trap.id, patch: { rig: { hits: { cells: next.rects } } } }) !== null) tool.setState({ picking: { ...picking, fresh: false } });
}

/** What a tap names for the open trap to set (4.1, "It also"): a hidden creature, a light, a door or a hidden stamp, topmost first. */
function pickAction(ctx: ToolContext, picking: TrapPicking, p: ToolPointer): void {
  const view = ctx.getState().view;
  const trap = view?.traps[picking.trapId];
  const tool = ctx.scope.get(trapSlot).store;
  if (!view || !trap?.rig) return;
  const scale = ctx.camera().scale;
  const token = p.tokenId ? view.tokens[p.tokenId] : undefined;
  const light = lightAt(view.lights, ctx.scene.id, p.world, LIGHT_REACH_PX / scale);
  const door = doorUnder({ chunks: view.buildChunks, sceneId: ctx.scene.id, at: p.world, slop: DOOR_SLOP_PX / scale, fog: null });
  const stamp = stampAt(sceneStamps(view.stamps, ctx.scene.id), p.world, 0);
  let action: TrapAction | null = null;
  if (token && token.visibility === "dm") action = { show: { tokenId: token.id } };
  else if (light) action = { light: light.id, on: !light.on };
  else if (door) action = { door: door.ref, state: door.door.state === "open" ? "closed" : "open" };
  else if (stamp && stamp.visibility === "dm") action = { show: { stampId: stamp.id } };
  if (!action) {
    ctx.ui.notify(token || stamp ? "Only a hidden creature or a hidden stamp can be shown." : "Tap a door, a light, a hidden creature or a hidden stamp.", "info");
    return;
  }
  const actions = trap.rig.actions;
  if (actions.some((a) => sameTarget(a, action))) {
    ctx.ui.notify(`${trap.name} already does something to that.`, "info");
    return;
  }
  if (actions.length >= LIMITS.trapActions) {
    ctx.ui.notify(`A trap does at most ${LIMITS.trapActions} things.`, "error");
    return;
  }
  if (ctx.actions.dispatch({ t: "trap.update", trapId: trap.id, patch: { rig: { actions: [...actions, action] } } }) !== null) tool.setState({ picking: null });
}

function sameTarget(a: TrapAction, b: TrapAction): boolean {
  if ("door" in a) return "door" in b && sameDoor(a.door, b.door);
  if ("light" in a) return "light" in b && a.light === b.light;
  if (!("show" in b)) return false;
  if ("tokenId" in a.show) return "tokenId" in b.show && a.show.tokenId === b.show.tokenId;
  return "stampId" in b.show && a.show.stampId === b.show.stampId;
}

function onDown(p: ToolPointer, ctx: ToolContext): void {
  if (trapToolOff(ctx.scene)) return;
  const slot = ctx.scope.get(trapSlot);
  const st = slot.store.getState();
  const view = ctx.getState().view;
  const hit = st.picking || !view ? null : trapAt(sceneTraps(ctx), view.buildChunks, p.world, DOOR_SLOP_PX / ctx.camera().scale);
  slot.gesture = { start: p.screen, world: p.world, hit: hit?.id ?? null, moved: false };
}

/** What a drag draws now: squares for a squares trap or a pick of squares, a wire for a trip wire, nothing for a door or an action. */
function drawing(st: { kind: ZoneKind; picking: TrapPicking | null }): "squares" | "wire" | null {
  if (st.picking) return st.picking.what === "action" ? null : "squares";
  return st.kind === "door" ? null : st.kind;
}

function onMove(p: ToolPointer, ctx: ToolContext): void {
  if (trapToolOff(ctx.scene)) return;
  const slot = ctx.scope.get(trapSlot);
  const g = slot.gesture;
  if (!g) return;
  if (!g.moved && Math.hypot(p.screen.x - g.start.x, p.screen.y - g.start.y) < TAP_SLOP_PX) return;
  g.moved = true;
  const st = slot.store.getState();
  const bounds = ctx.scene.bounds;
  const what = drawing(st);
  if (what === "squares") slot.store.setState({ draft: { rect: rectBetween(g.world, p.world, bounds) } });
  else if (what === "wire") {
    const wire = wireBetween(wireEnd(g.world, bounds), p.world, bounds);
    slot.store.setState({ draft: wire ? { wire } : null });
  }
}

function onUp(p: ToolPointer, ctx: ToolContext): void {
  if (trapToolOff(ctx.scene)) return;
  const slot = ctx.scope.get(trapSlot);
  const g = slot.gesture;
  slot.gesture = null;
  if (!g) return;
  const st = slot.store.getState();
  const draft = st.draft;
  if (draft) slot.store.setState({ draft: null });
  if (st.picking) {
    if (st.picking.what === "action") {
      if (!g.moved) pickAction(ctx, st.picking, p);
      return;
    }
    pickSquares(ctx, st.picking, drawnZone(ctx, "squares", p, draft, g.moved, g.world));
    return;
  }
  if (!g.moved && g.hit) {
    slot.store.setState({ paneId: g.hit });
    return;
  }
  // A tap off the open trap closes its pane, as a tap off a pin closes the pin's.
  if (!g.moved && st.paneId !== null) {
    slot.store.setState({ paneId: null });
    return;
  }
  const zone = drawnZone(ctx, st.kind, p, draft, g.moved, g.world, true);
  if (zone) create(ctx, zone);
}

const PICK_LINES: Record<TrapPicking["what"], (name: string) => string> = {
  squares: (name) => `Drag across squares to add to ${name}, or tap one square.`,
  hits: (name) => `Drag across the squares ${name} hits, or tap one square.`,
  action: (name) => `Tap a door, a light, a hidden creature or a hidden stamp for ${name} to set.`,
};

/**
 * The Trap tool's options (4.1): what a new trap starts from and the
 * party's level, and the kind of zone to draw. While the pane asks for
 * something on the map, the row says what to tap and offers Done.
 */
function TrapOptions() {
  const scope = useRoomScope();
  const store = useScoped(trapSlot).store;
  const start = useStore(store, (s) => s.start);
  const band = useStore(store, (s) => s.band);
  const kind = useStore(store, (s) => s.kind);
  const picking = useStore(store, (s) => s.picking);
  const editing = useStore(store, (s) => s.paneId !== null);
  const pickName = useRoomView((s) => (picking ? (s.view?.traps[picking.trapId]?.name ?? null) : null));
  const off = useRoomView((s) => trapToolOff(s.sceneId ? s.view?.scenes[s.sceneId] : undefined));

  if (off !== null) return <OptionsStrip tool="Trap" line={{ tone: "hint", content: off }} slots={[]} />;

  if (picking) {
    return (
      <OptionsStrip
        tool="Trap"
        task
        line={{ tone: "reading", content: PICK_LINES[picking.what](pickName ?? "the trap") }}
        slots={[
          {
            id: "done",
            priority: 1,
            control: (
              <OptButton ends tone="primary" onClick={() => store.setState({ picking: null })}>
                Done
              </OptButton>
            ),
          },
        ]}
      />
    );
  }
  if (editing) return <OptionsStrip tool="Trap" line={{ tone: "hint", content: "Tap another trap to edit it." }} slots={[]} />;
  const choices = startChoices();
  const startName = choices.find((c) => c.value === start)?.label ?? "Blank";
  const preset = start !== START_BLANK && start !== START_ALARM;
  return (
    <OptionsStrip
      tool="Trap"
      line={{ tone: "hint", content: `${ZONE_HINTS[kind]} Tap a trap to edit it.` }}
      slots={[
        {
          id: "start",
          priority: 1,
          control: (
            <ValueChip label="Start from" kind="choice" value={start} valueName={startName} options={choices.map((c) => ({ key: c.value, words: c.label }))}>
              <PickCloses>
                <ChoiceRows<string>
                  label="Start from"
                  value={start}
                  options={choices}
                  onChange={(next) => store.setState({ start: next, kind: startKind(next) ?? store.getState().kind })}
                />
              </PickCloses>
            </ValueChip>
          ),
        },
        preset && {
          id: "band",
          priority: 2,
          control: (
            <ValueChip label="Party level" kind="choice" value={band} valueName={BAND_NAMES[band]} options={LEVEL_BANDS.map((b) => ({ key: b, words: BAND_NAMES[b] }))}>
              <PickCloses>
                <ChoiceRows<LevelBand>
                  label="Party level"
                  value={band}
                  options={LEVEL_BANDS.map((b) => ({ value: b, label: BAND_NAMES[b], detail: trapPreset(start, b)?.rig.damage?.map((d) => d.formula).join(" + ") }))}
                  onChange={(next) => store.setState({ band: next })}
                />
              </PickCloses>
            </ValueChip>
          ),
        },
        { id: "kind", priority: 1, compact: true, control: <OptSegmented<ZoneKind> label="Zone" value={kind} options={ZONE_KINDS} onChange={(next) => pickZone(scope, next)} /> },
      ]}
    />
  );
}

export const trapTool: ToolDef = {
  id: "trap",
  label: "Trap",
  icon: { path: TRAP_ICON_PATH, box: TRAP_ICON_BOX },
  roles: ["dm"],
  order: TOOL_ORDER.trap,
  cursor: "crosshair",
  pointer: {
    down: onDown,
    move: onMove,
    up: onUp,
    cancel(ctx) {
      const slot = ctx.scope.get(trapSlot);
      slot.gesture = null;
      if (slot.store.getState().draft) slot.store.setState({ draft: null });
    },
  },
  deactivate(ctx) {
    const slot = ctx.scope.get(trapSlot);
    slot.gesture = null;
    slot.store.setState({ draft: null, picking: null, paneId: null });
  },
  Options: TrapOptions,
  cycle: trapCycle,
};

