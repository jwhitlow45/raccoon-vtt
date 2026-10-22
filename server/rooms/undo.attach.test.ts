import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EdgeFeature, RoomState, Viewer } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { projectState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { DEPENDED_ON, PARENT_GONE } from "#shared/reducer/misc.ts";
import { WALL_IN_THE_WAY } from "#shared/rules/movement.ts";
import { DM, P1, P2, actor, effect, member, room, token } from "#shared/testutil.ts";
import { MOVED_SINCE } from "./undo.ts";
import { UndoTable } from "./undoTesting.ts";

/**
 * Undo and redo of attached tokens (docs/design-v1-attach.md 8.3), through
 * the room actor's own steps: a player's op goes on their stack with the
 * poses their copy shows and the rides it ended or made, and an undo or a
 * redo is built by `poseRestore`, passes `canApply` as the player
 * (`restoreMoveCheck` on undo, `restorePoseCheck` on redo) and applies.
 * Paired rooms that differ only in hidden state give every player the same
 * answers and the same copies throughout.
 */

const DM2: Viewer = { memberId: "dm2", role: "dm" };

/** The kit with P1 as the default undoer. */
class Table extends UndoTable {
  override undo(who: Viewer = P1): string {
    return super.undo(who);
  }

  override redo(who: Viewer = P1): string {
    return super.redo(who);
  }
}

/**
 * Thorn (P1's PC at 4,6) beside his warhorse (P1's, Large, at 4,4), Cora
 * (P2's) at 12,6, and the DM's goblin at 8,6. The scene stops moves.
 */
function table(setup?: (s: RoomState) => void): Table {
  const state = room({
    tokens: {
      thorn: token("thorn", { name: "Thorn", kind: "pc", disposition: "ally", ownerIds: ["p1"], x: 4, y: 6 }),
      horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", disposition: "ally", ownerIds: ["p1"], x: 4, y: 4, actor: { inline: actor({ speeds: { walk: 60 } }) } }),
      cora: token("cora", { name: "Cora", kind: "pc", disposition: "ally", ownerIds: ["p2"], x: 12, y: 6 }),
      gob: token("gob", { name: "Goblin", x: 8, y: 6 }),
    },
  });
  state.scenes.s1 = { ...state.scenes.s1!, blockMovement: true, autoWalls: "off" };
  setup?.(state);
  return new Table(state);
}

/** Thorn's turn of a fight with rows for Thorn 20, the goblin 12 and the horse 8. */
function thornsTurn(t: Table): Table {
  assert.equal(t.play(DM, { t: "encounter.start", entries: [{ id: "et", tokenId: "thorn", value: 20 }, { id: "eg", tokenId: "gob", value: 12 }, { id: "eh", tokenId: "horse", value: 8 }] }), "ok");
  assert.equal(t.play(DM, { t: "encounter.next" }), "ok");
  return t;
}

const ride: Op = { t: "token.attach", tokenId: "thorn", to: "horse", kind: "ride", steer: true, x: 4, y: 5, elevation: 0 };
const getOff: Op = { t: "token.detach", tokenId: "thorn", x: 4, y: 6 };
const endTurn = (t: Table): Op => ({ t: "encounter.next", from: { entry: t.state.encounter!.activeEntryId ?? null, round: t.state.encounter!.round } });
const row = (t: Table, tokenId: string) => t.state.encounter!.entries.find((e) => e.tokenId === tokenId)!;

/**
 * Both rooms' answers to the same step, which must agree, and every
 * player's copies after it. `revealed` names visible tokens the
 * carried-object reveal may move in one room and not the other (8.0).
 */
function both(a: Table, b: Table, step: (t: Table) => string, players: readonly Viewer[] = [P1, P2], revealed: readonly string[] = []): string {
  const ra = step(a);
  const rb = step(b);
  assert.equal(ra, rb, "the answer differs");
  const copy = (t: Table, p: Viewer) => {
    const out = projectState(t.state, p, { sceneId: "s1" });
    for (const id of revealed) delete out.tokens[id];
    return out;
  };
  for (const p of players) assert.deepEqual(copy(a, p), copy(b, p), `${p.memberId} sees the rooms differ`);
  return ra;
}

describe("a player's attach and detach undo as moves (8.3)", () => {
  test("undoing a Ride takes back the link and the seat, keeps the rows it matched and the round's mark, and ends the sharing", () => {
    const t = thornsTurn(table());
    assert.equal(t.play(P1, ride), "ok");
    assert.deepEqual([row(t, "horse").value, row(t, "horse").markRound, t.mounts()], [20, 1, ["horse"]]);
    assert.equal(t.undo(), "ok");
    assert.equal(t.t("thorn").attached, undefined);
    assert.deepEqual([t.t("thorn").x, t.t("thorn").y], [4, 6]);
    assert.equal(t.t("thorn").path?.stops.length ?? 1, 1, "the leg to the seat goes with it");
    assert.deepEqual([row(t, "horse").value, row(t, "horse").markRound, t.mounts()], [20, 1, undefined]);
  });

  test("undoing a Get off on the same turn puts the mount back on the turn's list, and its moves record again", () => {
    const t = thornsTurn(table());
    assert.equal(t.play(P1, ride), "ok");
    assert.equal(t.play(P1, getOff), "ok");
    assert.equal(t.mounts(), undefined);
    assert.equal(t.undo(), "ok");
    assert.deepEqual(t.t("thorn").attached, { to: "horse", kind: "ride", steer: true });
    assert.deepEqual(t.mounts(), ["horse"]);
    assert.equal(t.play(P1, { t: "token.move", tokenId: "horse", x: 8, y: 4 }), "ok");
    assert.equal(t.t("horse").path!.stops.length, 2);
  });

  test("undoing a Get off off a chain of controlled mounts puts every mount of the chain back on the turn's list", () => {
    // Pip (Small) rides a mastiff by a controlled ride, and the mastiff rides the warhorse the same way.
    const t = table((s) => {
      s.tokens.pip = token("pip", { name: "Pip", kind: "pc", size: "small", disposition: "ally", ownerIds: ["p1"], x: 4, y: 4, attached: { to: "dog", kind: "ride", steer: true } });
      s.tokens.dog = token("dog", { name: "Mastiff", kind: "npc", disposition: "ally", ownerIds: ["p1"], x: 4, y: 4, attached: { to: "horse", kind: "ride", steer: true } });
    });
    assert.equal(t.play(DM, { t: "encounter.start", entries: [{ id: "ep", tokenId: "pip", value: 20 }, { id: "eg", tokenId: "gob", value: 12 }] }), "ok");
    assert.equal(t.play(DM, { t: "encounter.next" }), "ok");
    assert.deepEqual(t.mounts(), ["dog", "horse"]);
    assert.equal(t.play(P1, { t: "token.detach", tokenId: "pip", x: 3, y: 4 }), "ok");
    assert.equal(t.mounts(), undefined);
    assert.equal(t.undo(), "ok");
    assert.deepEqual(t.mounts(), ["dog", "horse"]);
    assert.equal(t.redo(), "ok");
    assert.equal(t.mounts(), undefined);
  });

  test("getting on a mount that rides a controlled mount shares the whole chain, as the turn's start would, and its undo and redo take it back and forth", () => {
    const t = table((s) => {
      s.tokens.pip = token("pip", { name: "Pip", kind: "pc", size: "small", disposition: "ally", ownerIds: ["p1"], x: 3, y: 4 });
      s.tokens.dog = token("dog", { name: "Mastiff", kind: "npc", disposition: "ally", ownerIds: ["p1"], x: 4, y: 4, attached: { to: "horse", kind: "ride", steer: true } });
    });
    assert.equal(t.play(DM, { t: "encounter.start", entries: [{ id: "ep", tokenId: "pip", value: 20 }, { id: "eg", tokenId: "gob", value: 12 }, { id: "eh", tokenId: "horse", value: 8 }] }), "ok");
    assert.equal(t.play(DM, { t: "encounter.next" }), "ok");
    assert.equal(t.mounts(), undefined);
    assert.equal(t.play(P1, { t: "token.attach", tokenId: "pip", to: "dog", kind: "ride", steer: true, x: 4, y: 4, elevation: 0 }), "ok");
    assert.deepEqual(t.mounts(), ["dog", "horse"]);
    assert.equal(row(t, "horse").markRound, 1);
    assert.equal(t.undo(), "ok");
    assert.equal(t.mounts(), undefined);
    assert.equal(t.redo(), "ok");
    assert.deepEqual(t.mounts(), ["dog", "horse"]);
  });

  test("on another turn the ride comes back without sharing that turn, even the rider's own next one", () => {
    const t = thornsTurn(table());
    assert.equal(t.play(P1, ride), "ok");
    assert.equal(t.play(P1, getOff), "ok");
    for (let i = 0; i < 3; i++) assert.equal(t.play(DM, { t: "encounter.next" }), "ok");
    assert.equal(t.state.encounter!.turnStart!.tokenId, "thorn");
    assert.equal(t.state.encounter!.round, 2);
    assert.equal(t.undo(), "ok");
    assert.equal(t.t("thorn").attached?.to, "horse");
    assert.equal(t.mounts(), undefined);
  });

  test("Mount, Undo, Redo: the redo shares the same turn again, and never sets or clears the round's mark", () => {
    const t = thornsTurn(table());
    assert.equal(t.play(P1, ride), "ok");
    assert.equal(t.undo(), "ok");
    assert.equal(t.mounts(), undefined);
    assert.equal(t.redo(), "ok");
    assert.deepEqual(t.mounts(), ["horse"]);
    assert.equal(row(t, "horse").markRound, 1);
    // Undone and redone after Next, it shares nothing.
    assert.equal(t.undo(), "ok");
    assert.equal(t.play(P1, endTurn(t)), "ok");
    assert.equal(t.redo(), "ok");
    assert.equal(t.t("thorn").attached?.to, "horse");
    assert.equal(t.mounts(), undefined);
  });

  test("a Put down and a Let go undo too, as the bar's Undo move", () => {
    const t = table((s) => {
      s.tokens.torch = token("torch", { name: "Torch", kind: "object", size: "tiny", ownerIds: ["p1"], x: 4.5, y: 6.5, attached: { to: "thorn", kind: "carry" } });
      s.tokens.gob = { ...s.tokens.gob!, x: 5, y: 7, actor: { inline: actor({ effects: [effect("g", { key: "grappled" })] }) }, attached: { to: "thorn", kind: "drag" } };
    });
    assert.equal(t.play(P1, { t: "token.detach", tokenId: "torch" }), "ok");
    assert.equal(t.play(P1, { t: "token.detach", tokenId: "gob" }), "ok");
    assert.equal(t.undo(), "ok");
    assert.equal(t.t("gob").attached?.kind, "drag");
    assert.equal(t.undo(), "ok");
    assert.equal(t.t("torch").attached?.kind, "carry");
  });
});

describe("a player's undo of a group move (8.3)", () => {
  test("puts back the holder and its public members, and refuses when one was moved since", () => {
    const t = thornsTurn(table());
    assert.equal(t.play(P1, ride), "ok");
    assert.equal(t.play(P1, { t: "token.move", tokenId: "horse", x: 8, y: 4 }), "ok");
    assert.equal(t.undo(), "ok");
    assert.deepEqual([t.t("horse").x, t.t("thorn").x, t.t("thorn").y], [4, 4, 5]);
    assert.equal(t.redo(), "ok");
    assert.equal(t.play(DM, { t: "token.move", tokenId: "thorn", x: 9, y: 5 }), "ok");
    assert.equal(t.undo(), MOVED_SINCE);
  });

  test("a hidden passenger rides back silently by its displacement, and one the DM moved off since stays, with the same answers", () => {
    const a = thornsTurn(table());
    const b = thornsTurn(table((s) => (s.tokens.imp = token("imp", { name: "Imp", size: "tiny", x: 5, y: 5, visibility: "dm", attached: { to: "horse", kind: "perch" } }))));
    both(a, b, (t) => t.play(P1, ride));
    both(a, b, (t) => t.play(P1, { t: "token.move", tokenId: "horse", x: 8, y: 4 }));
    assert.deepEqual([b.t("imp").x, b.t("imp").y], [9, 5]);
    both(a, b, (t) => t.undo());
    assert.deepEqual([b.t("imp").x, b.t("imp").y, b.t("imp").attached?.to], [5, 5, "horse"]);
    both(a, b, (t) => t.redo());
    assert.deepEqual([b.t("imp").x, b.t("imp").y], [9, 5]);
    // The DM takes the imp off and away: the undo leaves it where it is.
    b.play(DM, { t: "token.detach", tokenId: "imp" });
    b.play(DM, { t: "token.move", tokenId: "imp", x: 20, y: 20 });
    a.play(DM, { t: "token.update", tokenId: "gob", patch: { name: "Goblin" } });
    assert.equal(both(a, b, (t) => t.undo()), "ok");
    assert.deepEqual([b.t("imp").x, b.t("imp").y, b.t("imp").attached], [20, 20, undefined]);
  });

  test("a passenger only its own player sees answers nothing to the other player's undo", () => {
    // P2's owl perches on P1's horse, hidden from every other player.
    const owl = (s: RoomState) => (s.tokens.owl = token("owl", { name: "Owl", kind: "npc", size: "tiny", ownerIds: ["p2"], x: 5, y: 5, visibility: "dm", attached: { to: "horse", kind: "perch" } }));
    const a = table();
    const b = table(owl);
    both(a, b, (t) => t.play(P1, { t: "token.move", tokenId: "horse", x: 8, y: 4 }), [P1]);
    both(a, b, (t) => t.undo(), [P1]);
    assert.deepEqual([b.t("owl").x, b.t("owl").y], [5, 5]);
  });

  test("a change to a link whose holder the player cannot see never answers moved since", () => {
    // P1's torch rides a stalker no player sees, then the DM hands it to another one in the same spot.
    const stalkers = (s: RoomState) => {
      s.tokens.sa = token("sa", { name: "Stalker", x: 8, y: 2, visibility: "dm" });
      s.tokens.sb = token("sb", { name: "Stalker", x: 8, y: 2, visibility: "dm" });
      s.tokens.torch = { ...s.tokens.torch!, attached: { to: "sa", kind: "carry" } };
    };
    const lit = (s: RoomState) => (s.tokens.torch = token("torch", { name: "Torch", kind: "object", size: "tiny", ownerIds: ["p1"], x: 8, y: 2 }));
    const a = table(lit);
    const b = table((s) => {
      lit(s);
      stalkers(s);
    });
    both(a, b, (t) => t.play(P1, { t: "token.move", tokenId: "torch", x: 8.5, y: 2.5 }));
    assert.equal(b.t("torch").attached?.to, "sa");
    b.play(DM, { t: "token.attach", tokenId: "torch", to: "sb", kind: "carry", x: 8.5, y: 2.5, elevation: 0 });
    a.play(DM, { t: "token.update", tokenId: "gob", patch: { name: "Goblin" } });
    assert.equal(both(a, b, (t) => t.undo()), "ok");
  });

  test("a torch moved off an invisible holder comes back with its link where it holds, and without it where it does not", () => {
    const lit = (s: RoomState) => (s.tokens.torch = token("torch", { name: "Torch", kind: "object", size: "tiny", ownerIds: ["p1"], x: 8, y: 2 }));
    const held = (s: RoomState) => {
      s.tokens.sa = token("sa", { name: "Stalker", x: 8, y: 2, visibility: "dm" });
      s.tokens.torch = { ...s.tokens.torch!, attached: { to: "sa", kind: "carry" } };
    };
    for (const stalkerMoves of [false, true]) {
      const a = table(lit);
      const b = table((s) => {
        lit(s);
        held(s);
      });
      both(a, b, (t) => t.play(P1, { t: "token.move", tokenId: "torch", x: 5, y: 6.5 }));
      assert.equal(b.t("torch").attached, undefined, "moved off, it came loose");
      if (stalkerMoves) b.play(DM, { t: "token.move", tokenId: "sa", x: 20, y: 2 });
      else b.play(DM, { t: "token.update", tokenId: "sa", patch: { name: "Stalker" } });
      a.play(DM, { t: "token.update", tokenId: "gob", patch: { name: "Goblin" } });
      assert.equal(both(a, b, (t) => t.undo()), "ok");
      assert.deepEqual([b.t("torch").x, b.t("torch").y], [8, 2]);
      assert.equal(b.t("torch").attached?.to, stalkerMoves ? undefined : "sa");
    }
  });
});

/*
 * The class of AT-ASTRA-1: no hidden state may change a player's undo or
 * redo answer. Each generator is a pair of rooms that start alike, take the
 * same player's group move, and then differ only by what the DM does unseen
 * in room b (room a takes a neutral edit in its place). Every player's copy
 * stays the same, so the player's undo, and then their redo, must answer
 * alike in both rooms and leave their copies alike.
 */
describe("no hidden state changes a player's undo or redo answer (8.3)", () => {
  /** P1's horse carries an imp no player sees, which carries a torch every player sees and nobody owns. */
  const imp = (s: RoomState) => {
    s.tokens.imp = token("imp", { name: "Imp", size: "tiny", x: 5, y: 5, visibility: "dm", attached: { to: "horse", kind: "perch" } });
    s.tokens.torch = token("torch", { name: "Torch", kind: "object", size: "tiny", x: 5, y: 5, attached: { to: "imp", kind: "carry" } });
  };
  /** Thorn drags a rat no player sees, a row up. */
  const rat = (s: RoomState) => (s.tokens.rat = token("rat", { name: "Rat", size: "small", x: 4, y: 5, visibility: "dm", attached: { to: "thorn", kind: "drag" } }));
  const neutral: Op = { t: "token.update", tokenId: "gob", patch: { name: "Goblin" } };
  const moveHorse: Op = { t: "token.move", tokenId: "horse", x: 8, y: 4 };
  const moveThorn: Op = { t: "token.move", tokenId: "thorn", x: 8, y: 6 };
  const pairs: { name: string; setup: (s: RoomState) => void; move: Op; unseen: Op[] }[] = [
    { name: "the DM puts down the visible torch the hidden imp carries", setup: imp, move: moveHorse, unseen: [{ t: "token.detach", tokenId: "torch" }] },
    { name: "the DM deletes the hidden imp, so the torch comes loose", setup: imp, move: moveHorse, unseen: [{ t: "token.delete", tokenId: "imp" }] },
    {
      name: "the DM puts down the torch, which carries a visible light: silence runs down the whole chain from the hidden imp",
      setup: (s) => {
        imp(s);
        s.tokens.light = token("light", { name: "Light", kind: "object", size: "tiny", x: 5, y: 5, attached: { to: "torch", kind: "carry" } });
      },
      move: moveHorse,
      unseen: [{ t: "token.detach", tokenId: "torch" }],
    },
    {
      name: "the DM hands the torch to another hidden creature in the same spot",
      setup: (s) => {
        imp(s);
        s.tokens.sprite = token("sprite", { name: "Sprite", size: "tiny", x: 9, y: 5, visibility: "dm" });
      },
      move: moveHorse,
      unseen: [{ t: "token.attach", tokenId: "torch", to: "sprite", kind: "carry", x: 9, y: 5, elevation: 0 }],
    },
    {
      name: "the DM puts a new hidden passenger on the horse",
      setup: (s) => (s.tokens.sprite = token("sprite", { name: "Sprite", size: "tiny", x: 12, y: 2, visibility: "dm" })),
      move: moveHorse,
      unseen: [{ t: "token.attach", tokenId: "sprite", to: "horse", kind: "perch", x: 8, y: 4, elevation: 0 }],
    },
    { name: "the DM takes the hidden imp off and away with its torch hidden too", setup: (s) => (imp(s), (s.tokens.torch = { ...s.tokens.torch!, visibility: "dm" })), move: moveHorse, unseen: [{ t: "token.detach", tokenId: "imp" }, { t: "token.move", tokenId: "imp", x: 14, y: 10 }] },
    { name: "the DM lets the hidden rat go and moves it off", setup: rat, move: moveThorn, unseen: [{ t: "token.detach", tokenId: "rat" }, { t: "token.move", tokenId: "rat", x: 2, y: 10 }] },
    { name: "the DM moves the hidden rat beside Thorn, still dragged", setup: rat, move: moveThorn, unseen: [{ t: "token.move", tokenId: "rat", x: 9, y: 7 }] },
  ];
  for (const pair of pairs) {
    test(pair.name, () => {
      const a = table(pair.setup);
      const b = table(pair.setup);
      both(a, b, (t) => t.play(P1, pair.move));
      for (const op of pair.unseen) assert.equal(b.play(DM, op), "ok", `${op.t} in room b`);
      a.play(DM, neutral);
      // The torch follows its hidden holder back and forth in room a only, by the reveal: its copy is the one thing that may differ.
      const revealed = ["torch", "light"];
      both(a, b, (t) => t.undo(), [P1, P2], revealed);
      both(a, b, (t) => t.redo(), [P1, P2], revealed);
      both(a, b, (t) => t.undo(), [P1, P2], revealed);
    });
  }
});

/*
 * The class of AT-ASTRA-3: a player's undo and redo take the rights the
 * forward op took. Each case is an op a player may make by a right of
 * attached tokens, then its undo, its redo and its undo again, each with
 * nothing changed between.
 */
describe("a hidden link never lends a player's undo a right (8.0, review AT-O-16)", () => {
  test("Thorn moved off a steed no player sees, then locked, answers as Thorn on nothing", () => {
    const steed = (s: RoomState) => {
      s.tokens.steed = token("steed", { name: "Phantom steed", kind: "npc", size: "large", x: 4, y: 6, visibility: "dm" });
      s.tokens.thorn = { ...s.tokens.thorn!, attached: { to: "steed", kind: "ride" } };
    };
    const a = table(steed);
    const b = table();
    both(a, b, (t) => t.play(P1, { t: "token.move", tokenId: "thorn", x: 9, y: 6 }));
    both(a, b, (t) => t.play(DM, { t: "token.update", tokenId: "thorn", patch: { locked: true } }));
    assert.equal(both(a, b, (t) => t.undo()), "that token is locked");
  });
});

describe("a restore walks up only links to holders the player sees, from its first step (8.0, review AT-O-20)", () => {
  test("a redo that puts the DM's torch back on a hidden imp perched on Thorn's horse meets the walls as the same redo without the imp", () => {
    // The same restore, sent to a room with the imp and one without it. The torch rides the horse now, and a wall
    // since stands across its way to the spot put back: carried by the horse it would skip the wall.
    const torch = token("torch", { name: "Torch", kind: "object", size: "tiny", x: 4, y: 4, attached: { to: "horse", kind: "carry" } });
    const answer = (withImp: boolean) => {
      const t = table((s) => {
        s.tokens.torch = torch;
        if (withImp) s.tokens.imp = token("imp", { name: "Imp", size: "tiny", x: 5, y: 5, visibility: "dm", attached: { to: "horse", kind: "perch" } });
        s.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: { "6,4,w": { kind: "wall" }, "6,5,w": { kind: "wall" } } };
      });
      const op: Op = {
        t: "sys.restore",
        from: "redo",
        deps: true,
        entries: [
          { key: "token:horse", value: t.state.tokens.horse! },
          { key: "token:torch", value: { ...torch, x: 7, y: 5, attached: { to: "imp", kind: "carry" } } },
        ],
      };
      const d = canApply(op, P1, t.state, { canUseAsset: () => true });
      return d.ok ? "ok" : d.message;
    };
    assert.equal(answer(false), WALL_IN_THE_WAY);
    assert.equal(answer(true), answer(false));
  });
});

