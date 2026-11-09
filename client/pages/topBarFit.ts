import { STRIP_FACES, STRIP_FACES_FEW, STRIP_NAME_MIN_PX } from "../features/encounter/band.ts";

/**
 * The top bar's parts and the order it gives way in
 * (docs/design/design-v1-qol.md 4, The give-way), and the rule that takes the
 * steps (fitStep, shapeOf). A part sets itself in BarContent and draws in the
 * form BarShape gives, as Now playing (features/sound/mini/NowChip.tsx) and
 * Search (features/search/SearchSheet.tsx SearchButton) do.
 */

/**
 * Every part, in its place from left to right. `you` is the DM chip or a
 * player's chip, `blackout` the DM's Players see black, `gap` the room
 * the row keeps between its two ends, `volume` this device's speaker
 * beside the room's Now playing (docs/design/design-v1-volume.md 3), and
 * `turn` the turn chip with Next or End turn.
 */
export type TopBarPart =
  | "dot"
  | "name"
  | "you"
  | "blackout"
  | "search"
  | "gap"
  | "nowPlaying"
  | "volume"
  | "clock"
  | "undo"
  | "redo"
  | "phase"
  | "turn"
  | "find"
  | "floor"
  | "view"
  | "fit"
  | "fullscreen";

export const TOP_BAR_ORDER: readonly TopBarPart[] = ["dot", "name", "you", "blackout", "search", "gap", "nowPlaying", "volume", "clock", "undo", "redo", "phase", "turn", "find", "floor", "view", "fit", "fullscreen"];

/**
 * Search's forms (design-v1-qol.md 5, Opening): the field-like button with its words and
 * key, its 44 px icon (step 0, which from 900 px up it never gives way
 * past), and below 900 px folded into the Panels field, its home off the
 * bar (D-261106-167). Not in View as a player, nor on a table display.
 */
export type SearchForm = "field" | "icon" | "panels";

/**
 * Now playing's forms (sound layout design 5.4): the split chip, its 44 px
 * music icon, or off the bar, where the DM menu holds it. The DM's alone,
 * shown while something plays or its player is open. A phone starts at the
 * icon.
 */
export type NowPlayingForm = "full" | "compact" | "off";

/**
 * Floor's forms (docs/design/design-v1-floors.md 18.6, D-261107-215): the
 * icon with the floor's name, the icon alone (a phone's from the start,
 * as Search's and Now playing's), or folded with View into the Menu
 * panel's Floor row.
 */
export type FloorForm = "name" | "icon" | "menu";

/**
 * The steps from 900 px up, in the order the bar takes them (design-v1-qol.md
 * 4, The give-way, 0 to 12, with step 10's two halves apart). Each but
 * Search's puts what left the bar into the DM menu. Floor's name leaves
 * right after the Phase menu (`floorIcon`, docs/design/design-v1-floors.md
 * 18.6), its icon staying, and Floor folds with View. After step 12 a player's
 * inline "Your turn" drops while End turn shows, its live region kept, unseen
 * (design-v1-qol.md 4, The give-way, QD-OPUS-24 and 30). The speaker
 * folds right after View (`volumeFold`, D-261108-362), into the DM menu's
 * or the You menu's Volume, so View and Floor go before it and a fight's
 * turn name only after it. Last, where a blackout's crossed eye stands in
 * the DM chip's place, it slims to the dot's width (`eyeSlim`): it is 8 px
 * wider, and no other step makes up for it.
 */
export type WideStep =
  | "searchIcon"
  | "facesThree"
  | "clockOff"
  | "nowPlayingCompact"
  | "blackoutFold"
  | "dmDot"
  | "nowPlayingOff"
  | "fullscreenOff"
  | "phaseOff"
  | "floorIcon"
  | "facesNone"
  | "tightGaps"
  | "viewFold"
  | "volumeFold"
  | "turnName"
  | "timerShort"
  | "yourTurnOff"
  | "eyeSlim";

