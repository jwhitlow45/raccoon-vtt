import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "../../../components/Button.tsx";
import { DiscardQuestion } from "../../../components/Dialog.tsx";
import { Field, Input } from "../../../components/Field.tsx";
import { IconButton } from "../../../components/IconButton.tsx";
import { Help } from "../../../components/Panel.tsx";
import { RowList } from "../../../components/Row.tsx";
import { Segmented } from "../../../components/Segmented.tsx";
import { useUnsavedInput } from "../../../lib/sheetSwipe.ts";
import { theme } from "../../../lib/theme.ts";
import type { RoomActions } from "../../../state/types.ts";
import type { Scene } from "#shared/model.ts";
import { MAX_NAME } from "#shared/protocol.ts";
import { SOUND_LIMITS } from "#shared/limits.ts";
import { FADES, REPEATS, type Fade, type Playlist, type Repeat, type SoundId } from "#shared/sound.ts";
import { ConfirmButton } from "../../scenes/controls.tsx";
import { send } from "../panel/ops.ts";
import { nameOf, orderFor, scenesNamingPlaylist, soundsByUse, totalMs, type Playlists, type Sounds } from "../panel/state.ts";
import { NEW_PLAYLIST_NAME, PLAYING_CHANGES, playlistDetail, playlistLeavesScenes, REPEAT_CHOICES } from "../panel/words.ts";
import { keyMovedInList, movedInList } from "./dragOrder.ts";
import { matches } from "./Library.tsx";
import { draftOf, type MakerDraft, type MakerFields, type MakerTab } from "./open.ts";
import { dragRowStyle, Handle, HandleHelp, ListHead, MoveStatus, useRowDrag } from "./parts.tsx";
import { HANDLE_KEYS, OrderedList, OrderRow, TrackLine } from "./UpNext.tsx";
import {
  ADD_TRACKS,
  addName,
  ALL_IN,
  CANCEL,
  CREATE_PLAYLIST,
  CROSSFADE,
  DELETE_AGAIN,
  DELETE_PLAYLIST,
  DELETED_ELSEWHERE,
  FADE_WORDS,
  handleName,
  MAKER_EMPTY_NARROW,
  MAKER_EMPTY_WIDE,
  movedLine,
  MUSIC_TO_ADD,
  NAME,
  NAME_PLACEHOLDER,
  noTrackMatches,
  PLAY,
  PLAYLIST_FULL,
  PLAYLIST_TABS,
  removeName,
  REPEAT,
  SAVE,
  SEARCH_MUSIC,
  SHUFFLE,
  TRACKS,
  TRACKS_CHANGED,
  TRACKS_IN_ORDER,
  tracksTab,
} from "./words.ts";

/*
 * The playlist maker (docs/design/design-v1-music-player.md 5), its own
 * pop-up from Library (docs/design/design-v1-sound-layout.md 4.5,
 * MakerDialog.tsx): a draft saved once, so making or changing a playlist
 * is one Setup step. The draft lives in the Room scope's maker slot
 * (open.ts), so a resize across 900 px keeps it.
 */

/** The name a save sends: an empty one saves as "New playlist" (5). */
export function savedName(draft: Pick<MakerFields, "name">): string {
  return draft.name.trim().slice(0, MAX_NAME) || NEW_PLAYLIST_NAME;
}

function sameList(a: readonly SoundId[], b: readonly SoundId[]): boolean {
  return a.length === b.length && a.every((id, i) => b[i] === id);
}

/** The tracks a save sends: the draft's that are still music, so a track deleted or turned into a loop elsewhere drops out rather than refusing the save. */
export function savedTracks(draft: Pick<MakerFields, "sounds">, sounds: Sounds): SoundId[] {
  return draft.sounds.filter((id) => sounds[id]?.use === "music");
}

/** Every field as a save sends it. */
export function savedFields(draft: MakerFields, sounds: Sounds): MakerFields {
  return { name: savedName(draft), sounds: savedTracks(draft, sounds), shuffle: draft.shuffle, repeat: draft.repeat, fade: draft.fade };
}

/**
 * Whether the draft changed its tracks: both lists read without the tracks
 * no longer music, so one deleted or turned into a loop elsewhere is no
 * change of this DM's, and Save leaves another DM's list alone.
 */