describe("a player's undo and redo take the forward op's rights (6 and 8.3)", () => {
  const grappled = { actor: { inline: actor({ effects: [effect("g", { key: "grappled" })] }) } };
  /** The DM's warhorse, which P1's Thorn rides by a controlled ride. */
  const dmHorse = (s: RoomState) => {
    s.tokens.horse = { ...s.tokens.horse!, ownerIds: [], x: 4, y: 4 };
    s.tokens.thorn = { ...s.tokens.thorn!, x: 4, y: 5, attached: { to: "horse", kind: "ride", steer: true } };
  };
  const cases: { name: string; setup: (s: RoomState) => void; op: Op }[] = [
    { name: "a move of the DM's horse Thorn directs", setup: dmHorse, op: { t: "token.move", tokenId: "horse", x: 8, y: 4 } },
    { name: "a moveMany naming the directed horse", setup: dmHorse, op: { t: "token.moveMany", moves: [{ tokenId: "horse", x: 8, y: 2 }] } },
    { name: "a Get off the DM's horse by Thorn's player, Thorn locked", setup: (s) => (dmHorse(s), (s.tokens.thorn = { ...s.tokens.thorn!, locked: true })), op: { t: "token.detach", tokenId: "thorn", x: 4, y: 6 } },
    { name: "a Drag of a goblin the DM marked Grappled", setup: (s) => (s.tokens.gob = { ...s.tokens.gob!, x: 5, y: 7, ...grappled }), op: { t: "token.attach", tokenId: "gob", to: "thorn", kind: "drag", x: 5, y: 7, elevation: 0 } },
    { name: "a Carry of a Small goblin the DM marked Grappled", setup: (s) => (s.tokens.gob = { ...s.tokens.gob!, size: "small", x: 6, y: 4, ...grappled }), op: { t: "token.attach", tokenId: "gob", to: "horse", kind: "carry", x: 5, y: 4, elevation: 0 } },
    { name: "a Let go of the goblin Thorn drags", setup: (s) => (s.tokens.gob = { ...s.tokens.gob!, x: 5, y: 7, ...grappled, attached: { to: "thorn", kind: "drag" } }), op: { t: "token.detach", tokenId: "gob" } },
    { name: "a Put down of the DM's torch Thorn holds", setup: (s) => (s.tokens.torch = token("torch", { name: "Torch", kind: "object", size: "tiny", x: 4, y: 6, attached: { to: "thorn", kind: "carry" } })), op: { t: "token.detach", tokenId: "torch" } },
    { name: "a new seat for the DM's torch on Thorn", setup: (s) => (s.tokens.torch = token("torch", { name: "Torch", kind: "object", size: "tiny", x: 4, y: 6, attached: { to: "thorn", kind: "carry" } })), op: { t: "token.move", tokenId: "torch", x: 4.5, y: 6.5 } },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const t = table(c.setup);
      assert.equal(t.play(P1, c.op), "ok", "the op");
      assert.equal(t.undo(), "ok", "its undo");
      assert.equal(t.redo(), "ok", "its redo");
      assert.equal(t.undo(), "ok", "its undo again");
    });
  }
});

