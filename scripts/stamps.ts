/**
 * Builds the map builder's stamps in public/stamps/ and their catalog in
 * shared/stamps.ts (docs/design-v1-maps-vision.md section 3.5). Run by hand
 * when the set changes:
 *
 *   node scripts/stamps.ts [--cache <dir>]
 *
 * Each original is fetched from where its author published it and checked
 * against a pinned SHA-256, so a changed upstream file fails loudly instead of
 * slipping different art into the app. Downloads are untrusted data. They are
 * kept in a cache directory of their own, named by their hash, so a second run
 * fetches nothing, and nothing in it is ever run. Archives are read one named
 * entry at a time into memory, never unpacked onto disk.
 *
 * Two kinds of art, in the Prime_8 look the design chose (question 6):
 *
 * - Sprites from four OpenGameArt packs, taken by name and cropped to the art.
 *   Each one's footprint in cells is set by hand below.
 * - Poly Haven's CC0 models, rendered straight down by three.js in headless
 *   Chrome under a fixed light, with a soft shadow baked under them like
 *   Prime_8's. Each one is drawn at its true size, centered in a footprint
 *   of its size rounded up to the next quarter cell.
 *
 * Every image is centered in a canvas of its footprint's shape, so the client
 * can draw a stamp into its footprint without stretching it. The outputs are
 * committed: a later run need not match them bit for bit, and a re-render that
 * changes a pixel is reviewed like any other image change.
 *
 * shared/credits.ts and CREDITS.md credit each source. No AI-generated art.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parseArgs, promisify } from "node:util";
import { path7za } from "7zip-bin";
import { chromium, type Browser, type Page } from "playwright-core";
import sharp from "sharp";
import yauzl from "yauzl";
import type { StampSourceId } from "../shared/credits.ts";

const ROOT = join(import.meta.dirname, "..");
const OUT_DIR = join(ROOT, "public", "stamps");
const CATALOG = join(ROOT, "shared", "stamps.ts");
const THREE_DIR = join(ROOT, "node_modules", "three");

/** The client draws `/stamps/<key>.webp`, so a key is a slug, never a path (design 3.5). */
const KEY = /^[a-z0-9-]{1,40}$/;

/** The design's cap on a stamp image's long side. */
const MAX_PX = 512;

// ---------------------------------------------------------------------------
// Sprites

/** A sprite taken by name from a pack, with its footprint in cells set by hand. */
type Sprite = { key: string; name: string; file: string; sha256: string; w: number; h: number };

/**
 * A pack is one archive with its own pin, or loose files published one by one
 * on the pack's page (the village pack has no archive). Either way each sprite
 * taken from it is pinned too.
 */
type Pack = {
  source: StampSourceId;
  from: { archive: "7z" | "zip"; url: string; sha256: string } | { files: string };
  sprites: Sprite[];
};

const OGA = "https://opengameart.org/sites/default/files/";

/**
 * The footprints keep each pack's own scale where it has one. Prime_8 drew
 * every tree on a 192 px canvas, the larger ones about 2 cells across and the
 * small ones about 1.5. The village elements and bushes are about 64 px a cell,
 * so a bonfire's stone ring is one cell.
 */
const PRIME8_TREES: Pack = {
  source: "trees-top-down-fake-shadow",
  from: {
    archive: "7z",
    url: `${OGA}trees_192rez_topDown_png.7z`,
    sha256: "1969f976b8fe6843035a82f2c412b4e0c717df67d6b1254b9a36573401cc245f",
  },
  sprites: [
    { key: "tree-1", name: "Tree 1", file: "RE_00.png", sha256: "555ee172b3107e661c8c2fb1bd80190961e1c842fb152f00c52b7c63c43b0cb7", w: 2, h: 2 },
    { key: "tree-2", name: "Tree 2", file: "RE_01.png", sha256: "eab08d38f2ff2f06d38a5e23c170d4eadb00333f0bac485b2c0de712eda2ab9e", w: 2, h: 1.75 },
    { key: "tree-3", name: "Tree 3", file: "RE_02.png", sha256: "602463639ce7445942b264417e6d72129256fa3139435d5f6f5ebf7cfa51af55", w: 2, h: 2 },
    { key: "tree-4", name: "Tree 4", file: "RE_03.png", sha256: "0d10090f357d8377e640fb855997937d53cf40a5ef98e42cd99882ca8276a527", w: 2, h: 2 },
    { key: "tree-5", name: "Tree 5", file: "RE_04.png", sha256: "98f3943f4c1e788133007c1ded8c8f72b6cf57b88993a256acb22b18108797b7", w: 1.5, h: 1.5 },
    { key: "tree-6", name: "Tree 6", file: "RE_05.png", sha256: "b5cd9cb37685371bda83253f6d3dced70ff0a8dfb70cef637aebd2091a8434ee", w: 2, h: 2 },
    { key: "tree-7", name: "Tree 7", file: "RE_06.png", sha256: "10eefd87f65f025186c2133230926f690a0842289a16beb54d0d307b2118b4db", w: 2, h: 2 },
    { key: "tree-8", name: "Tree 8", file: "RE_07.png", sha256: "6daf3d67ea394dcfbe0c0e4ba466a46ed2c0a30ece2a4ba74715cfa34d508368", w: 2, h: 2 },
    { key: "tree-9", name: "Tree 9", file: "RE_08.png", sha256: "a33c3d1c41398f12896b33b9b270ba2b29531cdf18a7c9422e9650c109173c14", w: 2, h: 2 },
    { key: "tree-10", name: "Tree 10", file: "RE_12.png", sha256: "fbcd16a9862cb4fd03c57034111ba8f64bf50990fd0de600e21157d02fb4342f", w: 2, h: 2 },
  ],
};

