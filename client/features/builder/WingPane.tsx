import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useStore } from "zustand";
import type { CellRect, RoomState, Scene } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { isHex, sceneGrid, type Grid } from "#shared/rules/grid.ts";
import type { WingClear } from "#shared/rules/wingClear.ts";
import { Button } from "../../components/Button.tsx";
import { useDelayed } from "../../components/Loading.tsx";
import { Help } from "../../components/Panel.tsx";
import { PaneHeader } from "../../components/SheetHeader.tsx";
import { useBackClose } from "../../lib/backClose.ts";
import type { Camera, Insets, Size } from "../../lib/camera.ts";
import { isCoarsePointer } from "../../lib/device.ts";
import { theme } from "../../lib/theme.ts";
import type { ViewBox } from "../../lib/view.ts";
import { useAlertsLane } from "../../pages/fold.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomStore, useRoomView } from "../../state/view.ts";
import { preview, type Summary } from "../dungeon/client.ts";
import type { DungeonPlan, WingBase } from "../dungeon/plan.ts";
import { newSeed, type Seed } from "../dungeon/seed.ts";
import type { DungeonOutcome } from "../dungeon/send.ts";
import { DEFAULT_SETTINGS, MAX_SIDE, MIN_SIDE, type DungeonSettings, type GridKind } from "../dungeon/settings.ts";
import { statusLine } from "../dungeon/words.ts";
import { requestPan } from "../encounter/pan.ts";
import { paneEscape } from "./labelEdit.ts";
import { labelPaneFrame } from "./labelPaneFrame.ts";
import { useBuilderStore, type WingPicks } from "./store.ts";
import { ghostOf, type GhostRoom, type WingGhost } from "./wingGhost.ts";
import { wingBox, wingFit, wingPanePlacement, wingPlace } from "./wingPanePlacement.ts";
import { areaLine, judgeJoin, wingBaseOf, wingWarnings, type WingJoin } from "./wingPick.ts";

/*
 * The wing pane (docs/design: dungeon generator phase 3, 3.3, D-261110-161,
 * 170, 171 and 236): the wing's choices docked beside the map, its ghost
 * on the map, and Add the wing. The choice rows are the Generate dialog's
 * own (`choices`), the planner and the send are given (`planner`, `send`),
 * so the pane holds only the wing's own parts: its place, the area line,
 * the warnings, the camera's fit on opening, the status and its foot.
 */

/** The shared choice rows' props (dungeon/Choices.tsx), `wing` set so they speak of a wing. */
export type WingChoicesProps = { value: DungeonSettings; onChange(next: DungeonSettings): void; held: boolean; grid: GridKind; wing: boolean };

/** What the wing would land, as a send takes it: its ops and the scratch room they landed in. */
export type WingMade = { ops: ClientOp[]; room: RoomState; ids: ReadonlyMap<string, string> };

/** A plan of the wing: its ghost, the foot's counts and what Add the wing sends, or why there is none. */
export type WingPlan = { ok: true; summary: Summary; ghost: WingGhost; made: WingMade | null } | { ok: false; error: "fit" | "bug" };

/** Plans the wing for the choices and seed on its base. Only the newest call's answer is shown. */
export type WingPlanner = (input: { settings: DungeonSettings; seed: Seed; base: WingBase; feetPerCell: number }) => Promise<WingPlan>;

/** Sends a planned wing behind its asks (dungeon/send.ts sendWing), saying how far it got, and asking the forget question. */
export type WingSend = (made: WingMade & { sceneId: string; clear: WingClear }, onAnswered: (n: number, of: number) => void, ask: (q: "forget") => Promise<boolean>) => Promise<DungeonOutcome>;

export const WING_TITLE = "Add a wing";
export const WING_DRAWING = "Drawing the wing…";
export const WING_NO_FOG = "Players see this scene without fog, so the wing shows at once.";
export const WING_FIT_NONE = "Could not fit two rooms. Drag a larger area over empty ground, or pick fewer rooms or Sparse.";
export const WING_NOT_MADE = "This wing could not be made. Reroll for another.";
/** A request waits this long after the last change, so a run of quick changes plans once. */
const QUIET_MS = 120;

/** The grid as the choices read it. */
function gridKind(g: Grid): GridKind {
  return isHex(g) ? (g.orient === "rows" ? "hexRows" : "hexColumns") : "squares";
}

