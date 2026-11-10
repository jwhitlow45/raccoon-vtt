import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ComponentType, type RefObject } from "react";
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
import { LIMITS } from "#shared/limits.ts";
import type { RoomActions } from "../../state/types.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { postWingBase, previewWing, type Preview, type Summary } from "../dungeon/client.ts";
import { highestWingPin, type KeyInput } from "../dungeon/keyPage.ts";
import { wingIds } from "../dungeon/ops.ts";
import type { DungeonEdits, RoomEdit, RoomFacts } from "../dungeon/edits.ts";
import { editedRooms, editsStep, startEdits, type EditsEvent, type EditsState } from "../dungeon/flow.ts";
import type { WingBase } from "../dungeon/plan.ts";
import { RoomPanel } from "../dungeon/RoomPanel.tsx";
import { newSeed, type Seed } from "../dungeon/seed.ts";
import { sendWing, WING_TOO_LARGE, type SendRoom, type WingOutcome } from "../dungeon/send.ts";
import { DEFAULT_SETTINGS, isHexGrid, type DungeonSettings, type GridKind } from "../dungeon/settings.ts";
import type { WingProblem } from "../dungeon/wing.ts";
import { BUILD_ASKING } from "./ask.ts";
import { BRING_BACK, DROP_EDITS, EDIT_OVER_WALLS, editedLine, EDITS_DROPPED, EDITS_GONE, statusLine } from "../dungeon/words.ts";
import { requestPan } from "../encounter/pan.ts";
import { paneEscape } from "./labelEdit.ts";
import { labelPaneFrame } from "./labelPaneFrame.ts";
import { NO_WING, useBuilderStore, type WingPicks } from "./store.ts";
import { ghostOf, ghostRooms, type WingGhost } from "./wingGhost.ts";
import { wingBox, wingFit, wingPanePlacement, wingPlace } from "./wingPanePlacement.ts";
import { areaLine, JOIN_WORDS, judgeJoin, wingBaseOf, wingWarnings, type WingJoin } from "./wingPick.ts";
import { JOIN_CHANGED, WING_MOVED } from "#shared/rules/wingClear.ts";

/*
 * The wing pane (docs/design: dungeon generator phase 3, 3.3, D-261110-161,
 * 170, 171 and 236): the wing's choices docked beside the map, its ghost
 * on the map, and Add the wing. The choice rows are the Generate dialog's
 * own (`choices`), the planner and the send are given (`planner`, `send`),
 * so the pane holds only the wing's own parts: its place, the area line,
 * the warnings, the camera's fit on opening, the status and its foot.
 */

/** The shared choice rows' props (dungeon/Choices.tsx), `wing` set so they speak of a wing. */
export type WingChoicesProps = { value: DungeonSettings; onChange(next: DungeonSettings): void; held: boolean; grid: GridKind; wing: boolean; flat?: boolean };

/** What the wing would land, as a send takes it: its ops and the scratch room they landed in. */
export type WingMade = { ops: ClientOp[]; room: RoomState; ids: ReadonlyMap<string, string> };

/** A plan of the wing: its ghost, the foot's counts and what Add the wing sends with what its asks carry, or why there is none, in words when the planner says. */
export type WingPlan =
  | { ok: true; summary: Summary; ghost: WingGhost; made: WingMade | null; clear?: WingClear; facts?: RoomFacts[]; layout?: DungeonEdits["layout"] }
  | { ok: false; error: "fit" | "bug"; words?: string; why?: string };

/** Plans the wing for the choices, seed and room edits on its base. Only the newest call's answer is shown. */
export type WingPlanner = (input: { settings: DungeonSettings; seed: Seed; base: WingBase; feetPerCell: number; edits?: DungeonEdits | null }) => Promise<WingPlan>;

/** Sends a planned wing behind its asks (dungeon/send.ts sendWing), saying how far it got, and asking the forget question. */
export type WingSend = (made: WingMade & { sceneId: string; clear: WingClear }, onAnswered: (n: number, of: number) => void, ask: (q: "forget") => Promise<boolean>) => Promise<WingOutcome>;

export const WING_TITLE = "Add a wing";
export const WING_DRAWING = "Drawing the wing…";
export const WING_NO_FOG = "Players see this scene without fog, so the wing shows at once.";
export const WING_FIT_NONE = "Could not fit two rooms. Drag a larger area over empty ground, or pick fewer rooms or Sparse.";
export const WING_NOT_MADE = "This wing could not be made. Reroll for another.";
export const WING_WAITING = "Waiting for the server…";
/** A request waits this long after the last change, so a run of quick changes plans once. */
const QUIET_MS = 120;