const PRIME8_STONES: Pack = {
  source: "simple-stones",
  from: { archive: "zip", url: `${OGA}SM_set.zip`, sha256: "f11ad0eef9c1da438fda356f6f110d8deba75feaa31a23c46a57a102ebfd1096" },
  sprites: [
    { key: "rock-1", name: "Rock 1", file: "SM_set/SM_001.png", sha256: "9be094ae7a715b2c35e21bc0f79bd48b4193cb0fdba242b035bc5d60318dd287", w: 1, h: 1 },
    { key: "rock-2", name: "Rock 2", file: "SM_set/SM_002.png", sha256: "c5ce4fa2426512f3149785dc6040e7efb541eede68e9627c3fd2b3349c5b251e", w: 1, h: 1 },
    { key: "rock-3", name: "Rock 3", file: "SM_set/SM_003.png", sha256: "ca9924bc265f6db3be7b9536383971225322917554feeda6f0ed077c8604bee2", w: 0.75, h: 1 },
    { key: "rock-4", name: "Rock 4", file: "SM_set/SM_004.png", sha256: "fc343d483303a6447d3da2e14c759f4c1a4df5a0fbd9f606bb0f9894df1036db", w: 1, h: 1 },
    { key: "rock-5", name: "Rock 5", file: "SM_set/SM_005.png", sha256: "223ed0eb32cd57299a7a12e3a2dda83e56eb24f058315f5c55881c1b93e3844e", w: 1, h: 0.75 },
    { key: "rock-6", name: "Rock 6", file: "SM_set/SM_009.png", sha256: "bbfcc998844abd10ed2b09e84267f883c21abcbd4fb8fe65a905d7d63391533b", w: 0.5, h: 0.5 },
    { key: "rocks-1", name: "Rocks 1", file: "SM_set/SM_007.png", sha256: "f3048a099f991dc521928811150aa219d282feb57c863abd982db221cb2d9507", w: 0.75, h: 0.75 },
    { key: "rocks-2", name: "Rocks 2", file: "SM_set/SM_013.png", sha256: "6c4f0a52bd3e99c1d37626004c4933c4789a6ef362ed45eca6a51b46f87d0fc7", w: 0.75, h: 0.75 },
  ],
};

const LIOSAN_FOLIAGE: Pack = {
  source: "top-down-foliage-collection",
  from: { archive: "zip", url: `${OGA}foliage.zip`, sha256: "fec8786a545deca71d37a018157169d0908fd0b81f51b32591db9370dc0785de" },
  sprites: [
    { key: "bush-1", name: "Bush 1", file: "foliage1.png", sha256: "4af856c49c9280f59a032d7cd44dce7ce7ddf2a6d01c0dd6c87dd5284ec341bf", w: 1, h: 1 },
    { key: "bush-2", name: "Bush 2", file: "foliage2_0.png", sha256: "298c724f1bfb91c4ec1723b2ecb1c5ec80f447c8d3ace081343889ba7e338290", w: 1, h: 1 },
    { key: "bush-3", name: "Bush 3", file: "foliage3_0.png", sha256: "2af796ed2a22215aabc28bfb5c39f51e02596235fabe80beb86ffafb5c052af4", w: 1, h: 1 },
    { key: "bush-4", name: "Bush 4", file: "foliage5.png", sha256: "17d1b5ee4214d8e4ee77b57a35fa6e482c041cb2890955d601a7e023af1c27df", w: 1, h: 1 },
    { key: "bush-5", name: "Bush 5", file: "foliage7.png", sha256: "a90162c00d17ecb45c383d83cf3d87e782e1f12f34861eff3f9a3ba3d1a1da17", w: 1, h: 1 },
    { key: "ferns-1", name: "Ferns 1", file: "foliage8.png", sha256: "aa04ebee4f148aeb4c03adc78976ca83177b6a6d3af7b243d40739f545470867", w: 2, h: 2 },
    { key: "ferns-2", name: "Ferns 2", file: "foliage9.png", sha256: "151ae9958f57c901ff571041ed219e00184acbaa5ccfdea82b3f0b64e9430bec", w: 2, h: 2 },
    { key: "spiky-plant", name: "Spiky plant", file: "tree-strange.png", sha256: "26cd1b02d8d592b91de9291a95e591ffdcb71e69afc3fa476a56e5ae107ed54b", w: 1.5, h: 1.5 },
  ],
};

const LIOSAN_VILLAGE: Pack = {
  source: "top-down-village-elements",
  from: { files: OGA },
  sprites: [
    { key: "campfire", name: "Campfire", file: "bonefire_four.png", sha256: "48bcc37579b66eb2bba5ec5c338b1b52ff9344bce1eeb1f6230deadcf8d82c67", w: 1, h: 1 },
    { key: "campfire-embers", name: "Campfire, embers", file: "bonefire_three.png", sha256: "8dca16278e5bc4689f2a0f8e707e1ab01c666bd591764dc1e2b9efc080919162", w: 1, h: 1 },
    { key: "campfire-ashes", name: "Campfire, ashes", file: "bonefire_five.png", sha256: "4aa134e2dfb42c5704898096d22783c8ec81937810fc82fde9d3e8772d4a7d59", w: 1, h: 1 },
    { key: "woodpile", name: "Woodpile", file: "wood_stack_one.png", sha256: "9fbb13c220910562af2171baec1adc746a19db0feefd8f7485a9b41c5217cd47", w: 1, h: 1 },
    { key: "woodpile-long", name: "Woodpile, long", file: "wood_stack_big.png", sha256: "33f67fd619d8cb0e297ee969cef69aad7c127894ce360c7ec92f8dbc212849d7", w: 2.25, h: 1 },
    { key: "wheel", name: "Broken wheel", file: "broken_wheel_1.png", sha256: "1be44f2e7db745b3b51473f06affc1faa7f39911ad7a5a93dccfacd4143a55e2", w: 0.5, h: 0.5 },
    { key: "bucket", name: "Bucket", file: "bucket.png", sha256: "d7a67ad5717a0739b31d8d1cf399fa31e555f2b9dfc27f2ef24c35e76600a14f", w: 0.5, h: 0.5 },
  ],
};