function tracksChanged(draft: MakerDraft, base: MakerFields, sounds: Sounds): boolean {
  return !sameList(savedTracks(draft, sounds), savedTracks(base, sounds));
}

/**
 * What Save sends (5): only the fields the draft changed, so another DM's
 * change to another field stands. Every field for a new playlist. Empty
 * when nothing changed.
 */
export function changedFields(draft: MakerDraft, sounds: Sounds): Partial<MakerFields> {
  const fields = savedFields(draft, sounds);
  const base = draft.base;
  if (base === null) return fields;
  const out: Partial<MakerFields> = {};
  if (fields.name !== base.name) out.name = fields.name;
  if (tracksChanged(draft, base, sounds)) out.sounds = fields.sounds;
  if (fields.shuffle !== base.shuffle) out.shuffle = fields.shuffle;
  if (fields.repeat !== base.repeat) out.repeat = fields.repeat;
  if (fields.fade !== base.fade) out.fade = fields.fade;
  return out;
}

/** Whether leaving would lose something: a new playlist with anything in it, or a saved one with a change. */
export function draftDirty(draft: MakerDraft, sounds: Sounds): boolean {
  if (draft.base === null) return draft.name.trim() !== "" || draft.sounds.length > 0 || draft.shuffle || draft.repeat !== "all" || draft.fade !== 5;
  return Object.keys(changedFields(draft, sounds)).length > 0;
}

/** The status line's words (5), the most pressing first, or null. */
export function makerStatus(input: { draft: MakerDraft; stored: Playlist | undefined; sounds: Sounds; playingIt: boolean }): string | null {
  const { draft, stored } = input;
  if (draft.base !== null && stored === undefined) return DELETED_ELSEWHERE;
  // The draft's change of tracks reads as Save reads it, so the line shows only when Save would send this list over another DM's.
  if (draft.base !== null && stored !== undefined && stored.rev !== draft.base.rev && !sameList(stored.sounds, draft.base.sounds) && tracksChanged(draft, draft.base, input.sounds)) return TRACKS_CHANGED;
  if (input.playingIt) return PLAYING_CHANGES;
  return null;
}

/** A save the server took: the id it saved under. */
export type Saved = { playlistId: string };

/**
 * The playlist as it stands once a save is answered (5): the stored one,
 * read from the room store as the answer comes. The store takes the
 * answer's batch before it calls back, so this holds the save and any
 * other DM's change committed with it, such as a track appended in the
 * same batch. Nothing is laid over it, since the fields this save sent
 * would put back a list the server no longer holds, and Play's order would
 * be refused. With nothing stored under the saved id (a playlist deleted
 * since), the draft's own.
 */
export function savedPlaylist(draft: MakerDraft, playlistId: string, stored: Playlist | undefined, sounds: Sounds): Playlist {
  if (stored?.id === playlistId) return stored;
  const fields = savedFields(draft, sounds);
  return { id: playlistId, rev: 0, name: fields.name, sounds: [...fields.sounds], repeat: fields.repeat, fade: fields.fade, ...(fields.shuffle ? { shuffle: true } : null) };
}

/**
 * Sends the draft as one Setup op: `playlist.create` for a new playlist,
 * or for one deleted elsewhere under a fresh id, so an undo of that delete
 * never meets it, else `playlist.update` with only the changed fields.
 * `onDone` hears the answer, with what was saved once the server took it.
 * A saved playlist with nothing changed sends nothing and is done at once.
 */
export function saveDraft(actions: Pick<RoomActions, "dispatch" | "newId">, draft: MakerDraft, stored: Playlist | undefined, sounds: Sounds, onDone: (saved: Saved | null) => void): void {
  const fields = savedFields(draft, sounds);
  if (draft.base === null || stored === undefined) {
    const playlistId = draft.base === null ? draft.playlistId : actions.newId();
    send(actions, { t: "playlist.create", id: playlistId, name: fields.name, sounds: fields.sounds, repeat: fields.repeat, fade: fields.fade, ...(fields.shuffle ? { shuffle: true as const } : null) }, (answer) =>
      onDone(answer === "taken" ? { playlistId } : null),
    );
    return;
  }
  const changed = changedFields(draft, sounds);
  if (Object.keys(changed).length === 0) {
    onDone({ playlistId: draft.playlistId });
    return;
  }
  send(actions, { t: "playlist.update", id: draft.playlistId, ...changed }, (answer) => onDone(answer === "taken" ? { playlistId: draft.playlistId } : null));
}