export const WIDE_STEPS: readonly WideStep[] = [
  "searchIcon",
  "facesThree",
  "clockOff",
  "nowPlayingCompact",
  "blackoutFold",
  "dmDot",
  "nowPlayingOff",
  "fullscreenOff",
  "phaseOff",
  "floorIcon",
  "facesNone",
  "tightGaps",
  "viewFold",
  "volumeFold",
  "turnName",
  "timerShort",
  "yourTurnOff",
  "eyeSlim",
];

/**
 * The steps below 900 px, in order (design-v1-qol.md 4, The give-way): the turn strip goes to the
 * band under the bar first. A phone's bar has no clock chip and no Phase
 * menu. The speaker folds right after View, as from 900 px up, and only
 * the DM's 320 px phone at 130% takes that step (docs/design/design-v1-volume.md
 * 10). The crossed eye's slimming comes last: a DM's 320 px phone at 130%
 * in a blackout with a long room name overflowed by 1 px with every other
 * step taken.
 */
export type NarrowStep = "band" | "blackoutFold" | "dmDot" | "searchPanels" | "nowPlayingOff" | "tightGaps" | "viewFold" | "volumeFold" | "eyeSlim";

export const NARROW_STEPS: readonly NarrowStep[] = ["band", "blackoutFold", "dmDot", "searchPanels", "nowPlayingOff", "tightGaps", "viewFold", "volumeFold", "eyeSlim"];

export type BarStep = WideStep | NarrowStep;

/**
 * What the bar holds, as far as its give-way goes: the parts it has, and
 * what the turn chip shows while the strip is in the row. `words` holds
 * everything else whose change moves a part's width (the room's name, a
 * chip's words, the phases' names, the turn chip's own content), so the
 * key changes with them.
 */
export type BarContent = {
  /** Below 900 px: the narrow list of steps. */
  phone: boolean;
  role: "dm" | "player" | null;
  search: boolean;
  /** The DM's Now playing chip shows: something plays, or its player is open. */
  nowPlaying: boolean;
  /** The clock's chip, from 900 px up. */
  clock: boolean;
  /** The DM's Players see black. */
  blackout: boolean;
  /** Full screen, from 900 px up where the browser can. */
  fullscreen: boolean;
  /** The DM's Phase menu, from 900 px up on a scene with phases. */
  phase: boolean;
  /** The gaps may tighten, once Isometric is offered. */
  gaps: boolean;
  /** The View button. */
  view: boolean;
  /**
   * This device's speaker (features/sound/device/Speaker.tsx): a DM's or a
   * player's bar once the role is known, not View as a player, whose
   * preview plays nothing. Its 44 px never change, so it adds no words.
   */
  volume: boolean;
  /** Floor: this device holds more than one floor of its scene (docs/design/design-v1-floors.md 7.2). */
  floor: boolean;
  /**
   * The turn strip in the row: none (no fight, or a portrait phone's
   * band), in the row from 900 px up, or on a short landscape phone in
   * the row until the band step moves it (band.ts turnPlaces).
   */
  strip: "none" | "bar" | "movable";
  /** The next faces the turn chip has to show: the DM's alone, 0 for a player. */
  faces: number;
  /** The turn timer has run out. */
  timerOver: boolean;
  /** A player's own turn, with "Your turn" in the chip. */
  yourTurn: boolean;
  words: readonly string[];
};

/** The content as one string: two bars with the same key and width show the same. */
export function fitKey(content: BarContent): string {
  return JSON.stringify(content);
}

