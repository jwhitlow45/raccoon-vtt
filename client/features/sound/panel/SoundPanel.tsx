import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useStore } from "zustand";
import { Button } from "../../../components/Button.tsx";
import { Loading } from "../../../components/Loading.tsx";
import { Help, Section } from "../../../components/Panel.tsx";
import { Segmented } from "../../../components/Segmented.tsx";
import { panelIsOpen, soundFoldsSlot, useFolds } from "../../../lib/folds.ts";
import { scrollBox } from "../../../lib/reveal.ts";
import { theme } from "../../../lib/theme.ts";
import { scopeSlot, useRoomScope, useScoped, type RoomScope } from "../../../state/scope.ts";
import type { LocalUi } from "../../../state/types.ts";
import { useRoomStore, useRoomView } from "../../../state/view.ts";
import { layoutWidth } from "../../device/layout.ts";
import { SOUND_PANEL, takeOverPanelScroll, usePanelHeader, usePanelView, type PanelProps } from "../../panels.ts";
import { comingNext, queueLists, type ComingNext, type QueueLists } from "../music/dragOrder.ts";
import { Library } from "../music/Library.tsx";
import { MakerHost } from "../music/MakerHost.tsx";
import { NowFull } from "../music/NowFull.tsx";
import { endSoundView, soundAskSlot, soundViewSlot, useSoundRoot, useSoundView, type SoundView } from "../music/open.ts";
import { lengthOf, UpNext } from "../music/UpNext.tsx";
import { tracksDetail, UP_NEXT } from "../music/words.ts";
import { useWakeAt } from "./controls.tsx";
import { EffectsBoard } from "./EffectsBoard.tsx";
import { RoomSoundControls, serverRoomSound, useServerRoomSoundState, type ServerSound } from "./engine.ts";
import { LoopsSection } from "./LoopsSection.tsx";
import { DeviceLine, nextWords, TableSound } from "./NowPlaying.tsx";
import { PlayerSound } from "./PlayerSound.tsx";
import { SoundPage } from "./SoundPage.tsx";
import { nameOf, serverNow, soundsOf, type Sounds } from "./state.ts";
import { StorageLine } from "./StorageLine.tsx";
import { LIBRARY_VIEW, NOW_VIEW, SERVER_CHECKING, SERVER_FAILED, SERVER_OFF, SOUND_TITLE, SOUND_VIEWS, TABLE_SOUND } from "./words.ts";

/**
 * The Sound panel (docs/design/design-v1-sound-layout.md 4): the DM's two
 * views, Now playing and Library, with their subpages and the playlist
 * maker's pop-up, and a player's Now playing and On this device. Nothing
 * here reads more than the player's projection already holds.
 */
export default function SoundPanel(_props: PanelProps) {
  const role = useRoomView((s) => s.you?.role);
  if (role === "dm") return <DmSound />;
  if (role === "player") return <PlayerSound />;
  return null;
}

function DmSound() {
  const pages = useDmSoundPages(SOUND_TITLE);
  const root = useRef<HTMLDivElement | null>(null);
  // Open Sound blurs a field typed in here before it leaves a subpage (music/open.ts openSoundNow).
  const soundRoot = useSoundRoot();
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      root.current = el;
      const undo = soundRoot(el);
      return () => {
        root.current = null;
        if (typeof undo === "function") undo();
      };
    },
    [soundRoot],
  );
  useEndViewOnClose();
  useOpenSoundAsk(pages.subpage !== null, pages.toFirstPage, root);
  // The maker first, so its pop-up stays mounted as a subpage comes or goes after it.
  return (
    <div ref={ref} data-sound-panel="" style={{ display: "grid", minWidth: 0 }}>
      <MakerHost />
      {pages.subpage ?? <DmSoundFirstPage {...pages.first} />}
    </div>
  );
}

/**
 * Whether Sound is open, as Room and the folds read it
 * (lib/folds.ts panelIsOpen): the side panel's tab or the pane below from
 * 900 px up, else the phone's sheet, a hidden side panel or sheet
 * counting as open. `layoutPx` is the layout's width now.
 */
export function soundOpen(local: Pick<LocalUi, "panel" | "tab" | "below">, layoutPx: number): boolean {
  return panelIsOpen(local, SOUND_PANEL, layoutPx >= theme.layout.wideMinWidth);
}

/**
 * Sound going from open to closed ends its view (4.1, music/open.ts
 * endSoundView): the next opening starts on Now playing with no search,
 * at its top. The panel is drawn exactly while it is open, so it ends as
 * the panel leaves, unless it is still open, as when a turn across 900 px
 * or a swap of the side panel's two panels remounts it elsewhere: then
 * the view, the search and the scroll stay.
 */
function useEndViewOnClose(): void {
  const scope = useRoomScope();
  const store = useRoomStore();
  useEffect(() => () => endViewIfClosed(scope, store.getState().local, layoutWidth()), [scope, store]);
}