/** The maker's footer and status for its Dialog, and what leaving does. */
export type MakerControl = {
  footer: ReactNode;
  status: ReactNode;
  /** Whether the status asks "Throw away your changes?". */
  asking: boolean;
  dirty: boolean;
  busy: "save" | "play" | null;
  /** Leaving by Cancel, Back, the close button, Escape or Android's Back: asks first while the draft has changes, and `go` on the next press. */
  leave(go: () => void): void;
  play(): void;
};

/**
 * The maker's controller, called by its dialog on every render, idle
 * while no draft is open. Save and Create show busy and refuse a second
 * press until answered (9). Play saves first when the draft changed and
 * plays once the save is answered, so a refused save never turns into a
 * refused play (5), and plays the playlist as it then stands
 * (savedPlaylist).
 */
export function useMakerControl(input: {
  draft: MakerDraft | null;
  stored: Playlist | undefined;
  sounds: Sounds;
  playingIt: boolean;
  actions: Pick<RoomActions, "dispatch" | "newId">;
  /** The room store's playlists and sounds now, which an answer reads before React renders the batch it came with. */
  room(): { playlists: Playlists; sounds: Sounds };
  setDraft(draft: MakerDraft): void;
  onSaved(): void;
}): MakerControl {
  const { draft, sounds, actions } = input;
  const [busy, setBusy] = useState<"save" | "play" | null>(null);
  const [asking, setAsking] = useState(false);
  // Any edit after the question takes it back, as every editor's discard does (features/clock/useDiscard.ts).
  useEffect(() => setAsking(false), [draft]);
  const dirty = draft !== null && draftDirty(draft, sounds);
  const latest = useRef(input);
  latest.current = input;

  const save = (kind: "save" | "play", then: (saved: Saved) => void) => {
    if (draft === null || busy !== null) return;
    setBusy(kind);
    saveDraft(actions, draft, input.stored, sounds, (saved) => {
      setBusy(null);
      if (saved) then(saved);
    });
  };
  const play = () => {
    if (draft === null || busy !== null) return;
    const start = (saved: Saved) => {
      const now = latest.current;
      // The store, not the last render's props: the answer comes before React renders the batch that holds the save (MB-ASTRA-02).
      const room = now.room();
      const playlist = savedPlaylist(draft, saved.playlistId, room.playlists[saved.playlistId], room.sounds);
      now.setDraft({ ...draftOf(playlist), tab: draft.tab });
      const order = orderFor({ playlistId: playlist.id, ...(playlist.shuffle ? { shuffle: true } : null) }, { [playlist.id]: playlist }, room.sounds);
      if (order.length === 0) return;
      send(actions, { t: "music.play", run: actions.newId(), playlistId: playlist.id, order, index: 0, repeat: playlist.repeat, fade: playlist.fade, ...(playlist.shuffle ? { shuffle: true as const } : null) });
    };
    if (!dirty && draft.base !== null && input.stored !== undefined) start({ playlistId: draft.playlistId });
    else save("play", start);
  };
  const leave = (go: () => void) => {
    if (dirty && !asking) setAsking(true);
    else go();
  };

  if (draft === null) return { footer: null, status: null, asking: false, dirty: false, busy: null, leave: (go) => go(), play };
  const creates = draft.base === null || input.stored === undefined;
  const line = makerStatus({ draft, stored: input.stored, sounds, playingIt: input.playingIt });
  return {
    asking,
    dirty,
    busy,
    leave,
    play,
    status: asking ? <DiscardQuestion /> : line,
    // The two buttons wrap as one, so a narrow footer never leaves Save alone under Cancel.
    footer: (
      <div style={{ display: "flex", gap: theme.space(2) }}>
        <Button onClick={() => leave(input.onSaved)}>{CANCEL}</Button>
        <Button variant="primary" busy={busy === "save"} onClick={() => save("save", () => latest.current.onSaved())}>
          {creates ? CREATE_PLAYLIST : SAVE}
        </Button>
      </div>
    ),
  };
}