/** The steps this content can take, in order: each changes what the bar draws. */
export function stepsFor(c: BarContent): BarStep[] {
  const dm = c.role === "dm";
  if (c.phone) {
    const narrow: Record<NarrowStep, boolean> = {
      band: c.strip === "movable",
      blackoutFold: dm && c.blackout,
      // The crossed eye already stands in the chip's place.
      dmDot: dm && !c.blackout,
      searchPanels: c.search,
      nowPlayingOff: dm && c.nowPlaying,
      tightGaps: c.gaps,
      // Floor folds with View, one step for one idea (D-261107-215).
      viewFold: c.view || c.floor,
      volumeFold: c.volume,
      eyeSlim: dm && c.blackout,
    };
    return NARROW_STEPS.filter((step) => narrow[step]);
  }
  const strip = c.strip !== "none";
  const wide: Record<WideStep, boolean> = {
    searchIcon: c.search,
    facesThree: strip && c.faces > STRIP_FACES_FEW,
    clockOff: c.clock,
    nowPlayingCompact: dm && c.nowPlaying,
    blackoutFold: dm && c.blackout,
    dmDot: dm && !c.blackout,
    nowPlayingOff: dm && c.nowPlaying,
    fullscreenOff: c.fullscreen,
    phaseOff: dm && c.phase,
    floorIcon: c.floor,
    facesNone: strip && c.faces > 0,
    tightGaps: c.gaps,
    viewFold: c.view || c.floor,
    volumeFold: c.volume,
    turnName: strip,
    timerShort: strip && c.timerOver,
    yourTurnOff: strip && c.yourTurn,
    eyeSlim: dm && c.blackout,
  };
  return WIDE_STEPS.filter((step) => wide[step]);
}

/**
 * The steps a bar has taken for its content: how many of stepsFor's, and
 * the row's width when last measured, in layout px. `nameCap` is the turn
 * chip's name's measured cap once step 11 is taken, 0 once the name has
 * left.
 */
export type FitRecord = { key: string; width: number; taken: number; nameCap: number | null };

/**
 * The row as measured, in layout px: its own width (clientWidth), what its
 * content overflows it by, and the turn chip's name as drawn, null while
 * it draws none.
 */
export type FitMeasure = { width: number; overflow: number; name: number | null };

/** A record for another content is no record: the bar draws the content's first shape then. */
function drawnFor(record: FitRecord | null, key: string): FitRecord | null {
  return record !== null && record.key === key ? record : null;
}

/** The name's cap: what it shows less what the row lacks, or 0 where that leaves under a few letters. */
function nameCapFor(m: FitMeasure): number {
  if (m.name === null) return 0;
  const cap = Math.floor(m.name - m.overflow);
  return cap >= STRIP_NAME_MIN_PX ? cap : 0;
}

/**
 * The bar's next record, from the one it is drawn with and the row as
 * measured then (design-v1-qol.md 4, C6). The steps start over whenever the content
 * changes (a new key) or the row is wider than when they were taken, so
 * the bar shows what a page opened now would: the fewest steps, in order,
 * with which the row fits. A narrower row keeps its steps and takes more,
 * since one that needed them before needs them still. Each call takes at
 * most one step: the bar is drawn again and measured before the next.
 *
 * The record keeps the width the row measured, never one passed down to
 * it, which can lag the row by a render: a step recorded with a width from
 * before a resize landed never came back (docs/design/design-v1-qol.md 4, C6).
 */
export function fitStep(record: FitRecord | null, key: string, m: FitMeasure, steps: readonly BarStep[]): FitRecord {
  const drawn = drawnFor(record, key);
  const fresh: FitRecord = { key, width: m.width, taken: 0, nameCap: null };
  if (drawn === null) return giveWay(fresh, m, steps);
  if (m.width > drawn.width) {
    // Measured with steps a wider row may not need: draw the first shape and measure again.
    return drawn.taken > 0 ? fresh : giveWay(fresh, m, steps);
  }
  return giveWay(m.width < drawn.width ? { ...drawn, width: m.width } : drawn, m, steps);
}

