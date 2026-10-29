/**
 * Every third-party work the app ships or uses, for the About page.
 *
 * CREDITS.md carries the same list for people reading the repository, and
 * credits.test.ts fails when a file in public/textures, public/icons,
 * public/stamps, public/starter or public/fonts is missing from either one. The condition, status and damage icon
 * maps below also drive `node scripts/icons.ts effects` and `node scripts/icons.ts damage`, so the icon a key
 * uses and the credit shown for it cannot drift apart. Likewise each shipped
 * stamp names its source in shared/stamps.ts, which scripts/stamps.ts writes,
 * and its credit is found from that. The token icons in public/game-icons
 * are credited by author (TOKEN_ICONS below), and the test checks each file
 * against the index their build writes.
 *
 * No AI-generated art (design section 20). Apart from the raccoon icon, every
 * image here is existing work found under an open license, changed only
 * mechanically.
 */
import type { DamageType } from "./rules/damage.ts";
import type { ConditionKey, StatusKey } from "./model.ts";
import { GAME_ICON_AUTHORS, GAME_ICONS_DIR, GAME_ICONS_TOTAL, type GameIconAuthor } from "./gameIcons.ts";
import type { LicenseId } from "./licenses.ts";
import type { StarterWork } from "./starter.ts";
import { STARTER_PACKS } from "./starterArt.ts";
import { STAMP_ART } from "./stamps.ts";

export { LICENSES, type LicenseId } from "./licenses.ts";

export type Credit = {
  /**
   * What the credit covers. Paths starting with `public/` are served by the
   * app. Others are repository paths for data the server or rules use.
   */
  files: string[];
  title: string;
  author: string;
  authorUrl?: string;
  /** The page the work came from, where its license is stated. */
  source: string;
  license: LicenseId;
  /** What was changed from the original. CC BY asks for this. */
  changes: string;
};

export type CreditGroup = {
  id: "icons" | "interface-icons" | "font" | "textures" | "stamps" | "starter-packs" | "app-icon" | "srd" | "safety" | "passwords";
  heading: string;
  credits: Credit[];
};

/** One icon from game-icons.net. `slug` is `author-folder/icon-name`, as in its URL. */
export type GameIcon = { slug: string; title: string; author: string };

/** The game-icons.net commit the icon files were taken from. */
export const GAME_ICONS_COMMIT = "82d948812bfe3f269ef8f731dcdb07b08160edc4";

const GAME_ICON_AUTHOR_URLS: Record<string, string> = {
  Delapouite: "https://delapouite.com",
  Lorc: "https://lorcblog.blogspot.com",
  sbed: "http://opengameart.org/content/95-game-icons",
};

export const CONDITION_ICONS: Record<ConditionKey, GameIcon> = {
  blinded: { slug: "delapouite/blindfold", title: "Blindfold", author: "Delapouite" },
  charmed: { slug: "lorc/charm", title: "Charm", author: "Lorc" },
  deafened: { slug: "skoll/hearing-disabled", title: "Hearing disabled", author: "Skoll" },
  exhaustion: { slug: "delapouite/tired-eye", title: "Tired eye", author: "Delapouite" },
  frightened: { slug: "lorc/terror", title: "Terror", author: "Lorc" },
  grappled: { slug: "lorc/grab", title: "Grab", author: "Lorc" },
  incapacitated: { slug: "skoll/knockout", title: "Knockout", author: "Skoll" },
  invisible: { slug: "delapouite/invisible", title: "Invisible", author: "Delapouite" },
  paralyzed: { slug: "delapouite/frozen-body", title: "Frozen body", author: "Delapouite" },
  petrified: { slug: "delapouite/stone-bust", title: "Stone bust", author: "Delapouite" },
  poisoned: { slug: "lorc/poison-bottle", title: "Poison bottle", author: "Lorc" },
  prone: { slug: "sbed/falling", title: "Falling", author: "sbed" },
  restrained: { slug: "lorc/manacles", title: "Manacles", author: "Lorc" },
  stunned: { slug: "lorc/star-swirl", title: "Star swirl", author: "Lorc" },
  unconscious: { slug: "delapouite/night-sleep", title: "Night sleep", author: "Delapouite" },
};

