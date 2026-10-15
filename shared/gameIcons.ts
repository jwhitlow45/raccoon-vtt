/**
 * Written by `node scripts/game-icons.ts`. Do not edit by hand.
 *
 * The token icons from game-icons.net (docs/design-v1-dm-tools.md 3.12):
 * where the app serves them, and each author with their license and how
 * many of their icons ship. The icons themselves and their index are files
 * under public/, fetched only when shown, so this module stays small.
 */

export type GameIconAuthor = { id: string; name: string; url?: string; license: "CC-BY-3.0" | "CC0-1.0"; icons: number };

/** The served folder, named by the first 8 characters of the pinned commit so a new pin never meets an old cached file. */
export const GAME_ICONS_DIR = "/game-icons/82d94881";

export const GAME_ICONS_TOTAL = 4180;

export const GAME_ICON_AUTHORS: readonly GameIconAuthor[] = [
  { id: "andymeneely", name: "Andy Meneely", url: "http://www.se.rit.edu/~andy/", license: "CC-BY-3.0", icons: 2 },
  { id: "aussiesim", name: "Aussiesim", license: "CC-BY-3.0", icons: 52 },
  { id: "carl-olsen", name: "Carl Olsen", url: "https://twitter.com/unstoppableCarl", license: "CC-BY-3.0", icons: 6 },
  { id: "caro-asercion", name: "Caro Asercion", license: "CC-BY-3.0", icons: 127 },
  { id: "cathelineau", name: "Cathelineau", license: "CC-BY-3.0", icons: 29 },
  { id: "catsu", name: "Catsu", license: "CC-BY-3.0", icons: 1 },
  { id: "darkzaitzev", name: "DarkZaitzev", url: "http://darkzaitzev.deviantart.com", license: "CC-BY-3.0", icons: 32 },
  { id: "delapouite", name: "Delapouite", url: "http://delapouite.com", license: "CC-BY-3.0", icons: 2022 },
  { id: "faithtoken", name: "Faithtoken", url: "http://fungustoken.deviantart.com", license: "CC-BY-3.0", icons: 10 },
  { id: "felbrigg", name: "Felbrigg", url: "http://blackdogofdoom.blogspot.co.uk", license: "CC-BY-3.0", icons: 5 },
  { id: "generalace135", name: "GeneralAce135", license: "CC-BY-3.0", icons: 2 },
  { id: "guard13007", name: "Guard13007", url: "https://guard13007.com", license: "CC-BY-3.0", icons: 3 },
  { id: "heavenly-dog", name: "HeavenlyDog", url: "http://www.gnomosygoblins.blogspot.com", license: "CC-BY-3.0", icons: 2 },
  { id: "irongamer", name: "Irongamer", url: "http://ecesisllc.wix.com/home", license: "CC-BY-3.0", icons: 1 },
  { id: "john-colburn", name: "John Colburn", url: "http://ninmunanmu.com", license: "CC-BY-3.0", icons: 1 },
  { id: "john-redman", name: "John Redman", url: "http://www.uniquedicetowers.com", license: "CC-BY-3.0", icons: 3 },
  { id: "kier-heyl", name: "Kier Heyl", license: "CC-BY-3.0", icons: 3 },
  { id: "lorc", name: "Lorc", url: "http://lorcblog.blogspot.com", license: "CC-BY-3.0", icons: 1429 },
  { id: "lord-berandas", name: "Lord Berandas", url: "http://berandas.deviantart.com", license: "CC-BY-3.0", icons: 10 },
  { id: "lucasms", name: "Lucas", license: "CC-BY-3.0", icons: 5 },
  { id: "pepijn-poolman", name: "Pepijn Poolman", license: "CC-BY-3.0", icons: 1 },
  { id: "pierre-leducq", name: "Pierre Leducq", license: "CC-BY-3.0", icons: 3 },
  { id: "priorblue", name: "PriorBlue", license: "CC-BY-3.0", icons: 7 },
  { id: "quoting", name: "Quoting", license: "CC-BY-3.0", icons: 12 },
  { id: "rihlsul", name: "Rihlsul", license: "CC-BY-3.0", icons: 3 },
  { id: "sbed", name: "Sbed", url: "http://opengameart.org/content/95-game-icons", license: "CC-BY-3.0", icons: 95 },
  { id: "seregacthtuf", name: "SeregaCthtuf", license: "CC-BY-3.0", icons: 5 },
  { id: "skoll", name: "Skoll", license: "CC-BY-3.0", icons: 172 },
  { id: "sparker", name: "Sparker", url: "http://citizenparker.com", license: "CC-BY-3.0", icons: 1 },
  { id: "spencerdub", name: "SpencerDub", license: "CC-BY-3.0", icons: 1 },
  { id: "starseeker", name: "Starseeker", license: "CC-BY-3.0", icons: 1 },
  { id: "various-artists", name: "Various artists", license: "CC0-1.0", icons: 2 },
  { id: "viscious-speed", name: "Viscious Speed", url: "http://viscious-speed.deviantart.com", license: "CC0-1.0", icons: 121 },
  { id: "willdabeast", name: "Willdabeast", url: "http://wjbstories.blogspot.com", license: "CC-BY-3.0", icons: 7 },
  { id: "zajkonur", name: "Zajkonur", license: "CC-BY-3.0", icons: 2 },
  { id: "zeromancer", name: "Zeromancer", license: "CC0-1.0", icons: 2 },
];