/** Each room's number, as the key numbers it where there is a key, else in plan order, at its middle. */
function ghostRooms(plan: DungeonPlan): GhostRoom[] {
  const numbers = new Map(plan.key?.map((k) => [k.room, k.n]) ?? []);
  return plan.rooms.map((r, i) => ({ n: numbers.get(i) ?? i + 1, x: r.x + r.w / 2, y: r.y + r.h / 2, rect: { x: r.x, y: r.y, w: r.w, h: r.h } }));
}

/**
 * Until the worker plans wings against the scene, its join and open ground
 * (design 3.4), the pane previews a dungeon of the area's size on a scene
 * of its own, stood at the area's corner, so the choices and the ghost can
 * be seen and checked. It never lands as a wing, so Add the wing stays off
 * for it, and on hexes, which the generator does not plan yet, it plans
 * nothing.
 */
export const areaPreview: WingPlanner = async ({ settings, seed, base, feetPerCell }) => {
  if (isHex(sceneGrid(base.scene))) return { ok: false, error: "bug" };
  const side = (n: number) => Math.min(MAX_SIDE, Math.max(MIN_SIDE, n));
  const own = { id: "wing-area", name: "Wing", bounds: { w: side(base.area.w), h: side(base.area.h) } };
  const answer = await preview({ ...settings, w: own.bounds.w, h: own.bounds.h }, seed, own, { feetPerCell }, null);
  if (!answer.ok) return answer;
  const scratchScene = Object.values(answer.room.scenes).find((s) => s !== undefined);
  if (!scratchScene) return { ok: false, error: "bug" };
  const ghost = ghostOf({ base: base.state, sceneId: base.scene.id, scratch: answer.room, scratchScene, area: base.area, offset: { x: base.area.x, y: base.area.y }, feetPerCell, rooms: ghostRooms(answer.plan) });
  return { ok: true, summary: answer.summary, ghost, made: null };
};

type Planned = { asked: number; pending: boolean; plan: WingPlan | null };