/**
 * The maker's body: Name, then wide a settings row and two columns (the
 * tracks in order, and Add tracks with its search), narrow two tabs with
 * the settings under the tracks (5).
 */
export function MakerBody(props: {
  draft: MakerDraft;
  stored: Playlist | undefined;
  sounds: Sounds;
  scenes: Readonly<Record<string, Pick<Scene, "sound">>>;
  wide: boolean;
  dirty: boolean;
  playBusy: boolean;
  onChange(draft: MakerDraft): void;
  onPlay(): void;
  onDelete(): void;
}) {
  const { draft, sounds } = props;
  // The sheet's swipe and Put away sheet spring back while the draft holds a change (the dialog's draft registry).
  useUnsavedInput(props.dirty);
  const set = (patch: Partial<MakerDraft>) => props.onChange({ ...draft, ...patch });
  const tracks = draft.sounds.flatMap((id) => (sounds[id]?.use === "music" ? [sounds[id]!] : []));
  const [query, setQuery] = useState("");
  const inIt = new Set(draft.sounds);
  const free = soundsByUse(sounds, "music").filter((s) => !inIt.has(s.id) && matches(nameOf(s), query));
  const full = draft.sounds.length >= SOUND_LIMITS.playlistTracks;
  const searching = query.trim() !== "";

  const tracksPart = (
    <div style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>
      {props.wide ? <ListHead detail={playlistDetail(tracks.length, totalMs(tracks))}>{TRACKS}</ListHead> : <Help>{playlistDetail(tracks.length, totalMs(tracks))}</Help>}
      {tracks.length === 0 ? (
        <Help>{props.wide ? MAKER_EMPTY_WIDE : MAKER_EMPTY_NARROW}</Help>
      ) : (
        <MakerOrder ids={tracks.map((s) => s.id)} sounds={sounds} onChange={(ids) => set({ sounds: ids })} />
      )}
    </div>
  );
  const addPart = (
    <div style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
      {props.wide ? <ListHead>{ADD_TRACKS}</ListHead> : null}
      <Input type="search" aria-label={SEARCH_MUSIC} placeholder={SEARCH_MUSIC} enterKeyHint="search" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: "100%" }} />
      {full ? <Help>{PLAYLIST_FULL}</Help> : null}
      {free.length > 0 ? (
        <RowList label={MUSIC_TO_ADD}>
          {free.map((s) => {
            const name = nameOf(s);
            return (
              // Words at the column's edge, as Add tracks and the search above them stand, and as the order's rows beside them read.
              <div key={s.id} data-music-row="" style={{ display: "flex", alignItems: "center", gap: theme.space(1), minWidth: 0, minHeight: 56 }}>
                <TrackLine name={name} ms={s.ms} />
                <IconButton icon="plus" label={addName(name)} disabled={full} onClick={() => set({ sounds: [...draft.sounds, s.id] })} />
              </div>
            );
          })}
        </RowList>
      ) : (
        <Help>{searching ? noTrackMatches(query.trim()) : ALL_IN}</Help>
      )}
    </div>
  );
  const leaves = props.stored ? playlistLeavesScenes(scenesNamingPlaylist(props.stored.id, props.scenes)) : null;
  const settings = (
    <div data-music-maker-settings="" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(3), minWidth: 0 }}>
      <Button size="sm" icon="shuffle" pressed={draft.shuffle} onClick={() => set({ shuffle: !draft.shuffle })}>
        {SHUFFLE}
      </Button>
      <Choice<Repeat> name={REPEAT} value={draft.repeat} options={REPEATS.map((r) => ({ value: r, label: REPEAT_CHOICES[r] }))} onChange={(repeat) => set({ repeat })} />
      <Choice<Fade> name={CROSSFADE} value={draft.fade} options={FADES.map((f) => ({ value: f, label: FADE_WORDS[f] }))} onChange={(fade) => set({ fade })} />
      <Button size="sm" variant="primary" icon="play" busy={props.playBusy} disabled={tracks.length === 0} onClick={props.onPlay}>
        {PLAY}
      </Button>
    </div>
  );
  // At the maker's foot in both layouts, under the settings, away from the buttons pressed most (5).
  const remove = props.stored ? (
    <div style={{ display: "grid", gap: theme.space(2), justifyItems: "start" }}>
      {leaves ? <Help>{leaves}</Help> : null}
      <ConfirmButton label={DELETE_PLAYLIST} confirm={DELETE_AGAIN} onConfirm={props.onDelete} />
    </div>
  ) : null;
  return (
    <div data-music-maker="" style={{ display: "grid", gap: theme.space(4), minWidth: 0 }}>
      <Field label={NAME} value={draft.name} placeholder={NAME_PLACEHOLDER} maxLength={MAX_NAME} onChange={(e) => set({ name: e.target.value })} />
      {props.wide ? (
        <>
          {settings}
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: theme.space(6), alignItems: "start" }}>
            {tracksPart}
            {addPart}
          </div>
          {remove}
        </>
      ) : (
        <>
          <Segmented<MakerTab>
            label={PLAYLIST_TABS}
            grow
            value={draft.tab}
            options={[
              { value: "tracks", label: tracksTab(tracks.length) },
              { value: "add", label: ADD_TRACKS },
            ]}
            onChange={(tab) => set({ tab })}
          />
          {draft.tab === "tracks" ? (
            <>
              {tracksPart}
              {settings}
              {remove}
            </>
          ) : (
            addPart
          )}
        </>
      )}
    </div>
  );
}