export const STATUS_ICONS: Record<StatusKey, GameIcon> = {
  concentrating: { slug: "lorc/concentration-orb", title: "Concentration orb", author: "Lorc" },
  hidden: { slug: "lorc/hood", title: "Hood", author: "Lorc" },
  flying: { slug: "lorc/feathered-wing", title: "Feathered wing", author: "Lorc" },
  dodging: { slug: "lorc/dodging", title: "Dodging", author: "Lorc" },
  raging: { slug: "delapouite/angry-eyes", title: "Angry eyes", author: "Delapouite" },
  blessed: { slug: "lorc/spiked-halo", title: "Spike halo", author: "Lorc" },
  baned: { slug: "lorc/cursed-star", title: "Cursed star", author: "Lorc" },
  hasted: { slug: "lorc/sprint", title: "Sprint", author: "Lorc" },
  "hunters-mark": { slug: "lorc/target-arrows", title: "Target arrows", author: "Lorc" },
  hexed: { slug: "delapouite/warlock-eye", title: "Warlock eye", author: "Delapouite" },
  "heroic-inspiration": { slug: "lorc/laurels", title: "Laurels", author: "Lorc" },
  surprised: { slug: "lorc/surprised", title: "Surprised", author: "Lorc" },
  marked: { slug: "delapouite/human-target", title: "Human target", author: "Delapouite" },
  readied: { slug: "lorc/hourglass", title: "Hourglass", author: "Lorc" },
};

export const DAMAGE_ICONS: Record<DamageType | "untyped", GameIcon> = {
  acid: { slug: "lorc/acid-blob", title: "Acid blob", author: "Lorc" },
  bludgeoning: { slug: "lorc/flat-hammer", title: "Flat hammer", author: "Lorc" },
  cold: { slug: "lorc/snowflake-1", title: "Snowflake 1", author: "Lorc" },
  fire: { slug: "carl-olsen/flame", title: "Flame", author: "Carl Olsen" },
  force: { slug: "lorc/magic-swirl", title: "Magic swirl", author: "Lorc" },
  lightning: { slug: "sbed/electric", title: "Electric", author: "sbed" },
  necrotic: { slug: "sbed/death-skull", title: "Death skull", author: "sbed" },
  piercing: { slug: "lorc/arrowhead", title: "Arrowhead", author: "Lorc" },
  poison: { slug: "lorc/poison-bottle", title: "Poison bottle", author: "Lorc" },
  psychic: { slug: "lorc/brain", title: "Brain", author: "Lorc" },
  radiant: { slug: "lorc/sun", title: "Sun", author: "Lorc" },
  slashing: { slug: "lorc/sword-wound", title: "Sword wound", author: "Lorc" },
  thunder: { slug: "lorc/sonic-boom", title: "Sonic boom", author: "Lorc" },
  untyped: { slug: "lorc/impact-point", title: "Impact point", author: "Lorc" },
};

/**
 * The ISC license asks for its copyright and permission notice in every
 * copy, so the About page shows it whole, as CREDITS.md does.
 */
export const LUCIDE_NOTICE =
  "ISC License. Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022. Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies. THE SOFTWARE IS PROVIDED \"AS IS\" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.";

/**
 * The Lucide icons the app copies, by Lucide's own names, as the credit
 * lists them. client/components/Icon.tsx says which meaning draws each
 * (its LUCIDE table), and a test holds the two lists and CREDITS.md to
 * the same names, so a newly copied icon cannot ship uncredited.
 */
