import { useCallback } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { theme } from "../../lib/theme.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { useLayoutSize } from "../device/layout.ts";

/** The height of a phone's turn band under the top bar (design 14.4, InitiativeStrip.tsx). */
export const TURN_BAND_PX = 48;

/**
 * Below this layout height a phone in landscape keeps the turn strip in
 * its top bar when the bar has room for it: a band of its own would take
 * 48 of about 390 px while the bar's row stood mostly empty
 * (docs/design/design-v1-visual.md F22).
 */
export const SHORT_LANDSCAPE_MAX = 500;

/** Where the turn strip goes: in the top bar's row, or a band of its own under it. */
export type TurnPlacement = "bar" | "band";

/**
 * Where the turn strip may go at a layout size (docs/design/design-v1-visual.md
 * 3.2), in the chrome's own pixels (features/device/layout.ts layoutSize),
 * so the interface size moves it as it moves everything else.
 *
 * - From 900 px wide the strip sits in the top bar, as it always has.
 * - A short landscape phone (wider than tall, under 500 px tall) may put
 *   it in either: in the bar while the bar's row has room for it, else in
 *   the band (docs/design/design-v1-visual.md F22). The top bar's give-way
 *   decides, as its first step on a phone (pages/topBarFit.ts, "band").
 * - Anything else, a portrait phone above all, takes the band.
 *
 * No fixed threshold decides it, since what the bar holds varies: a long
 * room name gives way, but a player's own turn adds "Your turn" and End
 * turn, and the DM's bar has Undo and Redo.
 */
export function turnPlaces(input: { width: number; height: number }): TurnPlacement | "either" {
  if (input.width >= theme.layout.wideMinWidth) return "bar";
  const shortLandscape = input.width > input.height && input.height < SHORT_LANDSCAPE_MAX;
  return shortLandscape ? "either" : "band";
}

/** Where the turn strip goes: where turnPlaces puts it, and where it may go either way, the band once the top bar's give-way has taken that step (`band`). */
export function turnPlacement(input: { width: number; height: number; band: boolean }): TurnPlacement {
  const places = turnPlaces(input);
  if (places !== "either") return places;
  return input.band ? "band" : "bar";
}

/**
 * The top bar's turn chip (InitiativeStrip.tsx Strip) shows up to five
 * next faces from 900 px up, then three, then none, as the bar gives way
 * (designs/qol/chips.md 5, steps 1 and 9). A phone's bar, where the strip
 * sits only on a short landscape phone, shows the three.
 */
export const STRIP_FACES = 5;
export const STRIP_FACES_FEW = 3;

/**
 * The turn chip's name is cut at 180 px, and at 120 on the player's own
 * turn, to leave room for "Your turn" and End turn. As the bar's last
 * steps it gives way further, by what the row lacks, down to
 * STRIP_NAME_MIN_PX (a few letters and the ellipsis), and below that it
 * leaves the chip (chips.md 5, step 11).
 */
export const STRIP_NAME_PX = 180;
export const STRIP_NAME_YOURS_PX = 120;
export const STRIP_NAME_MIN_PX = 40;

/** The acting creature's name always keeps this much of the band's row: two or three letters and the ellipsis, at the band's 16 px. */
export const BAND_NAME_MIN_PX = 36;

/** The most Next disks the band shows, room allowing. */
export const BAND_MAX_DISKS = 4;

/**
 * What the band's row holds, in layout px, as Chrome draws it, rounded
 * up. They were set from the system font. Inter draws each a little
 * narrower (the round's digits, the clock and "Time's up" were checked),
 * so they still hold. Estimates rather than measurements, so the
 * band's layout follows its width and what it shows (the round's digits,
 * the clock's text), never its own drawing, and never flickers between two
 * layouts while it measures itself. `slack` covers a font a little wider.
 */
const ROW = {
  gutters: 2 * theme.space(3),
  gap: theme.space(2),
  portrait: 36,
  /** The name column's padding for the flare's pill, less the margins that take it back (InitiativeStrip.tsx PILL_PAD). */
  nameFrame: 4,
  roundLetter: 9,
  roundDigit: 7.5,
  /** A running clock ("1:05", timer.ts clockText) in the band's tabular digits: each digit, its colon, and a little over. */
  clockDigit: 7.5,
  clockColon: 12,
  clockPad: 2,
  timeUp: 68,
  endTurn: 91,
  endTurnStacked: 50,
  /** The DM's Next pill (parts.tsx NextPill): "Start", its wider word, in the bold 14 px with its padding and outline. */
  dmNext: 72,
  nextLabel: 25,
  disk: 24,
  diskGap: theme.space(1),
  slack: 4,
};

