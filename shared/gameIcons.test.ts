import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildIconSet, gameIconsModule, iconTitle, parseLicenseText, shippedIconSvg } from "../scripts/game-icons.ts";
import { ICON_KEY_RE } from "./imageRef.ts";

/** A game-icons.net file as upstream ships it: a black square and one white path. */
const upstream = (d: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M0 0h512v512H0z"/><path fill="#fff" d="${d}"/></svg>`;

const LICENSE = `Icons provided under the Creative Commons 3.0 BY or CC0 if mentioned below.

- Lorc, http://lorcblog.blogspot.com
- Delapouite, http://delapouite.com
- PriorBlue
- Viscious Speed, http://viscious-speed.deviantart.com - CC0
- Zeromancer - CC0

Please, include a mention "Icons made by {author}" in your derivative work.
`;

/** A small tree in the repository's layout, with the files that are not icons. */
function fixture(extra: Array<{ path: string; text: string }> = []) {
  return [
    { path: "README.md", text: "# Game Icons" },
    { path: "license.txt", text: LICENSE },
    { path: "check-svgs.sh", text: "#!/bin/sh" },
    { path: "lorc/wolf-head.svg", text: upstream("M10 20h30v-5z") },
    { path: "lorc/bat.svg", text: upstream("M1 1h2z") },
    { path: "delapouite/bat.svg", text: upstream("M2 2h3z") },
    { path: "priorblue/rune-sword.svg", text: upstream("M3 3l4 4z") },
    { path: "zeromancer/heart-0.svg", text: upstream("M4 4l1 1z") },
    { path: "various-artists/infinity.svg", text: upstream("M5 5l1 1z") },
    { path: "badges/anvil.svg", text: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><circle cx="128" cy="128" r="128"/></svg>' },
    ...extra,
  ];
}

describe("game-icons build", () => {
  test("reads license.txt's authors, their links and the CC0 marks", () => {
    const listed = parseLicenseText(LICENSE);
    assert.deepEqual(listed.get("Lorc"), { url: "http://lorcblog.blogspot.com", cc0: false });
    assert.deepEqual(listed.get("PriorBlue"), { cc0: false });
    assert.deepEqual(listed.get("Viscious Speed"), { url: "http://viscious-speed.deviantart.com", cc0: true });
    assert.deepEqual(listed.get("Zeromancer"), { cc0: true });
    assert.equal(listed.size, 5);
  });

  test("builds the index from a small tree: authors with their license, icons sorted, badges and loose files left out", () => {
    const { index, svgs } = buildIconSet(fixture(), "82d948812bfe3f269ef8f731dcdb07b08160edc4");
    assert.equal(index.commit, "82d948812bfe3f269ef8f731dcdb07b08160edc4");
    assert.deepEqual(index.authors, [
      { id: "delapouite", name: "Delapouite", url: "http://delapouite.com", license: "CC-BY-3.0", icons: ["bat"] },
      { id: "lorc", name: "Lorc", url: "http://lorcblog.blogspot.com", license: "CC-BY-3.0", icons: ["bat", "wolf-head"] },
      { id: "priorblue", name: "PriorBlue", license: "CC-BY-3.0", icons: ["rune-sword"] },
      { id: "various-artists", name: "Various artists", license: "CC0-1.0", icons: ["infinity"] },
      { id: "zeromancer", name: "Zeromancer", license: "CC0-1.0", icons: ["heart-0"] },
    ]);
    // The same name under two authors is two icons, told apart by the author in the key.
    assert.deepEqual([...svgs.keys()].sort(), ["delapouite/bat", "lorc/bat", "lorc/wolf-head", "priorblue/rune-sword", "various-artists/infinity", "zeromancer/heart-0"]);
    for (const key of svgs.keys()) assert.match(key, ICON_KEY_RE);
    assert.equal(svgs.get("lorc/wolf-head"), shippedIconSvg("M10 20h30v-5z"));
  });

  test("drops the black square and gives the file an explicit size", () => {
    assert.equal(
      shippedIconSvg("M10 20h30v-5z"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><path d="M10 20h30v-5z"/></svg>\n',
    );
  });

  test("an author folder neither license.txt nor the script names stops the build", () => {
    assert.throws(() => buildIconSet(fixture([{ path: "newcomer/axe.svg", text: upstream("M1 1z") }]), "c"), /newcomer/);
  });

  test("an author license.txt stops listing stops the build", () => {
    const files = fixture().map((f) => (f.path === "license.txt" ? { ...f, text: LICENSE.replace("- PriorBlue\n", "") } : f));
    assert.throws(() => buildIconSet(files, "c"), /PriorBlue/);
  });

  test("a file of another shape, a nested file or a name the key rule refuses stops the build", () => {
    const script = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M0 0h512v512H0z"/><path fill="#fff" d="M1 1z"/><script>x()</script></svg>';
    assert.throws(() => buildIconSet(fixture([{ path: "lorc/evil.svg", text: script }]), "c"), /shape/);
    assert.throws(() => buildIconSet(fixture([{ path: "lorc/sub/axe.svg", text: upstream("M1 1z") }]), "c"), /nested/);
    assert.throws(() => buildIconSet(fixture([{ path: "lorc/Axe.svg", text: upstream("M1 1z") }]), "c"), /icon key/);
    assert.throws(() => buildIconSet(fixture([{ path: "lorc/notes.txt", text: "hi" }]), "c"), /not an SVG/);
    assert.throws(() => buildIconSet(fixture().filter((f) => f.path !== "license.txt"), "c"), /license\.txt/);
  });

  test("a title comes from the name", () => {
    assert.equal(iconTitle("wolf-head"), "Wolf head");
    assert.equal(iconTitle("heart-0"), "Heart 0");
    assert.equal(iconTitle("bat"), "Bat");
  });

  test("the generated module carries the folder, the total and each author's count", () => {
    const { index } = buildIconSet(fixture(), "82d948812bfe3f269ef8f731dcdb07b08160edc4");
    const source = gameIconsModule(index, "/game-icons/82d94881");
    assert.match(source, /export const GAME_ICONS_DIR = "\/game-icons\/82d94881";/);
    assert.match(source, /export const GAME_ICONS_TOTAL = 6;/);
    assert.match(source, /\{ id: "lorc", name: "Lorc", url: "http:\/\/lorcblog\.blogspot\.com", license: "CC-BY-3\.0", icons: 2 \},/);
    assert.match(source, /\{ id: "priorblue", name: "PriorBlue", license: "CC-BY-3\.0", icons: 1 \},/);
  });
});