export const LUCIDE_ICONS = ["arrow-down", "arrow-left", "arrow-right", "arrow-up", "book-open", "brick-wall", "chevrons-down", "circle-user-round", "clipboard-list", "compass", "contact-round", "copy-plus", "crop", "crown", "download", "eraser", "external-link", "eye", "eye-off", "file-text", "focus", "footprints", "hash", "image", "info", "library", "lightbulb", "list-tree", "lock", "log-out", "map", "maximize-2", "menu", "minimize-2", "mountain", "notebook-text", "paintbrush", "paw-print", "pencil", "radar", "radius", "redo-2", "refresh-cw", "repeat", "scan-eye", "scroll-text", "settings", "share", "skull", "smartphone", "snail", "square-dashed", "stamp", "sticky-note", "swords", "timer", "trash-2", "type", "undo-2", "user-minus", "users", "zap", "zoom-in", "zoom-out"] as const;

export type LucideIcon = (typeof LUCIDE_ICONS)[number];

/**
 * The copied icons Lucide derives from Feather, which its license credits
 * to Feather under MIT. MIT asks for its notice in every copy, so the
 * About page shows it whole beside the ISC one, as CREDITS.md does.
 */
export const FEATHER_ICONS = ["arrow-down", "arrow-left", "arrow-right", "arrow-up", "chevrons-down", "compass", "download", "external-link", "hash", "info", "lock", "log-out", "minimize-2", "share", "smartphone", "trash-2", "type", "zoom-in", "zoom-out"] as const satisfies readonly LucideIcon[];

export const FEATHER_NOTICE =
  "The MIT License (MIT). Copyright (c) 2013-present Cole Bemis. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.";

export const GAME_ICON_CHANGES = "Black background square removed, fill set to currentColor so the app can tint it.";

/**
 * The token icons (docs/design-v1-dm-tools.md 3.12): all 4,180 icons of the
 * pinned commit, credited by author rather than by file, since 4,180 rows
 * would bury every other credit. The index the build writes beside them
 * lists every file with its author, and so its license. The author table
 * comes from shared/gameIcons.ts, which the same build writes from the
 * repository's license.txt.
 */
export const TOKEN_ICONS: {
  heading: string;
  site: string;
  repository: string;
  commit: string;
  /** The generated list of every file, as a repository path. */
  index: string;
  total: number;
  changes: string;
  /** Named first in the mention the site asks for, "Icons made by {author}": the set's founder, then its largest contributor. */
  leadAuthors: readonly string[];
  authors: readonly GameIconAuthor[];
} = {
  heading: "Token icons",
  site: "https://game-icons.net",
  repository: "https://github.com/game-icons/icons",
  commit: GAME_ICONS_COMMIT,
  index: `public${GAME_ICONS_DIR}/index.json`,
  total: GAME_ICONS_TOTAL,
  changes: "Black background square removed.",
  leadAuthors: ["lorc", "delapouite"],
  authors: GAME_ICON_AUTHORS,
};

function gameIconCredit(dir: "conditions" | "statuses" | "damage", key: string, icon: GameIcon): Credit {
  const authorUrl = GAME_ICON_AUTHOR_URLS[icon.author];
  return {
    files: [`public/icons/${dir}/${key}.svg`],
    title: icon.title,
    author: icon.author,
    ...(authorUrl ? { authorUrl } : {}),
    source: `https://game-icons.net/1x1/${icon.slug}.html`,
    license: "CC-BY-3.0",
    changes: GAME_ICON_CHANGES,
  };
}

const TEXTURE_CHANGES = "Downscaled to 256 x 256 with wraparound edges so it still tiles, converted to WebP.";

/**
 * One source of the map stamps (design addendum section 3.5): a pack of
 * sprites or one 3D model, credited once for every stamp taken from it.
 */
export type StampSource = Omit<Credit, "files">;

/** The wording the design asks for, so the About page says exactly what changed. */
export const STAMP_CROPPED = "Cropped and converted to WebP.";
export const STAMP_RENDERED = "Rendered from above and converted to WebP.";

/** The attribution both Liosan packs ask for, with who submitted them. */
const WARLOCKS_GAUNTLET = "Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan";

function polyHavenModel(id: string, title: string, author: string): StampSource {
  return { title, author, source: `https://polyhaven.com/a/${id}`, license: "CC0-1.0", changes: STAMP_RENDERED };
}

