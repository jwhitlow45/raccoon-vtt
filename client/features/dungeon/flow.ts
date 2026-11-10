import type { DungeonEdits, RoomEdit } from "./edits.ts";

/*
 * How the Generate a dungeon dialog's preview stands
 * (docs/design/design-v1-dungeon-generator.md 4.3), kept pure so a
 * randomized test walks it. Make sends the answer it holds, so Make is on
 * only for the newest request's answer once that very answer's picture is
 * on screen. The worker answers before the picture is drawn (textures load
 * and the image encodes after), and until it is, the box still shows the
 * previous dungeon. A picture that fails to draw keeps Make off, since the
 * DM would be making a dungeon they never saw.
 */

/** A worker's answer: the dungeon, or why there is none. */
export type Answer<T> = { ok: true; value: T } | { ok: false; error: "fit" | "bug" };

export type Flow<T extends { drawn: object }> = {
  /** The newest request's number. An answer to any other is dropped. */
  asked: number;
  /** The newest request is not answered yet. */
  pending: boolean;
  /** The seed field reads as a seed. */
  seedOk: boolean;
  /** The newest dungeon answered. It stays through a later error, as the old picture does. */
  shown: T | null;
  problem: "fit" | "bug" | null;
  /** The drawing whose picture the box shows, null while it shows none. */
  pictured: object | null;
  /** The answer whose picture the box shows, null while it shows none or one whose answer a newer one replaced before it landed. */
  onScreen: T | null;
  /** A drawing whose picture could not be made. */
  failed: object | null;
};

export type FlowEvent<T> =
  | { k: "ask"; id: number }
  /** The seed stopped reading as one. A request still drawing is overtaken, so its answer never replaces the one shown. */
  | { k: "invalid"; id: number }
  | { k: "answer"; id: number; answer: Answer<T> }
  | { k: "pictured"; drawn: object }
  | { k: "pictureFailed"; drawn: object };

export function startFlow<T extends { drawn: object }>(): Flow<T> {
  return { asked: 0, pending: false, seedOk: true, shown: null, problem: null, pictured: null, onScreen: null, failed: null };
}

export function flowStep<T extends { drawn: object }>(f: Flow<T>, e: FlowEvent<T>): Flow<T> {
  switch (e.k) {
    case "ask":
      return { ...f, asked: e.id, pending: true, seedOk: true };
    case "invalid":
      return { ...f, asked: e.id, pending: false, seedOk: false };
    case "answer":
      // A bad seed asks nothing, so an answer then is a stale one.
      if (e.id !== f.asked || !f.seedOk) return f;
      return e.answer.ok ? { ...f, pending: false, shown: e.answer.value, problem: null } : { ...f, pending: false, problem: e.answer.error };
    case "pictured":
      // A picture of a drawing already overtaken still shows, but stands for nothing Make would send.
      return { ...f, pictured: e.drawn, onScreen: f.shown?.drawn === e.drawn ? f.shown : null, failed: f.failed === e.drawn ? null : f.failed };
    case "pictureFailed":
      // The box empties on a failure, so nothing is pictured.
      return { ...f, pictured: null, onScreen: null, failed: e.drawn };
  }
}

export type Readiness<T> = {
  /** What Make would send, or null while Make is off for the preview's sake. */
  current: T | null;
  /** "Drawing the dungeon…": a request out, or an answer whose picture is not in yet. */
  drawing: boolean;
  /** The newest dungeon's picture could not be drawn. */
  pictureFailed: boolean;
};

export function readiness<T extends { drawn: object }>(f: Flow<T>): Readiness<T> {
  const answered = f.seedOk && !f.pending && f.problem === null ? f.shown : null;
  const failed = answered !== null && f.failed === answered.drawn;
  const pictured = answered !== null && f.pictured === answered.drawn;
  return {
    current: pictured ? answered : null,
    drawing: f.seedOk && (f.pending || (answered !== null && !pictured && !failed)),
    pictureFailed: failed,
  };
}

/**
 * The answer the foot counts: the one on screen, kept while the next one
 * draws and while the seed does not read, as its picture is, so the foot
 * never loses its line between two pictures. Never one not on screen, and
 * none beside a problem, whose words say why no dungeon follows it.
 */
export function counted<T extends { drawn: object }>(f: Flow<T>): T | null {
  return f.problem === null ? f.onScreen : null;
}

/**
 * The drawing the box should be rendering, or null for none. A seed that
 * stopped reading cancels a render in flight, so a picture made after it
 * never replaces the one kept, and a failed encode never clears it.
 */
