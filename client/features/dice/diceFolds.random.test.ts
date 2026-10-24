import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { NamedRoll } from "#shared/dice/bonus.ts";
import type { RollRequest, RoomState } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { castAsk, character, room, token } from "#shared/testutil.ts";
import { openedBlock } from "./cast/cast.ts";
import { createDiceFolds, DICE_FOLD_KEYS, DICE_FOLDS_KEY, foldKey, foldKind, type DiceFoldKey, type DiceFoldsStore } from "./diceFolds.ts";
import { groupAsks, openForAsks } from "./options.ts";
import type { CastBlock } from "./optionState.ts";

/*
 * The Dice panel's folds under random play (docs/design-v1-dice-pass.md 6.4):
 * asks and casts arriving and closing, the same spell's block reopened, its
 * send retried from the list above the card, taps on folds, the options
 * remounting, the panel switching creatures, a tablet turned across 900 px,
 * and "view as a player". Each render runs what the options run (options.ts
 * groupAsks and openForAsks) on the Room's folds.
 *
 * The invariants, after every step:
 * 1. An app opening never writes storage: only a tap on the page writes.
 * 2. A new ask or cast leaves its group open on the render that first sees it.
 * 3. A group nothing new waits in keeps its fold through a render, so one
 *    the viewer folded stays folded, whatever remounts.
 * 4. A tap is stored for its own kind and group only.
 * 5. Nothing is written while viewing as a player.
 * 6. A crossing of 900 px refolds nothing.
 */

/** A small seeded generator, so a failing sequence can be run again by its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function storage() {
  const items = new Map<string, string>();
  let writes = 0;
  return {
    items,
    writes: () => writes,
    getItem: (key: string) => items.get(key) ?? null,
    setItem(key: string, value: string) {
      writes++;
      items.set(key, value);
    },
  };
}

type Creature = { creature: ActorTarget; key: string; named: Pick<NamedRoll, "key" | "name" | "section">[] };

/** Pat's Thorn, his wolf, and the DM's NPC lent to him: a pc, a companion and a monster. */
const CREATURES: Creature[] = [
  {
    creature: { characterId: "thorn" },
    key: "c:thorn",
    named: [
      { key: "s:fireball", name: "Fireball", section: "spells" },
      { key: "s:hold", name: "Hold Person", section: "spells" },
      { key: "a:mace", name: "Mace", section: "actions" },
    ],
  },
  { creature: { tokenId: "wolf" }, key: "t:wolf", named: [{ key: "a:bite", name: "Bite", section: "actions" }] },
  {
    creature: { tokenId: "sildar" },
    key: "t:sildar",
    named: [
      { key: "a:club", name: "Club", section: "actions" },
      { key: "b:shove", name: "Shove", section: "bonusActions" },
    ],
  },
];

const TESTS: RollRequest["test"][] = [
  { kind: "save", choices: [{ ability: "dex" }] },
  { kind: "check", choices: [{ ability: "str" }] },
  { kind: "check", choices: [{ ability: "wis", skill: "perception" }] },
  { kind: "save", choices: [{ ability: "wis" }, { ability: "con" }] },
];

