import { following, musicAt, type MusicRun, type QueueEdit, type Repeat, type SoundId, type SoundLengths } from "#shared/sound.ts";

/**
 * The queue as Up next shows and edits it (docs/design/design-v1-music-player.md
 * 4.3), as pure functions so the window and its tests read one answer.
 *
 * Everything starts from the track Now playing names: `musicAt` at the
 * shown server time, as the reducer starts every music op at its `t`. The
 * stored `index` moves only once a crossfade ends, so from `next.at` the
 * incoming track would show twice, as Now playing and as Up next's first
 * row, and a control on that row would act on the playing track.
 */

/** Up next's lists at one moment. */
export type QueueLists = {
  run: string;
  /** The track Now playing names. */
  playing: SoundId;
  /** Its place in `order`. */
  index: number;
  order: readonly SoundId[];
  repeat: Repeat;
  shuffle: boolean;
  paused: boolean;
  /** The rest of this pass, after the playing track. */
  ahead: readonly SoundId[];
  /** Repeat all and one: the order from its first track up to the playing one, without it. Empty under Repeat off. */
  again: readonly SoundId[];
  /** Repeat off: the tracks before the playing one, heard already. Empty under Repeat all and one. */
  played: readonly SoundId[];
};

export function queueLists(music: MusicRun | null, sounds: SoundLengths, t: number): QueueLists | null {
  const current = musicAt(music, sounds, t);
  if (current === null) return null;
  const order = current.order ?? [current.now.soundId];
  const found = order.indexOf(current.now.soundId);
  const index = found >= 0 ? found : (current.index ?? 0);
  const before = order.slice(0, index);
  return {
    run: current.run,
    playing: current.now.soundId,
    index,
    order,
    repeat: current.repeat,
    shuffle: current.shuffle === true,
    paused: current.paused !== undefined,
    ahead: order.slice(index + 1),
    again: current.repeat === "off" ? [] : before,
    played: current.repeat === "off" ? before : [],
  };
}

/** The rows a handle moves, in play order: Up next, then under Repeat all and one the second list. Played rows have no handle. */
export function movable(lists: QueueLists): readonly SoundId[] {
  return lists.repeat === "off" ? lists.ahead : [...lists.ahead, ...lists.again];
}

/** A row's place for its handle's name, "2 of 11": numbered across both lists in play order, or Up next alone under Repeat off. */
export function placeOf(lists: QueueLists, soundId: SoundId): { place: number; of: number } | null {
  const rows = movable(lists);
  const at = rows.indexOf(soundId);
  return at < 0 ? null : { place: at + 1, of: rows.length };
}

/**
 * The move that puts a row at `slot`, a place among the other rows in play
 * order (0 before the first, their count after the last), or null where it
 * already is. The first and last places are named, so the server finds them
 * at apply time: a Home pressed as the first row starts playing still lands
 * right after the new playing track. The lists' seam, after Up next's last
 * row and before the second list's first, is one slot, the order's end
 * (`passEnd`), which renders under Up next (4.3).
 */
export function moveTo(lists: QueueLists, soundId: SoundId, slot: number): QueueMove | null {
  const rows = movable(lists);
  const from = rows.indexOf(soundId);
  if (from < 0) return null;
  const rest = rows.filter((id) => id !== soundId);
  const s = Math.max(0, Math.min(slot, rest.length));
  const upNext = lists.ahead.includes(soundId);
  const seam = lists.ahead.length - (upNext ? 1 : 0);
  // The second list's first row stands at the seam in play order, yet a drop there still moves it, from the order's start to its end.
  const toSeam = lists.repeat !== "off" && s === seam;
  if (s === from && !(toSeam && !upNext)) return null;
  if (s === 0) return move(soundId, "first");
  // Before the last place: with the second list empty, or its only row moving, the seam is the last slot too, and `last` would put the row before the playing track.
  if (toSeam) return move(soundId, "passEnd");
  if (s === rest.length) return move(soundId, "last");
  return move(soundId, { before: rest[s]! });
}

export type QueueMove = Extract<QueueEdit, { t: "move" }>;

function move(soundId: SoundId, to: QueueMove["to"]): QueueMove {
  return { t: "move", soundId, to };
}

/**
 * The handle's keys (4.3): Up and Down swap a row with its neighbour in
 * play order, staying in its own list, except that they step past the
 * seam: Down from Up next's last row goes after the second list's first,
 * and Up from the second list's first goes before Up next's last. Home
 * goes to the first place and End to the last, which with the second list
 * empty is the seam, as for a drop (moveTo). Null for a key it does not
 * take, or a move that goes nowhere.
 */
export function keyMove(lists: QueueLists, soundId: SoundId, key: string): QueueMove | null {
  const rows = movable(lists);
  const i = rows.indexOf(soundId);
  if (i < 0) return null;
  const last = rows.length - 1;
  switch (key) {
    case "ArrowUp":
      if (i === 0) return null;
      return i - 1 === 0 ? move(soundId, "first") : move(soundId, { before: rows[i - 1]! });
    case "ArrowDown":
      if (i === last) return null;
      // Past Up next's last row, the row stays the end of Up next: the order's end.
      if (lists.repeat !== "off" && i + 1 === lists.ahead.length - 1) return move(soundId, "passEnd");
      return i + 2 <= last ? move(soundId, { before: rows[i + 2]! }) : move(soundId, "last");
    case "Home":
      return i > 0 ? move(soundId, "first") : null;
    case "End":
      if (i === last) return null;
      return move(soundId, lists.repeat !== "off" && lists.again.length === 0 ? "passEnd" : "last");
    default:
      return null;
  }
}

