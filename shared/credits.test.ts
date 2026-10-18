import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import sharp from "sharp";
import { simplifyGameIcon } from "../scripts/icons.ts";
import { footprintCells } from "../scripts/stamps.ts";
import {
  CONDITION_ICONS,
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
import { CONDITION_KEYS, STATUS_KEYS, type TerrainId } from "./model.ts";
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
const shippedArt = [...filesUnder("public/textures"), ...filesUnder("public/icons"), ...filesUnder("public/stamps")];
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
    ]);
    const svgs = shippedArt.filter((file) => file.endsWith(".svg"));
    assert.deepEqual(new Set(svgs), expected);
  });

  test("icon maps cover exactly the model's keys", () => {
    assert.deepEqual(Object.keys(CONDITION_ICONS), [...CONDITION_KEYS]);
    assert.deepEqual(Object.keys(STATUS_ICONS), [...STATUS_KEYS]);
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

  test("the catalog lists exactly the files in public/stamps", () => {
    assert.ok(STAMP_ART.length > 0);
    assert.deepEqual(new Set(filesUnder("public/stamps")), new Set(STAMP_ART.map((s) => stampFile(s.key))));
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
  test("each stamp is a WebP of its footprint's shape, at most 512 px, footprints in quarter cells", async () => {
    for (const stamp of STAMP_ART) {
      const file = stampFile(stamp.key);
      const meta = await sharp(read(file)).metadata();
      assert.equal(meta.format, "webp", file);
      assert.ok(meta.hasAlpha, file);
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