/** As the panel leaves: ends Sound's view when Sound is no longer open (useEndViewOnClose). */
export function endViewIfClosed(scope: RoomScope, local: Pick<LocalUi, "panel" | "tab" | "below">, layoutPx: number): void {
  if (!soundOpen(local, layoutPx)) endSoundView(scope);
}

/** The last Open Sound press the panel acted on, for the Room page, so a panel that mounts on a press acts on it once. */
const soundAskSeenSlot = scopeSlot(() => ({ seq: 0 }));

/**
 * Acts on Open Sound (4.1, music/open.ts openSoundNow), once per press: a
 * subpage leaves through its own Back, then the scroller goes to its top,
 * counting as the viewer taking it, so a remembered offset never pulls it
 * away. After the commit, since the sheet or pane around the panel puts
 * its remembered offset back in its own layout effect, which runs after
 * this one.
 */
function useOpenSoundAsk(onSubpage: boolean, toFirstPage: () => void, root: RefObject<HTMLElement | null>): void {
  const ask = useScoped(soundAskSlot);
  const seq = useStore(ask, (a) => a.seq);
  const seen = useScoped(soundAskSeenSlot);
  useLayoutEffect(() => {
    const step = askStep(seq, seen.seq, onSubpage);
    if (step === "none") return;
    if (step === "back") {
      toFirstPage();
      return;
    }
    seen.seq = seq;
    queueMicrotask(() => {
      const el = root.current;
      if (!el?.isConnected) return;
      toTop(el);
      takeOverPanelScroll(el);
    });
  }, [seq, seen, onSubpage, toFirstPage, root]);
}

/**
 * What an Open Sound press asks of the panel as it draws: nothing once
 * acted on, a subpage's Back first, then its top. The press is acted on
 * only at the top, so the first page that Back brings acts on it. Pure.
 */
export function askStep(seq: number, seen: number, onSubpage: boolean): "none" | "back" | "top" {
  if (seq === seen) return "none";
  return onSubpage ? "back" : "top";
}