function giveWay(r: FitRecord, m: FitMeasure, steps: readonly BarStep[]): FitRecord {
  if (m.overflow <= 0) return r;
  // The name gives way by what the row lacks, and again where a pixel's rounding left the row short, until it fits or leaves.
  if (steps[r.taken - 1] === "turnName" && r.nameCap !== null && r.nameCap > 0) return { ...r, nameCap: nameCapFor(m) };
  const step = steps[r.taken];
  if (step === undefined) return r;
  return { ...r, taken: r.taken + 1, nameCap: step === "turnName" ? nameCapFor(m) : r.nameCap };
}

/** Two records alike, so a check that changes nothing draws nothing again. */
export function sameRecord(a: FitRecord | null, b: FitRecord | null): boolean {
  return a === b || (a !== null && b !== null && a.key === b.key && a.width === b.width && a.taken === b.taken && a.nameCap === b.nameCap);
}

/** What the bar draws: each part's form after the steps taken. */
export type BarShape = {
  /** The turn strip in the band under the bar, on a short landscape phone. */
  band: boolean;
  search: SearchForm | null;
  nowPlaying: NowPlayingForm | null;
  clock: boolean;
  /** Players see black as its own chip. */
  blackout: boolean;
  /** The crossed eye in the DM chip's place. */
  eye: boolean;
  /** The crossed eye at the dot's width, without its caret: the last step. */
  eyeSlim: boolean;
  /** The DM chip as its dot (or the eye). */
  dmDot: boolean;
  fullscreen: boolean;
  phase: boolean;
  /** The next faces the turn chip shows. */
  faces: number;
  tight: boolean;
  /** View, and Floor with it, folded into the Menu panel's rows. */
  viewFold: boolean;
  /** The speaker on the bar. Folded, the DM menu or the You menu holds its Volume. */
  volume: boolean;
  floor: FloorForm | null;
  /** The turn chip's name's cap, 0 once it has left, null before step 11. */
  nameCap: number | null;
  /** An overrun timer's short form, "+1:25". */
  timerShort: boolean;
  /** A player's inline "Your turn" shows. */
  yourTurn: boolean;
};

/** The bar's shape for its content, with the steps `record` has taken when it is this content's. */
export function shapeOf(c: BarContent, key: string, record: FitRecord | null): BarShape {
  const drawn = drawnFor(record, key);
  const steps = stepsFor(c);
  const taken = new Set(steps.slice(0, drawn?.taken ?? 0));
  const has = (step: BarStep) => taken.has(step);
  const faces = c.phone ? Math.min(c.faces, STRIP_FACES_FEW) : has("facesNone") ? 0 : Math.min(c.faces, has("facesThree") ? STRIP_FACES_FEW : STRIP_FACES);
  const nowPlaying: NowPlayingForm = has("nowPlayingOff") ? "off" : c.phone || has("nowPlayingCompact") ? "compact" : "full";
  return {
    band: has("band"),
    search: !c.search ? null : has("searchPanels") ? "panels" : c.phone || has("searchIcon") ? "icon" : "field",
    nowPlaying: c.nowPlaying ? nowPlaying : null,
    clock: c.clock && !has("clockOff"),
    blackout: c.blackout && !has("blackoutFold"),
    eye: has("blackoutFold"),
    eyeSlim: has("eyeSlim"),
    dmDot: has("dmDot") || has("blackoutFold"),
    fullscreen: c.fullscreen && !has("fullscreenOff"),
    phase: c.phase && !has("phaseOff"),
    faces,
    tight: has("tightGaps"),
    viewFold: has("viewFold"),
    volume: c.volume && !has("volumeFold"),
    floor: !c.floor ? null : has("viewFold") ? "menu" : c.phone || has("floorIcon") ? "icon" : "name",
    nameCap: has("turnName") ? (drawn?.nameCap ?? 0) : null,
    timerShort: has("timerShort"),
    yourTurn: c.yourTurn && !has("yourTurnOff"),
  };
}
