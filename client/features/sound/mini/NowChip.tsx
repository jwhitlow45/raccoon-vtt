import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { flushSync } from "react-dom";
import { Icon } from "../../../components/Icon.tsx";
import { LoadBoundary } from "../../../components/LoadBoundary.tsx";
import { LoadFailed } from "../../../components/LoadFailed.tsx";
import { Loading } from "../../../components/Loading.tsx";
import { Popover, usePopover, type Rect } from "../../../components/Popover.tsx";
import { useTooltip } from "../../../components/Tooltip.tsx";
import { retryableLazy } from "../../../lib/retryableLazy.ts";
import { theme } from "../../../lib/theme.ts";
import { mapFocusSlot, panelFocusSlot } from "../../../pages/mapFocus.ts";
import type { NowPlayingForm } from "../../../pages/topBarFit.ts";
import { scopeSlot, useRoomScope, useScoped } from "../../../state/scope.ts";
import type { RoomView } from "../../../state/types.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../../state/view.ts";
import type { MusicRun, Playing } from "#shared/sound.ts";
import { uiScale } from "../../device/settings.ts";
import { SOUND_PANEL } from "../../panels.ts";
import { SheetDialog } from "../../tokens/SheetDialog.tsx";
import { serverSound, useServerRoomSoundState, type ServerSound } from "../engine/store.ts";
import type { FadeControl } from "../music/NowFull.tsx";
import { openSoundNow } from "../music/open.ts";
import { useWakeAt } from "../panel/controls.tsx";
import { send } from "../panel/ops.ts";
import { musicShown, playlistsOf, serverNow, soundsOf, type Playlists, type Sounds } from "../panel/state.ts";
import { CHIP_PAUSE, CHIP_PLAY, chipName, chipText, OPENING_PLAYER, PLAYER_FAILED, PLAYER_TITLE, runLine, type ChipShows } from "../panel/words.ts";

/*
 * The Now playing chip in the DM's top bar (docs/design/design-v1-sound-layout.md
 * 5): while something plays, Pause or Play beside the track's name, which
 * opens the player the Sound panel holds, as a popover under it from 900
 * px up and as a card or a sheet below (ChipDialogs). The bar places it
 * and gives it way (pages/topBarFit.ts), and holds it in the DM menu once
 * it has left the bar. Players, the table display and View as a player
 * draw none: the top bar mounts it for a DM alone.
 */

/** The popover's body (5.3). The card's and the sheet's fill them. */
export const POPOVER_BODY_PX = 340;
/** The name gives way to "…" past this (5.2). */
export const NAME_CAP_PX = 180;
/** The pill inside the chip's 44 px row (docs/design/design-v1-visual.md 3.2), as the other chips draw it. */
const PILL_PX = 28;
/** The mark the chip's opener carries, so its player's card hands focus back to it (returnTo). */
export const NOW_OPENER = "data-now-open";

/**
 * What the chip shows of what plays at `t` (5.2): the music by the name
 * Now playing gives it, so a crossfade's incoming track from its start,
 * with its run line and whether it is paused, else the background sounds'
 * count, else nothing. Pure.
 */
export function chipShows(playing: Playing | null | undefined, sounds: Sounds, playlists: Playlists, t: number): ChipShows | null {
  if (!playing) return null;
  const shown = playing.music ? musicShown(playing.music, sounds, playlists, t) : null;
  if (shown) return { t: "music", name: shown.name, run: runLine(shown), paused: shown.paused };
  const loops = Object.keys(playing.loops).length;
  return loops > 0 ? { t: "background", count: loops } : null;
}

const STOPPED: ChipShows = Object.freeze({ t: "stopped" });

/**
 * While its player is open the chip stays (5.1): once playback has ended,
 * by a Stop here, another DM's Stop or the last track ending, it shows its
 * stopped state, and it goes as the player closes. Pure.
 */
export function keptShows(live: ChipShows | null, open: boolean): ChipShows | null {
  return live ?? (open ? STOPPED : null);
}

/** What the chip shows for this room, nothing to anyone but a DM or with the server's sound switch anything but on. Pure. */
export function liveShows(room: Pick<RoomView, "you" | "view" | "serverOffset">, server: ServerSound): ChipShows | null {
  if (room.you?.role !== "dm" || server !== "on") return null;
  return chipShows(room.view?.playing, soundsOf(room.view), playlistsOf(room.view), serverNow(room));
}

/** The chip's words as one key for the bar's fit (BarContent `words`), or null while it shows nothing: its kind and its text are what move its width. Pure. */
export function showsKey(shows: ChipShows | null): string | null {
  return shows === null ? null : `${shows.t}:${chipText(shows)}`;
}

