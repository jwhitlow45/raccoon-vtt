/**
 * The top bar's parts and the order it gives way in (designs/qol plan.md
 * 4, chips.md 5). Declared first by lane Q0, so the lanes that add a part,
 * Search (S3) and Now playing (SL-C), and the lane that writes the rule
 * over them (QC-B) read one list. The rule itself, pure, is QC-B's, and
 * its randomized test stands in for Search and Now playing until they land.
 */

/**
 * Every part, in its place from left to right. `you` is the DM chip or a
 * player's chip, `blackout` the DM's Players see black, `gap` the room
 * the row keeps between its two ends, and `turn` the turn chip with Next
 * or End turn.
 */
export type TopBarPart =
  | "dot"
  | "name"
  | "you"
  | "blackout"
  | "search"
  | "gap"
  | "nowPlaying"
  | "clock"
  | "undo"
  | "redo"
  | "phase"
  | "turn"
  | "find"
  | "view"
  | "fit"
  | "fullscreen";

export const TOP_BAR_ORDER: readonly TopBarPart[] = ["dot", "name", "you", "blackout", "search", "gap", "nowPlaying", "clock", "undo", "redo", "phase", "turn", "find", "view", "fit", "fullscreen"];

/**
 * Search's forms (search.md 5.1): the field-like button with its words and
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
 * The steps from 900 px up, in the order the bar takes them (chips.md 5,
 * 0 to 12, with step 10's two halves apart). Each but Search's puts what
 * left the bar into the DM menu.
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
  | "facesNone"
  | "tightGaps"
  | "viewFold"
  | "turnName"
  | "timerShort";

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
  "facesNone",
  "tightGaps",
  "viewFold",
  "turnName",
  "timerShort",
];

/** The steps below 900 px, in order (plan.md 4): the turn strip goes to the band under the bar first. A phone's bar has no clock chip and no Phase menu. */
export type NarrowStep = "band" | "blackoutFold" | "dmDot" | "searchPanels" | "nowPlayingOff" | "tightGaps" | "viewFold";

export const NARROW_STEPS: readonly NarrowStep[] = ["band", "blackoutFold", "dmDot", "searchPanels", "nowPlayingOff", "tightGaps", "viewFold"];