describe("redo checks walls on the holder and the public dragged creatures only (8.3)", () => {
  const WALL: EdgeFeature = { kind: "wall" };
  /** Thorn drags a goblin marked Grappled at 4,7. In room b a hidden rat is dragged too at 4,5. */
  function dragging(withRat: boolean): Table {
    return table((s) => {
      s.tokens.gob = { ...s.tokens.gob!, x: 4, y: 7, actor: { inline: actor({ effects: [effect("g", { key: "grappled" })] }) }, attached: { to: "thorn", kind: "drag" } };
      if (withRat) s.tokens.rat = token("rat", { name: "Rat", size: "small", x: 4, y: 5, visibility: "dm", attached: { to: "thorn", kind: "drag" } });
    });
  }

  test("a wall built since across the goblin's leg stops the redo, and one across the hidden rat's never does", () => {
    for (const across of ["gob", "rat"] as const) {
      const a = dragging(false);
      const b = dragging(true);
      both(a, b, (t) => t.play(P1, { t: "token.move", tokenId: "thorn", x: 10, y: 6 }));
      both(a, b, (t) => t.undo());
      // The DM's wall, written straight into both rooms: how it is built is no part of the test.
      for (const t of [a, b]) {
        const chunk = t.state.buildChunks["s1:0,0"] ?? { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {} };
        const edges = { ...chunk.edges, [across === "gob" ? "8,7,w" : "8,5,w"]: WALL };
        t.state = { ...t.state, buildChunks: { ...t.state.buildChunks, "s1:0,0": { ...chunk, edges } } };
      }
      const answer = both(a, b, (t) => t.redo());
      assert.equal(answer, across === "gob" ? WALL_IN_THE_WAY : "ok");
    }
  });
});