/** When a crossfade starts, the moment Now playing names the incoming track with no frame from the server, or null with none ahead. Pure. */
export function crossfadeAt(music: MusicRun | null, t: number): number | null {
  return music && music.paused === undefined && music.next !== undefined && t < music.next.at ? music.next.at : null;
}

/**
 * Where focus goes as the chip's card or sheet closes (5.1): back to what
 * opened it, the DM chip when the DM menu did. Opened from the chip, to
 * the chip while something still plays, else to the map's focus target,
 * since the chip goes as the player closes and focus put on it would be
 * lost. Pure.
 */
export function returnTo<T>(at: { from: T | null; fromChip: boolean; chip: T | null; chipDrawn: boolean; map: T | null; goes: boolean }): T | null {
  if (!at.fromChip) return at.from;
  if (at.goes || !at.chipDrawn) return at.map;
  return at.chip;
}

/** The chip's opener as now drawn, per Room page, for its card's return focus: a turn of form draws it afresh. */
const nowChipSlot = scopeSlot(() => ({ el: null as HTMLElement | null }));

/** Whether a close of the player now takes the chip away: nothing plays, so only the player kept it (5.1). Read from the store as the close happens. */
function useChipGoes(): () => boolean {
  const store = useRoomStore();
  return useCallback(() => liveShows(store.getState(), serverSound()) === null, [store]);
}

/**
 * What the chip shows, kept while its player is open (`open`). It renders
 * on the room's changes to what plays and once more as a crossfade
 * starts, never on a tick (5.2).
 */
function useNowShows(open: boolean): ChipShows | null {
  const role = useRoomView((s) => s.you?.role);
  const server = useServerRoomSoundState();
  const playing = useRoomView((s) => s.view?.playing ?? null);
  const sounds = useRoomView((s) => soundsOf(s.view));
  const playlists = useRoomView((s) => playlistsOf(s.view));
  const serverOffset = useRoomView((s) => s.serverOffset);
  const t = serverNow({ serverOffset });
  useWakeAt(crossfadeAt(playing?.music ?? null, t), t);
  const live = role === "dm" && server === "on" ? chipShows(playing, sounds, playlists, t) : null;
  return keptShows(live, open);
}

const loadPlayer = () => import("./NowPlayer.tsx");
const LazyPlayer = retryableLazy(loadPlayer, { roles: ["dm"] });

/** Calls `onDrawn` once drawn, inside the player's Suspense, so it fires as the loaded body commits and never for the loading line. */
function Drawn(props: { onDrawn(): void }) {
  const { onDrawn } = props;
  useLayoutEffect(onDrawn, [onDrawn]);
  return null;
}

/**
 * The player's body as it loads (5.3): the shared loading line past the
 * shared delay, "Opening the player…", and a failed load says so with Try
 * again, in the popover, the card or the sheet already open.
 */
function PlayerBody(props: { fadeControl: FadeControl; onOpenSound(): void; onDrawn?(): void }) {
  const noop = useCallback(() => {}, []);
  return (
    <LoadBoundary fallback={(f) => <LoadFailed retry={f.retry}>{PLAYER_FAILED}</LoadFailed>}>
      <Suspense fallback={<Loading text={OPENING_PLAYER} />}>
        <LazyPlayer fadeControl={props.fadeControl} onOpenSound={props.onOpenSound} />
        <Drawn onDrawn={props.onDrawn ?? noop} />
      </Suspense>
    </LoadBoundary>
  );
}

/** Open Sound (5.3, music/open.ts openSoundNow): the Sound panel on Now playing at its top, focus to the panel as Room's own buttons hand it. */
function useOpenSound(): () => void {
  const scope = useRoomScope();
  const ui = useRoomUi();
  const panelFocus = useScoped(panelFocusSlot);
  return useCallback(() => {
    openSoundNow(scope, ui);
    panelFocus.focus?.(SOUND_PANEL);
  }, [scope, ui, panelFocus]);
}

function viewportBound(): Rect {
  const scale = uiScale();
  return { left: 0, top: 0, right: window.innerWidth / scale, bottom: window.innerHeight / scale };
}

/**
 * The chip (5.2): in full, Pause or Play on its own, a thin line, then the
 * track's name with a caret, one 28 px pill holding two 44 px tall
 * targets. Compact, the music icon alone in a round pill. Its player opens
 * as a popover from 900 px up (`popover`) and as a card or a sheet below
 * (`openDialog`, ChipDialogs). It tells the bar what it shows
 * (`onShows`, showsKey) and draws only in the form the bar gives it
 * (`form`), nothing while that is off the bar or not yet known.
 */
