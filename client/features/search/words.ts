import type { Token } from "#shared/model.ts";
import type { SearchKind } from "./entry.ts";

/**
 * The room search's own words (docs/design/design-v1-qol.md 5, Matching and Words): the
 * synonyms a DM or player types for the app's words, the small words a
 * query may hold that need match nothing, and the words a row reads. They
 * are the same for both roles and name no entry, so this file ships to
 * every device. An entry's own other names and best bets are written on the
 * entry, so a DM entry's stay in the DM's chunk with it (design-v1-qol.md 5, Loading).
 */

/**
 * A typed word, folded (match.ts fold), and the phrases it may stand for,
 * each written as the app writes it. Every word of a phrase must match, as
 * a whole word or its start, on a title, another name or a value, never by
 * a typo and never where an entry lives: the prototype's "darkvision",
 * standing for "sight", found Start a fight by its where. "dv" stands for
 * "darkvision" and "darkvision" for nothing, so both find a Senses field
 * by its value (index.ts), which lists only the creatures that have it.
 */
export const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  hp: ["hit points", "health"],
  health: ["hit points"],
  heal: ["healing", "hit points"],
  healing: ["hit points"],
  dmg: ["damage"],
  damage: ["hit points"],
  init: ["initiative"],
  initiative: ["fight"],
  fight: ["combat", "initiative"],
  combat: ["fight", "initiative"],
  encounter: ["fight", "initiative"],
  conc: ["concentrating", "concentration"],
  concentration: ["concentrating"],
  fow: ["fog"],
  reveal: ["fog"],
  dark: ["darkness", "black out", "light level"],
  dv: ["darkvision"],
  music: ["sound", "playlist", "track"],
  song: ["music", "track"],
  songs: ["music", "tracks"],
  audio: ["sound"],
  sfx: ["effects"],
  rest: ["long rest", "short rest"],
  lr: ["long rest"],
  sr: ["short rest"],
  ac: ["armor class"],
  pp: ["passive perception"],
  cr: ["challenge rating"],
  aoe: ["area", "areas"],
  temp: ["temporary"],
  thp: ["temporary hp"],
  pc: ["character"],
  pcs: ["characters"],
  npc: ["token"],
  map: ["scene"],
  maps: ["scenes"],
  pause: ["black out"],
  break: ["black out"],
  blackout: ["black out"],
  invite: ["player link"],
  qr: ["player link"],
  tv: ["table display"],
  los: ["sight"],
  vision: ["sight"],
  adv: ["advantage"],
  dis: ["disadvantage"],
  roll: ["dice"],
  dice: ["roll"],
  clock: ["time"],
  date: ["time", "calendar"],
  calendar: ["time"],
  rain: ["weather"],
  snow: ["weather"],
  wind: ["weather"],
  creature: ["token", "monster"],
  speed: ["walk speed"],
  move: ["speed"],
  stats: ["stat block"],
  sheet: ["character", "stat block"],
  kick: ["remove"],
  bigger: ["interface size"],
  zoom: ["interface size"],
  volume: ["music", "effects"],
  mute: ["room sound"],
  hide: ["hidden"],
  invisible: ["hidden"],
  picture: ["image"],
  portrait: ["image"],
  theme: ["dark mode", "light mode"],
  help: ["guide"],
  chat: ["message"],
  measure: ["ruler"],
  distance: ["ruler"],
  exit: ["leave room"],
  quit: ["leave room"],
  safety: ["x card"],
  xcard: ["x card"],
  hex: ["grid shape"],
  statblock: ["stat block"],
  whisper: ["message"],
};

/** Words a query may hold that need match nothing (design-v1-qol.md 5, Matching). Where one does match, it counts as any word does. */
export const SMALL_WORDS: ReadonlySet<string> = new Set(["the", "a", "an", "of", "for", "my", "on", "in", "to", "and", "with"]);

/** What a row calls its kind, before where it lives: "Setting · Menu · Room settings · Combat". */
export const KIND_LABEL: Readonly<Record<SearchKind, string>> = {
  action: "Action",
  key: "Key",
  panel: "Panel",
  dice: "Dice",
  field: "Field",
  token: "Token",
  character: "Character",
  condition: "Condition",
  section: "Section",
  scene: "Scene",
  playlist: "Playlist",
  track: "Track",
  page: "Page",
  handout: "Handout",
  setting: "Setting",
  monster: "Monster",
};

/** A token's kind in its row, "Monster on Battle mat", as the Outliner words it (outliner/rows.ts). */
export const TOKEN_KIND_WORD: Readonly<Record<Token["kind"], string>> = { pc: "Character", npc: "NPC", monster: "Monster", object: "Object" };

/** The words the index writes into rows from the room (index.ts). The sheet's own words are lane S3's. */
export const ROW_WORDS = {
  /** A DM's hidden token, after its name. */
  hidden: "Hidden",
  /** A token's where: "Monster on Battle mat". */
  tokenOn: (kind: string, scene: string) => `${kind} on ${scene}`,
  /** A scene's where, while the DM looks at it. */
  youAreHere: "You are here",
  /** A scene's where, while the players are on it. */
  playersAreHere: "Players are here",
  /** A condition the selection lacks, and one it has. */
  addTo: (name: string) => `Add to ${name}`,
  removeFrom: (name: string) => `Remove from ${name}`,
  /** A key row's where: a tool's, and the rest. */
  toolbar: "Toolbar",
  shortcuts: "Shortcuts",
  /** A monster's where: "CR 1/4 · Fey (Goblinoid)". */
  monster: (cr: string, type: string) => `CR ${cr} · ${type}`,
  /** The room's own monster, after its CR and type. */
  roomMonster: "This room's own",
  /** A playlist's where. */
  tracks: (n: number) => (n === 1 ? "1 track" : `${n} tracks`),
  /** A handout's where: one showing now, and a document in the DM's library. */
  showing: "Showing",
  library: "Library",
  /** A dice formula's row, and its where. */
  roll: (formula: string) => `Roll ${formula}`,
  dice: "Dice",
  /** The Play row of a playlist. */
  play: (name: string) => `Play ${name}`,
  /** A page's where when it has no folder. */
  journal: "Journal",
  /** A field's value for HP: "24 of 24". */
  hpOf: (cur: number, max: number) => `${cur} of ${max}`,
} as const;
