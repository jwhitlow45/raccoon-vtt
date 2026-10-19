import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PathStop, RoomState, Token, Viewer } from "../model.ts";
import { projectState } from "../project.ts";
import { MAX_PATH_STOPS, type Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { pathThisTurn, withStop } from "../rules/path.ts";
import { DM, P1, P2, actor, env, room, token } from "../testutil.ts";

/**
 * Paths and costs of attached tokens (docs/design-v1-attach.md 7.2 and
 * 7.3): a carried leg on the rider's path, joins and "Doesn't count" on
 * one, the cost of getting on and off a mount, and a controlled mount's
 * moves on its rider's turn recorded on its own path.
 */

/** Bree (P1's, walking 30 ft) has the turn. Her warhorse at 4,4 walks 60 ft and has no row. */
function bresTurn(setup?: (s: RoomState) => void) {
  const state = room({
    tokens: {
      horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, actor: { inline: actor({ speeds: { walk: 60 } }) } }),
      bree: token("bree", { name: "Bree", kind: "pc", x: 4, y: 4, ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } }),
      gob: token("gob", { x: 20, y: 20 }),
    },
  });
  setup?.(state);
  const f = {
    state,
    seq: 0,
    run(op: Op, who: Viewer = DM) {
      f.seq++;
      const r = applyOp(f.state, op, who, env(f.seq));
      assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
      f.state = r.state;
      return f;
    },
    refused(op: Op, who: Viewer = DM): string {
      const r = applyOp(f.state, op, who, env(f.seq + 1));
      assert.ok(!r.ok);
      return r.message;
    },
    stops(id: string): PathStop[] {
      return f.state.tokens[id]!.path?.stops ?? [];
    },
    /** The mounts sharing the turn, set by hand: Next writes them for a visible controlled ride anyway. */
    share(...ids: string[]) {
      const e = f.state.encounter!;
      f.state = { ...f.state, encounter: { ...e, turnStart: { ...e.turnStart!, mounts: ids } } };
      return f;
    },
  };
  return f.run({ t: "encounter.start", entries: [{ id: "e1", tokenId: "bree", value: 15 }, { id: "e2", tokenId: "gob", value: 5 }] }).run({ t: "encounter.next" });
}

function last(stops: PathStop[]): PathStop {
  return stops[stops.length - 1]!;
}

describe("a carried leg (7.2)", () => {
  test("the rider's leg on the horse's move is uncounted and carried, with no cost and no corners", () => {
    // An independent mount: Bree's turn moves it on no path of its own.
    const f = bresTurn((s) => (s.tokens.bree = { ...s.tokens.bree!, attached: { to: "horse", kind: "ride" } })).run({ t: "token.move", tokenId: "horse", x: 8, y: 4 });
    const leg = last(f.stops("bree"));
    assert.equal(leg.uncounted, true);
    assert.equal(leg.carried, true);
    assert.equal(leg.cost, undefined);
    assert.equal(leg.via, undefined);
    assert.equal(leg.moved, 20);
    assert.equal(f.state.tokens.horse!.path, undefined, "the horse shares no turn");
  });

  test("players get the leg as one that does not count, without the mark", () => {
    const f = bresTurn().run({ t: "token.move", tokenId: "horse", x: 8, y: 4 });
    for (const p of [P1, P2]) {
      const stops = (projectState(f.state, p, { sceneId: "s1" }).tokens.bree as Token).path!.stops;
      assert.equal(last(stops).uncounted, true, p.memberId);
      assert.equal(last(stops).carried, undefined, p.memberId);
    }
  });

  test("Doesn't count is never refused on it: counting it drops the mark", () => {
    const f = bresTurn().run({ t: "token.move", tokenId: "horse", x: 8, y: 4 }).run({ t: "token.countLeg", tokenId: "bree", counts: true });
    const leg = last(f.stops("bree"));
    assert.equal(leg.uncounted, undefined);
    assert.equal(leg.carried, undefined);
    assert.equal(leg.moved, 20);
  });

  test("a full path joins two legs as carried only when both were", () => {
    const at = (x: number, extra: Partial<PathStop> = {}): PathStop => ({ x, y: 0, elevation: 0, seen: true, ...extra });
    const carried = { uncounted: true as const, carried: true as const };
    const fill = (second: Partial<PathStop>, third: Partial<PathStop>) => {
      const stops = [at(0), at(1, second), at(2, third)];
      for (let x = 3; stops.length < MAX_PATH_STOPS; x++) stops.push(at(x));
      return withStop({ turn: 1, stops }, at(999)).stops[1]!;
    };
    assert.equal(fill(carried, carried).carried, true);
    assert.equal(fill(carried, carried).uncounted, true);
    assert.equal(fill({}, carried).carried, undefined);
    assert.equal(fill(carried, {}).carried, undefined);
  });
});