/** The grid as the choices read it. */
function gridKind(g: Grid): GridKind {
  return isHex(g) ? (g.orient === "rows" ? "hexRows" : "hexColumns") : "squares";
}

/** What each of the planner's problems says (design 3.2 to 3.4), in the pane's status line. */
export function problemWords(problem: WingProblem, hex: boolean): string {
  switch (problem) {
    case "noGround":
      return JOIN_WORDS.hexBeyond;
    case "openRoom":
      return JOIN_WORDS.hexOpen;
    case "longWall":
      return JOIN_WORDS.hexLong;
    case "offGrid":
      return JOIN_WORDS.squaresFree;
    case "wideShape":
      return hex ? JOIN_WORDS.wideHex : JOIN_WORDS.wideSquares;
    case "raised":
      return JOIN_WORDS.floorRaised;
    case "nearJoin":
      return WING_NEAR;
    case "noStairs":
      return WING_NO_STAIRS;
    case "noWay":
      return WING_NO_WAY;
    case "noRooms":
      return WING_FIT_NONE;
    case "full":
      return WING_FULL;
  }
}

export const WING_NEAR = "Something stands too near that wall for a doorway. Tap another wall.";
export const WING_NO_STAIRS = "No room for stairs at that wall. Tap another wall.";
export const WING_NO_WAY = "No way from the area to that wall. Reroll, tap a nearer wall or drag the area closer.";
export const WING_FULL = "This scene has too many walls and doors for a wing.";
export const WING_HEX_TOO_MANY = "Too many rooms for the walls a hex scene holds. Try fewer rooms or Sparse.";

/** What the wing's key reads of the room: the scene's name, the DM's color, the scene's highest W pin, its pages' titles and the pins it has room for (D-261110-165). */
export type WingKeyRoom = { name: string; color: string; titles: readonly string[] };

/**
 * The worker's wing (dungeon/client.ts previewWing, design 3.3 and 3.4):
 * the base posted once per hash and join, then planned with the choices,
 * the ghost drawn from the scratch room the wing landed in, and what Add
 * the wing sends with what its asks carry. The hash leaves out the join
 * Corridor width widens (wingPick.ts `wingBaseOf`), so the join is read
 * apart.
 */
export function wingPlanner(keyRoom: () => WingKeyRoom | null, post: (base: WingBase) => void = postWingBase, plan: typeof previewWing = previewWing): WingPlanner {
  let posted: string | null = null;
  return async ({ settings, seed, base, feetPerCell, edits }) => {
    const read = `${base.hash} ${JSON.stringify(base.join)}`;
    if (posted !== read) {
      post(base);
      posted = read;
    }
    const grid = base.scene.gridShape ?? "squares";
    const sceneId = base.scene.id;
    const room = keyRoom();
    const held = Object.values(base.state.pins).filter((p) => p?.sceneId === sceneId).length;
    const key: KeyInput | null = settings.key && room ? { name: room.name, color: room.color, feetPerCell, wing: { from: highestWingPin(base.state.pins, sceneId), titles: room.titles, pins: Math.max(0, Math.floor(0.9 * LIMITS.pinsPerScene) - held) } } : null;
    const answer: Preview = await plan(settings, seed, { feetPerCell, ...(isHexGrid(grid) ? { grid } : {}) }, key, edits ?? null);
    if (!answer.ok) {
      const words = answer.problem ? problemWords(answer.problem, isHexGrid(grid)) : answer.why === "tooMany" ? WING_HEX_TOO_MANY : undefined;
      return { ok: false, error: answer.error, ...(words ? { words } : {}), ...(answer.why ? { why: answer.why } : {}) };
    }
    const scratchScene = answer.room.scenes[sceneId];
    if (!scratchScene) return { ok: false, error: "bug" };
    const ghost = ghostOf({ base: base.state, sceneId, scratch: answer.room, scratchScene, area: base.area, offset: { x: 0, y: 0 }, feetPerCell, rooms: ghostRooms(answer.plan, answer.facts) });
    return { ok: true, summary: answer.summary, ghost, made: { ops: answer.ops, room: answer.room, ids: new Map() }, ...(answer.clear ? { clear: answer.clear } : {}), facts: answer.facts, layout: answer.layout };
  };
}