function table(): RoomState {
  return room({
    characters: { thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"] }) },
    tokens: {
      tt: token("tt", { kind: "pc", name: "Thorn", ownerIds: ["p1"], actor: { ref: "thorn" } }),
      wolf: token("wolf", { kind: "monster", name: "Wolf", ownerIds: ["p1"], companion: { of: "thorn", turn: "own" } }),
      sildar: token("sildar", { kind: "npc", name: "Sildar", ownerIds: ["p1"] }),
    },
  });
}

const COMPUTER = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** What a step newly put in a creature's group, which the next render of that creature on a page must show open. */
type Pending = { tag: string; creature: string; group: string };

/** The groups a request opens: Saves and checks for a save or a plain check, Skills for a skill. */
function groupsOf(test: RollRequest["test"]): string[] {
  return [...new Set(test.choices.map((c) => (test.kind === "check" && c.skill ? "skills" : "saves")))];
}

function run(seed: number, steps: number): void {
  const random = rng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const where = (step: number, what: string) => `seed ${seed}, step ${step}: ${what}`;

  const device = storage();
  const layout = random() < 0.5 ? COMPUTER : PHONE;
  // The Room page and its "view as a player" preview, each with a scope of its own, over one device's storage.
  const page = createDiceFolds(device);
  const preview = createDiceFolds({ getItem: (k) => device.getItem(k), setItem: () => assert.fail("the preview wrote storage") });
  page.get(layout);
  preview.get(layout);
  /*
   * What each page has yet to see, kept from the steps alone and not from
   * the ids the options compute, so a wrong id (a reopened block that reads
   * as the old one, a sent ask that reads as new) fails here.
   */
  const pending = new Map<DiceFoldsStore, Pending[]>([
    [page, []],
    [preview, []],
  ]);
  const add = (stores: DiceFoldsStore[], entries: Pending[]) => {
    for (const store of stores) pending.get(store)!.push(...entries);
  };
  const drop = (tag: string, stores: DiceFoldsStore[] = [page, preview]) => {
    for (const store of stores) pending.set(store, pending.get(store)!.filter((p) => p.tag !== tag));
  };
  const state = table();
  // The block lives in the page's option store: the preview, another Room, never sees it.
  let options: { openings: number; cast: CastBlock | null } = { openings: 0, cast: null };
  let shown = pick(CREATURES);
  let viewing: DiceFoldsStore = page;
  let ids = 0;
  const casterOf = (c: Creature) => ("tokenId" in c.creature ? c.creature.tokenId : "tt");

  const render = (step: number) => {
    const before = viewing.get(layout);
    const writes = device.writes();
    const kind = foldKind(state, shown.creature);
    const due = pending.get(viewing)!.filter((p) => p.creature === shown.key);
    const opens = new Set<DiceFoldKey>(due.map((p) => foldKey(kind, p.group as never)));
    openForAsks(viewing, kind, groupAsks({ state, creature: shown.creature, named: shown.named, cast: viewing === page ? options.cast : null }));
    const after = viewing.get(layout);
    assert.equal(device.writes(), writes, where(step, "an opening wrote storage"));
    for (const key of DICE_FOLD_KEYS) {
      if (opens.has(key)) assert.equal(after[key], true, where(step, `${key} holds something new and shows folded`));
      else assert.equal(after[key], before[key], where(step, `${key} changed with nothing new in it`));
    }
    pending.set(viewing, pending.get(viewing)!.filter((p) => p.creature !== shown.key));
  };

  for (let step = 0; step < steps; step++) {
    const roll = random();
    if (roll < 0.14) {
      // An ask arrives for one of the three, the lent NPC's among them.
      const target = pick(CREATURES);
      const id = `r${++ids}`;
      const test = pick(TESTS);
      state.rolls[id] = { id, rev: 0, test, dcShown: false, resultShown: true, at: "2026-10-23T20:00:00.000Z", targets: ["characterId" in target.creature ? { characterId: target.creature.characterId } : { tokenId: target.creature.tokenId }] };
      add([page, preview], groupsOf(test).map((group) => ({ tag: id, creature: target.key, group })));
    } else if (roll < 0.22) {
      // An ask is answered or withdrawn.
      const open = Object.keys(state.rolls);
      if (open.length > 0) {
        const id = pick(open);
        delete state.rolls[id];
        drop(id);
      }
    } else if (roll < 0.34) {
      // On the page, a player opens a block on a row, or on the same spell again, which is a new opening. It pins the panel to its creature.
      if (viewing === page) {
        const owner = pick(CREATURES);
        const row = pick(owner.named);
        if (options.cast) drop(`open:${options.cast.opened}`, [page]);
        options = { ...options, ...openedBlock(options, { key: owner.key, creature: owner.creature, spell: row.name, roll: row.key }) };
        add([page], [{ tag: `open:${options.cast!.opened}`, creature: owner.key, group: row.section }]);
        shown = owner;
      }
    } else if (roll < 0.4) {
      // The block's ask goes from the block on screen, under its row in an open group, and once it waits in the view the block closes. It is new only to the preview.
      const cast = options.cast;
      const owner = CREATURES.find((c) => c.key === cast?.key);
      const section = owner?.named.find((r) => r.key === cast?.roll)?.section;
      if (cast && owner && section && viewing === page && shown === owner && page.get(layout)[foldKey(foldKind(state, owner.creature), section)]) {
        const id = `k${++ids}`;
        options = { ...options, cast: { ...cast, sent: id } };
        render(step);
        state.casts[id] = castAsk(id, { caster: casterOf(owner), spell: cast.spell, roll: cast.roll, area: undefined });
        options = { ...options, cast: null };
        add([preview], [{ tag: id, creature: owner.key, group: section }]);
      }
    } else if (roll < 0.45) {
      // An ask for saves first seen in the view, as after a reload, or one resolved.
      const open = Object.keys(state.casts);
      if (open.length > 0 && random() < 0.5) {
        const id = pick(open);
        delete state.casts[id];
        drop(id);
      } else {
        const owner = pick(CREATURES);
        const row = pick(owner.named);
        const id = `k${++ids}`;
        state.casts[id] = castAsk(id, { caster: casterOf(owner), spell: row.name, roll: row.key, area: undefined });
        add([page, preview], [{ tag: id, creature: owner.key, group: row.section }]);
      }
    } else if (roll < 0.5) {
      if (options.cast) drop(`open:${options.cast.opened}`, [page]);
      options = { ...options, cast: null };
    } else if (roll < 0.7) {
      // A tap on a fold row: stored on the page, never in the preview, and only for its own key.
      const key = pick(DICE_FOLD_KEYS);
      const open = !viewing.get(layout)[key];
      const before = JSON.parse(device.getItem(DICE_FOLDS_KEY) ?? "{}") as Record<string, boolean>;
      const writes = device.writes();
      viewing.tap(key, open, viewing === page);
      assert.equal(viewing.get(layout)[key], open, where(step, "a tap shows at once"));
      if (viewing === page) {
        assert.deepEqual(JSON.parse(device.getItem(DICE_FOLDS_KEY) ?? "{}"), { ...before, [key]: open }, where(step, `a tap on ${key} stored something else`));
      } else assert.equal(device.writes(), writes, where(step, "a preview's tap wrote storage"));
    } else if (roll < 0.8) {
      // The panel shows another creature: a tab pick, which remounts the options, or a selection.
      shown = pick(CREATURES);
    } else if (roll < 0.85) {
      // A tablet turned across 900 px reads the folds already resolved.
      assert.equal(viewing.get(layout === COMPUTER ? PHONE : COMPUTER), viewing.get(layout), where(step, "a crossing resolved the folds again"));
    } else if (roll < 0.9) {
      viewing = viewing === page ? preview : page;
    } else if (roll < 0.95) {
      // Ask again in the list above the card, which shows whatever creature the panel shows, with the block's group open or folded: the block follows the retry, nothing new to the page. Taken while its creature shows, the ask waits in the view and the block closes, new only to the preview.
      const cast = options.cast;
      const owner = CREATURES.find((c) => c.key === cast?.key);
      const section = owner?.named.find((r) => r.key === cast?.roll)?.section;
      if (cast && owner && section && viewing === page) {
        const id = `k${++ids}`;
        options = { ...options, cast: { ...cast, sent: id } };
        if (shown === owner && random() < 0.5) {
          render(step);
          state.casts[id] = castAsk(id, { caster: casterOf(owner), spell: cast.spell, roll: cast.roll, area: undefined });
          options = { ...options, cast: null };
          add([preview], [{ tag: id, creature: owner.key, group: section }]);
        }
      }
    }
    // Anything else is the options remounting or a render with nothing new: it reads the same Room's folds.
    render(step);
  }
}

describe("the Dice panel's folds under random play", () => {
  test("400 random sequences of asks, casts, taps, remounts, kind switches, crossings and previews keep every invariant", () => {
    for (let seed = 1; seed <= 400; seed++) run(seed, 60);
  });
});
