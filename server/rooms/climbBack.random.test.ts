import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, BREE, GROUND, UPPER, putOp, thornToken, tower, withOpening } from "#shared/floorLinksTestutil.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { LINK_WORDS } from "#shared/rules/floorLinks.ts";
import { DM } from "#shared/testutil.ts";
import { UndoTable } from "./undoTesting.ts";

/*
 * A player's undo and redo of a climb or a fall are judged by what they are
 * shown of both ends (docs/design/design-v1-floors.md phase 2, 8, phase 4,
 * 4.5): the kind, each end's squares and hex shape, unlocked, both held, and
 * the climber's space, never the ends' `rev` or `made`. Twin rooms apart only
 * in a DM edit of the pair made and put back while Ana held one end at most
 * give her the same answers and copies.
 *
 * The tower (shared/floorLinksTestutil.ts): stairs l1 on Ground floor at 3, 3,
 * 2 by 1, up to l2 on Upper floor, and an opening o1 on Upper floor at 6, 6
 * over o2 on Ground floor. Ana owns Thorn.
 */

const climb = (linkId = "l1"): Op => ({ t: "token.climb", tokenId: "thorn", linkId });

/** The tower with its stairs, on Thorn's turn, every op played through the table so twins share every seq. */
function stairs(over: Partial<RoomState> = {}): UndoTable {
  const t = new UndoTable(tower(over));
  for (const op of [{ t: "encounter.start", entries: [{ id: "n1", tokenId: "thorn", value: 20 }] }, { t: "encounter.next" }, putOp()] as Op[]) assert.equal(t.play(DM, op), "ok", op.t);
  return t;
}

/** The tower with its opening and Thorn beside it on Upper floor, on his turn. */
function hole(): UndoTable {
  const t = new UndoTable(withOpening(tower({ tokens: { thorn: thornToken({ sceneId: UPPER, x: 4, y: 6 }) } })));
  for (const op of [{ t: "encounter.start", entries: [{ id: "n1", tokenId: "thorn", value: 20 }] }, { t: "encounter.next" }] as Op[]) assert.equal(t.play(DM, op), "ok", op.t);
  return t;
}

/** Fog on or off a floor, where no light or sight reveals anything, so its ends reach no player. */
function fog(t: UndoTable, sceneId: string, on: boolean): void {
  t.state = { ...t.state, scenes: { ...t.state.scenes, [sceneId]: { ...t.state.scenes[sceneId]!, fogEnabled: on } } };
}

/** Every player's whole copy of every floor they hold. */
function copies(t: UndoTable, players: readonly Viewer[] = [ANA, BREE]): unknown[] {
  return players.map((who) => projectState(t.state, who, { sceneId: null }));
}

/** A DM edit of a pair and the edit that puts it back. */
type Edit = { name: string; there: Op; back: Op };

function stairsEdits(): Edit[] {
  const update = (patch: Record<string, unknown>): Op => ({ t: "floorLink.update", linkId: "l1", patch }) as Op;
  return [
    { name: "the far end moved a square and back", there: update({ pairRect: { x: 4, y: 4, w: 2, h: 1 } }), back: update({ pairRect: { x: 3, y: 3, w: 2, h: 1 } }) },
    { name: "both ends moved and back", there: update({ rect: { x: 8, y: 8, w: 2, h: 1 }, pairRect: { x: 8, y: 8, w: 2, h: 1 } }), back: update({ rect: { x: 3, y: 3, w: 2, h: 1 }, pairRect: { x: 3, y: 3, w: 2, h: 1 } }) },
    { name: "locked and unlocked", there: update({ locked: true }), back: update({ locked: false }) },
    { name: "hidden and shown", there: update({ hidden: true }), back: update({ hidden: false }) },
    { name: "turned to a ladder and back", there: update({ kind: "ladder" }), back: update({ kind: "stairs" }) },
  ];
}

const openingMove = (x: number): Op => ({ t: "floorLink.update", linkId: "o1", patch: { rect: { x, y: 6, w: 2, h: 2 } } }) as Op;