describe("the DM's restore reference checks add the link (8.3)", () => {
  function twoDms(): Table {
    return table((s) => {
      s.members.dm2 = member("dm2", "dm");
      s.tokens.imp = token("imp", { name: "Imp", size: "tiny", x: 4, y: 6, attached: { to: "thorn", kind: "perch" } });
    });
  }

  test("putting back a link whose holder was deleted since is refused", () => {
    const t = twoDms();
    assert.equal(t.play(DM, { t: "token.detach", tokenId: "imp" }), "ok");
    assert.equal(t.play(DM2, { t: "token.delete", tokenId: "thorn" }), "ok");
    assert.equal(t.undo(DM), PARENT_GONE);
  });

  test("taking away a token another one is attached to is refused", () => {
    const t = twoDms();
    const { rev: _rev, ...ogre } = token("ogre", { name: "Ogre", size: "large", x: 10, y: 10 });
    assert.equal(t.play(DM, { t: "token.create", token: ogre }), "ok");
    assert.equal(t.play(DM2, { t: "token.attach", tokenId: "imp", to: "ogre", kind: "perch", x: 10, y: 10, elevation: 0 }), "ok");
    assert.equal(t.undo(DM), DEPENDED_ON);
  });

  test("a player's restore never refuses on a link", () => {
    const t = table((s) => (s.tokens.torch = token("torch", { name: "Torch", kind: "object", size: "tiny", ownerIds: ["p1"], x: 4.5, y: 6.5, attached: { to: "thorn", kind: "carry" } })));
    assert.equal(t.play(P1, { t: "token.detach", tokenId: "torch" }), "ok");
    assert.equal(t.play(DM, { t: "token.delete", tokenId: "thorn" }), "ok");
    assert.equal(t.undo(), "ok");
    assert.equal(t.t("torch").attached, undefined);
  });
});