/**
 * Keyed by the source's own name for it: the OpenGameArt page's slug, or the
 * Poly Haven asset ID. The authors of each model come from Poly Haven's asset
 * data, and Poly Haven states its CC0 license at https://polyhaven.com/license.
 */
export const STAMP_SOURCES = {
  "trees-top-down-fake-shadow": {
    title: "Trees Top-down fake shadow",
    author: "Prime_8",
    source: "https://opengameart.org/content/trees-top-down-fake-shadow",
    license: "CC0-1.0",
    changes: STAMP_CROPPED,
  },
  "simple-stones": {
    title: "Simple stones",
    author: "Prime_8",
    source: "https://opengameart.org/content/simple-stones",
    license: "CC0-1.0",
    changes: STAMP_CROPPED,
  },
  "top-down-foliage-collection": {
    title: "Top down foliage collection",
    author: WARLOCKS_GAUNTLET,
    source: "https://opengameart.org/content/top-down-foliage-collection",
    license: "CC-BY-3.0",
    changes: STAMP_CROPPED,
  },
  "top-down-village-elements": {
    title: "Top down village elements",
    author: WARLOCKS_GAUNTLET,
    source: "https://opengameart.org/content/top-down-village-elements",
    license: "CC-BY-3.0",
    changes: STAMP_CROPPED,
  },
  wine_barrel_01: polyHavenModel("wine_barrel_01", "Wine Barrel 01", "James Ray Cock"),
  treasure_chest: polyHavenModel("treasure_chest", "Treasure Chest", "Rico Cilliers"),
  wooden_crate_01: polyHavenModel("wooden_crate_01", "Wooden Crate 01", "James Ray Cock"),
  WoodenTable_01: polyHavenModel("WoodenTable_01", "Wooden Table 01", "Ethan Place"),
  round_wooden_table_01: polyHavenModel("round_wooden_table_01", "Round Wooden Table 01", "Ulan Cabanilla"),
  GothicBed_01: polyHavenModel("GothicBed_01", "Gothic Bed 01", "Kirill Sannikov"),
  wooden_bookshelf_worn: polyHavenModel("wooden_bookshelf_worn", "Wooden Bookshelf Worn", "Ulan Cabanilla"),
  stone_fire_pit: polyHavenModel("stone_fire_pit", "Stone Fire Pit", "Sebastian Platen"),
  rock_moss_set_01: polyHavenModel("rock_moss_set_01", "Rock Moss Set 01", "Kless Gyzen"),
  namaqualand_boulders_01: polyHavenModel(
    "namaqualand_boulders_01",
    "Namaqualand Boulders 01",
    "Greg Zaal (photography) and Jenelle van Heerden (modeling)",
  ),
  fir_sapling: polyHavenModel("fir_sapling", "Fir Sapling", "Rob Tuytel (photography) and Rico Cilliers (modeling)"),
} satisfies Record<string, StampSource>;

export type StampSourceId = keyof typeof STAMP_SOURCES;

function stampCredits(): Credit[] {
  return (Object.entries(STAMP_SOURCES) as [StampSourceId, StampSource][]).map(([id, source]) => ({
    ...source,
    files: STAMP_ART.filter((stamp) => stamp.source === id).map((stamp) => `public/stamps/${stamp.key}.webp`),
  }));
}

/**
 * The starter packs (docs/design-v1-starter-art.md 9), credited from their
 * catalog, which scripts/starter-art.ts writes with CREDITS.md's section.
 * One credit per page a license is stated on: a pack published on one page
 * is one credit, and a pack whose works each have a page of their own (a
 * Dyson Logos map's post, a museum's object, a Poly Haven model) is one per
 * work, so every credit links the page its license is on.
 */
