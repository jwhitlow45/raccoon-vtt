import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { MenuItem } from "../../../components/Menu.tsx";
import { Help } from "../../../components/Panel.tsx";
import { theme } from "../../../lib/theme.ts";
import { useRoomActions, useRoomStore, useRoomView } from "../../../state/view.ts";
import type { QueueEdit, SoundId } from "#shared/sound.ts";
import { useTicking, useWakeAt } from "../panel/controls.tsx";
import { send } from "../panel/ops.ts";
import { nameOf, playlistsOf, serverNow, soundsOf, totalMs, type Sounds } from "../panel/state.ts";
import { lengthText } from "../panel/words.ts";
import { dragKey, keyMove, movable, moveTo, placeOf, queueLists, type QueueLists } from "./dragOrder.ts";
import { useJumps } from "./jumps.ts";
import { dragRowStyle, Handle, HandleHelp, ListHead, MoreMenu, MoveStatus, useRowDrag } from "./parts.tsx";
import { againLine, handleName, movedLine, MUSIC_ENDS, NOTHING_AFTER, PLAY_NEXT, PLAY_NOW, PLAYED, REMOVE_FROM_QUEUE, REPEAT_ONE_LINE, tracksDetail, UP_NEXT } from "./words.ts";

/** The keys a handle takes, which never scroll the list under it. */
export const HANDLE_KEYS = new Set(["ArrowUp", "ArrowDown", "Home", "End"]);

/**
 * Up next (docs/design/design-v1-music-player.md 4.3): the order after the
 * track Now playing names, which drags and keys reorder, then under Repeat
 * all and one the rest of the cycle, or under Repeat off Played. Each edit
 * is one `music.queue` naming the run it was made on, shown at once by the
 * store's prediction. The playing track has no row: it is Now playing.
 */
export function UpNext() {
  const actions = useRoomActions();
  const store = useRoomStore();
  const jumps = useJumps();
  const music = useRoomView((s) => s.view?.playing?.music ?? null);
  const sounds = useRoomView((s) => soundsOf(s.view));
  const playlists = useRoomView((s) => playlistsOf(s.view));
  const serverOffset = useRoomView((s) => s.serverOffset);
  const playingNow = music !== null && music.paused === undefined;
  // Each tick reads the lists again, so a drag ends as a crossfade starts, which no frame from the server marks (4.3).
  const t = useTicking(() => serverNow({ serverOffset }), playingNow);
  useWakeAt(playingNow && music.next !== undefined && t < music.next.at ? music.next.at : null, t);
  const lists = queueLists(music, sounds, t);
  const helpId = useId();
  const againId = useId();
  const [status, setStatus] = useState("");
  const handles = useRef(new Map<SoundId, HTMLButtonElement>());
  const focusAfter = useRef<SoundId | null>(null);

  const rows = lists ? movable(lists) : [];
  const edit = (from: QueueLists, e: QueueEdit) => send(actions, { t: "music.queue", from: from.run, edit: e });
  const drag = useRowDrag({
    ids: rows,
    lists: lists ? rows.map((id) => (lists.ahead.includes(id) ? 0 : 1)) : [],
    key: dragKey(lists),
    onDrop(id, slot) {
      const move = lists ? moveTo(lists, id, slot) : null;
      if (lists && move) edit(lists, move);
    },
  });

  // A key's move keeps focus on its handle, which may now stand in the other list.
  useLayoutEffect(() => {
    const id = focusAfter.current;
    if (id === null) return;
    focusAfter.current = null;
    const el = handles.current.get(id);
    if (el && el.ownerDocument.activeElement !== el) el.focus();
  });

  if (!lists) return null;
  const onKey = (id: SoundId) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!HANDLE_KEYS.has(e.key)) return;
    e.preventDefault();
    const move = keyMove(lists, id, e.key);
    if (!move) return;
    edit(lists, move);
    focusAfter.current = id;
    // The store predicts the op at once, so the row's new place is already the room's view.
    const view = store.getState().view;
    const after = queueLists(view?.playing?.music ?? null, soundsOf(view), serverNow({ serverOffset }));
    const place = after ? placeOf(after, id) : null;
    if (place) setStatus(movedLine(nameOf(sounds[id]), place.place, place.of));
  };
  const items = (id: SoundId): MenuItem[] => [
    { id: "now", title: PLAY_NOW, kind: "action" },
    { id: "next", title: PLAY_NEXT, kind: "action", disabled: lists.ahead[0] === id },
    { id: "remove", title: REMOVE_FROM_QUEUE, kind: "action" },
  ];
  const pick = (id: SoundId) => (what: string) => {
    if (what === "now") jumps.send({ t: "music.jump", run: actions.newId(), from: lists.run, soundId: id });
    else if (what === "next") edit(lists, { t: "next", soundIds: [id] });
    else if (what === "remove") edit(lists, { t: "remove", soundId: id });
  };
  const row = (id: SoundId, handled: boolean): ReactNode => {
    const name = nameOf(sounds[id]);
    const place = placeOf(lists, id);
    const lifted = drag.drag?.id === id;
    return (
      <OrderRow key={id} rowRef={handled ? drag.rowRef(id) : undefined} style={handled ? dragRowStyle(drag.offsetOf(id), lifted, drag.drag !== null) : undefined}>
        {handled && place ? (
          <Handle
            label={handleName(name, place.place, place.of)}
            helpId={helpId}
            lifted={lifted}
            buttonRef={(el) => {
              if (el) handles.current.set(id, el);
              else handles.current.delete(id);
            }}
            onKeyDown={onKey(id)}
            events={drag.handle(id)}
          />
        ) : null}
        <TrackLine name={name} ms={sounds[id]?.ms ?? 0} inset={!handled} />
        <MoreMenu name={name} items={items(id)} onPick={pick(id)} />
      </OrderRow>
    );
  };

  const playlistName = music?.playlistId !== undefined ? (playlists[music.playlistId]?.name ?? null) : null;
  const { ahead } = lists;
  return (
    <div data-music-upnext="" style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
      <HandleHelp id={helpId} />
      <ListHead detail={ahead.length > 0 ? tracksDetail(ahead.length, lengthOf(ahead, sounds)) : undefined}>{UP_NEXT}</ListHead>
      {lists.repeat === "one" ? <Help>{REPEAT_ONE_LINE}</Help> : null}
      {ahead.length > 0 ? <OrderedList label={UP_NEXT}>{ahead.map((id) => row(id, true))}</OrderedList> : <Help>{NOTHING_AFTER}</Help>}
      {lists.repeat !== "off" && lists.again.length > 0 ? (
        <>
          <Help id={againId}>{againLine(playlistName)}</Help>
          <OrderedList labelledBy={againId} start={ahead.length + 1}>
            {lists.again.map((id) => row(id, true))}
          </OrderedList>
        </>
      ) : null}
      {lists.repeat === "off" ? (
        <>
          <Help>{MUSIC_ENDS}</Help>
          {lists.played.length > 0 ? (
            <>
              <ListHead>{PLAYED}</ListHead>
              <OrderedList label={PLAYED}>{lists.played.map((id) => row(id, false))}</OrderedList>
            </>
          ) : null}
        </>
      ) : null}
      <MoveStatus text={status} />
    </div>
  );
}