/** Puts the panel's scroller, the nearest that scrolls `el`, at its top. One that has nothing to scroll is at its top already. */
function toTop(el: HTMLElement): void {
  // An element's parent chain, read through reveal.ts's narrow view of an element.
  const box = scrollBox(el as unknown as Parameters<typeof scrollBox>[0]);
  if (box) box.scrollTop = 0;
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
 * What the DM's Sound keeps above its subpages
 * (docs/design/design-v1-panel-groups.md 4.1, D-261102-763): which page
 * shows, Background's and Effects' Edit, and the storage line's version. A
 * sound's page, a music track's from Library included
 * (docs/design/design-v1-sound-layout.md 4.5), replaces the whole first
 * page, so these must outlive it. The view and Library's search outlive it
 * in the Room scope's view slot (music/open.ts). `subpage` is the page to
 * draw in its place, or null for the first page. `toFirstPage` goes back
 * as Back does, for Open Sound.
 */
export type DmSoundPages = { subpage: ReactNode | null; first: DmSoundFirst; toFirstPage(): void };

/** The first page's part of DmSoundPages, handed to DmSoundFirstPage. */
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
 * The DM's Sound first page (4.1): the view row, named "Sound", and the
 * view it picks, from the Room scope's view slot so both trees read one.
 * The scroll keeper counts the view as the page (usePanelView), so a
 * remount puts each view back where it was and never one's place on the
 * other. A switch of view puts the scroller at the new view's top itself,
 * since the keeper only restores as the panel shown changes. With the
 * server's switch off: no view row, its line, Effects and On this device,
 * since nothing could play a file.
 */
export function DmSoundFirstPage(props: DmSoundFirst) {
  const server = useServerRoomSoundState();
  const serverOn = server === "on";
  const scope = useRoomScope();
  const { view } = useSoundView();
  const shown: SoundView = serverOn ? view : "now";
  usePanelView(shown);
  const root = useRef<HTMLDivElement | null>(null);
  // Set by the Library link in the idle line, whose press also moves focus to Library's search.
  const toSearch = useRef(false);
  useViewStart(shown, root, toSearch);
  const setView = (next: SoundView) => scope.get(soundViewSlot).setState({ view: next });
  const effects = <EffectsBoard serverOn={serverOn} editing={props.editing.effects} onEditing={props.onEditEffects} onOpenSound={props.onOpenSound} onStorageChanged={props.onStorageChanged} />;
  if (!serverOn) {
    return (
      <div ref={root} data-sound-view={shown} style={PAGE}>
        <Section divider={false}>
          <ServerLine server={server} onRetry={() => void serverRoomSound()} />
        </Section>
        {effects}
        <Section label="On this device">
          <RoomSoundControls />
        </Section>
      </div>
    );
  }
  return (
    <div ref={root} data-sound-view={shown} style={PAGE}>
      <Segmented<SoundView>
        label={SOUND_VIEWS}
        grow
        value={shown}
        options={[
          { value: "now", label: NOW_VIEW },
          { value: "library", label: LIBRARY_VIEW },
        ]}
        onChange={setView}
      />
      {shown === "now" ? (
        <NowPlayingView
          first={props}
          effects={effects}
          onLibrary={() => {
            toSearch.current = true;
            setView("library");
          }}
        />
      ) : (
        <Library onOpenTrack={props.onOpenSound} />
      )}
    </div>
  );
}

/**
 * A switch of view puts the panel's scroller at the top of the view it
 * shows now, as a subpage starts at its top (panels.ts useSubpageFocus),
 * and the Library link moves focus to Library's search. Not on the first
 * draw: a remount is the keeper's to put back.
 */
function useViewStart(view: SoundView, root: RefObject<HTMLElement | null>, toSearch: RefObject<boolean>): void {
  const was = useRef(view);
  useLayoutEffect(() => {
    if (was.current === view) return;
    was.current = view;
    const el = root.current;
    if (!el) return;
    toTop(el);
    if (!toSearch.current) return;
    toSearch.current = false;
    el.querySelector<HTMLElement>("[data-music-search] input")?.focus({ preventScroll: true });
  }, [view, root, toSearch]);
}

/**
 * Now playing, in the order of 4.2 (D-261106-091): the player with Stop
 * all sound in its own row and the device line, Up next folded, Effects,
 * Table sound, Background, then On this device and the storage line.
 */
function NowPlayingView(props: { first: DmSoundFirst; effects: ReactNode; onLibrary(): void }) {
  const { first } = props;
  const roomId = useRoomView((s) => s.roomId);
  const soundCount = useRoomView((s) => Object.keys(soundsOf(s.view)).length);
  return (
    <>
      <div data-sound-player="" style={{ display: "grid", gap: theme.space(3), minWidth: 0 }}>
        <NowFull stopAll onLibrary={props.onLibrary} />
        <DeviceLine />
      </div>
      <UpNextFold />
      {props.effects}
      <Section label={TABLE_SOUND}>
        <TableSound />
      </Section>
      <LoopsSection editing={first.editing.loops} onEditing={first.onEditLoops} onOpenSound={first.onOpenSound} onStorageChanged={first.onStorageChanged} />
      <Section label="On this device">
        <RoomSoundControls />
      </Section>
      <Section>
        <StorageLine roomId={roomId} version={`${first.storageVersion} ${soundCount}`} />
      </Section>
    </>
  );
}

/**
 * Up next's summary beside its fold (4.3): folded, the Next line alone,
 * "Next: Tavern in the rain", so the next track stays in sight with the
 * queue a tap away. Open, the count, "9 tracks · 26 min", as the list's
 * heading said it. Null with nothing to say. Pure.
 */
export function upNextSummary(open: boolean, lists: QueueLists | null, next: ComingNext | null, sounds: Sounds): string | null {
  if (open) return lists && lists.ahead.length > 0 ? tracksDetail(lists.ahead.length, lengthOf(lists.ahead, sounds)) : null;
  return next ? nextWords(next, sounds) : null;
}

/**
 * Up next as a fold (4.3): folded on every width with nothing stored,
 * remembered on this device after a tap (lib/folds.ts SOUND_FOLDS), its
 * list kept mounted while folded. Its summary is the fold's description.
 * Only while music plays, since with none there is no queue. It renders
 * on the room's changes and once more as a crossfade starts, when the
 * next track becomes the one Now playing names with no frame from the
 * server, never each second.
 */
function UpNextFold() {
  const fold = useFolds(soundFoldsSlot)("upnext");
  const summaryId = useId();
  const music = useRoomView((s) => s.view?.playing?.music ?? null);
  const sounds = useRoomView((s) => soundsOf(s.view));
  const serverOffset = useRoomView((s) => s.serverOffset);
  const t = serverNow({ serverOffset });
  useWakeAt(music?.next !== undefined && music.paused === undefined && t < music.next.at ? music.next.at : null, t);
  if (!music) return null;
  const summary = upNextSummary(fold.open, queueLists(music, sounds, t), comingNext(music, sounds, t), sounds);
  return (
    <Section
      label={UP_NEXT}
      fold={{
        ...fold,
        keep: true,
        ...(summary
          ? {
              summary: (
                <span id={summaryId} data-music-upnext-summary="" style={SUMMARY}>
                  {summary}
                </span>
              ),
              describedBy: summaryId,
            }
          : null),
      }}
    >
      <UpNext />
    </Section>
  );
}

const PAGE = { display: "grid", gap: theme.space(4), minWidth: 0 } as const;
/** The fold's usual muted summary look, wrapping under the label where the row is short, a long name kept whole. */
const SUMMARY = { fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.textMuted, minWidth: 0, overflowWrap: "anywhere" } as const;
