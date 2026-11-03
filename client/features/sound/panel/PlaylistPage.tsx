import { useState } from "react";
import { Button } from "../../../components/Button.tsx";
import { Checkbox } from "../../../components/Checkbox.tsx";
import { Field } from "../../../components/Field.tsx";
import { IconButton } from "../../../components/IconButton.tsx";
import { Help, Section } from "../../../components/Panel.tsx";
import { RowList } from "../../../components/Row.tsx";
import { Segmented } from "../../../components/Segmented.tsx";
import { SettingRow } from "../../../components/SettingRow.tsx";
import { Switch } from "../../../components/Switch.tsx";
import { theme } from "../../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../../state/view.ts";
import { MAX_NAME } from "#shared/protocol.ts";
import { SOUND_LIMITS } from "#shared/limits.ts";
import { FADES, REPEATS, type Fade, type Playlist, type Repeat, type SoundId } from "#shared/sound.ts";
import { ConfirmButton } from "../../scenes/controls.tsx";
import { Actions } from "./controls.tsx";
import { playPlaylist } from "./MusicSection.tsx";
import { send } from "./ops.ts";
import { nameOf, playlistTracks, scenesNamingPlaylist, soundsByUse, soundsOf, type Sounds } from "./state.ts";
import { ALL_TRACKS_IN, lengthText, NO_TRACKS, PLAYING_CHANGES, playlistLeavesScenes, REPEAT_CHOICES } from "./words.ts";

const FADE_LABELS: Record<Fade, string> = { 0: "Off", 2: "2 s", 5: "5 s", 10: "10 s" };

/** The tracks a playlist plays, in order, each with its arrows and Remove. Pure. */
export function TrackOrder(props: { playlist: Playlist; sounds: Sounds; onChange(order: SoundId[]): void }) {
  const tracks = playlistTracks(props.playlist, props.sounds);
  const ids = tracks.map((t) => t.id);
  const move = (from: number, to: number) => {
    const next = [...ids];
    const [id] = next.splice(from, 1);
    next.splice(to, 0, id!);
    props.onChange(next);
  };
  if (tracks.length === 0) return <Help>{NO_TRACKS}</Help>;
  return (
    <RowList label="Tracks in order">
      {tracks.map((t, i) => {
        const name = nameOf(t);
        return (
          <div key={t.id} data-sound-order-row="" style={{ display: "flex", alignItems: "center", gap: theme.space(1), minWidth: 0, padding: `${theme.space(1)}px 0` }}>
            <span style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(0.5) }}>
              <span style={{ fontSize: theme.font.input, fontWeight: theme.weight.strong, lineHeight: theme.leading.tight, overflowWrap: "anywhere" }}>{name}</span>
              <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>{lengthText(t.ms)}</span>
            </span>
            <IconButton icon="arrowUp" label={`Move ${name} up`} disabled={i === 0} onClick={() => move(i, i - 1)} />
            <IconButton icon="arrowDown" label={`Move ${name} down`} disabled={i === tracks.length - 1} onClick={() => move(i, i + 1)} />
            <Button size="sm" aria-label={`Remove ${name}`} onClick={() => props.onChange(ids.filter((id) => id !== t.id))}>
              Remove
            </Button>
          </div>
        );
      })}
    </RowList>
  );
}

/**
 * Add tracks (4.1): a checklist of the room's music not yet in the
 * playlist, so a track appears once, and Add for the ones ticked.
 */
function AddTracks(props: { playlist: Playlist; sounds: Sounds; onAdd(ids: SoundId[]): void }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<SoundId>>(new Set());
  const inIt = new Set(props.playlist.sounds);
  const free = soundsByUse(props.sounds, "music").filter((s) => !inIt.has(s.id));
  const room = SOUND_LIMITS.playlistTracks - props.playlist.sounds.length;
  if (!open) {
    return (
      <div style={{ display: "flex" }}>
        <Button size="sm" icon="plus" expanded={false} disabled={free.length === 0 || room <= 0} onClick={() => setOpen(true)}>
          Add tracks
        </Button>
      </div>
    );
  }
  const close = () => {
    setOpen(false);
    setPicked(new Set());
  };
  return (
    <div data-sound-add-tracks="" style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
      {free.length === 0 ? <Help>{ALL_TRACKS_IN}</Help> : null}
      {free.map((s) => (
        <Checkbox
          key={s.id}
          label={`${nameOf(s)}, ${lengthText(s.ms)}`}
          checked={picked.has(s.id)}
          onChange={(on) => {
            const next = new Set(picked);
            if (on && next.size < room) next.add(s.id);
            else next.delete(s.id);
            setPicked(next);
          }}
        />
      ))}
      <Actions>
        <Button
          size="sm"
          variant="primary"
          disabled={picked.size === 0}
          onClick={() => {
            props.onAdd(free.filter((s) => picked.has(s.id)).map((s) => s.id));
            close();
          }}
        >
          {picked.size > 1 ? `Add ${picked.size} tracks` : "Add"}
        </Button>
        <Button size="sm" onClick={close}>
          Cancel
        </Button>
      </Actions>
    </div>
  );
}