describe("a climb's undo and redo by the ends as shown (STAIRS-REV-1)", () => {
  for (const edit of stairsEdits()) {
    for (const from of ["undo", "redo"] as const) {
      test(`${edit.name} while Ana holds one end at most, then shown to her again: her ${from} is taken in both twins`, () => {
        const [a, b] = [stairs(), stairs()];
        for (const t of [a, b]) {
          assert.equal(t.play(ANA, climb()), "ok");
          if (from === "redo") assert.equal(t.undo(ANA), "ok");
          // Thorn stands on the floor the restore starts from, so the far end is the one fog withholds.
          fog(t, from === "undo" ? GROUND : UPPER, true);
        }
        assert.equal(a.play(DM, edit.there), "ok", edit.name);
        assert.equal(a.play(DM, edit.back), "ok", `${edit.name}: back`);
        assert.notEqual(a.state.floorLinks!.l1!.rev, b.state.floorLinks!.l1!.rev, "the twins' ends differ by rev alone");
        for (const t of [a, b]) fog(t, from === "undo" ? GROUND : UPPER, false);
        assert.deepEqual(copies(a), copies(b), "every player's copy before the answer");
        const answers = [a, b].map((t) => t.restore(ANA, from));
        assert.deepEqual(answers, ["ok", "ok"], from);
        assert.deepEqual(copies(a), copies(b), "every player's copy after it");
      });
    }
  }

  test("an end left moved a square, locked, or a ladder: the stairs changed in both twins, named as Ana is shown them", () => {
    const update = (patch: Record<string, unknown>): Op => ({ t: "floorLink.update", linkId: "l1", patch }) as Op;
    for (const [patch, words] of [
      [{ pairRect: { x: 4, y: 3, w: 2, h: 1 } }, LINK_WORDS.changed("stairs")],
      [{ locked: true }, LINK_WORDS.changed("stairs")],
      [{ kind: "ladder" }, LINK_WORDS.changed("ladder")],
    ] as const) {
      const t = stairs();
      assert.equal(t.play(ANA, climb()), "ok");
      assert.equal(t.play(DM, update(patch)), "ok");
      assert.equal(t.undo(ANA), words, JSON.stringify(patch));
      assert.equal(t.state.tokens.thorn!.sceneId, UPPER);
    }
  });

  test("a redo with the far end left moved a square, Thorn's end as it was: the stairs changed", () => {
    const t = stairs();
    assert.equal(t.play(ANA, climb()), "ok");
    assert.equal(t.undo(ANA), "ok");
    assert.equal(t.play(DM, { t: "floorLink.update", linkId: "l1", patch: { pairRect: { x: 5, y: 3, w: 2, h: 1 } } } as Op), "ok");
    assert.equal(t.redo(ANA), LINK_WORDS.changed("stairs"));
    assert.equal(t.state.tokens.thorn!.sceneId, GROUND);
  });

  test("stairs removed and placed again with the same ids on the same squares are the stairs Ana was shown: her undo is taken", () => {
    const t = stairs();
    assert.equal(t.play(ANA, climb()), "ok");
    assert.equal(t.play(DM, { t: "floorLink.delete", linkId: "l1" }), "ok");
    assert.equal(t.play(DM, putOp()), "ok");
    assert.equal(t.undo(ANA), "ok");
    assert.equal(t.state.tokens.thorn!.sceneId, GROUND);
  });

  test("a step whose record carries no shown ends, as one stored before change format 65, is judged by rev and made as it was", () => {
    const t = stairs();
    assert.equal(t.play(ANA, climb()), "ok");
    const step = t.stacks.peek("p1", "undo")!;
    assert.ok(step.climb?.shown, "a new climb's record carries the ends as shown");
    assert.deepEqual(step.climb.shown, { kind: "stairs", rect: { x: 3, y: 3, w: 2, h: 1 }, pairRect: { x: 3, y: 3, w: 2, h: 1 } });
    delete step.climb.shown;
    assert.equal(t.play(DM, { t: "floorLink.update", linkId: "l1", patch: { locked: true } }), "ok");
    assert.equal(t.play(DM, { t: "floorLink.update", linkId: "l1", patch: { locked: false } }), "ok");
    assert.equal(t.undo(ANA), LINK_WORDS.changed("stairs"));
  });
});