function starterCredits(): Credit[] {
  const credits: Credit[] = [];
  for (const pack of STARTER_PACKS) {
    const pages = new Map<string, StarterWork[]>();
    for (const work of pack.works) {
      const page = `${work.credit.source} ${work.credit.license}`;
      const works = pages.get(page);
      if (works) works.push(work);
      else pages.set(page, [work]);
    }
    for (const works of pages.values()) {
      const first = works[0];
      if (!first) continue;
      const one = works.length === 1;
      const authors = new Set(works.map((w) => w.credit.author));
      credits.push({
        files: works.flatMap((w) => [w.file, ...(w.thumb && w.thumb !== w.file ? [w.thumb] : [])]).map((file) => `public${file}`),
        title: one ? first.credit.title : (collectionTitle(works) ?? pack.title),
        author: authors.size === 1 ? first.credit.author : pack.author,
        ...(pack.authorUrl ? { authorUrl: pack.authorUrl } : {}),
        source: first.credit.source,
        license: first.credit.license,
        changes: one ? first.credit.changes : pack.changes,
      });
    }
  }
  return credits;
}

/** What a page's works are part of, when each one's title names it: "hero_artificer, from Cute Heroes" is from "Cute Heroes". */
function collectionTitle(works: readonly StarterWork[]): string | null {
  const parts = works.map((w) => /, from (.+)$/.exec(w.credit.title)?.[1]);
  const first = parts[0];
  return first !== undefined && parts.every((p) => p === first) ? first : null;
}