function lengthOf(ids: readonly SoundId[], sounds: Sounds): number {
  return totalMs(ids.flatMap((id) => (sounds[id] ? [sounds[id]!] : [])));
}

/** An ordered list with no marks of its own: each row says its place in its handle's name (9). */
export function OrderedList(props: { label?: string; labelledBy?: string; start?: number; children: ReactNode }) {
  return (
    <ol aria-label={props.label} aria-labelledby={props.labelledBy} start={props.start} style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)" }}>
      {props.children}
    </ol>
  );
}

/** One row of an order: a handle, the track, and its button at the end, split from the next by a line. */
export function OrderRow(props: { rowRef?: ((el: HTMLElement | null) => void) | undefined; style?: CSSProperties | undefined; children: ReactNode }) {
  return (
    <li
      ref={props.rowRef}
      data-music-order-row=""
      style={{ display: "flex", alignItems: "center", gap: theme.space(1), minWidth: 0, minHeight: 56, borderBottom: `${theme.line.border}px solid ${theme.color.border}`, ...props.style }}
    >
      {props.children}
    </li>
  );
}

/** A track's name over its length, the middle of an order row. `inset` lines a row with no handle up with the window's edge. */
export function TrackLine(props: { name: string; ms: number; inset?: boolean }) {
  return (
    <span style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(0.5), padding: `${theme.space(1)}px 0`, paddingLeft: props.inset ? theme.space(3) : 0 }}>
      <span data-music-row-name="" style={{ fontSize: theme.font.input, fontWeight: theme.weight.strong, lineHeight: theme.leading.tight, overflowWrap: "anywhere" }}>
        {props.name}
      </span>
      <span style={{ fontSize: theme.font.small, color: theme.color.textMuted, fontVariantNumeric: "tabular-nums" }}>{lengthText(props.ms)}</span>
    </span>
  );
}