/** Add the wing's send: every id fresh at Make (dungeon/ops.ts wingIds), then sendWing behind its asks. */
export function wingSender(actions: RoomActions, room: SendRoom): WingSend {
  return (made, onAnswered, ask) => {
    const fresh = wingIds(made.ops, made.sceneId, made.sceneId, actions.newId);
    return sendWing({ ops: fresh.ops, ids: fresh.ids, room: made.room, sceneId: made.sceneId, clear: made.clear }, actions, room, onAnswered, ask);
  };
}

/** The forget question's words, the builder's own (design 3.5). */
export const FORGET_TITLE = "Remembered map";
export const FORGET_ASK_WORDS = "Players' remembered map here will be forgotten. Go ahead?";
export const FORGET_HELP = "Their map can keep only so much that changed out of their sight. The ground this change runs past that goes back under the fog for them, as if never seen, and neither Undo nor Undo setup in Setup history brings it back.";

/**
 * The forget question as Add the wing asks it (3.5): `ask` shows it through
 * `show` and waits for Go ahead or Cancel, and `close`, as the pane goes,
 * answers a question still showing as Cancel without showing anything, so
 * the send never waits on a pane that is gone (DG3 review round 1). An
 * answer given after that, or to an older question, does nothing.
 */
export function forgetQuestion(show: (answer: ((yes: boolean) => void) | null) => void): { ask(): Promise<boolean>; close(): void } {
  let waiting: ((yes: boolean) => void) | null = null;
  return {
    ask: () =>
      new Promise<boolean>((resolve) => {
        waiting = resolve;
        show((yes) => {
          if (waiting !== resolve) return;
          waiting = null;
          show(null);
          resolve(yes);
        });
      }),
    close() {
      const pending = waiting;
      waiting = null;
      pending?.(false);
    },
  };
}

/** What the pane says of a wing that did not end complete (3.5), or null where the pane closes. */
export function outcomeWords(outcome: WingOutcome): string | null {
  switch (outcome.k) {
    case "complete":
      return outcome.checked ? "The connection dropped while adding the wing, but it is complete. Undo setup in Setup history usually takes it back." : null;
    case "none":
      return outcome.lost ? "The connection dropped, and nothing was added. Try again." : "Nothing was added.";
    case "partial":
      return "The server refused part of the wing, so it may be missing rooms, doors or traps. Undo setup in Setup history usually takes back what landed.";
    case "unconfirmed":
      return "The connection dropped while adding the wing, and it could not be confirmed complete. Undo setup in Setup history usually takes back what landed.";
    case "join":
      return JOIN_CHANGED;
    case "moved":
      return WING_MOVED;
    case "large":
      return WING_TOO_LARGE;
  }
}

/**
 * Whether a sheet is too short to keep its header in place over the rows:
 * the room the rows would get beside the header is under two of their
 * first row, the Reroll row. Measured, so it holds at any interface size,
 * and the same either way the header stands, so it never flips back and
 * forth. Each move of the header observes it afresh. A docked card is
 * never short.
 */
function useShortSheet(sheet: boolean, scroll: RefObject<HTMLElement | null>, head: RefObject<HTMLElement | null>, rows: RefObject<HTMLElement | null>): boolean {
  const [short, setShort] = useState(false);
  useLayoutEffect(() => {
    const box = scroll.current;
    if (!sheet || !box) {
      setShort(false);
      return;
    }
    const measure = () => {
      const header = head.current;
      const first = rows.current?.firstElementChild;
      if (!header || !(first instanceof HTMLElement)) return;
      const inside = box.contains(header);
      const room = box.clientHeight - (inside ? header.offsetHeight : 0);
      setShort(room < 2 * first.offsetHeight + theme.space(2));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    if (head.current) observer.observe(head.current);
    return () => observer.disconnect();
  }, [sheet, scroll, head, rows, short]);
  return short;
}

type Planned = { asked: number; pending: boolean; plan: WingPlan | null };
/** What Bring them back restores beside the edits. */
type WingBefore = { settings: DungeonSettings; seed: Seed };
const EDITS_LINE = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), minWidth: 0 } as const;