// ---------------------------------------------------------------------------
// Poly Haven models

/**
 * A model as Poly Haven publishes it: the 1k glTF, its one buffer and its 1k
 * textures. `files` pins the glTF and every file it names, by the path it
 * names them with, and the glTF may name nothing else. Poly Haven keeps the
 * buffer, which every resolution shares, under the largest resolution's folder.
 */
type Model = {
  id: StampSourceId;
  gltf: string;
  bufferFolder: "4k" | "8k";
  files: Record<string, string>;
  /** One stamp per entry. `nodes` names the meshes of a set to render on their own, else the whole model is one. */
  stamps: { key: string; name: string; nodes?: string[] }[];
};

const PH = "https://dl.polyhaven.org/file/ph-assets/Models/";

function modelUrl(model: Model, path: string): string {
  if (path === `${model.id}_1k.gltf`) return `${PH}gltf/1k/${model.id}/${path}`;
  if (path.endsWith(".bin")) return `${PH}gltf/${model.bufferFolder}/${model.id}/${path}`;
  if (path.startsWith("textures/")) return `${PH}jpg/1k/${model.id}/${path.slice("textures/".length)}`;
  throw new Error(`${model.id}: no URL for ${path}`);
}

function model(id: StampSourceId, bufferFolder: Model["bufferFolder"], files: Record<string, string>, stamps: Model["stamps"]): Model {
  const gltf = `${id}_1k.gltf`;
  if (!files[gltf]) throw new Error(`${id}: the glTF is not pinned`);
  return { id, gltf, bufferFolder, files, stamps };
}

const FURNITURE: Model[] = [
  model(
    "wine_barrel_01",
    "8k",
    {
      "wine_barrel_01_1k.gltf": "503d3339677217c3241a3cdbc1c803ed1eb82d1a48f51436d1545ec5745ae8d8",
      "wine_barrel_01.bin": "d827c31afed824b923ea9168462c93ab3ad3a88c4a68b155bd35efb1a02cbf00",
      "textures/wine_barrel_01_diff_1k.jpg": "6bea25b4fadda0636b6b7e46e0cc15153eda21ef62c823d5ee2e06a5a7589214",
      "textures/wine_barrel_01_arm_1k.jpg": "be658e1389dbe8669e847b8fc7df8affdce46d6582f01ac701555b6446a40b9d",
      "textures/wine_barrel_01_nor_gl_1k.jpg": "86cdb0729b44d1687c75d895e6d0ef650f7580d70f3bcb52bce6fedc5fd79b6f",
    },
    [{ key: "barrel", name: "Barrel" }],
  ),
  model(
    "treasure_chest",
    "8k",
    {
      "treasure_chest_1k.gltf": "5edb8df3a45d2709b9407102ba4dd63025adff401ed8eba939d0117a74dd8dd5",
      "treasure_chest.bin": "6e8fd5b5c641c3535bf26767fc7b0e7295c314d43613726da9679ee8cffecb03",
      "textures/treasure_chest_diff_1k.jpg": "4a2ee3b53835e7d4a3e411863c7829f37df1221aeb1cd78d89e24239cf8bbd0b",
      "textures/treasure_chest_arm_1k.jpg": "1f09896cfad5b2f80483ab440b732fb03e94a67c3b09eee4c864af7ad2c6cc12",
      "textures/treasure_chest_nor_gl_1k.jpg": "c86a694f7d40e46dfdd0293a5a9bae32061a8476132bbd679b63404cc1795b68",
    },
    [{ key: "chest", name: "Chest" }],
  ),
  model(
    "wooden_crate_01",
    "8k",
    {
      "wooden_crate_01_1k.gltf": "fd9c6073acfc671e12b64666053f2805ae33aff5d3dbbcfe5c97c08c06644927",
      "wooden_crate_01.bin": "85f381f8035f7a6f2f3b848640894c6d3333b261946dd8a338c0fe19e0bea21e",
      "textures/wooden_crate_01_diff_1k.jpg": "16653f4abaf4c1d9bca94bde3bd8c54d0ea9a5298d1648abcf57de1f7ecc34cc",
      "textures/wooden_crate_01_arm_1k.jpg": "cd0b031c3924905e16ffd78ead062c2cc274148c4104d09635310097738b4679",
      "textures/wooden_crate_01_nor_gl_1k.jpg": "f4ea44c7dc1686123d337039cb713d74e8a2dbc6d1bd2beeac276d06f5df3fab",
    },
    [{ key: "crate", name: "Crate" }],
  ),
  model(
    "WoodenTable_01",
    "4k",
    {
      "WoodenTable_01_1k.gltf": "413804e054055c397b4cfbd0916027097d2a20853b165b533007a46d131e1d17",
      "WoodenTable_01.bin": "1083a3442969d27e18e6a7a454bc164407439e3908bf8f17f5fb24d58cd0172e",
      "textures/WoodenTable_01_diff_1k.jpg": "9535de577ad6b64deb68457af14240dd9b6d82143da0b6d2bf337660ebd855f3",
      "textures/WoodenTable_01_arm_1k.jpg": "ad876f814215006d35f74670d4fc14a9f6eab386a9307764521449464a1cd6ef",
      "textures/WoodenTable_01_nor_gl_1k.jpg": "330655534ea1fc7c7387b5d2ba5ca3231711a9fa680b980933a3a9c82cdb1c67",
    },
    [{ key: "table", name: "Table" }],
  ),
  model(
    "round_wooden_table_01",
    "8k",
    {
      "round_wooden_table_01_1k.gltf": "dd09c1663b10d15a1fda12ba4f53743e8b8379b17254a78be22100d584738b48",
      "round_wooden_table_01.bin": "c2635368bc86239a73fafdd8bce20b4261155ce7241e95e809a753ed4693f157",
      "textures/round_wooden_table_01_diff_1k.jpg": "d83659d8d584bbadf160760b825f990c6264901e33051643d19fcd389b0d19ae",
      "textures/round_wooden_table_01_arm_1k.jpg": "32b5056dc36e3081987c20cd03f15e73298266c1aff3e573b832e9dd0f8145b9",
      "textures/round_wooden_table_01_nor_gl_1k.jpg": "5f80ed76e2eccaea8ab7c0cc9c85d29cc9b164aabfa2403304e1ec79dc47150c",
    },
    [{ key: "table-round", name: "Round table" }],
  ),
  model(
    "GothicBed_01",
    "4k",
    {
      "GothicBed_01_1k.gltf": "67df189dd3a645936827f3cc123fb9e97ca9d2201d1e4090762bf477cab82fc0",
      "GothicBed_01.bin": "2276e86480c49dfb63a4671a9637621f88727708cf83342156c157a1d89f747b",
      "textures/GothicBed_01_diff_1k.jpg": "f7e8611a731a87a42a35d92e59f78b848ac20475827b79cb8aa34df0dd5bcbd5",
      "textures/GothicBed_01_arm_1k.jpg": "049014a0bb54fd3da3b555d90966b63cad7e35feb5470b578524a7b1cec8506a",
      "textures/GothicBed_01_nor_gl_1k.jpg": "27533a33617689035cf9880803ed19af45550864442734ee9898697933b7319f",
    },
    [{ key: "bed", name: "Bed" }],
  ),
  model(
    "wooden_bookshelf_worn",
    "4k",
    {
      "wooden_bookshelf_worn_1k.gltf": "a1c5b3f1e71ae0b5eb73047e8097bceaa5f17e5d2d0d7ae1b8053d5ec0878fc6",
      "wooden_bookshelf_worn.bin": "170758113b50132380ab46943f6eab18f2714460dead065aae37241a94abf0f9",
      "textures/wooden_bookshelf_worn_diff_1k.jpg": "970f60178decadd0d8fb1e5872f718350a49b027fd69469210c41ead350cba56",
      "textures/wooden_bookshelf_worn_arm_1k.jpg": "41b3aca38fb55cb300d971016a597c80425da3744a6d33d82fe78f9dbe609eaa",
      "textures/wooden_bookshelf_worn_nor_gl_1k.jpg": "90ffb1b3f7bb638d5a7e1a2b244a260d623e314a6010a6b8c23c57203e510ac9",
    },
    [{ key: "bookshelf", name: "Bookshelf" }],
  ),
  model(
    "stone_fire_pit",
    "4k",
    {
      "stone_fire_pit_1k.gltf": "40034b326d28c06f25cf1cdb39a5ab3f3b1d1a9415d490af39621efe6c31cee6",
      "stone_fire_pit.bin": "83528a314ac1ff67a583a59640612e7f8dca803dbb581188b8226d9b661ef0d6",
      "textures/stone_fire_pit_diff_1k.jpg": "3f2a2340a7dc7207d5b24deb7697c11c43bbd1963533b8f7c41644d32872d1ff",
      "textures/stone_fire_pit_arm_1k.jpg": "9812f7511ccbddcb8340fd47a6fffcf3897820fad31004241639d6d2ea523e2c",
      "textures/stone_fire_pit_nor_gl_1k.jpg": "6ba240fbdc1ab6dac4b06ac342e7fca9fa6064c7d4f98e75cfccad44214c533a",
    },
    [{ key: "fire-pit", name: "Fire pit" }],
  ),
];