export function NowChip(props: {
  form: NowPlayingForm | null;
  popover: boolean;
  /** The chip's card or sheet is open (ChipDialogs), which keeps the chip as its popover does. */
  dialogOpen: boolean;
  onShows(key: string | null): void;
  onOpen?(open: boolean): void;
  openDialog(from: HTMLElement | null): void;
}) {
  const actions = useRoomActions();
  const map = useScoped(mapFocusSlot);
  const chip = useScoped(nowChipSlot);
  const goes = useChipGoes();
  const pop = usePopover({ kind: "dialog", fallbackFocus: () => map.el, anchorGoes: goes });
  const shows = useNowShows(pop.open || props.dialogOpen);
  const key = showsKey(shows);
  const { onShows, onOpen } = props;
  useLayoutEffect(() => onShows(key), [key, onShows]);
  useLayoutEffect(() => () => onShows(null), [onShows]);
  // The bar stands over the notices while the popover is open (docs/design/design-v1-tool-options.md 7.6).
  useLayoutEffect(() => onOpen?.(pop.open), [pop.open, onOpen]);
  useLayoutEffect(() => () => onOpen?.(false), [onOpen]);
  // The player's code loads as the chip first shows, so opening it rarely waits.
  const showing = shows !== null;
  useEffect(() => {
    if (showing) loadPlayer().catch(() => {});
  }, [showing]);
  // Under 900 px the chip opens a card or a sheet instead, so a turn of the window closes the popover.
  const { open: popOpen, close: popClose } = pop;
  useEffect(() => {
    if (!props.popover && popOpen) popClose("state");
  }, [props.popover, popOpen, popClose]);
  const openSound = useOpenSound();
  // The popover is placed again as its body arrives or changes its shape, and otherwise lets its content scroll (Popover.tsx contentKey).
  const [drawnBody, setDrawnBody] = useState(0);
  const onDrawn = useCallback(() => setDrawnBody((n) => n + 1), []);
  const loops = useRoomView((s) => Object.keys(s.view?.playing?.loops ?? {}).length);
  const nameRef = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = nameRef.current;
    const now = el !== null && el.scrollWidth > el.clientWidth;
    if (now !== cut) setCut(now);
  });
  const text = shows ? chipText(shows) : "";
  const tip = useTooltip(text);
  const pauseTip = useTooltip(shows?.t === "music" && shows.paused ? CHIP_PLAY : CHIP_PAUSE);
  const { ref: anchorRef, ...anchor } = pop.anchorProps;
  const openerRef = useCallback(
    (el: HTMLElement | null) => {
      chip.el = el;
      anchorRef(el);
    },
    [chip, anchorRef],
  );
  if (!shows || props.form === null || props.form === "off") return null;

  const opener = props.popover
    ? anchor
    : {
        "aria-haspopup": "dialog" as const,
        "aria-expanded": props.dialogOpen,
        onClick: () => props.openDialog(chip.el),
      };
  const state = shows.t === "music" ? (shows.paused ? "paused" : "playing") : shows.t;
  const muted = shows.t === "music" && shows.paused;
  const popover = props.popover ? (
    <Popover handle={pop} side="below" flip bound={viewportBound} title={PLAYER_TITLE} contentKey={`${drawnBody}:${shows.t}:${loops}`}>
      <div style={{ width: POPOVER_BODY_PX, maxWidth: "100%", minWidth: 0 }}>
        <PlayerBody
          fadeControl="inline"
          onDrawn={onDrawn}
          onOpenSound={() => {
            pop.close("pick");
            openSound();
          }}
        />
      </div>
    </Popover>
  ) : null;

  if (props.form === "compact") {
    return (
      <>
        <button
          type="button"
          data-chip="nowPlaying"
          data-chip-form="compact"
          data-chip-state={state}
          data-now-open=""
          {...tip.anchor()}
          {...opener}
          ref={openerRef}
          aria-label={chipName(shows)}
          style={TARGET}
        >
          <span style={{ ...PILL, width: PILL_PX, padding: 0, justifyContent: "center", color: muted ? theme.color.textMuted : theme.color.text }}>
            <Icon name="music" size="sm" />
          </span>
        </button>
        {tip.tip}
        {popover}
      </>
    );
  }
  const music = shows.t === "music" ? shows : null;
  return (
    <>
      <span data-chip="nowPlaying" data-chip-form="full" data-chip-state={state} style={{ flex: "none", display: "flex", alignItems: "center" }}>
        {music ? (
          <button
            type="button"
            data-now-pause=""
            {...pauseTip.anchor()}
            aria-label={music.paused ? CHIP_PLAY : CHIP_PAUSE}
            onClick={() => send(actions, music.paused ? { t: "music.resume", run: actions.newId() } : { t: "music.pause" })}
            style={{ ...TARGET, minWidth: PAUSE_PX, width: PAUSE_PX }}
          >
            <span style={{ ...PILL, width: "100%", justifyContent: "center", borderRight: 0, borderRadius: `${theme.radius.pill}px 0 0 ${theme.radius.pill}px` }}>
              <Icon name={music.paused ? "play" : "pause"} size="sm" />
            </span>
          </button>
        ) : null}
        <button type="button" data-now-open="" {...(cut ? tip.anchor() : null)} {...opener} ref={openerRef} aria-label={chipName(shows)} style={{ ...TARGET, color: muted ? theme.color.textMuted : theme.color.text }}>
          <span
            style={{
              ...PILL,
              gap: theme.space(1),
              padding: music ? `0 ${theme.space(1.5)}px 0 0` : `0 ${theme.space(1.5)}px 0 ${theme.space(2.5)}px`,
              ...(music ? { borderLeft: 0, borderRadius: `0 ${theme.radius.pill}px ${theme.radius.pill}px 0` } : null),
            }}
          >
            {music ? <span aria-hidden style={DIVIDER} /> : <Icon name="music" size="sm" />}
            <span ref={nameRef} style={NAME}>
              {text}
            </span>
            <Icon name="caret" size="sm" />
          </span>
        </button>
      </span>
      {music ? pauseTip.tip : null}
      {cut ? tip.tip : null}
      {popover}
    </>
  );
}