/** A playlist's name, saved on Enter or leaving the field, as a sound's is. */
function NameField(props: { name: string; onSave(name: string): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? props.name;
  const save = () => {
    const name = value.trim();
    setDraft(null);
    if (name !== "" && name !== props.name) props.onSave(name.slice(0, MAX_NAME));
  };
  return (
    <Field
      label="Name"
      value={value}
      maxLength={MAX_NAME}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape" && draft !== null) {
          e.stopPropagation();
          setDraft(null);
        }
      }}
    />
  );
}

/**
 * A playlist's page (4.1 item 2): its name, its tracks in order, Add
 * tracks, Shuffle, Repeat, Crossfade, Play, and Delete playlist on a second
 * tap. Each change is one Setup step (6.6). While it plays, a change plays
 * from its next start, since a run keeps the order it started with.
 */
export function PlaylistPage(props: { playlist: Playlist; onDeleted(): void }) {
  const { playlist } = props;
  const actions = useRoomActions();
  const sounds = useRoomView((s) => soundsOf(s.view));
  const scenes = useRoomView((s) => s.view?.scenes ?? {});
  const playingIt = useRoomView((s) => s.view?.playing?.music?.playlistId === playlist.id);
  const update = (patch: Omit<Extract<Parameters<typeof send>[1], { t: "playlist.update" }>, "t" | "id">) => send(actions, { t: "playlist.update", id: playlist.id, ...patch });
  const leaves = playlistLeavesScenes(scenesNamingPlaylist(playlist.id, scenes));
  const tracks = playlistTracks(playlist, sounds);

  return (
    <div style={{ display: "grid", gap: theme.space(4), minWidth: 0 }}>
      <NameField name={playlist.name} onSave={(name) => update({ name })} />
      {playingIt ? <Help>{PLAYING_CHANGES}</Help> : null}
      <Section label="Tracks" divider={false}>
        <TrackOrder playlist={playlist} sounds={sounds} onChange={(order) => update({ sounds: order })} />
        <AddTracks playlist={playlist} sounds={sounds} onAdd={(ids) => update({ sounds: [...tracks.map((t) => t.id), ...ids] })} />
      </Section>
      <Section label="Playing">
        <Switch label="Shuffle" help="A new order each time it starts." checked={playlist.shuffle === true} onChange={(shuffle) => update({ shuffle })} />
        <SettingRow name="Repeat" wide>
          {(ids) => <Segmented<Repeat> labelledBy={ids.nameId} value={playlist.repeat} options={REPEATS.map((r) => ({ value: r, label: REPEAT_CHOICES[r] }))} onChange={(repeat) => update({ repeat })} />}
        </SettingRow>
        <SettingRow name="Crossfade" wide>
          {(ids) => <Segmented<Fade> labelledBy={ids.nameId} value={playlist.fade} options={FADES.map((f) => ({ value: f, label: FADE_LABELS[f] }))} onChange={(fade) => update({ fade })} />}
        </SettingRow>
        <div style={{ display: "flex" }}>
          <Button size="sm" variant="primary" icon="play" disabled={tracks.length === 0} onClick={() => playPlaylist(actions, playlist, sounds)}>
            Play
          </Button>
        </div>
      </Section>
      <Section label="Delete" tone="danger">
        {leaves ? <Help>{leaves}</Help> : null}
        <div style={{ display: "flex" }}>
          <ConfirmButton
            label="Delete playlist"
            confirm="Tap again to delete"
            onConfirm={() => {
              send(actions, { t: "playlist.delete", id: playlist.id });
              props.onDeleted();
            }}
          />
        </div>
      </Section>
    </div>
  );
}
