import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type { RoomState } from "#shared/model.ts";
import { chance, effect, int, P1, pick, randomState, rng } from "#shared/testutil.ts";
import type { RoomView } from "../../state/types.ts";
import type { Catalog } from "./catalog/types.ts";
import type { SearchEntry } from "./entry.ts";
import { buildIndex, catalogsFor, searchResults } from "./index.ts";
import { DM_FIXTURE, keysOf, SRD, viewOf } from "./search.testutil.ts";

/**
 * A player's search holds only what that player may see and do
 * (designs/qol/search.md 5.9 and 7): random rooms with a word of their own
 * planted in every name, title and note, passed through the server's
 * projection for a player, and that player's index built from it as the
 * sheet builds it. Named invariants:
 *
 * 1. Every planted word an entry holds is one the projection holds too:
 *    the index holds nothing the player's device was not sent.
 * 2. No notes text is indexed, a note for everyone included.
 * 3. Every entry of the room's own names a record the projection holds,
 *    and a character's or a selection's fields only the player's own.
 * 4. No scene, monster, playlist or track is built for a player.
 * 5. The DM catalog's loader is never called, and nothing of a DM catalog
 *    (its entries, its menu items, its panel words) is in the index.
 * 6. Typing a planted word the projection lacks finds nothing.
 */

/** A planted word: ten letters from the room's own random source, unlike any word the app writes. */
function word(r: () => number): string {
  let out = "q";
  for (let i = 0; i < 9; i++) out += String.fromCharCode(97 + int(r, 0, 25));
  return out;
}

type Planted = { all: string[]; notes: string[] };

/** Plants a word in every name, title and note of the room, and the kinds random rooms lack. */
function plant(state: RoomState, r: () => number): Planted {
  const all: string[] = [];
  const notes: string[] = [];
  const named = () => {
    const w = word(r);
    all.push(w);
    return w;
  };
  const noted = () => {
    const w = word(r);
    notes.push(w);
    return `${w} note`;
  };
  for (const sc of Object.values(state.scenes)) sc.name = `${named()} hall`;
  for (const t of Object.values(state.tokens)) {
    t.name = named();
    if (t.publicName !== undefined || chance(r, 0.3)) t.publicName = named();
    t.notes = noted();
    if ("inline" in t.actor) {
      t.actor.inline.notes = noted();
      t.actor.inline.dmNotes = noted();
      t.actor.inline.senses = `Darkvision 60 ft. ${named()}`;
      t.actor.inline.effects.push(effect(`fx-${t.id}`, { key: "custom", label: named(), hiddenFromPlayers: chance(r, 0.5) }));
    }
  }
  for (const c of Object.values(state.characters)) {
    c.name = named();
    c.actor.notes = noted();
    c.actor.dmNotes = noted();
    c.actor.senses = named();
  }
  for (const m of Object.values(state.monsters)) m.name = named();
  for (const h of Object.values(state.handouts)) h.title = named();
  for (const d of Object.values(state.handoutDocs)) d.title = named();
  for (const l of Object.values(state.labels)) l.text = named();
  const access = ["dm", "all", { member: "p1" }, { member: "p2" }] as const;
  for (let i = 0; i < int(r, 1, 4); i++) {
    const id = `j${i}`;
    state.journal[id] = { id, rev: 0, title: named(), ...(chance(r, 0.5) ? { folder: named() } : null), access: pick(r, access), blocks: [{ id: "b1abcdefghij", text: noted() }] };
  }
  state.playlists = {};
  state.sounds = {};
  for (let i = 0; i < int(r, 0, 3); i++) {
    state.sounds[`so${i}`] = { id: `so${i}`, rev: 0, name: named(), assetId: `a${i}`, ms: 60_000, use: pick(r, ["music", "loop", "effect"] as const) };
    state.playlists[`pl${i}`] = { id: `pl${i}`, rev: 0, name: named(), sounds: [], repeat: "all", fade: 0 };
  }
  if (chance(r, 0.5)) state.meta.settings.soundNames = true;
  return { all, notes };
}

/** A DM catalog of planted words, so a leak of any part of it shows. */
function dmCanaries(r: () => number): { catalog: Catalog; words: string[] } {
  const words = [word(r), word(r), word(r), word(r)];
  const catalog: Catalog = {
    entries: [{ ...DM_FIXTURE.entries[0]!, id: `action:${words[0]}`, title: words[0]!, bets: [words[1]!] }],
    fields: [{ key: "secret", title: words[2]!, icon: "hidden", token: { anchor: "token.secret" }, page: { anchor: "character.secret" }, everyCharacter: true }],
    panels: { tracker: { names: [words[3]!] } },
    items: () => [{ id: `item:${words[0]}x`, kind: "action", title: `${words[3]} menu`, where: "DM menu", icon: "dm", act: { t: "item", itemId: "x", twin: { panel: "dm" } } }],
  };
  return { catalog, words };
}