export function drawable<T extends { drawn: object }>(f: Flow<T>): T["drawn"] | null {
  return f.seedOk ? (f.shown?.drawn ?? null) : null;
}

/*
 * Per-room edits as the dialog and the wing pane hold them (docs/design:
 * dungeon generator phase 3, 4.2 and 4.4, D-261110-098 and 231), kept pure
 * so a randomized test walks them. Edits freeze the layout of the plan
 * they were first made on. A changed choice, a Reroll or a new seed drops
 * them, and Bring them back restores the choices, the seed and the edits
 * from before that change, for one step: any later change or edit forgets
 * it. An edit that takes a hex plan past its wall budget is undone, with a
 * report on its room. A wing base whose geometry changed drops them with
 * no way back.
 */

/** The layout edits freeze (edits.ts `DungeonEdits`). */
export type EditLayout = DungeonEdits["layout"];

export type EditsState<C> = {
  edits: DungeonEdits | null;
  /** The newest edit, so the wall budget can undo it: its room and the pins the room had before. */
  last: { room: number; before: RoomEdit | undefined } | null;
  /** What Bring them back restores: the choices and seed before the change that dropped the edits, and the edits. */
  dropped: { before: C; edits: DungeonEdits } | null;
  /** Reports the wall budget left, by board index, until the room's next edit. */
  undone: Readonly<Record<number, string>>;
  /** Said once edits go without Bring them back: the scene changed under a wing. */
  gone: boolean;
};

export type EditsEvent<C> =
  /** A room's pins set, or dropped with null (Reset room). `layout` is the plan on screen's, frozen by the first edit. */
  | { k: "edit"; room: number; edit: RoomEdit | null; layout: EditLayout }
  /** A choice, a Reroll or the seed changed: `before` is what stood before it. */
  | { k: "change"; before: C }
  | { k: "bringBack" }
  /** Drop edits: the seed alone again, with no way back, as the DM asked for it. */
  | { k: "drop" }
  /** The newest plan, made with the edits, passed the wall budget. */
  | { k: "overBudget"; report: string }
  /** A wing base posted again with other geometry (4.2). */
  | { k: "baseChanged" };

export function startEdits<C>(): EditsState<C> {
  return { edits: null, last: null, dropped: null, undone: {}, gone: false };
}

/** Pins with nothing in them are no pins: a room reset, or every pin set back, leaves no edit. */
function pinned(edit: RoomEdit | null): edit is RoomEdit {
  return edit !== null && Object.values(edit).some((v) => v !== undefined);
}

function withRoom(rooms: DungeonEdits["rooms"], room: number, edit: RoomEdit | undefined | null): DungeonEdits["rooms"] {
  const next: Record<number, RoomEdit> = { ...rooms };
  if (edit && pinned(edit)) next[room] = edit;
  else delete next[room];
  return next;
}

export function editsStep<C>(s: EditsState<C>, e: EditsEvent<C>): EditsState<C> {
  switch (e.k) {
    case "edit": {
      const layout = s.edits?.layout ?? e.layout;
      const rooms = withRoom(s.edits?.rooms ?? {}, e.room, e.edit);
      const { [e.room]: _, ...undone } = s.undone;
      const edits = Object.keys(rooms).length > 0 ? { layout, rooms } : null;
      return { edits, last: { room: e.room, before: s.edits?.rooms[e.room] }, dropped: null, undone, gone: false };
    }
    case "change":
      if (!s.edits) return s.dropped || s.gone ? { ...s, dropped: null, gone: false } : s;
      return { edits: null, last: null, dropped: { before: e.before, edits: s.edits }, undone: {}, gone: false };
    case "bringBack":
      return s.dropped ? { edits: s.dropped.edits, last: null, dropped: null, undone: {}, gone: false } : s;
    case "drop":
      return startEdits<C>();
    case "overBudget": {
      if (!s.edits || !s.last) return s;
      const rooms = withRoom(s.edits.rooms, s.last.room, s.last.before);
      const edits = Object.keys(rooms).length > 0 ? { layout: s.edits.layout, rooms } : null;
      return { ...s, edits, last: null, undone: { ...s.undone, [s.last.room]: e.report } };
    }
    case "baseChanged":
      return s.edits || s.dropped ? { ...startEdits<C>(), gone: true } : s;
  }
}

/** Rooms with edits standing. */
export function editedRooms(s: Pick<EditsState<unknown>, "edits">): number {
  return s.edits ? Object.keys(s.edits.rooms).length : 0;
}
