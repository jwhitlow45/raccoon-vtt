import { MOVING_PLAYERS } from "../features/scenes/movePlayers.ts";

/**
 * The words of the top bar's chips and their menus (designs/qol/chips.md
 * 7, with plan.md 9's whole-document showings), keyed, so the menus (lane
 * QC-A), the search's rows for menu items (S2) and the tests read the same
 * text. Declared first by lane Q0. A word with a name, a title or a scene
 * in it takes it as an argument.
 */

/**
 * Each kind of item the DM menu and the Blackout menu hold (chips.md 4,
 * C1 and C2). The search pairs each kind with its twin, the panel control
 * that does the same (search.md 5.5). Time and Now playing stand in for
 * the bar's chips that gave way, and the search leaves them out.
 */
export type DmItemKind =
  | "hideHandout"
  | "showRecent"
  | "showHandout"
  | "blackout"
  | "follow"
  | "bringEveryone"
  | "movePlayers"
  | "phase"
  | "viewAs"
  | "time"
  | "nowPlaying"
  | "endBlackout"
  | "showPlayers";

/** The DM menu's sections in order, each shown only while it holds something. During a blackout its two items lead, above a line. */
export type DmMenuSection = "handouts" | "screens" | "phase" | "preview" | "time" | "nowPlaying";

export const DM_MENU_SECTIONS: readonly DmMenuSection[] = ["handouts", "screens", "phase", "preview", "time", "nowPlaying"];

export const DM_MENU_HEADINGS: Readonly<Record<DmMenuSection, string>> = {
  handouts: "Handouts",
  screens: "Players' screens",
  phase: "Map phase",
  // The DM panel's group name after the polish pass (D-261106-077).
  preview: "Preview",
  time: "Time",
  nowPlaying: "Now playing",
};

/** Each fixed word, by its place. */
export const CHIP_WORDS = {
  dmChip: "DM",
  dmChipName: "DM options",
  dmDotDescription: "You are the DM",
  eyeName: "DM options. Players see black",
  dmMenuName: "DM",
  showing: "Showing",
  showHandout: "Show a handout…",
  blackout: "Black out players' screens",
  follow: "Follow me",
  bringEveryone: "Bring everyone here",
  bringEveryoneDone: "Players' maps moved to what you see now.",
  movePlayers: "Move players here",
  moveAnyway: "Move players anyway",
  showAnyway: "Show players anyway",
  cancel: "Cancel",
  moving: MOVING_PLAYERS,
  liftRefused: "Not shown: the players are on another scene now. The blackout stays on.",
  playersSeeBlack: "Players see black",
  blackoutMenuName: "Blackout",
  endBlackout: "End the blackout",
  endBlackoutDescription: "Players see the map again.",
  showPlayersDescription: "Moves the players here and ends the blackout in one step.",
  // The four steps are StepButtons' own (clock/words.ts STEPS and To dawn), which the popover reuses (chips.md C5).
  timeTitle: "Time",
  openTime: "Open Time",
  next: "Next",
  start: "Start",
  nextName: "Next turn",
  youMenuName: "You",
  xcard: "X-card…",
  handoutDialogTitle: "Show a handout",
  rememberedTitleHint: "This device keeps the title for the next time you show this image.",
  document: "Document",
} as const;

export type ChipWord = keyof typeof CHIP_WORDS;

export const hideTitle = (title: string) => `Hide ${title}`;
export const showTitle = (title: string) => `Show ${title}`;
export const showPlayers = (scene: string) => `Show players ${scene}`;
/** Move players here's detail, the scene the DM looks at. */
export const onScene = (scene: string) => `on ${scene}`;
/** Follow me's detail while the DM looks at another scene than the players, and its description. */
export const followOnly = (playersScene: string) => `only on ${playersScene}`;
export const followOnlyDescription = (playersScene: string) => `Players' maps follow yours only while you look at their scene, ${playersScene}.`;
/** A refused move, with the refusal's own sentence (reasonText). */
export const moveRefused = (reason: string) => `Players not moved. ${reason}`;
export const viewAs = (player: string) => `View as ${player}`;
export const youChipName = (name: string) => `You are ${name}. Your options`;
export const sheetOf = (character: string) => `${character}'s sheet`;

/** Names in a sentence: "Pat", "Pat and Ana", "Pat, Ana and Bree" (handouts.ts audienceText). */
function joined(names: readonly string[]): string {
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * A recent handout's detail by its audience: "to everyone", "to Pat", "to
 * Pat and Ana", or past two "to 3 players", whose description names them.
 * `names` are the players a re-show goes to, as recent.ts offers it.
 */
export function audienceDetail(names: "all" | readonly string[]): string {
  if (names === "all") return "to everyone";
  return names.length <= 2 ? `to ${joined(names)}` : `to ${names.length} players`;
}

/** The item's description: "Shows it to Pat again." */
export function audienceDescription(names: "all" | readonly string[]): string {
  return `Shows it to ${names === "all" ? "everyone" : joined(names)} again.`;
}

/** A recent showing's detail: its audience, after "Document" for a whole document (plan.md 9: a document has no page of its own). */
export function recentDetail(kind: "image" | "doc", names: "all" | readonly string[]): string {
  return kind === "doc" ? `${CHIP_WORDS.document} · ${audienceDetail(names)}` : audienceDetail(names);
}
