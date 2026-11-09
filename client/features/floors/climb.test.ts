import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, BREE, GROUND, UPPER, thornToken, tower, withStairs } from "#shared/floorLinksTestutil.ts";
import type { FloorLink, RoomState, Token } from "#shared/model.ts";
import { LINK_WORDS } from "#shared/rules/floorLinks.ts";
import { DM, token } from "#shared/testutil.ts";
import { createStore } from "zustand/vanilla";
import { climbKey, climbOffer, climbWaiting, notOnStairsThatWay, sendClimb, type ClimbWait } from "./climb.ts";

/*
 * Go up and Go down's offer and the one wait (docs/design/design-v1-floors.md
 * phase 2, 6.1, 6.2, 6.4), on the shared tower: stairs from Ground floor
 * (l1, 2 by 1 at 3, 3) up to Upper floor (l2), under Thorn.
 */

/** A player's cut of an end (project.ts, 4): no pair, ground or seq, `to` only where they hold the far floor, and its way. */
function cut(link: FloorLink, dir: "up" | "down", holdsFar: boolean): FloorLink {
  const { pair: _pair, to, ground: _ground, made: _made, ...rest } = link;
  return { ...rest, ...(holdsFar ? { to } : {}), dir } as unknown as FloorLink;
}

/** Ana's copy of the tower holding Ground floor alone: the end on it, with no far floor named. */
function anaCopy(s: RoomState, holdsUpper = false): RoomState {
  const { [UPPER]: upper, at: _attic, ...scenes } = s.scenes;
  return { ...s, scenes: holdsUpper ? { ...scenes, [UPPER]: upper! } : scenes, floorLinks: { l1: cut(s.floorLinks!.l1!, "up", holdsUpper) } };
}

const thorn = (s: RoomState): Token => s.tokens.thorn!;
const with_ = (s: RoomState, over: Partial<Token>): RoomState => ({ ...s, tokens: { ...s.tokens, thorn: { ...thorn(s), ...over } } });
const lock = (s: RoomState): RoomState => ({ ...s, floorLinks: { ...s.floorLinks!, l1: { ...s.floorLinks!.l1!, locked: true }, l2: { ...s.floorLinks!.l2!, locked: true } } });

describe("Go up's offer (6.1)", () => {
  test("the DM on Thorn's bar: up the stairs to Upper floor, on", () => {
    const s = withStairs();
    const offer = climbOffer(s, DM, thorn(s));
    assert.deepEqual(offer && { link: offer.link.id, dir: offer.dir, kind: offer.kind, floor: offer.floor, off: offer.off }, { link: "l1", dir: "up", kind: "stairs", floor: "Upper floor", off: null });
  });

  test("Ana, who owns Thorn, names no floor she does not hold, and names it once she holds it", () => {
    const s = withStairs();
    assert.equal(climbOffer(anaCopy(s), ANA, thorn(s))?.floor, null);
    assert.equal(climbOffer(anaCopy(s), ANA, thorn(s))?.dir, "up");
    assert.equal(climbOffer(anaCopy(s, true), ANA, thorn(s))?.floor, "Upper floor");
  });

  test("Bree, who may not move Thorn, gets nothing, unless the room lets players move any token", () => {
    const s = withStairs();
    assert.equal(climbOffer(anaCopy(s), BREE, thorn(s)), null);
    const any = { ...s, meta: { ...s.meta, settings: { ...s.meta.settings, playersMoveAny: "all" as const } } };
    assert.equal(climbOffer(anaCopy(any), BREE, thorn(any))?.link.id, "l1");
  });

  test("off while locked, in the server's words", () => {
    const offer = climbOffer(lock(withStairs()), DM, thorn(withStairs()));
    assert.equal(offer?.off, "locked");
    assert.deepEqual(climbKey(lock(withStairs()), DM, thorn(withStairs()), "up", "Thorn"), { say: LINK_WORDS.locked });
  });

  test("nothing partly on the squares, in the air over them, or off them", () => {
    const s = withStairs();
    assert.equal(climbOffer(with_(s, { x: 2, y: 3 }), DM, { ...thorn(s), x: 2, y: 3 }), null, "off the squares");
    assert.equal(climbOffer(s, DM, { ...thorn(s), elevation: 10 }), null, "a flier over them");
    const large = { ...thorn(s), size: "large" as const, x: 4, y: 3 };
    assert.equal(climbOffer(s, DM, large)?.off, "tooBig", "a Large creature half on 2 by 1 stairs is too big for them");
  });

  test("a creature on the far end goes down", () => {
    const s = withStairs();
    const up = { ...thorn(s), sceneId: UPPER };
    const offer = climbOffer(s, DM, up);
    assert.deepEqual(offer && [offer.link.id, offer.dir, offer.floor], ["l2", "down", "Ground floor"]);
  });

  test("a rider of a holder the viewer receives waits for its holder, and one whose holder they do not receive climbs alone (D-261109-018)", () => {
    const s = withStairs(tower({ tokens: { thorn: thornToken({ attached: { kind: "ride", to: "horse" } }), horse: token("horse", { sceneId: GROUND, x: 3, y: 3, size: "large" }) } }));
    assert.equal(climbOffer(s, DM, thorn(s)), null);
    const { horse: _horse, ...unseen } = s.tokens;
    assert.equal(climbOffer({ ...s, tokens: unseen }, DM, thorn(s))?.link.id, "l1");
    // A drag is no seat: the dragged creature climbs, and the drag lets go.
    const dragged = withStairs(tower({ tokens: { thorn: thornToken({ attached: { kind: "drag", to: "ogre" } }), ogre: token("ogre", { sceneId: GROUND, x: 6, y: 6 }) } }));
    assert.equal(climbOffer(dragged, DM, thorn(dragged))?.link.id, "l1");
  });
});