/** The band's timer: none, time up ("Time's up" over the time past it), or a running clock and its text. */
export type BandTimer = "none" | "over" | { clock: string };

/**
 * A running clock's width, from its text, as the round's is from its
 * digits. Reserving the width of "10:00" for every clock left the DM's band
 * at 320 px at 130% without a Next disk it had room for.
 */
function clockWidth(text: string): number {
  const digits = text.replace(/\D/g, "").length;
  const colons = text.length - text.replace(/:/g, "").length;
  return ROW.clockDigit * digits + ROW.clockColon * colons + ROW.clockPad;
}

/** How the band's row fits its width: how many of the `next` disks it has show, whether the round shows, and whether End turn stacks its words on two lines. */
export type BandFit = { disks: number; round: boolean; stackEnd: boolean };

/**
 * How the phone's turn band fits a narrow layout (LPD-DMPHONE-2). The
 * acting creature's name keeps a few letters (BAND_NAME_MIN_PX) and the
 * rest gives way around it, least needed first: the DM's Next disks, one
 * at a time, then the round ("R2", which the tracker and the band's own
 * name still give), then a player's End turn (the DM's Next counts in its place and never stacks), whose words stack on two
 * lines as the time past the turn does. Before, the name gave way first:
 * at 130% it was squeezed to nothing on the DM's band while the last disk
 * still ran off the screen, and on a 320 px phone a player's End turn did.
 */
export function bandFit(input: { width: number; round: number; timer: BandTimer; endTurn: boolean; dmNext?: boolean; next: number }): BandFit {
  const { gap } = ROW;
  const round = gap + ROW.roundLetter + ROW.roundDigit * String(input.round).length;
  const timer = input.timer === "none" ? 0 : gap + (input.timer === "over" ? ROW.timeUp : clockWidth(input.timer.clock));
  // The DM's Next never gives way or stacks (one short word), so it counts as an End turn that is already stacked or not at all.
  const end = (stacked: boolean) => (input.endTurn ? gap + (stacked ? ROW.endTurnStacked : ROW.endTurn) : input.dmNext ? gap + ROW.dmNext : 0);
  const base = ROW.gutters + ROW.portrait + gap + ROW.nameFrame + BAND_NAME_MIN_PX + timer + ROW.slack;
  const room = input.width - base - round - end(false);
  if (room >= 0) {
    const disks = Math.floor((room - gap - ROW.nextLabel) / (ROW.diskGap + ROW.disk));
    return { disks: Math.max(0, Math.min(input.next, disks)), round: true, stackEnd: false };
  }
  if (room + round >= 0) return { disks: 0, round: false, stackEnd: false };
  return { disks: 0, round: false, stackEnd: input.endTurn };
}

/**
 * Whether the top bar's give-way has moved the strip to the band, per Room
 * page (state/scope.ts): "view as a player" draws a second top bar with
 * other contents, which must not move the DM's strip. The top bar alone
 * writes it (pages/Room.tsx TopBar).
 */
const turnSlot = scopeSlot(() => createStore<{ band: boolean }>(() => ({ band: false })));

/** Where this Room's turn strip goes now. */
export function useTurnPlacement(): TurnPlacement {
  const { width, height } = useLayoutSize();
  const band = useStore(useScoped(turnSlot), (s) => s.band);
  return turnPlacement({ width, height, band });
}

/** Where this Room's turn strip may go at the layout's size (turnPlaces). */
export function useTurnPlaces(): TurnPlacement | "either" {
  return turnPlaces(useLayoutSize());
}

/** Sets whether the top bar's give-way has moved the strip to the band (pages/topBarFit.ts, its "band" step). */
export function useBandStep(): (band: boolean) => void {
  const store = useScoped(turnSlot);
  return useCallback(
    (band: boolean) => {
      if (store.getState().band !== band) store.setState({ band });
    },
    [store],
  );
}

/**
 * How far down from the safe area the bars over the top of the map reach:
 * the top bar, and the turn band under it during a fight when the strip
 * takes the band (turnPlacement). Anything placed over the map keeps clear
 * of it: sheets, notices, the token bar and the DM's roll desk. The layout
 * follows the window, not the map, which a docked side panel narrows, in
 * the chrome's own pixels (features/device/layout.ts), as the bars it
 * measures are.
 */
export function useTopBars(): number {
  const placement = useTurnPlacement();
  const fight = useRoomView((s) => !!s.view?.encounter);
  return theme.layout.topBar + (placement === "band" && fight ? TURN_BAND_PX : 0);
}
