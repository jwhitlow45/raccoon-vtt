import { useCallback, useState } from "react";
import { Button } from "../../../components/Button.tsx";
import { Loading } from "../../../components/Loading.tsx";
import { Help, Section } from "../../../components/Panel.tsx";
import { theme } from "../../../lib/theme.ts";
import { useRoomView } from "../../../state/view.ts";
import { usePanelHeader, type PanelProps } from "../../panels.ts";
import { EffectsBoard } from "./EffectsBoard.tsx";
import { RoomSoundControls, serverRoomSound, useServerRoomSoundState, type ServerSound } from "./engine.ts";
import { LoopsSection } from "./LoopsSection.tsx";
import { MusicSection } from "./MusicSection.tsx";
import { NowPlaying } from "./NowPlaying.tsx";
import { PlayerSound } from "./PlayerSound.tsx";
import { PlaylistPage } from "./PlaylistPage.tsx";
import { SoundPage } from "./SoundPage.tsx";
import { nameOf, playlistsOf, soundsOf } from "./state.ts";
import { StorageLine } from "./StorageLine.tsx";
import { SERVER_CHECKING, SERVER_FAILED, SERVER_OFF } from "./words.ts";

/** The page the DM's panel shows: its first page, or a playlist's or a sound's. */
type Page = { kind: "playlist"; id: string } | { kind: "sound"; id: string } | null;

/**
 * Sound (docs/design/design-v1-music.md 4.1 and 4.3). The DM, and co-DMs,
 * run everything here. A player sees what plays and this device's
 * controls, and only while the room plays something they receive, or
 * while a panel opened then stays open (pages/Room.tsx). A display has no
 * panel.
 */
export default function SoundPanel(_props: PanelProps) {
  const role = useRoomView((s) => s.you?.role);
  if (role === "dm") return <DmSound />;
  if (role === "player") return <PlayerSound />;
  return null;
}

/**
 * What the panel says of the server's switch when it is not on: the shared
 * loading line while it asks, never the off line, which comes only from
 * the server's answer, and a failed read with Try again. Pure.
 */
export function ServerLine(props: { server: ServerSound; onRetry(): void }) {
  if (props.server === "on") return null;
  if (props.server === "off") return <Help>{SERVER_OFF}</Help>;
  if (props.server === "unknown") return <Loading text={SERVER_CHECKING} small />;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
      <Help>{SERVER_FAILED}</Help>
      <Button size="sm" icon="retry" onClick={props.onRetry}>
        Try again
      </Button>
    </div>
  );
}

function DmSound() {
  const server = useServerRoomSoundState();
  const serverOn = server === "on";
  const roomId = useRoomView((s) => s.roomId);
  const sounds = useRoomView((s) => soundsOf(s.view));
  const playlists = useRoomView((s) => playlistsOf(s.view));
  const [page, setPage] = useState<Page>(null);
  const [storageVersion, setStorageVersion] = useState(0);
  // Kept here, above the sections a subpage replaces, so Back from a sound's page finds Background or Effects still in Edit.
  const [editing, setEditing] = useState({ loops: false, effects: false });
  const editLoops = useCallback((loops: boolean) => setEditing((e) => ({ ...e, loops })), []);
  const editEffects = useCallback((effects: boolean) => setEditing((e) => ({ ...e, effects })), []);
  const storageChanged = () => setStorageVersion((n) => n + 1);

  // A page whose playlist or sound went, deleted here or on another DM's device, goes back to the first page.
  const playlist = page?.kind === "playlist" ? playlists[page.id] : undefined;
  const sound = page?.kind === "sound" ? sounds[page.id] : undefined;
  const open: Page = playlist || sound ? page : null;
  const back = () => setPage(null);
  usePanelHeader(
    playlist
      ? { title: playlist.name, parent: "Sound", id: `playlist-${playlist.id}`, onBack: back, backTo: [`playlist-${playlist.id}`] }
      : sound
        ? { title: nameOf(sound), parent: "Sound", id: `sound-${sound.id}`, onBack: back, backTo: [`sound-${sound.id}`] }
        : null,
  );

  if (open && playlist) return <PlaylistPage key={playlist.id} playlist={playlist} onDeleted={back} />;
  if (open && sound)
    return (
      <SoundPage
        key={sound.id}
        sound={sound}
        onDeleted={() => {
          storageChanged();
          back();
        }}
      />
    );

  const openPlaylist = (id: string) => setPage({ kind: "playlist", id });
  const openSound = (id: string) => setPage({ kind: "sound", id });

  return (
    <div data-sound-panel="" style={{ display: "grid", gap: theme.space(0), minWidth: 0 }}>
      {serverOn ? (
        <>
          <Section label="Now playing" divider={false}>
            <NowPlaying />
          </Section>
          <MusicSection onOpenPlaylist={openPlaylist} onOpenSound={openSound} onStorageChanged={storageChanged} />
          <LoopsSection editing={editing.loops} onEditing={editLoops} onOpenSound={openSound} onStorageChanged={storageChanged} />
        </>
      ) : (
        <Section divider={false}>
          <ServerLine server={server} onRetry={() => void serverRoomSound()} />
        </Section>
      )}
      <EffectsBoard serverOn={serverOn} editing={editing.effects} onEditing={editEffects} onOpenSound={openSound} onStorageChanged={storageChanged} />
      <Section label="On this device">
        <RoomSoundControls />
      </Section>
      {serverOn ? (
        <Section divider={false}>
          <StorageLine roomId={roomId} version={`${storageVersion} ${Object.keys(sounds).length}`} />
        </Section>
      ) : null}
    </div>
  );
}
