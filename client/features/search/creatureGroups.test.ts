import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DM, P1 } from "#shared/testutil.ts";
import { DM_CATALOG } from "./catalog/dm.ts";
import { EVERYONE } from "./catalog/everyone.ts";
import { routeFolds } from "./route.ts";
import { indexOf, seededRoom, viewOf } from "./search.testutil.ts";

/*
 * A token's and a character's groups in the room search (designs/qol/search.md
 * 4, 5.9): Position, Image, Owners and Stat block on the token panel, and
 * Stat block, Companions, Image and Players on a character's page. QE1 found
 * them with no entry and no anchor.
 */

const FIELDS = [...EVERYONE.fields, ...DM_CATALOG.fields];
const GROUPS = ["position", "image", "stat-block", "companions", "owners", "players"] as const;

const onToken = (key: string, token = "tbree") => `field:token:${token}:${key}`;
const onPage = (key: string, character = "bree") => `field:character:${character}:${key}`;

describe("a creature's groups in the search", () => {
  test("each group is a section field with a place whose fold the route opens, and the keys are unique", () => {
    for (const key of GROUPS) {
      const f = FIELDS.find((x) => x.key === key);
      assert.ok(f, key);
      assert.equal(f.kind, "section", key);
      assert.ok(f.token || f.page, key);
    }
    assert.equal(new Set(FIELDS.map((f) => f.key)).size, FIELDS.length, "field keys are unique");
    for (const f of FIELDS) {
      if (f.token?.section) assert.ok(routeFolds("token").includes(f.token.section), `${f.key}: token fold ${f.token.section}`);
      if (f.page?.section) assert.ok(routeFolds("characters", "character:bree").includes(f.page.section), `${f.key}: page fold ${f.page.section}`);
    }
  });

  test("a DM selecting a monster finds Position, Image, Owners and Stat block, and a character's Players", () => {
    const room = seededRoom();
    room.tokens.g1 = { ...room.tokens.g1!, kind: "monster" };
    const dm = indexOf(viewOf(room, DM, { selectedId: "g1" }));
    for (const key of ["position", "image", "owners", "stat-block"]) assert.ok(dm.byId.has(onToken(key, "g1")), key);
    assert.ok(!dm.byId.has(onToken("players", "g1")) && !dm.byId.has(onToken("companions", "g1")), "a token has neither Players nor Companions");
    assert.ok(dm.byId.has(onPage("players")), "Bree's Players");
    assert.ok(dm.byId.has(onPage("players", "kel")), "and every other character's");
    assert.deepEqual(dm.byId.get(onPage("players"))?.entry.act, { t: "character", characterId: "bree", route: { panel: "characters", page: "character:bree", section: "page.owners", anchor: "character.owners" } });
    assert.ok(!dm.byId.has(onPage("image")), "a DM finds a character's other groups through its token, not for every character");
  });

  test("a player finds their own character's groups, and never Owners or Players", () => {
    const pat = indexOf(viewOf(seededRoom(), P1, { selectedId: "tbree" }));
    for (const key of ["position", "image", "stat-block"]) assert.ok(pat.byId.has(onToken(key)), `token ${key}`);
    assert.ok(pat.byId.has(onPage("companions")), "Companions is the page's alone");
    assert.ok(!pat.byId.has(onPage("image")) && !pat.byId.has(onPage("stat-block")), "the token's rows stand for the page's twins");
    const away = indexOf(viewOf(seededRoom(), P1));
    for (const key of ["companions", "image", "stat-block"]) assert.ok(away.byId.has(onPage(key)), `page ${key} with nothing selected`);
    assert.ok(!pat.byId.has(onPage("position")), "a page has no Position");
    for (const entry of pat.items.map((i) => i.entry)) {
      assert.ok(!/:(owners|players)$/.test(entry.id), entry.id);
      assert.ok(!entry.id.includes(":kel:"), entry.id);
    }
    assert.ok(!pat.byId.has(onPage("stat-block", "kel")) && !pat.byId.has(onPage("companions", "kel")), "nothing of another player's character");
  });

  test("a player's token of a monster without an SRD block draws no Stat block, so the search offers none", () => {
    const room = seededRoom();
    room.tokens.g1 = { ...room.tokens.g1!, ownerIds: ["p1"] };
    const without = indexOf(viewOf(room, P1, { selectedId: "g1" }));
    assert.ok(without.byId.has(onToken("position", "g1")), "Position is drawn for an owner");
    assert.ok(!without.byId.has(onToken("stat-block", "g1")));
    room.tokens.g1 = { ...room.tokens.g1!, actor: { inline: { ...(room.tokens.g1!.actor as { inline: object }).inline, srdId: "wolf" } as never } };
    assert.ok(indexOf(viewOf(room, P1, { selectedId: "g1" })).byId.has(onToken("stat-block", "g1")), "an SRD block is theirs to read");
  });

  test("a player selecting a token they do not own is offered none of the groups", () => {
    const pat = indexOf(viewOf(seededRoom(), P1, { selectedId: "tkel" }));
    assert.ok(![...pat.byId.keys()].some((id) => id.startsWith("field:token:")));
  });
});