const NATURE: Model[] = [
  model(
    "fir_sapling",
    "8k",
    {
      "fir_sapling_1k.gltf": "a9466ca9d8c5b9b2eeeeafd3ce426f8912dcbd98a7281bad8c734833eb35b186",
      "fir_sapling.bin": "efdebfae6ee4b3ea20c7a85eb9f798ff4953259a3616bcff0b7e580b00f34f40",
      "textures/fir_sapling_branches_diff_1k.jpg": "46d216526b6203dbd5dc3cfce5e49d7a4cc1770da2420faab45adf33671c7de4",
      "textures/fir_sapling_branches_arm_1k.jpg": "44c32b056b78c1046aeeb44c973a1d1352ea12d0d7ef2425527555f1256a0964",
      "textures/fir_sapling_branches_nor_gl_1k.jpg": "dbe474f6cd593d51a19fb92a627ad900b9ab47dabd1bf60117a2cf9d110f79ea",
      "textures/fir_sapling_twigs_diff_1k.jpg": "a9900fafad850deeb5f79b928fd7590bca9e8ec8734d2368d4c64bba8b0c5b22",
      "textures/fir_sapling_twigs_arm_1k.jpg": "d1ec27a55bb67bfe5fa2c8a41a545dc71769934b142db56ad7c703d4146e1770",
      "textures/fir_sapling_twigs_nor_gl_1k.jpg": "34928b2a9d1f722d2f64a7da468c790ecaca9b89c00ac0878a9e0bad26748368",
    },
    [{ key: "young-pine", name: "Young pine", nodes: ["fir_sapling_a"] }],
  ),
  model(
    "rock_moss_set_01",
    "8k",
    {
      "rock_moss_set_01_1k.gltf": "c36675aca9c6b2be7785c2534cf413b03ec82a5a2a5407a2b1c0cdb0346c9727",
      "rock_moss_set_01.bin": "de8360e6175879aaf02c171911069cf5f1852547f9ca7f10e440085dbcc3315e",
      "textures/rock_moss_set_01_diff_1k.jpg": "40cea65d8aa4ee73a93b04af19963834d061eee9779c3fc2c1cba76eef812ccc",
      "textures/rock_moss_set_01_nor_gl_1k.jpg": "eb4aad3f207f1dc5b624d74ae240372171626a66912bd71adf7bd3e518181d6e",
      "textures/rock_moss_set_01_rough_1k.jpg": "4d6ec46623abd8e2cdb855f59c7ce31873ad61b36b60e4de579e9e776a497c6b",
    },
    [
      { key: "mossy-rock-1", name: "Mossy rock 1", nodes: ["rock_moss_set_01_rock01"] },
      { key: "mossy-rock-2", name: "Mossy rock 2", nodes: ["rock_moss_set_01_rock04"] },
    ],
  ),
  model(
    "namaqualand_boulders_01",
    "8k",
    {
      "namaqualand_boulders_01_1k.gltf": "993be7eab67d98741968d0fa74e32792f6f53437f86c1fba4563c5acce30d94f",
      "namaqualand_boulders_01.bin": "0c37e75570ec72a1e8b76fdfc1fa7d5ae62cc4ff1363f244fe06892d12618b78",
      "textures/namaqualand_boulders_01_diff_1k.jpg": "f3ef4909f97b7087e9b01a655c8c8fe2bd2e820d9fcdcce90958c339f834067d",
      "textures/namaqualand_boulders_01_arm_1k.jpg": "fc030df70560322257f8234c9ee47cf470020de004104da3a43ecafe65dd6568",
      "textures/namaqualand_boulders_01_nor_gl_1k.jpg": "bb823e2439fd6e4679c63defa7edfb40a942bba4d7db1fa1bdbbc5a5e8792179",
    },
    [
      // Poly Haven calls these boulders, but both meshes are about a foot across.
      { key: "stone-1", name: "Stone 1", nodes: ["namaqualand_rocks_01_a"] },
      { key: "stone-2", name: "Stone 2", nodes: ["namaqualand_rocks_01_b"] },
    ],
  ),
];

