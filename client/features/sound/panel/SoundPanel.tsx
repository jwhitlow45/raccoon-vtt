import { useCallback, useState, type ReactNode } from "react";
import { Button } from "../../../components/Button.tsx";
import { Loading } from "../../../components/Loading.tsx";
import { Help, Section } from "../../../components/Panel.tsx";
import { theme } from "../../../lib/theme.ts";
import { useRoomView } from "../../../state/view.ts";
import { WHAT_PLAYERS_HEAR } from "../../ambiance/words.ts";
import { usePanelHeader, type PanelProps } from "../../panels.ts";
import { MusicWindowHost } from "../music/MusicWindowHost.tsx";
import { EffectsBoard } from "./EffectsBoard.tsx";
import { RoomSoundControls, serverRoomSound, useServerRoomSoundState, type ServerSound } from "./engine.ts";
import { LoopsSection } from "./LoopsSection.tsx";
import { NowPlaying, WhatPlayersHear } from "./NowPlaying.tsx";
import { PlayerSound } from "./PlayerSound.tsx";
import { SoundPage } from "./SoundPage.tsx";
import { nameOf, soundsOf } from "./state.ts";
import { StorageLine } from "./StorageLine.tsx";
import { SERVER_CHECKING, SERVER_FAILED, SERVER_OFF } from "./words.ts";

/**
 * The Sound panel (docs/design/design-v1-sound-layout.md 4), a stub that
 * draws today's Sound section until lane SL-B's two views take its place:
 * the DM's with its subpages and the Music window, a player's Now playing
 * and On this device.
 */
export default function SoundPanel(_props: PanelProps) {
  const role = useRoomView((s) => s.you?.role);
  if (role === "dm") return <DmSound />;
  if (role === "player") return <PlayerSound />;
  return null;
}

function DmSound() {
  const pages = useDmSoundPages("Sound");
  // First, so the Music window stays mounted as a subpage comes or goes after it.
  return (
    <>
      <MusicWindowHost />
      {pages.subpage ?? <DmSoundSection {...pages.first} />}
    </>
  );
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

/**
 * What the DM's Sound keeps above its subpages, in the Ambiance panel's top
 * (docs/design/design-v1-panel-groups.md 4.1, D-261102-763): which page
 * shows, Background's and Effects' Edit, and the storage line's version. A
 * sound's page replaces the whole of Ambiance's first page, as it replaced
 * the Sound panel's, so these must outlive it. `subpage` is the page to
 * draw in its place, or null for the first page. `toFirstPage` goes back
 * as Back does, for a request from elsewhere (4.3). A music track's page
 * and the playlists live in the Music window
 * (docs/design/design-v1-music-player.md 3.1).
 */
export type DmSoundPages = { subpage: ReactNode | null; first: DmSoundFirst; toFirstPage(): void };

/** The first page's part of DmSoundPages, handed to DmSoundSection. */
export type DmSoundFirst = {
  editing: { loops: boolean; effects: boolean };
  onEditLoops(editing: boolean): void;
  onEditEffects(editing: boolean): void;
  onOpenSound(id: string): void;
  storageVersion: number;
  onStorageChanged(): void;
};

/** The DM's Sound pages. `parent` names the panel for each subpage's "Back to" button. */
export function useDmSoundPages(parent: string): DmSoundPages {
  const sounds = useRoomView((s) => soundsOf(s.view));
  const [page, setPage] = useState<string | null>(null);
  const [storageVersion, setStorageVersion] = useState(0);
  // Kept here, above the sections a subpage replaces, so Back from a sound's page finds Background or Effects still in Edit.
  const [editing, setEditing] = useState({ loops: false, effects: false });
  const onEditLoops = useCallback((loops: boolean) => setEditing((e) => ({ ...e, loops })), []);
  const onEditEffects = useCallback((effects: boolean) => setEditing((e) => ({ ...e, effects })), []);
  const onStorageChanged = useCallback(() => setStorageVersion((n) => n + 1), []);
  const back = useCallback(() => setPage(null), []);

  // A page whose sound went, deleted here or on another DM's device, goes back to the first page.
  const sound = page !== null ? sounds[page] : undefined;
  usePanelHeader(sound ? { title: nameOf(sound), parent, id: `sound-${sound.id}`, onBack: back, backTo: [`sound-${sound.id}`] } : null);

  const subpage = sound ? (
    <SoundPage
      key={sound.id}
      sound={sound}
      onDeleted={() => {
        onStorageChanged();
        back();
      }}
    />
  ) : null;
  return {
    subpage,
    toFirstPage: back,
    first: { editing, onEditLoops, onEditEffects, onOpenSound: setPage, storageVersion, onStorageChanged },
  };
}

/**
 * The DM's Sound first page, in D-261102-766's order
 * (docs/design/design-v1-panel-groups.md 4.1): Now playing with Open music,
 * Effects right under it, What players hear, then Background, On this
 * device and the storage line. Music leaves for the Music window
 * (docs/design/design-v1-music-player.md 3.1). With the server's switch
 * off: its line, Effects and On this device, and no Open music, since
 * nothing could play a file.
 */
export function DmSoundSection(props: DmSoundFirst) {
  const server = useServerRoomSoundState();
  const serverOn = server === "on";
  const roomId = useRoomView((s) => s.roomId);
  const soundCount = useRoomView((s) => Object.keys(soundsOf(s.view)).length);
  const effects = <EffectsBoard serverOn={serverOn} editing={props.editing.effects} onEditing={props.onEditEffects} onOpenSound={props.onOpenSound} onStorageChanged={props.onStorageChanged} />;
  return (
    <div data-sound-panel="" style={{ display: "grid", gap: theme.space(4), minWidth: 0 }}>
      {serverOn ? (
        <>
          <Section label="Now playing">
            <NowPlaying />
          </Section>
          {effects}
          <Section label={WHAT_PLAYERS_HEAR}>
            <WhatPlayersHear />
          </Section>
          <LoopsSection editing={props.editing.loops} onEditing={props.onEditLoops} onOpenSound={props.onOpenSound} onStorageChanged={props.onStorageChanged} />
        </>
      ) : (
        <>
          <Section>
            <ServerLine server={server} onRetry={() => void serverRoomSound()} />
          </Section>
          {effects}
        </>
      )}
      <Section label="On this device">
        <RoomSoundControls />
      </Section>
      {serverOn ? (
        <Section>
          <StorageLine roomId={roomId} version={`${props.storageVersion} ${soundCount}`} />
        </Section>
      ) : null}
    </div>
  );
}