export const CREDITS: CreditGroup[] = [
  {
    id: "icons",
    heading: "Condition, status and damage icons",
    credits: [
      ...Object.entries(CONDITION_ICONS).map(([key, icon]) => gameIconCredit("conditions", key, icon)),
      ...Object.entries(STATUS_ICONS).map(([key, icon]) => gameIconCredit("statuses", key, icon)),
      ...Object.entries(DAMAGE_ICONS).map(([key, icon]) => gameIconCredit("damage", key, icon)),
    ],
  },
  {
    id: "interface-icons",
    heading: "Interface icons",
    credits: [
      {
        // Path data copied into the app's own icon component, never the package (docs/design-v1-icons.md 6).
        files: ["client/components/Icon.tsx"],
        title: "Lucide",
        author: "Lucide Contributors, with portions by Cole Bemis as part of Feather (MIT)",
        authorUrl: "https://lucide.dev",
        source: "https://github.com/lucide-icons/lucide",
        license: "ISC",
        changes: `The interface icons marked Lucide in client/components/Icon.tsx (${LUCIDE_ICONS.join(", ")}), their path data copied as written. ${LUCIDE_NOTICE} Of these, ${FEATHER_ICONS.join(", ")} are derived from Feather: ${FEATHER_NOTICE}`,
      },
    ],
  },
  {
    id: "font",
    heading: "Interface font",
    credits: [
      {
        // The release client/lib/interFont.ts pins, whose test holds this title to it.
        files: ["public/fonts/InterVariable-8a540aa8.woff2", "public/fonts/InterVariable-Italic-7e4680fd.woff2", "public/fonts/Inter-LICENSE.txt"],
        title: "Inter 4.1",
        author: "The Inter Project Authors",
        authorUrl: "https://rsms.me/inter/",
        source: "https://github.com/rsms/inter",
        license: "OFL-1.1",
        changes: "The variable roman and italic fonts, subset to Latin characters and converted to WOFF2 by scripts/inter.ts. Copyright (c) 2016 The Inter Project Authors. The license's full text ships beside the fonts in public/fonts/Inter-LICENSE.txt and is in CREDITS.md.",
      },
    ],
  },
  {
    id: "textures",
    heading: "Map builder textures",
    credits: [
      {
        files: ["public/textures/stone.webp"],
        title: "Grey Stone Path",
        author: "Amal Kumar",
        source: "https://polyhaven.com/a/grey_stone_path",
        license: "CC0-1.0",
        changes: TEXTURE_CHANGES,
      },
      {
        files: ["public/textures/wood.webp"],
        title: "Wood Planks",
        author: "Amal Kumar",
        source: "https://polyhaven.com/a/wood_planks",
        license: "CC0-1.0",
        changes: TEXTURE_CHANGES,
      },
      {
        files: ["public/textures/grass.webp"],
        title: "Grass 001",
        author: "Lennart Demes (ambientCG)",
        authorUrl: "https://ambientcg.com",
        source: "https://ambientcg.com/view?id=Grass001",
        license: "CC0-1.0",
        changes: TEXTURE_CHANGES,
      },
      {
        files: ["public/textures/dirt.webp"],
        title: "Brown Mud Dry",
        author: "Rob Tuytel",
        source: "https://polyhaven.com/a/brown_mud_dry",
        license: "CC0-1.0",
        changes: TEXTURE_CHANGES,
      },
      {
        files: ["public/textures/cave.webp"],
        title: "Rock Ground",
        author: "Rob Tuytel",
        source: "https://polyhaven.com/a/rock_ground",
        license: "CC0-1.0",
        changes: TEXTURE_CHANGES,
      },
      {
        files: ["public/textures/water.webp"],
        title: "Liquid_Blue_02, from Mini Texture Pack 3: Liquids",
        author: "Screaming Brain Studios",
        authorUrl: "https://screamingbrainstudios.itch.io",
        source: "https://opengameart.org/content/140-liquid-textures",
        license: "CC0-1.0",
        changes: "Converted to WebP from the pack's 256 x 256 PNG.",
      },
      {
        files: ["public/textures/difficult.webp"],
        title: "Forest Leaves 02",
        author: "Rob Tuytel",
        source: "https://polyhaven.com/a/forest_leaves_02",
        license: "CC0-1.0",
        changes: TEXTURE_CHANGES,
      },
      {
        files: ["public/textures/rubble.webp"],
        title: "Gray Rocks",
        author: "Dimitrios Savva",
        source: "https://polyhaven.com/a/gray_rocks",
        license: "CC0-1.0",
        changes: TEXTURE_CHANGES,
      },
    ],
  },
  { id: "stamps", heading: "Map stamps", credits: stampCredits() },
  { id: "starter-packs", heading: "Starter packs", credits: starterCredits() },
  {
    id: "app-icon",
    heading: "App icon",
    credits: [
      {
        files: [
          "public/icon.svg",
          "public/icons/app-192.png",
          "public/icons/app-512.png",
          "public/icons/app-maskable-512.png",
          "public/icons/apple-touch-icon-180.png",
        ],
        title: "RaccoonVTT icon",
        author: "RaccoonVTT",
        source: "public/icon.svg",
        license: "original",
        changes: "Drawn as an SVG after the party's crest, on the iOS app icon shape. The PNGs are rasterized from it by scripts/icons.ts.",
      },
    ],
  },
  {
    id: "srd",
    heading: "Rules content",
    credits: [
      {
        files: ["shared/srd/"],
        title: "System Reference Document 5.2.1",
        author: "Wizards of the Coast LLC",
        source: "https://www.dndbeyond.com/srd",
        license: "CC-BY-4.0",
        changes:
          "Condition text, monster stat blocks, area spells and names for the passphrase word list, converted to JSON and edited. The full notice is in shared/srd/NOTICE.md.",
      },
    ],
  },
  {
    id: "safety",
    heading: "Safety tools",
    credits: [
      {
        // The card's idea, not its text: the app's words are its own (docs/design-v1-dm-tools.md 3.11).
        files: ["client/features/xcard/"],
        title: "X-Card",
        author: "John Stavropoulos",
        // The link the card's text asks for, over https.
        source: "https://tinyurl.com/x-card-rpg",
        license: "CC-BY-SA-3.0",
        changes: "The X-card in the Menu follows the card's idea in RaccoonVTT's own words: anyone taps it to have what just happened edited out, with no explanation and no name on it.",
      },
    ],
  },
  {
    id: "passwords",
    heading: "Common-password list",
    credits: [
      {
        files: ["server/auth/common-passwords.txt"],
        title: "SecLists",
        author: "Daniel Miessler and the SecLists contributors",
        source: "https://github.com/danielmiessler/SecLists",
        license: "MIT",
        changes:
          "The 10,000 most common passwords, used to refuse weak room passwords. Copyright (c) 2018 Daniel Miessler. The full license text is in CREDITS.md.",
      },
    ],
  },
];