/** A cell is 5 ft. */
const METRES_PER_CELL = 1.524;

/**
 * A model's footprint on one axis: its size in cells, rounded up to the next
 * quarter cell, at least a quarter. The owner chose rounding up over the
 * design's nearest quarter (3.5), so every render keeps its true size: a
 * rounded-down footprint shrank a 0.96 by 0.52 m chest to 62% to fit 0.75 by
 * 0.25 cells. The tiny allowance keeps an exact quarter from rounding past itself.
 */
export function footprintCells(metres: number): number {
  return Math.max(0.25, Math.ceil((metres / METRES_PER_CELL) * 4 - 1e-9) / 4);
}

/**
 * Renders are stored at this density, so a model is drawn at its true size
 * with its footprint's margin around it. The 512 px cap lowers it for the
 * largest rocks only.
 */
const RENDER_PX_PER_CELL = 256;

/** The square canvas each model is rendered on, large enough to downscale from on every axis. */
const RENDER_CANVAS_PX = 2048;

/** Room left around the object on each side, as a fraction of its larger side, before the shadow is baked. */
const RENDER_MARGIN = 0.1;

/**
 * The baked shadow, as fractions of the object's larger side: the soft dark
 * halo of Prime_8's trees, a little down and right of the object as if lit
 * from the top left. These match the approved prototype.
 */
const SHADOW = { blur: 0.035, dx: 0.014, dy: 0.021, opacity: 0.85 };

/**
 * The renderer, served to headless Chrome. It draws one glTF straight down
 * with an orthographic camera and a fixed light onto a transparent square,
 * with room around the object for the shadow the script bakes afterwards. The
 * camera's up is -z, so a model's back (glTF faces +z) is at the top.
 */
const RENDER_HTML = `<!doctype html><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"/three/build/three.module.js"}}</script>
<script type="module">
import * as THREE from "three";
import { GLTFLoader } from "/three/examples/jsm/loaders/GLTFLoader.js";

window.renderTopDown = async ({ url, nodes, size, margin }) => {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;
  if (nodes) {
    for (const child of [...root.children]) if (!nodes.includes(child.name)) root.remove(child);
    const kept = root.children.map((child) => child.name).sort().join();
    if (kept !== [...nodes].sort().join()) throw new Error("expected nodes " + nodes + ", found " + kept);
  }
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root, true);
  const center = box.getCenter(new THREE.Vector3());
  const width = box.max.x - box.min.x;
  const depth = box.max.z - box.min.z;
  const height = box.max.y - box.min.y;
  const span = Math.max(width, depth) * (1 + 2 * margin);

  const scene = new THREE.Scene();
  scene.add(root);
  scene.add(new THREE.HemisphereLight(0xfff6ea, 0x3a3128, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(center.x - 0.6 * span, center.y + 3 * span, center.z - 0.9 * span);
  sun.target.position.copy(center);
  scene.add(sun, sun.target);

  const camera = new THREE.OrthographicCamera(-span / 2, span / 2, span / 2, -span / 2, 0.01, height + 20);
  camera.position.set(center.x, box.max.y + 10, center.z);
  camera.up.set(0, 0, -1);
  camera.lookAt(center);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.render(scene, camera);
  const gl = renderer.getContext();
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const gpu = String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  const png = renderer.domElement.toDataURL("image/png");
  renderer.dispose();
  return { png, metres: [width, depth, height], pxPerMetre: size / span, gpu };
};
window.ready = true;
</script>`;

// ---------------------------------------------------------------------------
// Fetching and reading

const sha256Of = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function checkPin(label: string, data: Buffer, sha256: string): Buffer {
  const actual = sha256Of(data);
  if (actual !== sha256) {
    throw new Error(`${label} changed upstream (sha256 ${actual}). Re-check its license before re-pinning.`);
  }
  return data;
}

/**
 * A pinned download, from the cache when an earlier run left it there. Files
 * are named by their pinned hash alone, so nothing a server sends ever picks
 * a path, and a cached file is checked again before it is used.
 */
async function fetchPinned(cache: string, url: string, sha256: string): Promise<{ path: string; data: Buffer }> {
  const path = join(cache, sha256);
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256Of(cached) === sha256) return { path, data: cached };
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const data = checkPin(url, Buffer.from(await res.arrayBuffer()), sha256);
  await writeFile(path, data);
  return { path, data };
}

