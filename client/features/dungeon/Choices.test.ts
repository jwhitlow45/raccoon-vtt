import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, MAX_HEX_ROOMS, type DungeonSettings, type GridKind } from "./settings.ts";
import { HEIGHTS_HELP, HEX_THEME_NOTE, KEY_FULL, SECRETS_CAVE, WIDE_HELP, WIDE_HELP_HEX, WING_FLAT } from "./words.ts";

const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { Choices, roomsLimit } = await import("./Choices.tsx");
const { changed } = await import("./GenerateDialog.tsx");

/*
 * The shared choice rows (phase 3, 3.3 and 7, D-261110-239): the dialog's
 * and the wing pane's, speaking of hexes on hexes and of an area on a wing.
 */

const nothing = () => {};
function draw(over: Partial<DungeonSettings> = {}, props: { grid?: GridKind; wing?: boolean; held?: boolean; flat?: boolean; keyHeld?: boolean; seed?: boolean } = {}): string {
  return renderToStaticMarkup(
    h(Choices, {
      value: { ...DEFAULT_SETTINGS, ...over },
      onChange: nothing,
      held: props.held ?? false,
      grid: props.grid ?? "squares",
      wing: props.wing ?? false,
      ...(props.flat ? { flat: true } : {}),
      ...(props.keyHeld ? { keyHeld: true } : {}),
      ...(props.seed ? { seed: { text: "9K7Q-H2MX-A9F3-TWQ5", onChange: nothing } } : {}),
    }),
  );
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'");

test("on hexes Theme says walls show the rooms and Corridor width speaks of hex sides", () => {
  const squares = text(draw());
  const rows = text(draw({}, { grid: "hexRows" }));
  const columns = text(draw({}, { grid: "hexColumns" }));
  assert.ok(!squares.includes(HEX_THEME_NOTE));
  assert.ok(squares.includes(WIDE_HELP));
  for (const hex of [rows, columns]) {
    assert.ok(hex.includes(HEX_THEME_NOTE));
    assert.ok(hex.includes(WIDE_HELP_HEX));
    assert.ok(!hex.includes(WIDE_HELP));
  }
});

test("Rooms stop at 24 on hexes, the size's cap on squares, and a wing's hint names its area", () => {
  assert.equal(roomsLimit({ w: 80, h: 80 }, "squares"), 40);
  assert.equal(roomsLimit({ w: 80, h: 80 }, "hexRows"), MAX_HEX_ROOMS);
  assert.equal(roomsLimit({ w: 30, h: 30 }, "hexRows"), 10);
  assert.match(text(draw({ w: 80, h: 80, rooms: 30 }, { grid: "hexRows" })), /2 to 24 on this size\./);
  assert.match(draw({ w: 80, h: 80, rooms: 30 }, { grid: "hexRows" }), /value="24"/);
  assert.match(text(draw({ w: 30, h: 44 }, { wing: true })), /2 to 14 in this area\. Fewer fit when the layout is tight\./);
});

test("a flat wing holds Heights at Flat with its line and keeps the DM's pick", () => {
  const flat = draw({ heights: 50 }, { wing: true, flat: true });
  assert.ok(text(flat).includes(WING_FLAT));
  assert.ok(!text(flat).includes(HEIGHTS_HELP));
  const slider = flat.match(/<input[^>]*aria-valuetext="Flat"[^>]*>/)?.[0] ?? "";
  assert.match(slider, /\svalue="0"/, "the slider itself at Flat");
  assert.match(draw({ heights: 50 }, { wing: true }), /aria-valuetext="About \d+ rooms? of \d+ off flat ground"/);
});

test("Cave holds Secret doors with its line, a held key reads off, and held rows are natively off", () => {
  assert.ok(text(draw({ theme: "cave", secrets: 4 })).includes(SECRETS_CAVE));
  assert.ok(text(draw({}, { keyHeld: true })).includes(KEY_FULL));
  assert.match(draw({}, { held: true }), /<fieldset disabled=""/);
  assert.doesNotMatch(draw(), /<fieldset disabled=""[^>]*><div data-choice="theme"/);
});

test("the seed row comes only when asked for, as the pane's five props leave it out", () => {
  assert.doesNotMatch(draw(), /Copy seed/);
  assert.match(draw({}, { seed: true }), /Copy seed/);
});

test("a row change patches only what it changed, so a Rooms past the cap stays the DM's", () => {
  const before = { ...DEFAULT_SETTINGS, rooms: 27 };
  assert.deepEqual(changed(before, { ...before, density: "dense" }), { density: "dense" });
  assert.deepEqual(changed(before, { ...before, rooms: 5, w: 99 }), { rooms: 5 });
});

/*
 * DSTOCK (docs/design/design-v1-dungeon-stock.md 1): the Monsters rows after
 * Dressing and before DM key, held at None without a leveled party, and the
 * Party level row held while it follows the party.
 */
const { MONSTERS_HELD, MONSTERS_HELP, MONSTERS_THEME, SEED_HELP, SEED_HELP_STOCKED } = await import("./words.ts");

function stocked(stock: { monsters?: number; held?: boolean; edited?: boolean; band?: { held: boolean; lines: string[] }; theme?: DungeonSettings["theme"]; traps?: number } = {}): string {
  return renderToStaticMarkup(
    h(Choices, {
      value: { ...DEFAULT_SETTINGS, theme: stock.theme ?? "dungeon", traps: stock.traps ?? 2 },
      onChange: nothing,
      held: false,
      grid: "squares",
      wing: false,
      seed: { text: "9K7Q-H2MX-A9F3-TWQ5", onChange: nothing },
      stock: { value: { monsters: stock.monsters ?? 50, difficulty: "moderate" }, onChange: nothing, held: stock.held ?? false, edited: stock.edited ?? false, groups: [{ count: 4, level: 3 }], party: h("p", null, "PARTY-SLOT"), below: h("p", null, "BELOW-SLOT") },
      ...(stock.band ? { band: stock.band } : {}),
    }),
  );
}

test("DSTOCK-C: above None the rows stand after Dressing and before DM key, with the help, the theme's line, the live budget and the party", () => {
  const html = stocked();
  const words = text(html);
  assert.ok(words.indexOf("Dressing") < words.indexOf("Monsters") && words.indexOf("Monsters") < words.indexOf("DM key"));
  assert.ok(words.includes(MONSTERS_HELP) && words.includes(MONSTERS_THEME.dungeon));
  assert.match(words, /About 6 rooms of 12 get monsters/);
  assert.ok(words.includes("Moderate: 900 XP a room for 4 characters at level 3."));
  assert.ok(words.includes("PARTY-SLOT") && words.includes("BELOW-SLOT"));
  assert.ok(words.includes(SEED_HELP_STOCKED), "the seed's promise names the party");
  assert.ok(text(stocked({ theme: "sewer" })).includes(MONSTERS_THEME.sewer));
});

test("DSTOCK-C: at None the rows are Monsters alone, and the seed's promise is as it was", () => {
  const words = text(stocked({ monsters: 0 }));
  assert.match(words, /No monsters/);
  assert.ok(!words.includes("Difficulty") && !words.includes("PARTY-SLOT") && !words.includes(MONSTERS_HELP));
  assert.ok(words.includes(SEED_HELP) && !words.includes(SEED_HELP_STOCKED));
});

test("DSTOCK-C: with no leveled party Monsters is held at None with its line and the party under it, the DM's pick kept", () => {
  const html = stocked({ held: true });
  const words = text(html);
  assert.ok(words.includes(MONSTERS_HELD));
  assert.ok(words.includes("PARTY-SLOT"), "the party to give a level to");
  assert.ok(!words.includes("Difficulty"));
  const slider = html.match(/<input[^>]*aria-valuetext="No monsters"[^>]*>/)?.[0] ?? "";
  assert.match(slider, /disabled=""/);
  assert.ok(words.includes(SEED_HELP) && !words.includes(SEED_HELP_STOCKED));
});

test("DSTOCK-C: while the band follows the party, Party level is held with where it came from", () => {
  const html = stocked({ band: { held: true, lines: ["Set from the party: levels 1 to 4.", "The party is now level 5. The band moves when you next change the party or Monsters."] } });
  const words = text(html);
  assert.ok(words.includes("Set from the party: levels 1 to 4.") && words.includes("The party is now level 5."));
  const band = html.slice(html.indexOf("Party level"), html.indexOf("Set from the party"));
  assert.match(band, /disabled=""/, "the band's choices are held");
  const free = stocked({ band: { held: false, lines: ["Set from the party: levels 1 to 4."] } });
  assert.ok(!text(free).includes("Set from the party"));
  assert.doesNotMatch(free.slice(free.indexOf("Party level"), free.indexOf("Secret doors")), /disabled=""/);
});

test("DSTOCK-C: an edited party keeps its rows at None, so Edit the party never takes its steppers away (STOCK-O-01)", () => {
  const words = text(stocked({ monsters: 0, edited: true }));
  assert.ok(words.includes("PARTY-SLOT"), "the edited party stays");
  assert.ok(!words.includes("Difficulty"));
  assert.ok(!text(stocked({ monsters: 0 })).includes("PARTY-SLOT"), "the room's party at None shows no rows");
});
