import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import sharp from "sharp";
import { simplifyGameIcon } from "../scripts/icons.ts";
import { STARTER_CAPS } from "../scripts/starter-art.ts";
import { footprintCells } from "../scripts/stamps.ts";
import {
  CONDITION_ICONS,
  DAMAGE_ICONS,
  CREDITS,
  LICENSES,
  STAMP_CROPPED,
  STAMP_RENDERED,
  STAMP_SOURCES,
  STATUS_ICONS,
  TOKEN_ICONS,
  type Credit,
} from "./credits.ts";
import { GAME_ICONS_DIR } from "./gameIcons.ts";
import { ICON_KEY_RE } from "./imageRef.ts";
import { DAMAGE_TYPES } from "./rules/damage.ts";
import { CONDITION_KEYS, STATUS_KEYS, type TerrainId } from "./model.ts";
import { STARTER_KEY, type StarterWork } from "./starter.ts";
import { STARTER_PACKS } from "./starterArt.ts";
import { STARTER_STAMPS } from "./starterStamps.ts";
import { STAMP_ART } from "./stamps.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(ROOT, path));

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    // Dotfiles such as Finder's .DS_Store are ignored by git and never ship.
    if (entry.name.startsWith(".")) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

const allCredits: Credit[] = CREDITS.flatMap((group) => group.credits);
const creditFor = (file: string) => allCredits.find((credit) => credit.files.includes(file));
const shippedArt = [...filesUnder("public/textures"), ...filesUnder("public/icons"), ...filesUnder("public/stamps"), ...filesUnder("public/starter")];
const shippedFonts = filesUnder("public/fonts");

/**
 * Which terrains have a texture file and which the builder draws in code.
 * Typed as a full record, so a new TerrainId fails typecheck here until
 * someone decides how it is drawn.
 */
const TERRAIN_ART: Record<TerrainId, "texture" | "code"> = {
  stone: "texture",
  wood: "texture",
  grass: "texture",
  dirt: "texture",
  cave: "texture",
  water: "texture",
  difficult: "texture",
  rubble: "texture",
  pit: "code",
  pillar: "code",
  stairs: "code",
};

function pngSize(png: Buffer): { width: number; height: number } {
  assert.equal(png.subarray(1, 4).toString("latin1"), "PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe("credits", () => {
  test("every shipped texture, icon and stamp is credited in shared/credits.ts and CREDITS.md", () => {
    const markdown = read("CREDITS.md").toString("utf8");
    assert.ok(shippedArt.length > 0);
    for (const file of shippedArt) {
      assert.ok(creditFor(file), `${file} has no entry in shared/credits.ts`);
      assert.ok(markdown.includes(`\`${file}\``), `${file} is not listed in CREDITS.md`);
    }
  });

  test("every shipped font file, its license included, is credited in shared/credits.ts and CREDITS.md", () => {
    const markdown = read("CREDITS.md").toString("utf8");
    assert.ok(shippedFonts.some((file) => file.endsWith(".woff2")));
    for (const file of shippedFonts) {
      assert.equal(creditFor(file)?.license, "OFL-1.1", `${file} has no font credit in shared/credits.ts`);
      assert.ok(markdown.includes(`\`${file}\``), `${file} is not listed in CREDITS.md`);
    }
    // The license asks for its text with every copy, so CREDITS.md carries it whole, as the file beside the fonts does.
    const license = read("public/fonts/Inter-LICENSE.txt").toString("utf8").trim();
    assert.ok(markdown.includes(license), "CREDITS.md lacks Inter's license text");
  });

  test("every credited public file exists", () => {
    for (const credit of allCredits) {
      for (const file of credit.files.filter((f) => f.startsWith("public/"))) {
        assert.ok(existsSync(join(ROOT, file)), `${credit.title} credits missing file ${file}`);
      }
    }
  });

  test("every credit names its work, author, source and license", () => {
    for (const credit of allCredits) {
      assert.ok(credit.title && credit.author && credit.source && credit.changes, JSON.stringify(credit));
      assert.ok(credit.license in LICENSES, credit.license);
    }
  });

  test("the About page names the app as it is shown, RaccoonVTT", () => {
    const shown = JSON.stringify(CREDITS) + JSON.stringify(LICENSES);
    assert.ok(!shown.includes("raccoon-vtt"), "the repository's name, not the app's");
    assert.equal(LICENSES.original.name, "Made for RaccoonVTT");
  });

  test("CREDITS.md links every third-party source", () => {
    const markdown = read("CREDITS.md").toString("utf8");
    for (const credit of allCredits.filter((c) => c.license !== "original")) {
      assert.ok(markdown.includes(credit.source), `${credit.source} missing`);
    }
  });
});