function readZipEntry(zip: Buffer, name: string): Promise<Buffer> {
  return new Promise((resolveEntry, reject) => {
    yauzl.fromBuffer(zip, { lazyEntries: true }, (err, file) => {
      if (err) return reject(err);
      file.on("error", reject);
      file.on("end", () => reject(new Error(`${name} is not in the zip`)));
      file.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName !== name) return file.readEntry();
        file.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("error", reject);
          stream.on("end", () => {
            file.close();
            resolveEntry(Buffer.concat(chunks));
          });
        });
      });
      file.readEntry();
    });
  });
}

/**
 * 7zip-bin's 7za, which pnpm unpacks without its executable bit. When it
 * cannot run in place, a private copy in its own temporary directory runs
 * instead, apart from the downloads.
 */
async function sevenZip(): Promise<{ bin: string; done: () => Promise<void> }> {
  try {
    await access(path7za, constants.X_OK);
    return { bin: path7za, done: async () => {} };
  } catch {
    const dir = await mkdtemp(join(tmpdir(), "raccoon-vtt-7za-"));
    const bin = join(dir, "7za");
    await copyFile(path7za, bin);
    await chmod(bin, 0o755);
    return { bin, done: () => rm(dir, { recursive: true, force: true }) };
  }
}

const run = promisify(execFile);

/** One named entry of a 7z archive, written to stdout. `-spd` makes the name literal, never a wildcard. */
async function read7zEntry(bin: string, archive: string, name: string): Promise<Buffer> {
  const { stdout } = await run(bin, ["x", "-so", "-t7z", "-spd", archive, name], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (stdout.length === 0) throw new Error(`${name} is not in the 7z archive`);
  return stdout;
}

// ---------------------------------------------------------------------------
// Images

type Raw = { data: Buffer; width: number; height: number };

const toRaw = async (image: Buffer): Promise<Raw> => {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error(`expected RGBA, got ${info.channels} channels`);
  return { data, width: info.width, height: info.height };
};

/** Pixels this faint are left out when finding the art: Prime_8's shadows fade to nothing at their edges. */
const ALPHA_MIN = 8;

function opaqueBounds({ data, width, height }: Raw): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) <= ALPHA_MIN) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) throw new Error("the image is empty");
  return { x0, y0, x1, y1 };
}

/**
 * Crops to the smallest box of the footprint's shape that holds the art,
 * centered on it, so a stamp drawn into its footprint is never stretched and
 * turns about the art's middle. A box that fits the canvas is moved inside it
 * by the pixel or so that rounding costs, so it stays a pure crop. Where a box
 * is larger than the canvas the new pixels are transparent. Returns how many
 * pixels that added, so the log says when a crop was not purely a crop.
 */
function frame(image: Raw, w: number, h: number): { raw: Raw; added: number } {
  const b = opaqueBounds(image);
  const artW = b.x1 - b.x0 + 1;
  const artH = b.y1 - b.y0 + 1;
  const aspect = w / h;
  const boxW = artW / artH >= aspect ? artW : Math.round(artH * aspect);
  const boxH = artW / artH >= aspect ? Math.round(artW / aspect) : artH;
  const inside = (start: number, box: number, canvas: number) =>
    box <= canvas ? Math.min(Math.max(start, 0), canvas - box) : start;
  const left = inside(Math.round((b.x0 + b.x1 + 1) / 2 - boxW / 2), boxW, image.width);
  const top = inside(Math.round((b.y0 + b.y1 + 1) / 2 - boxH / 2), boxH, image.height);
  return crop(image, left, top, boxW, boxH);
}

/** A box out of an image, transparent wherever it runs past the image's edge. */
function crop(image: Raw, left: number, top: number, width: number, height: number): { raw: Raw; added: number } {
  const out = Buffer.alloc(width * height * 4);
  let added = 0;
  for (let y = 0; y < height; y++) {
    const sy = top + y;
    for (let x = 0; x < width; x++) {
      const sx = left + x;
      if (sy < 0 || sx < 0 || sy >= image.height || sx >= image.width) {
        added++;
        continue;
      }
      image.data.copy(out, (y * width + x) * 4, (sy * image.width + sx) * 4, (sy * image.width + sx) * 4 + 4);
    }
  }
  return { raw: { data: out, width, height }, added };
}

/**
 * Bakes the soft shadow under a render and cuts out its footprint: the
 * object's silhouette, darkened, blurred and nudged down and right, with the
 * render drawn over it, in a box of `boxW` by `boxH` render pixels centered on
 * the object, which the camera put in the middle of the render. The object
 * always fits its rounded-up footprint, but its shadow can reach past a narrow
 * margin, so the shadow fades out over the box's last few pixels rather than
 * stopping at a hard line.
 */
async function bakeShadow(render: Raw, objectPx: number, boxW: number, boxH: number): Promise<Raw> {
  const sigma = SHADOW.blur * objectPx;
  const dx = Math.round(SHADOW.dx * objectPx);
  const dy = Math.round(SHADOW.dy * objectPx);
  const pad = Math.ceil(3 * sigma) + Math.max(dx, dy);
  const width = render.width + 2 * pad;
  const height = render.height + 2 * pad;
  const silhouette = Buffer.alloc(width * height * 4);
  for (let y = 0; y < render.height; y++) {
    for (let x = 0; x < render.width; x++) {
      const alpha = render.data[(y * render.width + x) * 4 + 3] ?? 0;
      silhouette[((y + pad + dy) * width + x + pad + dx) * 4 + 3] = Math.round(alpha * SHADOW.opacity);
    }
  }
  const blurred = await sharp(silhouette, { raw: { width, height, channels: 4 } })
    .blur(sigma)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const left = Math.round(width / 2 - boxW / 2);
  const top = Math.round(height / 2 - boxH / 2);
  const shadow = crop({ data: blurred.data, width, height }, left, top, boxW, boxH).raw;
  const fade = Math.max(1, Math.round(sigma));
  for (let y = 0; y < boxH; y++) {
    for (let x = 0; x < boxW; x++) {
      const edge = Math.min(x, y, boxW - 1 - x, boxH - 1 - y);
      if (edge >= fade) continue;
      const t = edge / fade;
      const i = (y * boxW + x) * 4 + 3;
      shadow.data[i] = Math.round((shadow.data[i] ?? 0) * t * t * (3 - 2 * t));
    }
  }
  const object = crop(render, left - pad, top - pad, boxW, boxH).raw;
  const asPng = (raw: Raw) => sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } }).png().toBuffer();
  const { data } = await sharp(await asPng(shadow))
    .composite([{ input: await asPng(object) }])
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: boxW, height: boxH };
}