function textOf(e: SearchEntry): string {
  return [e.title, e.where, e.value, e.mark, e.description, e.keys, ...(e.names ?? []), ...(e.bets ?? [])].filter((t) => t !== undefined).join(" ").toLowerCase();
}

/** Whether an entry of the room's own names a record the player's view holds, and a field or condition only of their own. */
function heldBy(id: string, view: NonNullable<RoomView["view"]>, owns: (tokenOrCharacter: string) => boolean, selectedId: string | null): boolean {
  const [kind, a, b] = id.split(":");
  switch (kind) {
    case "token":
      return a !== undefined && view.tokens[a] !== undefined;
    case "character":
      return a !== undefined && view.characters[a] !== undefined && owns(`character:${a}`);
    case "field":
      return a !== undefined && b !== undefined && (a === "token" ? view.tokens[b] !== undefined && b === selectedId && owns(`token:${b}`) : view.characters[b] !== undefined && owns(`character:${b}`));
    case "condition":
      return selectedId !== null && view.tokens[selectedId] !== undefined && owns(`token:${selectedId}`);
    case "page":
      return a !== undefined && view.journal[a] !== undefined;
    case "handout":
      return a !== undefined && view.handouts[a] !== undefined;
    default:
      return true;
  }
}

const ROOM_KINDS = new Set(["token", "character", "field", "condition", "page", "handout"]);
const DM_KINDS = new Set(["scene", "monster", "playlist", "track"]);

describe("a player's search holds only what that player may see and do (search.md 5.9)", () => {
  test("random rooms through the projection, with planted words everywhere", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), fc.boolean(), fc.boolean(), (seed, known, wide) => {
        const r = rng(seed);
        const state = randomState(r);
        const planted = plant(state, r);
        const tokenIds = Object.keys(state.tokens);
        const selectedId = chance(r, 0.7) && tokenIds.length > 0 ? pick(r, tokenIds) : null;
        const base = viewOf(state, P1, { selectedId });
        const view: RoomView = known ? base : { ...base, you: null };
        const projected = JSON.stringify(view.view).toLowerCase();

        const dm = dmCanaries(r);
        const loads: unknown[] = [];
        const { catalogs } = catalogsFor(view, { request: (role) => (loads.push(role), { status: "ready", catalog: dm.catalog }) });
        // The real catalogs as catalogsFor gives them. The sheet passes the SRD list it has to any role: a player's index must build no monster of it.
        const index = buildIndex({ state: view, wide, keys: keysOf(view), catalogs, monsters: SRD });

        assert.deepEqual(loads, [], "invariant 5: the DM catalog's loader was called");
        const memberId = view.you?.memberId ?? null;
        const v = view.view!;
        const owns = (key: string) => {
          if (memberId === null) return false;
          const [kind, id] = key.split(":");
          if (kind === "character") return (v.characters[id!]?.ownerIds ?? []).includes(memberId);
          const t = v.tokens[id!];
          if (!t) return false;
          if ((t.ownerIds ?? []).includes(memberId)) return true;
          return "ref" in t.actor && (v.characters[t.actor.ref]?.ownerIds ?? []).includes(memberId);
        };

        for (const { entry } of index.items) {
          const text = textOf(entry);
          for (const w of planted.all) if (text.includes(w)) assert.ok(projected.includes(w), `invariant 1: ${entry.id} holds "${w}", which the projection lacks`);
          for (const w of planted.notes) assert.ok(!text.includes(w), `invariant 2: ${entry.id} holds note text`);
          if (ROOM_KINDS.has(entry.id.split(":")[0]!)) assert.ok(heldBy(entry.id, v, owns, selectedId), `invariant 3: ${entry.id}`);
          assert.ok(!DM_KINDS.has(entry.kind), `invariant 4: ${entry.id}`);
          for (const w of dm.words) assert.ok(!text.includes(w), `invariant 5: ${entry.id} holds the DM catalog's "${w}"`);
        }

        for (const w of planted.all) {
          if (projected.includes(w)) continue;
          const out = searchResults(index, w, []);
          assert.deepEqual(out.t === "typed" && out.rows.map((e) => e.id), [], `invariant 6: "${w}"`);
        }
      }),
      { numRuns: 150 },
    );
  });

  test("the planting reaches the places it means to", () => {
    // A check on the check: some planted words are projected and some are not, so both halves of invariant 1 run.
    let both = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const r = rng(seed);
      const state = randomState(r);
      const planted = plant(state, r);
      const projected = JSON.stringify(viewOf(state, P1).view).toLowerCase();
      const shown = planted.all.filter((w) => projected.includes(w)).length;
      if (shown > 0 && shown < planted.all.length) both++;
    }
    assert.ok(both >= 15, `${both}`);
  });
});
