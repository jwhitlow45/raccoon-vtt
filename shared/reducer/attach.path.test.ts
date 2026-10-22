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

  test("so does a rider dragged off its mount on its own turn, along the rest of its route, and a Get off needs its place", () => {
    const free = (s: RoomState) => (s.tokens.bree = { ...s.tokens.bree!, attached: { to: "horse", kind: "ride" } });
    const straight = bresTurn(free).run({ t: "token.move", tokenId: "bree", x: 8, y: 4 });
    assert.equal(straight.state.tokens.bree!.attached, undefined);
    assert.deepEqual(
      straight.stops("bree").slice(1).map((s) => [s.x, s.y, s.moved, s.cost]),
      [
        [6, 4, 10, 15],
        [8, 4, 10, 10],
      ],
    );
    const routed = bresTurn(free).run({ t: "token.move", tokenId: "bree", x: 7, y: 6, route: [[7, 4, 0, 0], [7, 6, 0, 0]] });
    assert.deepEqual(
      routed.stops("bree").slice(1).map((s) => [s.x, s.y, s.moved, s.cost, s.via]),
      [
        [6, 4, 10, 15, undefined],
        [7, 6, 15, 15, [7, 4]],
      ],
    );
    // "Teleport here" off it uses no movement: one leg that does not count, with no dismount in it.
    const teleported = bresTurn(free).run({ t: "token.move", tokenId: "bree", x: 9, y: 4, teleport: "wall" }).stops("bree");
    assert.deepEqual([teleported.length, last(teleported).uncounted, last(teleported).cost], [2, true, 25]);
    assert.equal(bresTurn(free).refused({ t: "token.detach", tokenId: "bree" }), "getting off a mount needs a place beside it");
  });

  test("a walk off a mount that never clears it keeps its route, corners and distance (review AT-O-21)", () => {
    // Large Bree on a Huge horse: her walk ends half off it, so the ride no longer holds, yet no spot of it is clear.
    const huge = (s: RoomState) => {
      s.tokens.horse = { ...s.tokens.horse!, size: "huge" };
      s.tokens.bree = { ...s.tokens.bree!, size: "large", attached: { to: "horse", kind: "ride" } };
    };
    const f = bresTurn(huge).run({ t: "token.move", tokenId: "bree", x: 6, y: 5, route: [[4, 5, 0, 0], [6, 5, 0, 0]] });
    assert.equal(f.state.tokens.bree!.attached, undefined);
    assert.deepEqual(
      f.stops("bree").slice(1).map((s) => [s.x, s.y, s.moved, s.cost, s.via]),
      [[6, 5, 15, 15, [4, 5]]],
    );
  });

  test("a ride no player sees costs nothing to leave or take, so the rider's owner reads the same leg with or without a hidden mount (8.0)", () => {
    // Room a: Bree rides a horse no player sees. Room b: she stands there alone. Her owner's copies are the same.
    const hidden = () => bresTurn((s) => (s.tokens.horse = { ...s.tokens.horse!, visibility: "dm" }) && (s.tokens.bree = { ...s.tokens.bree!, attached: { to: "horse", kind: "ride" } }));
    const alone = () => bresTurn((s) => (delete s.tokens.horse, (s.tokens.bree = { ...s.tokens.bree!, attached: undefined })));
    const owners = (f: ReturnType<typeof bresTurn>) => projectState(f.state, P1, { sceneId: "s1" }).tokens.bree!.path?.stops;
    assert.deepEqual(owners(hidden()), owners(alone()));
    const ops: [string, Op][] = [
      ["a move off", { t: "token.move", tokenId: "bree", x: 7, y: 4 }],
      ["a group move off", { t: "token.moveMany", moves: [{ tokenId: "bree", x: 7, y: 4 }, { tokenId: "gob", x: 21, y: 20 }] }],
    ];
    for (const [name, op] of ops) assert.deepEqual(owners(hidden().run(op)), owners(alone().run(op)), name);
    // The DM's Get off of the hidden ride reads as the same walk taken by a move.
    assert.deepEqual(owners(hidden().run({ t: "token.detach", tokenId: "bree", x: 6, y: 4 })), owners(alone().run({ t: "token.move", tokenId: "bree", x: 6, y: 4 })));
    // And getting on one costs only the leg.
    const mount = (f: ReturnType<typeof bresTurn>) => f.run({ t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", x: 4, y: 4, elevation: 0 });
    const away = (s: RoomState) => (s.tokens.horse = { ...s.tokens.horse!, visibility: "dm" }) && (s.tokens.bree = { ...s.tokens.bree!, x: 6, y: 4, attached: undefined });
    assert.deepEqual(owners(mount(bresTurn(away))), owners(bresTurn((s) => (delete s.tokens.horse, (s.tokens.bree = { ...s.tokens.bree!, x: 6, y: 4, attached: undefined }))).run({ t: "token.move", tokenId: "bree", x: 4, y: 4 })));
  });

  test("a hidden rider still pays half Speed to get on, get off or be dragged off a mount every player sees, since only the DM and its owners read its path (review AT-O-19)", () => {
    // An invisible Bree: hidden by the DM and not shown on her turn.
    const invisible = (s: RoomState) => {
      s.meta.settings = { ...s.meta.settings, revealHiddenOnTurn: false };
      s.tokens.bree = { ...s.tokens.bree!, visibility: "dm" };
    };
    const on = bresTurn((s) => (invisible(s), (s.tokens.bree = { ...s.tokens.bree!, x: 6, y: 4, attached: undefined }))).run({ t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", x: 5, y: 4, elevation: 0 });
    assert.equal(on.state.tokens.bree!.visibility, "dm");
    assert.equal(last(on.stops("bree")).cost, 15);
    assert.equal(last(bresTurn(invisible).run({ t: "token.detach", tokenId: "bree", x: 6, y: 4 }).stops("bree")).cost, 15);
    assert.deepEqual(bresTurn(invisible).run({ t: "token.move", tokenId: "bree", x: 8, y: 4 }).stops("bree").map((stop) => stop.cost), [undefined, 15, 10]);
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

  test("a remount on the same turn goes on with the same path, a move between that shares no turn recording nothing and counting nothing", () => {
    const f = bresTurn().share("horse").run({ t: "token.move", tokenId: "horse", x: 8, y: 4 });
    f.run({ t: "token.detach", tokenId: "bree", x: 10, y: 4 });
    f.run({ t: "token.move", tokenId: "horse", x: 8, y: 5 });
    assert.equal(f.stops("horse").length, 2, "the move between records nothing");
    f.run({ t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", steer: true, x: 9, y: 5, elevation: 0 });
    assert.deepEqual(f.state.encounter!.turnStart!.mounts, ["horse"]);
    f.run({ t: "token.move", tokenId: "horse", x: 8, y: 9 });
    assert.deepEqual(
      f.stops("horse").map((s) => [s.x, s.y, s.uncounted ?? false, s.moved]),
      [
        [4, 4, false, undefined],
        [8, 4, false, 20],
        [8, 5, true, undefined],
        [8, 9, false, 20],
      ],
    );
  });

  test("a mount's path reads as empty on another turn", () => {
    const f = bresTurn().share("horse").run({ t: "token.move", tokenId: "horse", x: 8, y: 4 }).run({ t: "encounter.next" });
    assert.equal(pathThisTurn(f.state.encounter, f.state.tokens.horse!), null);
  });
});