export default function WingPane(props: {
  scene: Scene;
  picks: WingPicks & { area: CellRect; join: WingJoin };
  camera: Camera;
  viewport: Size;
  insets: Insets;
  onClose(): void;
  /** Left out, the worker's wing (`wingPlanner`) plans it. */
  planner?: WingPlanner;
  /** Left out, the room's own send (`wingSender`). Null sends nothing, as a test's pane. */
  send?: WingSend | null;
  choices: ComponentType<WingChoicesProps> | null;
}) {
  const { scene, picks } = props;
  const paneRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  useBackClose(true, () => closeRef.current());
  const builder = useBuilderStore();
  const scope = useRoomScope();
  const roomStore = useRoomStore();
  const ui = useRoomUi();
  const actions = useRoomActions();
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
    // The pane opens on Theme (design 7), as the dialog does.
    const first = firstRef.current?.querySelector<HTMLElement>('[data-choice="theme"] input:checked') ?? firstRef.current?.querySelector<HTMLElement>("input, button");
    if (!isCoarsePointer()) first?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [settings, setSettingsNow] = useState<DungeonSettings>(() => ({ ...DEFAULT_SETTINGS, w: picks.area.w, h: picks.area.h }));
  const [seed, setSeedNow] = useState<Seed>(() => newSeed());
  const edit = useStore(builder, (b) => b.wingEdit);
  const pickedRoom = useStore(builder, (b) => b.wingRoom);
  // Room edits in the pane, kept as the dialog keeps them (dungeon/flow.ts, 3.3, D-261110-171): a change of choice or seed drops them with Bring them back.
  const [edits, editStep] = useReducer((s: EditsState<WingBefore>, e: EditsEvent<WingBefore>) => editsStep(s, e), undefined, startEdits<WingBefore>);
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const setSettings = (next: DungeonSettings) => {
    editStep({ k: "change", before: { settings, seed } });
    setSettingsNow(next);
  };
  const setSeed = (next: Seed) => {
    editStep({ k: "change", before: { settings, seed } });
    builder.setState({ wingRoom: null });
    setSeedNow(next);
  };
  const bringBack = () => {
    const back = edits.dropped;
    if (!back) return;
    setSettingsNow(back.before.settings);
    setSeedNow(back.before.seed);
    editStep({ k: "bringBack" });
  };
  // A "floor" scene's stairs make no walls, so its wing stays flat (3.2, D-261110-235).
  const flat = scene.autoWalls === "floor";

  // Wide joins two squares or three hex sides, so the join is judged again for the pane's Corridor width.
  const judged = useMemo(() => {
    const view = roomStore.getState().floorView;
    if (!view || picks.tap === null) return null;
    return judgeJoin(view, scene, picks.tap, picks.area, settings.wide);
  }, [roomStore, scene, picks.tap, picks.area, settings.wide]);
  const join = judged?.ok === true ? judged.value : null;
  const joinProblem = judged?.ok === false ? judged.problem : null;

  // The base is read when the area or join is set, not on every change to the room: Add the wing checks the live scene again (3.5).
  // A clash at Add the wing posts the base again (3.5): `reread` moves it on.
  const [reread, setReread] = useState(0);
  const base = useMemo(() => {
    const view = roomStore.getState().floorView;
    return view && join ? wingBaseOf(view, scene, picks.area, join) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomStore, scene, picks.area, join, reread]);
  // The key's room: the scene's name, the DM's color and the pages' titles, read as each plan asks.
  const planner = useMemo(
    () =>
      props.planner ??
      wingPlanner(() => {
        const s = roomStore.getState();
        const color = s.view?.members[s.you?.memberId ?? ""]?.color;
        return color ? { name: scene.name, color, titles: Object.values(s.view?.journal ?? {}).flatMap((p) => (p ? [p.title] : [])) } : null;
      }),
    [props.planner, roomStore, scene.name],
  );

  // A base posted again whose geometry changed drops the edits, with no way back (4.2).
  const baseHash = base?.hash ?? null;
  const lastHash = useRef(baseHash);
  useEffect(() => {
    if (lastHash.current !== null && baseHash !== null && lastHash.current !== baseHash) editStep({ k: "baseChanged" });
    lastHash.current = baseHash;
  }, [baseHash]);

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
    const sent = edits.edits;
    const timer = setTimeout(() => {
      planner({ settings, seed, base, feetPerCell, edits: sent }).then(
        (plan) => {
          if (asked.current !== id) return;
          // Edits freeze a layout that fit, so a plan with them that does not fit is the newest edit's doing: undone, and asked again (4.2).
          if (!plan.ok && plan.error === "fit" && (plan.why === undefined || plan.why === "edits") && sent !== null && editsRef.current.last !== null) return editStep({ k: "overBudget", report: EDIT_OVER_WALLS });
          setPlanned({ asked: id, pending: false, plan });
          builder.setState({ wingGhost: plan.ok ? plan.ghost : null });
        },
        () => {
          if (asked.current === id) setPlanned({ asked: id, pending: false, plan: { ok: false, error: "bug" } });
        },
      );
    }, QUIET_MS);
    return () => clearTimeout(timer);
  }, [planner, base, settings, seed, feetPerCell, builder, edits.edits]);

  // The ghost goes with the pane.
  useEffect(() => () => builder.setState({ wingGhost: null, wingEdit: false, wingRoom: null }), [builder]);

  const drawing = useDelayed(planned.pending);
  const plan = planned.plan;
  // Add the wing: checking players' remembered map, then how many of its ops are answered, and the forget question while it waits.
  const [sending, setSending] = useState<"asking" | { n: number; of: number } | null>(null);
  const [forget, setForget] = useState<((yes: boolean) => void) | null>(null);
  const question = useMemo(() => forgetQuestion((answer) => setForget(() => answer)), []);
  const [said, setSaid] = useState<string | null>(null);
  const mounted = useRef(true);
  // Set again on each mount, since development's strict mode mounts the pane twice.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      question.close();
    };
  }, [question]);
  const send = useMemo(() => (props.send === undefined ? wingSender(actions, { store: roomStore, shown: () => mounted.current }) : props.send), [props.send, actions, roomStore]);
  const sendLine = sending === "asking" ? BUILD_ASKING : sending ? (sending.n >= sending.of ? WING_WAITING : `Adding the wing… ${sending.n} of ${sending.of}`) : null;
  const planLine = drawing ? WING_DRAWING : plan === null ? "" : plan.ok ? statusLine(plan.summary) : (plan.words ?? (plan.error === "fit" ? WING_FIT_NONE : WING_NOT_MADE));
  const status = sendLine ?? said ?? planLine;
  const ready = !planned.pending && sending === null && plan?.ok === true && plan.made !== null && plan.clear !== undefined && send !== null && joinProblem === null;
  const add = async () => {
    if (!ready || !plan?.ok || !plan.made || !plan.clear || !send) return;
    setSaid(null);
    setSending("asking");
    const outcome = await send(
      { ...plan.made, sceneId: scene.id, clear: plan.clear },
      (n, of) => {
        if (mounted.current) setSending({ n, of });
      },
      () => (mounted.current ? question.ask() : Promise.resolve(false)),
    );
    const words = outcomeWords(outcome);
    if (!mounted.current) {
      if (words) ui.notify(words, outcome.k === "complete" ? "info" : "error");
      return;
    }
    setSending(null);
    if (outcome.k === "complete") {
      // The pane closes and the mode clears (3.5), and a checked wing says how it was confirmed.
      if (words) ui.notify(words, "info");
      builder.setState({ ...NO_WING });
      return;
    }
    if (outcome.k === "join") {
      // A changed join is tapped again: the pane closes with it, and the toast says why.
      ui.notify(JOIN_CHANGED, "error");
      builder.setState({ wing: { ...picks, tap: null, join: null }, wingOpen: false, wingGhost: null, wingEdit: false, wingRoom: null });
      return;
    }
    if (outcome.k === "moved") setReread((n) => n + 1);
    setSaid(words);
  };
  const Choices = props.choices;
  // The rooms on the ghost as the key numbers them, and the picked one's panel in the rows' place (3.3).
  const facts = plan?.ok ? (plan.facts ?? []) : [];
  const pickedFacts = pickedRoom === null ? null : (facts.find((f) => f.n === pickedRoom) ?? null);
  const pickedIndex = pickedFacts?.room ?? null;
  const stepRoom = (by: -1 | 1) => {
    const at = facts.findIndex((f) => f.n === pickedRoom);
    const next = at < 0 ? facts[0] : facts[(at + by + facts.length) % facts.length];
    if (next) builder.setState({ wingRoom: next.n });
  };
  const editRoom = (next: RoomEdit | null) => {
    // The layout the plan froze, its choices clamped to the area, as the planner holds edits to (4.2).
    if (pickedIndex === null || !plan?.ok || !plan.layout) return;
    editStep({ k: "edit", room: pickedIndex, edit: next, layout: plan.layout });
  };
  // Done gives focus back to Edit rooms, the control that lets a tap on the ghost open a room, since the tap that opened the panel left none to return to (LP37-A-WING-5).
  const editRef = useRef<HTMLButtonElement>(null);
  const roomDone = () => {
    editRef.current?.focus({ preventScroll: true });
    builder.setState({ wingRoom: null });
  };
  const short = useShortSheet(place.kind === "sheet", scrollRef, headRef, firstRef);
  const header = (
    <div ref={headRef}>
      <PaneHeader title={<span role="heading" aria-level={2}>{WING_TITLE}</span>} closeLabel="Close" onClose={props.onClose} />
    </div>
  );

  return (
    <div
      ref={paneRef}
      role="dialog"
      aria-label={WING_TITLE}
      data-map-pane=""
      data-wing-pane=""
      style={{ ...labelPaneFrame(place), height: place.height, boxSizing: "border-box", display: "flex", flexDirection: "column", color: theme.color.text }}
    >
      {short ? null : header}
      {/*
       * Only the rows scroll, on a docked card and on a sheet alike, so the foot's counts, the planner's words and
       * Add the wing are in view as the pane opens (LP37-A-WING-3). A sheet too short for the header, two rows and the
       * foot, as at 320 by 568 at 130%, scrolls its header away with the rows instead (`useShortSheet`). The forget
       * question, which needs the room only while it asks, scrolls on its own.
       */}
      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }}>
        {short ? header : null}
        <div ref={firstRef} style={{ display: "grid", alignContent: "start", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
            <Button size="sm" icon="again" onClick={() => setSeed(newSeed())}>
              Reroll
            </Button>
            <Button ref={editRef} size="sm" pressed={edit} onClick={() => builder.setState({ wingEdit: !edit, wingRoom: null })}>
              Edit rooms
            </Button>
          </div>
          <p style={{ margin: 0 }}>{areaLine(grid, picks.area, feetPerCell)}</p>
          {/* A planner that gives no room facts has no rooms to edit. */}
          {pickedRoom !== null && facts.length > 0 ? (
            <RoomPanel
              facts={pickedFacts}
              edit={pickedIndex === null ? undefined : edits.edits?.rooms[pickedIndex]}
              onEdit={editRoom}
              onStep={stepRoom}
              onDone={roomDone}
              cave={settings.theme === "cave"}
              flat={flat}
              wing
              held={sending !== null}
              more={pickedIndex !== null && edits.undone[pickedIndex] ? [edits.undone[pickedIndex]] : []}
            />
          ) : (
            <>
              {edits.dropped || edits.gone ? (
                <div data-edits-dropped="" style={EDITS_LINE}>
                  <Help style={{ flex: "1 1 12em" }}>{edits.gone ? EDITS_GONE : EDITS_DROPPED}</Help>
                  {edits.dropped ? (
                    <Button size="sm" onClick={bringBack}>
                      {BRING_BACK}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {Choices ? <Choices value={settings} onChange={setSettings} held={sending !== null} grid={gridKind(grid)} wing flat={flat} /> : null}
              {edits.edits ? (
                <div data-edits-line="" style={EDITS_LINE}>
                  <Help style={{ flex: "1 1 12em" }}>{editedLine(editedRooms(edits))}</Help>
                  <Button size="sm" onClick={() => editStep({ k: "drop" })}>
                    {DROP_EDITS}
                  </Button>
                </div>
              ) : null}
            </>
          )}
          {joinProblem ? <Help style={{ color: theme.color.warning }}>{joinProblem}</Help> : null}
          {scene.fogEnabled !== true ? <Help>{WING_NO_FOG}</Help> : null}
          {warnings ? <Help style={{ color: theme.color.warning }}>{warnings}</Help> : null}
        </div>
      </div>
      {forget ? (
        <div role="group" aria-label={FORGET_TITLE} style={{ display: "grid", gap: theme.space(2), paddingTop: theme.space(2), borderTop: `${theme.line.border}px solid ${theme.color.border}`, flex: "0 1 auto", minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }}>
          <span role="heading" aria-level={3} style={{ fontWeight: 600 }}>
            {FORGET_TITLE}
          </span>
          <p style={{ margin: 0 }}>{FORGET_ASK_WORDS}</p>
          <Help>{FORGET_HELP}</Help>
          <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
            <Button size="sm" variant="primary" onClick={() => forget(true)}>
              Go ahead
            </Button>
            <Button size="sm" onClick={() => forget(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: theme.space(2), paddingTop: theme.space(2), borderTop: `${theme.line.border}px solid ${theme.color.border}` }}>
        <span role="status" style={{ flex: "1 1 10em", minWidth: 0, color: theme.color.textMuted, fontSize: theme.font.body14 }}>
          {status}
        </span>
        <Button size="sm" variant="primary" disabled={!ready} busy={sending !== null} onClick={() => void add()}>
          Add the wing
        </Button>
      </div>
    </div>
  );
}