describe("what getting on and off costs (7.3)", () => {
  test("a ride taken on the rider's turn costs half its Speed, whatever the leg", () => {
    const f = bresTurn((s) => (s.tokens.bree = { ...s.tokens.bree!, x: 6, y: 4, attached: undefined }));
    f.run({ t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", steer: true, x: 5, y: 4, elevation: 0 });
    assert.deepEqual([last(f.stops("bree")).moved, last(f.stops("bree")).cost], [5, 15]);
  });

  test("a full path stays full: getting on in place and getting off join the oldest legs as any stop does", () => {
    const f = bresTurn((s) => (s.tokens.bree = { ...s.tokens.bree!, x: 6, y: 4, attached: undefined }));
    for (let i = 0; i < MAX_PATH_STOPS - 1; i++) f.run({ t: "token.move", tokenId: "bree", x: i % 2 === 0 ? 5 : 6, y: 4 }, P1);
    assert.equal(f.stops("bree").length, MAX_PATH_STOPS);
    f.run({ t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", steer: true, x: 5, y: 4, elevation: 0 }, P1);
    assert.equal(f.stops("bree").length, MAX_PATH_STOPS, "getting on in place");
    assert.equal(last(f.stops("bree")).cost, 15);
    f.run({ t: "token.detach", tokenId: "bree", x: 3, y: 6 }, P1);
    assert.equal(f.stops("bree").length, MAX_PATH_STOPS, "getting off");
  });

  test("a rider already on the mount pays nothing to change Controlled or Independent", () => {
    const f = bresTurn();
    f.run({ t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", x: 4, y: 4, elevation: 0 });
    assert.ok(f.stops("bree").every((s) => s.cost === undefined));
    assert.deepEqual(f.state.tokens.bree!.attached, { to: "horse", kind: "ride" });
  });

  test("a perch, a carry and a drag cost only their leg", () => {
    const f = bresTurn((s) => {
      s.tokens.bree = { ...s.tokens.bree!, x: 6, y: 4, attached: undefined };
      s.tokens.cart = token("cart", { kind: "object", size: "large", x: 7, y: 4 });
    });
    f.run({ t: "token.attach", tokenId: "bree", to: "cart", kind: "carry", x: 7, y: 4, elevation: 0 });
    assert.deepEqual([last(f.stops("bree")).moved, last(f.stops("bree")).cost], [5, 5]);
  });

  test("getting off costs half its Speed to the first spot clear of the mount, and the rest of the leg as any leg", () => {
    const one = bresTurn().run({ t: "token.detach", tokenId: "bree", x: 6, y: 4 });
    assert.deepEqual([last(one.stops("bree")).moved, last(one.stops("bree")).cost], [10, 15]);
    const two = bresTurn((s) => (s.tokens.bree = { ...s.tokens.bree!, x: 5, y: 5 }));
    // The turn began in the seat: Bree's start is where she sat.
    two.run({ t: "token.detach", tokenId: "bree", x: 3, y: 6 });
    const stops = two.stops("bree");
    assert.deepEqual(
      stops.slice(1).map((s) => [s.x, s.y, s.moved, s.cost]),
      [
        [4, 6, 5, 15],
        [3, 6, 5, 5],
      ],
    );
  });

  test("nothing is paid off the rider's turn", () => {
    const f = bresTurn().run({ t: "encounter.next" }).run({ t: "token.detach", tokenId: "bree", x: 6, y: 4 });
    assert.equal(f.state.tokens.bree!.path?.turn === f.state.encounter!.turnStart?.seq, false);
  });

  test("players who do not own the rider read the leg's plain distance", () => {
    const f = bresTurn((s) => (s.tokens.bree = { ...s.tokens.bree!, x: 6, y: 4, attached: undefined }));
    f.run({ t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", x: 5, y: 4, elevation: 0 });
    const owner = (projectState(f.state, P1, { sceneId: "s1" }).tokens.bree as Token).path!.stops;
    const other = (projectState(f.state, P2, { sceneId: "s1" }).tokens.bree as Token).path!.stops;
    assert.equal(last(owner).cost, 15);
    assert.equal(last(other).cost, undefined);
  });
});

describe("a controlled mount's path on its rider's turn (7.2)", () => {
  test("its moves are its own legs from where it stood, against its own path, and the rider's are carried", () => {
    const f = bresTurn().share("horse").run({ t: "token.move", tokenId: "horse", x: 8, y: 4 }).run({ t: "token.move", tokenId: "horse", x: 8, y: 8 });
    assert.deepEqual(
      f.stops("horse").map((s) => [s.x, s.y, s.uncounted ?? false, s.moved]),
      [
        [4, 4, false, undefined],
        [8, 4, false, 20],
        [8, 8, false, 20],
      ],
    );
    assert.equal(f.state.tokens.horse!.path!.turn, f.state.encounter!.turnStart!.seq);
    assert.ok(pathThisTurn(f.state.encounter, f.state.tokens.horse!));
    assert.ok(f.stops("bree").slice(1).every((s) => s.carried === true));
  });

  test("only while the turn's creature still rides it, by a controlled ride", () => {
    const off = bresTurn().share("horse").run({ t: "token.detach", tokenId: "bree", x: 6, y: 4 }).run({ t: "token.move", tokenId: "horse", x: 8, y: 8 });
    assert.equal(off.state.tokens.horse!.path, undefined);
    const free = bresTurn((s) => (s.tokens.bree = { ...s.tokens.bree!, attached: { to: "horse", kind: "ride" } })).share("horse");
    free.run({ t: "token.move", tokenId: "horse", x: 8, y: 4 });
    assert.equal(free.state.tokens.horse!.path, undefined);
  });

  test("a mount's path reads as empty on another turn", () => {
    const f = bresTurn().share("horse").run({ t: "token.move", tokenId: "horse", x: 8, y: 4 }).run({ t: "encounter.next" });
    assert.equal(pathThisTurn(f.state.encounter, f.state.tokens.horse!), null);
  });
});