describe("} and { (6.2)", () => {
  test("climb where the bar offers it, else say why", () => {
    const s = withStairs();
    assert.equal("climb" in climbKey(s, DM, thorn(s), "up", "Thorn"), true);
    assert.deepEqual(climbKey(s, DM, thorn(s), "down", "Thorn"), { say: notOnStairsThatWay("Thorn", "down") });
    assert.equal(notOnStairsThatWay("Thorn", "down"), "Thorn isn't on stairs or a ladder going down.");
    assert.deepEqual(climbKey(s, DM, { ...thorn(s), x: 9, y: 9 }, "up", "Thorn"), { say: "Thorn isn't on stairs or a ladder." });
    assert.deepEqual(climbKey(anaCopy(s), BREE, thorn(s), "up", "Thorn"), { say: "Thorn isn't on stairs or a ladder." }, "no right to move it, no stairs to take");
  });

  test("a rider whose holder stands on stairs says its holder takes them", () => {
    const s = withStairs(tower({ tokens: { thorn: thornToken({ attached: { kind: "perch", to: "ogre" } }), ogre: token("ogre", { sceneId: GROUND, x: 3, y: 3 }) } }));
    assert.deepEqual(climbKey(s, DM, thorn(s), "up", "Thorn"), { say: "Thorn is carried. Its holder takes the stairs." });
  });
});

describe("the one wait (6.4)", () => {
  function page() {
    const wait = createStore<ClimbWait>(() => ({ n: null, tokenId: null }));
    const pending: { n: number; answer?: () => void }[] = [];
    let next = 1;
    const dispatch = (_op: unknown, opts?: { onAnswer?: (a: "taken" | "refused" | "unknown") => void }) => {
      const n = next++;
      pending.push({ n, answer: () => opts?.onAnswer?.("taken") });
      return n;
    };
    const answer = (n: number) => {
      const at = pending.findIndex((p) => p.n === n);
      const [p] = pending.splice(at, 1);
      p!.answer!();
    };
    return { wait, pending, dispatch, answer, send: () => sendClimb({ wait, pending, dispatch }, "thorn", "l1") };
  }

  test("a second press while the first is out sends nothing, and its answer frees the next", () => {
    const p = page();
    assert.equal(p.send(), true);
    assert.equal(p.send(), false);
    assert.equal(p.pending.length, 1);
    assert.equal(climbWaiting(p.wait.getState(), p.pending), true);
    p.answer(1);
    assert.equal(climbWaiting(p.wait.getState(), p.pending), false);
    assert.equal(p.send(), true);
    assert.equal(p.pending.length, 1);
  });

  test("an op the store refuses to queue holds no wait", () => {
    const wait = createStore<ClimbWait>(() => ({ n: null, tokenId: null }));
    assert.equal(sendClimb({ wait, pending: [], dispatch: () => null }, "thorn", "l1"), false);
    assert.deepEqual(wait.getState(), { n: null, tokenId: null });
  });

  test("random presses and answers: never two climbs out at once, and the wait clears only with its own answer", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let round = 0; round < 200; round++) {
      const p = page();
      for (let step = 0; step < 30; step++) {
        const r = rand();
        if (r < 0.5) p.send();
        else if (r < 0.8 && p.pending.length > 0) p.answer(p.pending[0]!.n);
        // A snapshot after a reconnect settles the op with no answer heard here: pending drops it, and the wait reads it as out no longer.
        else if (p.pending.length > 0) p.pending.splice(0, 1);
        assert.ok(p.pending.length <= 1, `round ${round} step ${step}: two climbs out`);
        assert.equal(climbWaiting(p.wait.getState(), p.pending), p.pending.length === 1, `round ${round} step ${step}: the wait reads what is out`);
      }
    }
  });
});