describe("a fall's undo and redo by the ends as shown (STAIRS-REV-1, phase 4 4.5)", () => {
  for (const from of ["undo", "redo"] as const) {
    test(`the opening moved a square and back while Ana holds one end: her ${from} is taken in both twins`, () => {
      const [a, b] = [hole(), hole()];
      for (const t of [a, b]) {
        assert.equal(t.play(ANA, { t: "token.move", tokenId: "thorn", x: 6, y: 6 }), "ok");
        assert.equal(t.state.tokens.thorn!.sceneId, GROUND, "Thorn fell");
        if (from === "redo") assert.equal(t.undo(ANA), "ok");
        fog(t, from === "undo" ? UPPER : GROUND, true);
      }
      const step = a.stacks.peek("p1", from)!;
      assert.deepEqual(step.falls?.[0]?.shown, { kind: "opening", rect: { x: 6, y: 6, w: 2, h: 2 }, pairRect: { x: 6, y: 6, w: 2, h: 2 } });
      assert.equal(a.play(DM, openingMove(7)), "ok");
      assert.equal(a.play(DM, openingMove(6)), "ok");
      for (const t of [a, b]) fog(t, from === "undo" ? UPPER : GROUND, false);
      assert.deepEqual(copies(a), copies(b), "before the answer");
      assert.deepEqual(
        [a, b].map((t) => t.restore(ANA, from)),
        ["ok", "ok"],
      );
      assert.deepEqual(copies(a), copies(b), "after it");
    });
  }

  test("the opening left moved a square: the opening changed in both directions", () => {
    for (const from of ["undo", "redo"] as const) {
      const t = hole();
      assert.equal(t.play(ANA, { t: "token.move", tokenId: "thorn", x: 6, y: 6 }), "ok");
      if (from === "redo") assert.equal(t.undo(ANA), "ok");
      assert.equal(t.play(DM, openingMove(9)), "ok");
      assert.equal(t.restore(ANA, from), LINK_WORDS.changed("opening"), from);
    }
  });
});

/** A small seeded generator, so a failing run names its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** The pair as stored, but for its revs. */
function stableLinks(t: UndoTable): string {
  return JSON.stringify(Object.values(t.state.floorLinks ?? {}).map(({ rev: _rev, ...rest }) => rest));
}

/** Whether Ana's copy holds both ends of the stairs now. */
function holdsBoth(t: UndoTable): boolean {
  const copy = projectState(t.state, ANA, { sceneId: null }) as unknown as { floorLinks?: Record<string, unknown> };
  return copy.floorLinks?.l1 !== undefined && copy.floorLinks?.l2 !== undefined;
}

describe("climbBack.random: Ana's answers and copies are the same whatever the DM did and put back while an end was withheld", () => {
  const SEEDS = 80;
  const STEPS = 60;
  for (let seed = 1; seed <= SEEDS; seed++) {
    test(`seed ${seed}`, () => {
      const next = rng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
      const [a, b] = [stairs(), stairs()];
      const fogged: Record<string, boolean> = { [GROUND]: false, [UPPER]: false };
      const log: string[] = [];
      for (let i = 0; i < STEPS; i++) {
        const roll = next();
        let kind: string;
        if (roll < 0.2) {
          kind = "climb";
          const linkId = a.state.tokens.thorn!.sceneId === GROUND ? "l1" : "l2";
          const answers = [a, b].map((t) => t.play(ANA, climb(linkId)));
          assert.equal(answers[0], answers[1], `seed ${seed} step ${i} climb: ${log.join(", ")}`);
        } else if (roll < 0.38) {
          kind = "undo";
          assert.equal(a.undo(ANA), b.undo(ANA), `seed ${seed} step ${i} undo: ${log.join(", ")}`);
        } else if (roll < 0.52) {
          kind = "redo";
          assert.equal(a.redo(ANA), b.redo(ANA), `seed ${seed} step ${i} redo: ${log.join(", ")}`);
        } else if (roll < 0.72) {
          // Mostly the floor Thorn is not on, so his end stays shown and the far one is withheld.
          const here = a.state.tokens.thorn!.sceneId;
          const floor = next() < 0.8 ? (here === GROUND ? UPPER : GROUND) : here;
          fogged[floor] = !fogged[floor];
          kind = `fog ${floor} ${fogged[floor] ? "on" : "off"}`;
          for (const t of [a, b]) fog(t, floor, fogged[floor]);
        } else {
          // An edit run on the pair: made and put back at once in A while Ana holds one end at most, skipped in B.
          // Otherwise both twins make one half of it, so the pair may stay edited until a later run puts it back.
          const edit = pick(stairsEdits());
          if (!holdsBoth(a)) {
            kind = `${edit.name} in A unseen`;
            const before = stableLinks(a);
            const made = [a.play(DM, edit.there), a.play(DM, edit.back)];
            // A run that could not be made, or did not put the pair back as it was, is not one twin B may skip.
            if (made.some((m) => m !== "ok") || stableLinks(a) !== before) for (const op of [edit.there, edit.back]) b.play(DM, op);
          } else {
            const half = next() < 0.5 ? edit.there : edit.back;
            kind = `${edit.name}, ${half === edit.there ? "made" : "put back"} in both`;
            assert.equal(a.play(DM, half), b.play(DM, half), kind);
          }
        }
        log.push(kind);
        assert.deepEqual(copies(a), copies(b), `seed ${seed} step ${i}: copies after ${log.join(", ")}`);
      }
    });
  }
});