/**
 * Lossy WebP with full alpha: the art is painted or photographic, and the
 * soft shadows need every alpha level.
 */
async function encode(raw: Raw, width: number, height: number): Promise<Buffer> {
  let image = sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } });
  if (width !== raw.width || height !== raw.height) {
    image = sharp(await image.resize(width, height, { fit: "fill", kernel: "lanczos3" }).png().toBuffer());
  }
  return image.webp({ quality: 85, alphaQuality: 100, effort: 6 }).toBuffer();
}

// ---------------------------------------------------------------------------
// Building

type Built = { key: string; name: string; w: number; h: number; source: StampSourceId; bytes: number };

async function writeStamp(key: string, webp: Buffer): Promise<void> {
  if (!KEY.test(key)) throw new Error(`${key} is not a slug`);
  await writeFile(join(OUT_DIR, `${key}.webp`), webp);
}

/** Sprites keep their own resolution, which is under the cap for every pack here. */
function spriteSize(raw: Raw): { width: number; height: number } {
  const scale = Math.min(1, MAX_PX / Math.max(raw.width, raw.height));
  return { width: Math.round(raw.width * scale), height: Math.round(raw.height * scale) };
}

async function buildPack(pack: Pack, cache: string, sevenZipBin: () => Promise<string>): Promise<Built[]> {
  const from = pack.from;
  let readSprite: (sprite: Sprite) => Promise<Buffer>;
  if ("files" in from) {
    readSprite = async (sprite) => (await fetchPinned(cache, from.files + sprite.file, sprite.sha256)).data;
  } else {
    const archive = await fetchPinned(cache, from.url, from.sha256);
    if (from.archive === "zip") readSprite = (sprite) => readZipEntry(archive.data, sprite.file);
    else readSprite = async (sprite) => read7zEntry(await sevenZipBin(), archive.path, sprite.file);
  }
  const built: Built[] = [];
  for (const sprite of pack.sprites) {
    const png = checkPin(`${pack.source}/${sprite.file}`, await readSprite(sprite), sprite.sha256);
    const { raw, added } = frame(await toRaw(png), sprite.w, sprite.h);
    const size = spriteSize(raw);
    const webp = await encode(raw, size.width, size.height);
    await writeStamp(sprite.key, webp);
    built.push({ key: sprite.key, name: sprite.name, w: sprite.w, h: sprite.h, source: pack.source, bytes: webp.length });
    const padded = added ? `, ${added} transparent px added` : "";
    console.log(`${sprite.key}.webp  ${webp.length} bytes  ${size.width}x${size.height}  ${sprite.w}x${sprite.h} cells  from ${sprite.file}${padded}`);
  }
  return built;
}

/**
 * The renderer page's origin, which never resolves: the page's requests are
 * answered by the script, with only the renderer, three.js and the pinned
 * files of the model in hand, and anything else is refused.
 */
const ORIGIN = "http://stamps.invalid";

const CONTENT_TYPES: Record<string, string> = {
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

function threeFile(path: string): string | null {
  if (path !== "build/three.module.js" && !/^examples\/jsm\/[A-Za-z0-9_/]+\.js$/.test(path)) return null;
  const file = resolve(THREE_DIR, path);
  return file.startsWith(THREE_DIR + sep) ? file : null;
}

type Renderer = { page: Page; serve: (files: Map<string, Buffer>) => void };

async function openRenderer(browser: Browser): Promise<Renderer> {
  const page = await browser.newPage();
  let served = new Map<string, Buffer>();
  // Errors only: SwiftShader warns about every pixel read, which is expected here.
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`page: ${message.text()}`);
  });
  page.on("pageerror", (error) => console.log(`page: ${error.message}`));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const path = decodeURIComponent(url.pathname);
    if (path === "/render.html") return route.fulfill({ contentType: "text/html", body: RENDER_HTML });
    const three = path.startsWith("/three/") ? threeFile(path.slice("/three/".length)) : null;
    if (three) return route.fulfill({ contentType: "text/javascript", body: await readFile(three) });
    const file = path.startsWith("/model/") ? served.get(path.slice("/model/".length)) : undefined;
    const type = CONTENT_TYPES[path.slice(path.lastIndexOf("."))];
    if (file && type) return route.fulfill({ contentType: type, body: file });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(`${ORIGIN}/render.html`);
  await page.waitForFunction(() => (globalThis as unknown as RenderPage).ready === true);
  return { page, serve: (files) => (served = files) };
}