/**
 * What a drag holds on to: the run, the playing track and the order, by
 * value. A drag ends, sending nothing, once this changes, since the rows
 * would move under the finger. Any other change to the room's sound (a
 * reveal, a volume, an effect) gives a new object with the same key and
 * leaves the drag alone.
 */
export function dragKey(lists: QueueLists | null): string {
  return lists === null ? "" : `${lists.run}\n${lists.playing}\n${lists.order.join(",")}`;
}

/**
 * The slot a dragged row's middle at `y` points at, among the other rows'
 * middles as the drag began. The middle passes a row once it reaches that
 * row's middle, going up or down, as the initiative tracker's dropIndex
 * does (features/encounter/logic.ts), so the drag's bounds (dragAt), the
 * first and last rows' middles, point at the first and last slots.
 */
export function dropSlot(mids: readonly number[], from: number, y: number): number {
  let slot = 0;
  for (let j = 0; j < mids.length; j++) {
    if (j === from) continue;
    if (j < from ? mids[j]! < y : mids[j]! <= y) slot++;
  }
  return slot;
}

/**
 * Where a drag stands once the pointer has moved `moved` px from where it
 * began: the row's offset, kept between the first and last rows' middles
 * so the row never leaves its list, and the slot it points at.
 */
export function dragAt(mids: readonly number[], from: number, moved: number): { dy: number; slot: number } {
  const here = mids[from]!;
  const dy = Math.min(mids[mids.length - 1]! - here, Math.max(mids[0]! - here, moved));
  return { dy, slot: dropSlot(mids, from, here + dy) };
}

/**
 * How far each row moves while one is dragged, so the others make room
 * (4.3). `lists` gives each row's list in play order (0 Up next, 1 the
 * second list), `from` the dragged row, `slot` its drop slot. A row after
 * the dragged one in its own list closes the gap it left, and a row at or
 * after the slot in the slot's list opens one. The seam's slot belongs to
 * Up next, under whose last row it renders.
 */
export function makeRoom(lists: readonly number[], from: number, slot: number, height: number): number[] {
  const seam = lists.filter((l, j) => l === 0 && j !== from).length;
  const slotList = slot <= seam ? 0 : 1;
  return lists.map((list, j) => {
    if (j === from) return 0;
    const rest = j < from ? j : j - 1;
    const close = list === lists[from] && j > from ? -height : 0;
    const open = list === slotList && rest >= slot ? height : 0;
    return close + open;
  });
}

/** One list's version of moveTo, for the maker's draft: the ids with `id` at `slot` among the others, or null where it already is. */
export function movedInList(ids: readonly SoundId[], id: SoundId, slot: number): SoundId[] | null {
  const from = ids.indexOf(id);
  if (from < 0) return null;
  const rest = ids.filter((x) => x !== id);
  const s = Math.max(0, Math.min(slot, rest.length));
  if (s === from) return null;
  rest.splice(s, 0, id);
  return rest;
}

/** The maker's handle keys, on the draft: Up, Down, Home, End. */
export function keyMovedInList(ids: readonly SoundId[], id: SoundId, key: string): SoundId[] | null {
  const from = ids.indexOf(id);
  if (from < 0) return null;
  switch (key) {
    case "ArrowUp":
      return movedInList(ids, id, from - 1);
    case "ArrowDown":
      return movedInList(ids, id, from + 1);
    case "Home":
      return movedInList(ids, id, 0);
    case "End":
      return movedInList(ids, id, ids.length);
    default:
      return null;
  }
}

/** Where Previous goes (4.2): the playing track's start once 3 s have played, else the track before it, wrapping under Repeat all and one, and the first's start under Repeat off. */
export const PREVIOUS_RESTARTS_MS = 3_000;

export function previousTarget(lists: QueueLists, positionMs: number): SoundId {
  if (positionMs >= PREVIOUS_RESTARTS_MS) return lists.playing;
  if (lists.index > 0) return lists.order[lists.index - 1]!;
  return lists.repeat === "off" ? lists.playing : lists.order[lists.order.length - 1]!;
}

/** What comes next, for the Sound group's Next line (3.1): another track, the same one again, or nothing. */
export type ComingNext = { t: "track"; soundId: SoundId } | { t: "again" } | { t: "last" };

export function comingNext(music: MusicRun | null, sounds: SoundLengths, t: number): ComingNext | null {
  const current = musicAt(music, sounds, t);
  if (current === null) return null;
  const j = following(current);
  if (j === null) return { t: "last" };
  const order = current.order ?? [current.now.soundId];
  const id = order[j];
  if (id === undefined || id === current.now.soundId) return { t: "again" };
  return { t: "track", soundId: id };
}