describe("condition and status icons", () => {
  test("every condition and status key has an icon", () => {
    for (const key of CONDITION_KEYS) {
      assert.ok(existsSync(join(ROOT, `public/icons/conditions/${key}.svg`)), key);
    }
    for (const key of STATUS_KEYS) {
      assert.ok(existsSync(join(ROOT, `public/icons/statuses/${key}.svg`)), key);
    }
    const expected = new Set([
      ...CONDITION_KEYS.map((key) => `public/icons/conditions/${key}.svg`),
      ...STATUS_KEYS.map((key) => `public/icons/statuses/${key}.svg`),
      ...[...DAMAGE_TYPES, "untyped"].map((key) => `public/icons/damage/${key}.svg`),
    ]);
    const svgs = shippedArt.filter((file) => file.endsWith(".svg"));
    assert.deepEqual(new Set(svgs), expected);
  });

  test("icon maps cover exactly the model's keys", () => {
    assert.deepEqual(Object.keys(CONDITION_ICONS), [...CONDITION_KEYS]);
    assert.deepEqual(Object.keys(STATUS_ICONS), [...STATUS_KEYS]);
    assert.deepEqual(Object.keys(DAMAGE_ICONS), [...DAMAGE_TYPES, "untyped"]);
  });

  /**
   * The app may inline these into the page, so each must be exactly one
   * tintable path and the attribution comment, with nothing that could run.
   */
  test("each icon is a single currentColor path carrying its own attribution", () => {
    const shape =
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512"><!-- ([^>]*) --><path fill="currentColor" d="[MmLlHhVvCcSsQqTtAaZz0-9.,\se-]+"\/><\/svg>\n$/;
    for (const file of shippedArt.filter((f) => f.endsWith(".svg"))) {
      const svg = read(file).toString("utf8");
      const comment = shape.exec(svg)?.[1];
      assert.ok(comment, `${file} is not a simplified game-icons.net icon`);
      const credit = creditFor(file);
      assert.ok(credit);
      assert.ok(comment.includes(credit.author) && comment.includes(credit.source), file);
    }
  });

  test("FL-4: damage icons preserve the pinned local path", () => {
    for (const [key, icon] of Object.entries(DAMAGE_ICONS)) {
      const original = read(`public${GAME_ICONS_DIR}/${icon.slug}.svg`).toString("utf8");
      const tint = read(`public/icons/damage/${key}.svg`).toString("utf8");
      assert.equal(/ d="([^"]+)"/.exec(tint)?.[1], / d="([^"]+)"/.exec(original)?.[1], key);
    }
  });

  test("simplifying keeps only the white path", () => {
    const original =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M0 0h512v512H0z"/><path fill="#fff" d="M10 20h30v-5z"/></svg>';
    assert.equal(
      simplifyGameIcon(original, "credit"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><!-- credit --><path fill="currentColor" d="M10 20h30v-5z"/></svg>\n',
    );
  });

  test("simplifying refuses anything but the expected shape", () => {
    const extra =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M0 0h512v512H0z"/><path fill="#fff" d="M1 1z"/><script>x()</script></svg>';
    assert.throws(() => simplifyGameIcon(extra, "credit"));
    const badPath =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M0 0h512v512H0z"/><path fill="#fff" d="M1 1z&lt;"/></svg>';
    assert.throws(() => simplifyGameIcon(badPath, "credit"));
    const good =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M0 0h512v512H0z"/><path fill="#fff" d="M1 1z"/></svg>';
    assert.throws(() => simplifyGameIcon(good, "a -- b"));
  });
});

describe("token icons", () => {
  type Index = { commit: string; authors: { id: string; name: string; url?: string; license: string; icons: string[] }[] };
  const dir = `public${GAME_ICONS_DIR}`;
  const index = JSON.parse(read(`${dir}/index.json`).toString("utf8")) as Index;
  const keys = index.authors.flatMap((a) => a.icons.map((name) => `${a.id}/${name}`));

  test("the served folder is the pinned commit's, and only it ships", () => {
    assert.equal(index.commit, TOKEN_ICONS.commit);
    assert.equal(GAME_ICONS_DIR, `/game-icons/${TOKEN_ICONS.commit.slice(0, 8)}`);
    assert.deepEqual(readdirSync(join(ROOT, "public/game-icons")), [TOKEN_ICONS.commit.slice(0, 8)]);
  });

  test("every shipped icon has an index entry with an author and a license, and every entry a file", () => {
    const shipped = filesUnder(dir).filter((f) => f !== `${dir}/index.json`);
    assert.equal(shipped.length, TOKEN_ICONS.total);
    assert.deepEqual(new Set(shipped), new Set(keys.map((key) => `${dir}/${key}.svg`)));
    for (const author of index.authors) {
      assert.ok(author.name && author.icons.length > 0, author.id);
      assert.ok(author.license === "CC-BY-3.0" || author.license === "CC0-1.0", author.id);
    }
    for (const key of keys) assert.match(key, ICON_KEY_RE);
  });

  test("every author in the index appears in shared/credits.ts and CREDITS.md with their license and count", () => {
    const markdown = read("CREDITS.md").toString("utf8");
    assert.equal(TOKEN_ICONS.authors.length, index.authors.length);
    for (const author of index.authors) {
      const credited = TOKEN_ICONS.authors.find((a) => a.id === author.id);
      assert.ok(credited, `${author.id} is missing from shared/credits.ts`);
      assert.equal(credited.name, author.name);
      assert.equal(credited.license, author.license);
      assert.equal(credited.icons, author.icons.length);
      const license = LICENSES[author.license as keyof typeof LICENSES];
      const row = `| ${author.name} | \`${author.id}\` | [${license.name}](${license.url}) | ${author.icons.length.toLocaleString("en-US")} | ${author.url ?? "none given"} |`;
      assert.ok(markdown.includes(row), `CREDITS.md lacks ${row}`);
    }
    assert.ok(markdown.includes(TOKEN_ICONS.commit) && markdown.includes(TOKEN_ICONS.index) && markdown.includes(TOKEN_ICONS.changes.toLowerCase().replace(/\.$/, "")));
  });

  test("exactly the three CC0 authors are marked CC0", () => {
    const cc0 = index.authors.filter((a) => a.license === "CC0-1.0").map((a) => a.id);
    assert.deepEqual(cc0, ["various-artists", "viscious-speed", "zeromancer"]);
    assert.equal(
      index.authors.filter((a) => a.license === "CC0-1.0").reduce((n, a) => n + a.icons.length, 0),
      125,
    );
  });

  test("names under two authors stay apart by their author", () => {
    const names = keys.map((key) => key.split("/")[1]);
    assert.equal(names.length - new Set(names).size, 47);
    for (const key of ["delapouite/bat", "skoll/bat", "delapouite/castle", "lorc/castle"]) assert.ok(keys.includes(key), key);
  });

  /** The canvas reads the path out of each file, and a CSS mask draws it, so each must be one path and nothing else. */
  test("each icon is one path with an explicit 512 px size", () => {
    const shape = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512" width="512" height="512"><path d="[MmLlHhVvCcSsQqTtAaZz0-9.,\se-]+"\/><\/svg>\n$/;
    for (const key of keys) assert.match(read(`${dir}/${key}.svg`).toString("utf8"), shape, key);
  });

  test("the lead authors the About page names are in the set", () => {
    for (const id of TOKEN_ICONS.leadAuthors) assert.ok(TOKEN_ICONS.authors.some((a) => a.id === id), id);
  });
});

describe("builder textures", () => {
  test("textures are named by terrain, and only code-drawn terrains lack one", () => {
    const textured = Object.entries(TERRAIN_ART)
      .filter(([, art]) => art === "texture")
      .map(([terrain]) => `public/textures/${terrain}.webp`);
    assert.deepEqual(new Set(filesUnder("public/textures")), new Set(textured));
  });

  test("each texture is a small 256 px WebP tile", async () => {
    for (const file of filesUnder("public/textures")) {
      const meta = await sharp(read(file)).metadata();
      assert.equal(meta.format, "webp", file);
      assert.equal(meta.width, 256, file);
      assert.equal(meta.height, 256, file);
      assert.ok(statSync(join(ROOT, file)).size < 30 * 1024, `${file} is over 30 KB`);
    }
  });
});

describe("map stamps", () => {
  const stampFile = (key: string) => `public/stamps/${key}.webp`;

  test("the catalog lists exactly the files in public/stamps, the starter packs' stamps among them", () => {
    assert.ok(STAMP_ART.length > 0);
    assert.deepEqual(new Set(filesUnder("public/stamps")), new Set([...STAMP_ART, ...STARTER_STAMPS].map((s) => stampFile(s.key))));
  });

  test("keys are unique slugs, names are unique", () => {
    for (const stamp of STAMP_ART) assert.match(stamp.key, /^[a-z0-9-]{1,40}$/);
    assert.equal(new Set(STAMP_ART.map((s) => s.key)).size, STAMP_ART.length);
    assert.equal(new Set(STAMP_ART.map((s) => s.name)).size, STAMP_ART.length);
  });

  /**
   * The client draws a stamp's image into its footprint, so an image of
   * another shape would be stretched. Rounding to whole pixels allows one.
   */
  const opaqueStamps = new Set(["gb-square-pit"]);

  test("each stamp is a WebP of its footprint's shape, at most 512 px, footprints in quarter cells", async () => {
    for (const stamp of [...STAMP_ART, ...STARTER_STAMPS]) {
      const file = stampFile(stamp.key);
      const meta = await sharp(read(file)).metadata();
      assert.equal(meta.format, "webp", file);
      // A starter prop drawn to the edges of its squares, such as a square pit, has no transparent pixel to keep.
      if (!opaqueStamps.has(stamp.key)) assert.ok(meta.hasAlpha, file);
      assert.ok(Math.max(meta.width, meta.height) <= 512, `${file} is over 512 px`);
      assert.ok(Math.abs((meta.width * stamp.h) / stamp.w - meta.height) <= 1, `${file} is not ${stamp.w} by ${stamp.h}`);
      for (const side of [stamp.w, stamp.h]) {
        assert.ok(Number.isInteger(side * 4) && side >= 0.25 && side <= 20, `${stamp.key} footprint ${side}`);
      }
    }
  });

  test("every stamp source ships a stamp and says what changed as the design words it", () => {
    const stamps = CREDITS.find((group) => group.id === "stamps");
    assert.ok(stamps);
    assert.equal(stamps.credits.length, Object.keys(STAMP_SOURCES).length);
    for (const credit of stamps.credits) {
      assert.ok(credit.files.length > 0, `${credit.title} ships no stamp`);
      const rendered = credit.source.startsWith("https://polyhaven.com/a/");
      assert.equal(credit.changes, rendered ? STAMP_RENDERED : STAMP_CROPPED, credit.title);
      if (credit.license === "CC-BY-3.0") assert.equal(credit.changes, "Cropped and converted to WebP.");
    }
  });

  test("a model's footprint is its size over 1.524 m, rounded up to a quarter cell, at least a quarter", () => {
    // A barrel, a crate, a table's length, a bed's width and length, the chest's depth.
    assert.equal(footprintCells(0.74), 0.5);
    assert.equal(footprintCells(0.83), 0.75);
    assert.equal(footprintCells(1.8), 1.25);
    assert.equal(footprintCells(1.5), 1);
    assert.equal(footprintCells(2.0), 1.5);
    assert.equal(footprintCells(0.52), 0.5);
    assert.equal(footprintCells(0.1), 0.25);
    // A size that is exactly a quarter cell stays that quarter.
    assert.equal(footprintCells(1.524), 1);
    assert.equal(footprintCells(1.524 * 0.75), 0.75);
  });
});

describe("PWA", () => {
  type ManifestIcon = { src: string; sizes: string; type: string; purpose: string };
  const manifest = JSON.parse(read("public/manifest.webmanifest").toString("utf8")) as {
    [key: string]: unknown;
    icons: ManifestIcon[];
  };

  test("manifest has the app's identity and colors", () => {
    assert.equal(manifest["name"], "RaccoonVTT");
    assert.equal(manifest["short_name"], "RaccoonVTT");
    assert.equal(manifest["display"], "standalone");
    assert.equal(manifest["start_url"], "/");
    assert.equal(manifest["scope"], "/");
    assert.equal(manifest["id"], "/");
    assert.equal(manifest["theme_color"], "#16161a");
    assert.equal(manifest["background_color"], "#16161a");
  });

  test("manifest icons exist at the sizes they claim", () => {
    const purposes = new Set(manifest.icons.map((icon) => `${icon.sizes} ${icon.purpose}`));
    for (const needed of ["192x192 any", "512x512 any", "512x512 maskable"]) {
      assert.ok(purposes.has(needed), needed);
    }
    for (const icon of manifest.icons) {
      const file = `public${icon.src}`;
      assert.ok(existsSync(join(ROOT, file)), icon.src);
      if (icon.type !== "image/png") continue;
      const { width, height } = pngSize(read(file));
      assert.equal(`${width}x${height}`, icon.sizes, icon.src);
    }
  });

  test("index.html links the manifest and a 180 px apple-touch-icon", () => {
    const html = read("client/index.html").toString("utf8");
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest" \/>/);
    const apple = /<link rel="apple-touch-icon" href="([^"]+)" \/>/.exec(html)?.[1];
    assert.ok(apple);
    assert.deepEqual(pngSize(read(`public${apple}`)), { width: 180, height: 180 });
  });
});