/** The glTF may name only pinned files, so the render reads nothing unchecked. */
function checkGltfNames(model: Model, gltf: Buffer): void {
  const json = JSON.parse(gltf.toString("utf8")) as { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
  const named = [...(json.buffers ?? []), ...(json.images ?? [])].map((entry) => entry.uri ?? "");
  const pinned = Object.keys(model.files).filter((path) => path !== model.gltf);
  if (named.sort().join("\n") !== pinned.sort().join("\n")) {
    throw new Error(`${model.id}: the glTF names ${named.join(", ")}, not the pinned files`);
  }
}

type RenderArgs = { url: string; nodes: string[] | null; size: number; margin: number };
type RenderResult = { png: string; metres: [number, number, number]; pxPerMetre: number; gpu: string };
/** What RENDER_HTML puts on the page's global object. */
type RenderPage = { ready?: boolean; renderTopDown: (args: RenderArgs) => Promise<RenderResult> };

async function buildModel(model: Model, cache: string, renderer: Renderer): Promise<Built[]> {
  const files = new Map<string, Buffer>();
  for (const [path, sha256] of Object.entries(model.files)) {
    files.set(`${model.id}/${path}`, (await fetchPinned(cache, modelUrl(model, path), sha256)).data);
  }
  checkGltfNames(model, files.get(`${model.id}/${model.gltf}`) ?? Buffer.alloc(0));
  renderer.serve(files);
  const built: Built[] = [];
  for (const stamp of model.stamps) {
    const result = await renderer.page.evaluate(
      (args: RenderArgs) => (globalThis as unknown as RenderPage).renderTopDown(args),
      { url: `${ORIGIN}/model/${model.id}/${model.gltf}`, nodes: stamp.nodes ?? null, size: RENDER_CANVAS_PX, margin: RENDER_MARGIN },
    );
    if (!/swiftshader/i.test(result.gpu)) throw new Error(`rendered on ${result.gpu}, not SwiftShader`);
    const [width, depth] = result.metres;
    const w = footprintCells(width);
    const h = footprintCells(depth);
    const render = await toRaw(Buffer.from(result.png.replace(/^data:image\/png;base64,/, ""), "base64"));
    const cellPx = METRES_PER_CELL * result.pxPerMetre;
    const raw = await bakeShadow(render, Math.max(width, depth) * result.pxPerMetre, Math.round(w * cellPx), Math.round(h * cellPx));
    const density = Math.min(RENDER_PX_PER_CELL, MAX_PX / Math.max(w, h));
    const outW = Math.round(w * density);
    const outH = Math.round(h * density);
    const webp = await encode(raw, outW, outH);
    await writeStamp(stamp.key, webp);
    built.push({ key: stamp.key, name: stamp.name, w, h, source: model.id, bytes: webp.length });
    console.log(
      `${stamp.key}.webp  ${webp.length} bytes  ${outW}x${outH}  ${w}x${h} cells  from ${model.id}` +
        `${stamp.nodes ? ` ${stamp.nodes.join(", ")}` : ""}  ${width.toFixed(2)} x ${depth.toFixed(2)} m`,
    );
  }
  return built;
}

function catalogSource(stamps: Built[]): string {
  const rows = stamps.map(
    (s) => `  { key: ${JSON.stringify(s.key)}, name: ${JSON.stringify(s.name)}, w: ${s.w}, h: ${s.h}, source: ${JSON.stringify(s.source)} },`,
  );
  return `/**
 * The stamp art RaccoonVTT ships, drawn from \`/stamps/<key>.webp\`
 * (docs/design-v1-maps-vision.md section 3.5). Written by
 * \`node scripts/stamps.ts\`, so change the script, not this file.
 *
 * \`w\` and \`h\` are the footprint in cells, the size a new stamp takes. Each
 * image has its footprint's shape, so drawing it into its footprint never
 * stretches it. \`source\` names its credit in shared/credits.ts.
 */
import type { StampSourceId } from "./credits.ts";

export type ShippedStamp = { key: string; name: string; w: number; h: number; source: StampSourceId };

export const STAMP_ART: readonly ShippedStamp[] = [
${rows.join("\n")}
];
`;
}

async function removeStale(keep: Set<string>): Promise<void> {
  for (const file of await readdir(OUT_DIR)) {
    if (!file.endsWith(".webp") || keep.has(file.slice(0, -".webp".length))) continue;
    await unlink(join(OUT_DIR, file));
    console.log(`removed ${file}, no longer in the set`);
  }
}

async function checkThree(): Promise<void> {
  const pkg = JSON.parse(await readFile(join(THREE_DIR, "package.json"), "utf8")) as { version?: string };
  if (pkg.version !== "0.160.0") throw new Error(`expected three 0.160.0, found ${pkg.version}`);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { cache: { type: "string" } } });
  const cache = resolve(values.cache ?? join(tmpdir(), "raccoon-vtt-stamps"));
  await mkdir(cache, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });
  await checkThree();

  // Only the 7z pack needs 7za, so it is made ready on first use.
  const tools: { sevenZip?: Promise<Awaited<ReturnType<typeof sevenZip>>> } = {};
  const sevenZipBin = async () => (await (tools.sevenZip ??= sevenZip())).bin;
  // Chrome's software renderer, so the renders never depend on this machine's GPU.
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  try {
    const renderer = await openRenderer(browser);
    const built: Built[] = [];
    for (const model of FURNITURE) built.push(...(await buildModel(model, cache, renderer)));
    built.push(...(await buildPack(LIOSAN_VILLAGE, cache, sevenZipBin)));
    built.push(...(await buildPack(PRIME8_TREES, cache, sevenZipBin)));
    built.push(...(await buildPack(LIOSAN_FOLIAGE, cache, sevenZipBin)));
    built.push(...(await buildPack(PRIME8_STONES, cache, sevenZipBin)));
    for (const model of NATURE) built.push(...(await buildModel(model, cache, renderer)));

    const keys = new Set(built.map((s) => s.key));
    if (keys.size !== built.length) throw new Error("two stamps share a key");
    await removeStale(keys);
    await writeFile(CATALOG, catalogSource(built));
    const total = built.reduce((sum, s) => sum + s.bytes, 0);
    console.log(`${built.length} stamps, ${total} bytes, catalog in shared/stamps.ts`);
  } finally {
    await browser.close();
    if (tools.sevenZip) await (await tools.sevenZip).done();
  }
}