export default function WingPane(props: {
  scene: Scene;
  picks: WingPicks & { area: CellRect; join: WingJoin };
  camera: Camera;
  viewport: Size;
  insets: Insets;
  onClose(): void;
  /** Left out, the area's preview below stands in. */
  planner?: WingPlanner;
  send: WingSend | null;
  choices: ComponentType<WingChoicesProps> | null;
}) {
  const { scene, picks } = props;
  const paneRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  useBackClose(true, () => closeRef.current());
  const builder = useBuilderStore();
  const scope = useRoomScope();
  const roomStore = useRoomStore();
  const feetPerCell = useRoomView((s) => s.floorView?.meta.settings.feetPerCell ?? 5);
  const grid = sceneGrid(scene);
  const lane = useAlertsLane(props.viewport);

  // The side is kept from the pane's opening: a pan while it is open must not swing it to the other edge. A resize places it again on that side.
  const [opened] = useState(() => wingPlace({ scene, area: picks.area, camera: props.camera, viewport: props.viewport, insets: props.insets, lane }));
  const side = opened.kind === "card" ? opened.side : "right";
  const place = wingPanePlacement({ viewport: props.viewport, insets: props.insets, areaX: side === "left" ? props.viewport.width : 0, lane });

  // Escape closes the pane, as it closes the other map panes, unless a dialog or a field elsewhere has it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const editing = target !== null && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (!paneEscape({ key: e.key, handled: e.defaultPrevented, dialogOpen: document.querySelector('[aria-modal="true"]') !== null, editingElsewhere: editing && !paneRef.current?.contains(target) })) return;
      e.preventDefault();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The camera fits the area and the way to the join into the map beside the pane, once, as it opens (D-261110-236): never again on a plan, or the map would jump while the DM changes choices.
  useEffect(() => {
    const box = wingBox(grid, picks.area, picks.join);
    const view: ViewBox = { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 } as ViewBox;
    const fit = wingFit({ viewport: props.viewport, insets: props.insets, place, box: view });
    requestPan(scope, { sceneId: scene.id, x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2, anchor: fit.anchor });
    // The pane opens on its first control, for a mouse: a phone keeps its keyboard and focus ring down.
    if (!isCoarsePointer()) firstRef.current?.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [settings, setSettings] = useState<DungeonSettings>(() => ({ ...DEFAULT_SETTINGS, w: picks.area.w, h: picks.area.h }));
  const [seed, setSeed] = useState<Seed>(() => newSeed());
  const edit = useStore(builder, (b) => b.wingEdit);

  // Wide joins two squares or three hex sides, so the join is judged again for the pane's Corridor width.
  const judged = useMemo(() => {
    const view = roomStore.getState().floorView;
    if (!view || picks.tap === null) return null;
    return judgeJoin(view, scene, picks.tap, picks.area, settings.wide);
  }, [roomStore, scene, picks.tap, picks.area, settings.wide]);
  const join = judged?.ok === true ? judged.value : null;
  const joinProblem = judged?.ok === false ? judged.problem : null;

  // The base is read when the area or join is set, not on every change to the room: Add the wing checks the live scene again (3.5).
  const base = useMemo(() => {
    const view = roomStore.getState().floorView;
    return view && join ? wingBaseOf(view, scene, picks.area, join) : null;
  }, [roomStore, scene, picks.area, join]);

  const view = useRoomView((s) => s.floorView);
  const warnings = useMemo(() => (view ? wingWarnings(view, scene, picks.area, join).join(" ") : ""), [view, scene, picks.area, join]);

  const [planned, setPlanned] = useState<Planned>({ asked: 0, pending: false, plan: null });
  const asked = useRef(0);
  useEffect(() => {
    const id = ++asked.current;
    if (!base) {
      setPlanned({ asked: id, pending: false, plan: null });
      builder.setState({ wingGhost: null });
      return;
    }
    setPlanned((p) => ({ ...p, asked: id, pending: true }));
    const planner = props.planner ?? areaPreview;
    const timer = setTimeout(() => {
      planner({ settings, seed, base, feetPerCell }).then(
        (plan) => {
          if (asked.current !== id) return;
          setPlanned({ asked: id, pending: false, plan });
          builder.setState({ wingGhost: plan.ok ? plan.ghost : null });
        },
        () => {
          if (asked.current === id) setPlanned({ asked: id, pending: false, plan: { ok: false, error: "bug" } });
        },
      );
    }, QUIET_MS);
    return () => clearTimeout(timer);
  }, [props.planner, base, settings, seed, feetPerCell, builder]);

  // The ghost goes with the pane.
  useEffect(() => () => builder.setState({ wingGhost: null, wingEdit: false }), [builder]);

  const drawing = useDelayed(planned.pending);
  const plan = planned.plan;
  const status = drawing ? WING_DRAWING : plan === null ? "" : plan.ok ? statusLine(plan.summary) : plan.error === "fit" ? WING_FIT_NONE : WING_NOT_MADE;
  const ready = !planned.pending && plan?.ok === true && plan.made !== null && props.send !== null && joinProblem === null;
  const Choices = props.choices;
  // A docked card keeps its foot in view and scrolls its rows. A sheet can be short, as at 320 by 568 at 130%, where a pinned foot would leave the rows no room, so the whole sheet scrolls under its header.
  const sheet = place.kind === "sheet";

  return (
    <div
      ref={paneRef}
      role="dialog"
      aria-label={WING_TITLE}
      data-map-pane=""
      data-wing-pane=""
      style={{ ...labelPaneFrame(place), height: place.height, boxSizing: "border-box", display: "flex", flexDirection: "column", color: theme.color.text, ...(sheet ? { overflowY: "auto", overscrollBehavior: "contain" } : null) }}
    >
      <PaneHeader title={<span role="heading" aria-level={2}>{WING_TITLE}</span>} closeLabel="Close" onClose={props.onClose} sticky={sheet} />
      <div
        ref={firstRef}
        style={{ display: "grid", alignContent: "start", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2), ...(sheet ? { flex: "1 0 auto" } : { flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }) }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
          <Button size="sm" icon="again" onClick={() => setSeed(newSeed())}>
            Reroll
          </Button>
          <Button size="sm" pressed={edit} onClick={() => builder.setState({ wingEdit: !edit })}>
            Edit rooms
          </Button>
        </div>
        <p style={{ margin: 0 }}>{areaLine(grid, picks.area, feetPerCell)}</p>
        {Choices ? <Choices value={settings} onChange={setSettings} held={false} grid={gridKind(grid)} wing /> : null}
        {joinProblem ? <Help style={{ color: theme.color.warning }}>{joinProblem}</Help> : null}
        {scene.fogEnabled !== true ? <Help>{WING_NO_FOG}</Help> : null}
        {warnings ? <Help style={{ color: theme.color.warning }}>{warnings}</Help> : null}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: theme.space(2), paddingTop: theme.space(2), borderTop: `${theme.line.border}px solid ${theme.color.border}` }}>
        <span role="status" style={{ flex: "1 1 10em", minWidth: 0, color: theme.color.textMuted, fontSize: theme.font.body14 }}>
          {status}
        </span>
        <Button size="sm" variant="primary" disabled={!ready}>
          Add the wing
        </Button>
      </div>
    </div>
  );
}