describe("starter packs", () => {
  const works = STARTER_PACKS.flatMap((pack) => pack.works.map((work) => ({ pack, work })));
  const isStamp = (work: StarterWork) => work.stamp !== undefined;
  const publicPath = (served: string) => `public${served}`;
  const filesOf = (work: StarterWork) => [work.file, ...(work.thumb && work.thumb !== work.file ? [work.thumb] : [])].map(publicPath);
  type Input = { packs: { id: string; works: { id: string }[] }[] };
  const input = JSON.parse(read("scripts/starter-art.json").toString("utf8")) as Input;

  test("the catalog is the build of scripts/starter-art.json: the same packs and works, in order", () => {
    assert.deepEqual(
      STARTER_PACKS.map((p) => [p.id, p.works.map((w) => w.id)]),
      input.packs.map((p) => [p.id, p.works.map((w) => w.id)]),
    );
  });

  test("the catalog equals the files on disk, and every file belongs to a work", () => {
    assert.ok(works.length > 0);
    const listed = works.filter(({ work }) => !isStamp(work)).flatMap(({ work }) => filesOf(work));
    assert.equal(new Set(listed).size, listed.length, "two works name one file");
    assert.deepEqual(new Set(filesUnder("public/starter")), new Set(listed));
    for (const { pack, work } of works) {
      if (isStamp(work)) assert.equal(work.file, `/stamps/${work.stamp?.key}.webp`, work.key);
      else assert.ok(work.file.startsWith(`/starter/${pack.id}/`) && work.thumb?.startsWith(`/starter/${pack.id}/`), work.key);
    }
    assert.deepEqual(
      STARTER_STAMPS.map((s) => [s.key, s.pack, s.w, s.h]),
      works.filter(({ work }) => isStamp(work)).map(({ pack, work }) => [work.stamp?.key, pack.id, work.stamp?.w, work.stamp?.h]),
    );
  });

  test("each file is the one the catalog pinned: its hash, size and dimensions", async () => {
    for (const { work } of works) {
      const data = read(publicPath(work.file));
      assert.equal(createHash("sha256").update(data).digest("hex"), work.sha256, work.key);
      assert.equal(data.length, work.bytes, work.key);
      const meta = await sharp(data).metadata();
      assert.deepEqual([meta.width, meta.height], [work.width, work.height], work.key);
    }
  });

  test("keys are unique and well formed, and stamp keys never take a shipped stamp's", () => {
    const keys = works.map(({ work }) => work.key);
    assert.equal(new Set(keys).size, keys.length);
    for (const { pack, work } of works) {
      assert.match(work.key, STARTER_KEY);
      assert.ok(work.key.startsWith(`${pack.id}/`), work.key);
    }
    const shipped = new Set(STAMP_ART.map((s) => s.key));
    for (const stamp of STARTER_STAMPS) assert.ok(!shipped.has(stamp.key), stamp.key);
    assert.equal(new Set(STARTER_STAMPS.map((s) => s.key)).size, STARTER_STAMPS.length);
  });

  test("every pack names its page, an allowed license and a Wayback snapshot, and every work its credit", () => {
    const allowed = new Set(["CC0-1.0", "CC-BY-3.0", "CC-BY-4.0", "CC-BY-SA-3.0", "CC-BY-SA-4.0", "public-domain-dedication"]);
    for (const pack of STARTER_PACKS) {
      assert.match(pack.page, /^https:\/\//, pack.id);
      assert.match(pack.wayback, /^https:\/\/web\.archive\.org\/web\/\d{14}\/\S+$/, pack.id);
      assert.ok(pack.licenses.length > 0 && pack.licenses.every((l) => allowed.has(l)), pack.id);
      assert.ok(pack.title && pack.author && pack.changes, pack.id);
      for (const work of pack.works) {
        assert.ok(pack.licenses.includes(work.credit.license), work.key);
        assert.ok(work.credit.title && work.credit.author && work.credit.changes, work.key);
        assert.match(work.credit.source, /^https:\/\//, work.key);
        assert.ok(work.name && work.category && work.uses.length > 0, work.key);
      }
    }
  });

  test("a work is a stamp in a stamp pack only, and a map only a map", () => {
    for (const { work } of works) {
      assert.equal(isStamp(work), work.uses.includes("stamp"), work.key);
      if (isStamp(work)) assert.deepEqual(work.uses, ["stamp"], work.key);
      if (work.uses.includes("map")) assert.deepEqual(work.uses, ["map"], work.key);
    }
  });

  test("a map's grid is a square size, with where its lines fall inside one square", () => {
    for (const { work } of works) {
      if (!work.grid) continue;
      assert.ok(work.uses.includes("map"), work.key);
      assert.ok(work.grid.cellPx >= 8 && work.grid.cellPx < Math.min(work.width, work.height), work.key);
      const origin = work.grid.originPx;
      if (origin) for (const at of [origin.x, origin.y]) assert.ok(at >= 0 && at < work.grid.cellPx, work.key);
    }
  });

  /** Section 10's caps, so growing the set, or a heavier encoding, is a decision. */
  test("each file stays within its cap", () => {
    const caps = STARTER_CAPS;
    for (const { work } of works) {
      const long = Math.max(work.width, work.height);
      if (isStamp(work)) continue;
      if (work.uses.includes("map")) {
        const lineArt = work.file.endsWith(".png");
        assert.ok(long <= (lineArt ? caps.lineMapPx : caps.colorMapPx), `${work.key} is ${long} px`);
        assert.ok(work.bytes <= (lineArt ? caps.lineMapBytes : caps.colorMapBytes), `${work.key} is ${work.bytes} bytes`);
      } else if (work.uses.includes("handout")) {
        assert.ok(long <= caps.picturePx, `${work.key} is ${long} px`);
        assert.ok(work.bytes <= caps.pictureBytes, `${work.key} is ${work.bytes} bytes`);
      } else {
        assert.ok(long <= caps.tokenPx, `${work.key} is ${long} px`);
      }
    }
  });

  test("each thumbnail is a small WebP at most 256 px", async () => {
    for (const { work } of works) {
      if (!work.thumb) continue;
      const data = read(publicPath(work.thumb));
      const meta = await sharp(data).metadata();
      assert.equal(meta.format, "webp", work.key);
      assert.ok(Math.max(meta.width, meta.height) <= STARTER_CAPS.thumbPx, work.key);
      assert.ok(data.length < STARTER_CAPS.thumbBytes, `${work.thumb} is ${data.length} bytes`);
    }
  });

  test("the packs stay within the whole-folder caps", () => {
    const folder = filesUnder("public/starter").reduce((n, f) => n + statSync(join(ROOT, f)).size, 0);
    assert.ok(folder <= STARTER_CAPS.folderBytes, `public/starter holds ${folder} bytes`);
    const stamps = STARTER_STAMPS.reduce((n, s) => n + statSync(join(ROOT, `public/stamps/${s.key}.webp`)).size, 0);
    assert.ok(stamps <= STARTER_CAPS.stampBytes, `the packs' stamps take ${stamps} bytes`);
  });

  test("every work is credited once, on the page its license is stated, in shared/credits.ts and CREDITS.md", () => {
    const markdown = read("CREDITS.md").toString("utf8");
    const group = CREDITS.find((g) => g.id === "starter-packs");
    assert.ok(group);
    for (const { work } of works) {
      const credited: Credit[] = group.credits.filter((c) => c.files.includes(publicPath(work.file)));
      assert.equal(credited.length, 1, work.key);
      assert.equal(credited[0]?.source, work.credit.source, work.key);
      assert.equal(credited[0]?.license, work.credit.license, work.key);
      assert.ok(markdown.includes(work.credit.source), work.key);
    }
    for (const pack of STARTER_PACKS) assert.ok(markdown.includes(pack.wayback), pack.id);
    assert.match(markdown, /stay under the same CC BY-SA license/);
  });
});