/**
 * The chip's player as a dialog (5.3), drawn by ChipDialogs: a centered
 * card from 600 px, 440 px wide, and a sheet from the bottom below, each
 * body filling it, with the Crossfade menu, since a dialog is no popover
 * that the menu's own would close. The chip opens it under 900 px, and
 * the DM menu's Now playing while the chip is off the bar. Focus goes back
 * as returnTo says, read as it closes. Open Sound closes it first, so the
 * room is no longer inert when focus moves to the Sound panel.
 */
export function NowPlayerDialog(props: { opener: RefObject<HTMLElement | null>; onClose(): void }) {
  const map = useScoped(mapFocusSlot);
  const chip = useScoped(nowChipSlot);
  const goes = useChipGoes();
  const openSound = useOpenSound();
  const { opener, onClose } = props;
  const back = useMemo(
    () => ({
      get current(): HTMLElement | null {
        const from = opener.current;
        return returnTo({ from, fromChip: from?.hasAttribute(NOW_OPENER) === true, chip: chip.el, chipDrawn: chip.el?.isConnected === true, map: map.el, goes: goes() });
      },
    }),
    [opener, chip, map, goes],
  );
  return (
    <SheetDialog title={PLAYER_TITLE} opener={back} onClose={onClose} width={theme.layout.dialog.sm}>
      <PlayerBody
        fadeControl="menu"
        onOpenSound={() => {
          flushSync(onClose);
          openSound();
        }}
      />
    </SheetDialog>
  );
}

const TARGET: CSSProperties = {
  flex: "none",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: theme.touch,
  minWidth: theme.touch,
  padding: 0,
  background: "transparent",
  border: 0,
  color: theme.color.text,
  cursor: "pointer",
  font: "inherit",
};
/**
 * The pill, as tall as the other chips' (CHIP_PX in pages/ChipMenus.tsx),
 * drawn inside each 44 px target as the other chips draw theirs: in full
 * its two halves meet into one pill. A pill drawn around both targets
 * would stand in the bar's row beside the connection dot as a painted box
 * of another height, which the alignment check refuses.
 */
const PILL: CSSProperties = {
  flex: "none",
  display: "flex",
  alignItems: "center",
  boxSizing: "border-box",
  height: PILL_PX,
  borderRadius: theme.radius.pill,
  border: `${theme.line.border}px solid ${theme.color.border}`,
  fontSize: theme.font.small,
  fontWeight: theme.weight.bold,
  whiteSpace: "nowrap",
};
/** The thin line between Pause and the name, with the name's own room after it. */
const DIVIDER: CSSProperties = { flex: "none", width: theme.line.border, height: 16, marginRight: theme.space(1), background: theme.color.border };
/** Pause's target: 44 px tall as every target, and 36 px wide as the design measured the split chip, which only a computer's bar draws. */
const PAUSE_PX = 36;
const NAME: CSSProperties = { minWidth: 0, maxWidth: NAME_CAP_PX, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