/** A named choice of a few in one line: "Repeat All One Off". */
function Choice<T extends string | number>(props: { name: string; value: T; options: readonly { value: T; label: string }[]; onChange(value: T): void }) {
  const id = useId();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), minWidth: 0 }}>
      <span id={id} style={{ fontSize: theme.font.body14, color: theme.color.textMuted }}>
        {props.name}
      </span>
      <Segmented<T> labelledBy={id} value={props.value} options={props.options} onChange={props.onChange} />
    </div>
  );
}

/** The draft's tracks in order, each with its handle and Remove, reordered by drag and keys as Up next is (4.3), on the draft. */
function MakerOrder(props: { ids: readonly SoundId[]; sounds: Sounds; onChange(ids: SoundId[]): void }) {
  const helpId = useId();
  const handles = useRef(new Map<SoundId, HTMLButtonElement>());
  const focusAfter = useRef<SoundId | null>(null);
  const [status, setStatus] = useState("");
  const drag = useRowDrag({
    ids: props.ids,
    lists: props.ids.map(() => 0),
    key: props.ids.join(","),
    onDrop(id, slot) {
      const next = movedInList(props.ids, id, slot);
      if (next) props.onChange(next);
    },
  });
  useLayoutEffect(() => {
    const id = focusAfter.current;
    if (id === null) return;
    focusAfter.current = null;
    const el = handles.current.get(id);
    if (el && el.ownerDocument.activeElement !== el) el.focus();
  });
  const onKey = (id: SoundId) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!HANDLE_KEYS.has(e.key)) return;
    e.preventDefault();
    const next = keyMovedInList(props.ids, id, e.key);
    if (!next) return;
    props.onChange(next);
    focusAfter.current = id;
    setStatus(movedLine(nameOf(props.sounds[id]), next.indexOf(id) + 1, next.length));
  };
  return (
    <>
      <HandleHelp id={helpId} />
      <OrderedList label={TRACKS_IN_ORDER}>
        {props.ids.map((id, i) => {
          const name = nameOf(props.sounds[id]);
          const lifted = drag.drag?.id === id;
          return (
            <OrderRow key={id} rowRef={drag.rowRef(id)} style={dragRowStyle(drag.offsetOf(id), lifted, drag.drag !== null)}>
              <Handle
                label={handleName(name, i + 1, props.ids.length)}
                helpId={helpId}
                lifted={lifted}
                buttonRef={(el) => {
                  if (el) handles.current.set(id, el);
                  else handles.current.delete(id);
                }}
                onKeyDown={onKey(id)}
                events={drag.handle(id)}
              />
              <TrackLine name={name} ms={props.sounds[id]?.ms ?? 0} />
              <IconButton icon="close" label={removeName(name)} onClick={() => props.onChange(props.ids.filter((x) => x !== id))} />
            </OrderRow>
          );
        })}
      </OrderedList>
      <MoveStatus text={status} />
    </>
  );
}
