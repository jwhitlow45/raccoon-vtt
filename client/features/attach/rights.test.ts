import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AttachKind, MoveAnyToken, RoomState, Token, Viewer } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { actor, character, DM, effect, entry, P1, P2, room, token } from "#shared/testutil.ts";
import { copyFor } from "./testing.ts";
import { attachAllowed, detachAllowed, dragsToken, grappledPublicly, movesToken, notRidersTurn, offersAttach, reseats, steers } from "./rights.ts";

const dm = { role: "dm" as const, memberId: DM.memberId };
const p1 = { role: "player" as const, memberId: P1.memberId };

/** Thorn, p1's through his character, beside a DM's horse he rides controlled, a goblin, a statue and a torch he holds. */
function table(over: (state: RoomState) => void = () => {}): RoomState {
  const state = room();
  state.characters.hero = character("hero", { ownerIds: ["p1"] });
  const list: Token[] = [
    token("thorn", { name: "Thorn", kind: "pc", actor: { ref: "hero" }, x: 5, y: 5, attached: { to: "horse", kind: "ride", steer: true } }),
    token("horse", { name: "Warhorse", size: "large", x: 5, y: 5 }),
    token("goblin", { name: "Goblin", x: 6, y: 6 }),
    token("statue", { name: "Statue", locked: true, ownerIds: ["p1"], x: 3, y: 5 }),
    token("torch", { name: "Torch", kind: "object", size: "tiny", x: 5, y: 5, attached: { to: "thorn", kind: "carry" } }),
  ];
  state.tokens = Object.fromEntries(list.map((t) => [t.id, t]));
  over(state);
  return state;
}

function asPlayer(state: RoomState): RoomState {
  return copyFor(state, P1);
}

const t = (view: RoomState, id: string) => view.tokens[id]!;

describe("who may attach, detach and drag", () => {
  test("the plain right to move: owners, through a character too, and the room's leave, never a lock but for the DM", () => {
    const view = asPlayer(table());
    assert.equal(movesToken(view, p1, t(view, "thorn")), true);
    assert.equal(movesToken(view, p1, t(view, "goblin")), false);
    assert.equal(movesToken(view, p1, t(view, "statue")), false);
    assert.equal(movesToken(table(), dm, t(table(), "statue")), true);
    const any = asPlayer(table((s) => (s.meta.settings.playersMoveAny = "all")));
    assert.equal(movesToken(any, p1, t(any, "goblin")), true);
  });

  test("a player directs the mount their creature rides controlled, but not one ridden freely, hidden or locked", () => {
    const view = asPlayer(table());
    assert.equal(steers(view, p1, t(view, "horse")), true);
    assert.equal(dragsToken(view, p1, t(view, "horse")), true);
    const free = asPlayer(table((s) => (s.tokens.thorn = { ...s.tokens.thorn!, attached: { to: "horse", kind: "ride" } })));
    assert.equal(steers(free, p1, t(free, "horse")), false);
    const locked = asPlayer(table((s) => (s.tokens.horse = { ...s.tokens.horse!, locked: true })));
    assert.equal(steers(locked, p1, t(locked, "horse")), false);
    // A mount the DM hides is no mount a player directs, wherever the copy came from.
    const hidden = table((s) => (s.tokens.horse = { ...s.tokens.horse!, visibility: "dm" }));
    assert.equal(steers(hidden, p1, t(hidden, "horse")), false);
  });

  test("a token carried by one the player may move takes a new seat from them", () => {
    const view = asPlayer(table());
    assert.equal(reseats(view, p1, t(view, "torch")), true);
    assert.equal(reseats(view, p1, t(view, "goblin")), false);
  });

  test("Ride, Perch and Carry of an object need both tokens, in reach, and a ride in a fight the rider's own turn", () => {
    const state = table((s) => {
      s.tokens.thorn = { ...s.tokens.thorn!, attached: undefined };
      delete s.tokens.thorn!.attached;
      s.tokens.pony = token("pony", { name: "Pony", size: "large", ownerIds: ["p1"], x: 6, y: 6 });
      s.tokens.farPony = token("farPony", { name: "Far pony", size: "large", ownerIds: ["p1"], x: 20, y: 20 });
    });
    const view = asPlayer(state);
    assert.equal(attachAllowed(view, p1, "ride", t(view, "thorn"), t(view, "pony")), true);
    assert.equal(attachAllowed(view, p1, "ride", t(view, "thorn"), t(view, "horse")), false, "the DM's horse");
    const far = asPlayer(table((s) => (s.tokens.farPony = token("farPony", { size: "large", ownerIds: ["p1"], x: 20, y: 20 }))));
    assert.equal(attachAllowed(far, p1, "ride", t(far, "thorn"), t(far, "farPony")), false, "out of reach");
    state.encounter = { rev: 1, round: 1, activeEntryId: "i-g", entries: [entry("i-t", { tokenId: "thorn" }), entry("i-g", { tokenId: "goblin" })] } as RoomState["encounter"];
    const fight = asPlayer(state);
    assert.equal(notRidersTurn(fight, "thorn"), true);
    assert.equal(attachAllowed(fight, p1, "ride", t(fight, "thorn"), t(fight, "pony")), false);
    assert.equal(attachAllowed(fight, p1, "carry", t(fight, "torch"), t(fight, "thorn")), false, "the torch is the DM's");
    state.encounter!.activeEntryId = "i-t";
    const own = asPlayer(state);
    assert.equal(attachAllowed(own, p1, "ride", t(own, "thorn"), t(own, "pony")), true);
    assert.equal(attachAllowed(own, dm, "ride", t(own, "thorn"), t(own, "farPony")), true, "the DM's fit and reach are the list's to check");
  });

  test("a drag needs the holder, and the creature too unless players see it Grappled", () => {
    const plain = asPlayer(table());
    assert.equal(attachAllowed(plain, p1, "drag", t(plain, "goblin"), t(plain, "thorn")), false);
    const grappled = table((s) => (s.tokens.goblin = { ...s.tokens.goblin!, actor: { inline: actor({ effects: [effect("g", { key: "grappled" })] }) } }));
    const seen = asPlayer(grappled);
    assert.equal(grappledPublicly(seen, t(seen, "goblin")), true);
    assert.equal(attachAllowed(seen, p1, "drag", t(seen, "goblin"), t(seen, "thorn")), true);
    assert.equal(attachAllowed(seen, p1, "carry", t(seen, "goblin"), t(seen, "thorn")), true, "a creature carried by a creature is a grapple too");
    const hidden = table((s) => (s.tokens.goblin = { ...s.tokens.goblin!, actor: { inline: actor({ effects: [effect("g", { key: "grappled", hiddenFromPlayers: true })] }) } }));
    assert.equal(grappledPublicly(hidden, t(hidden, "goblin")), false, "the DM's copy reads the mark as players see it");
    const unseen = asPlayer(hidden);
    assert.equal(attachAllowed(unseen, p1, "drag", t(unseen, "goblin"), t(unseen, "thorn")), false);
  });

  test("a link is undone by whoever moves either end, or owns the carried token, and Attach is offered to whoever moves the token", () => {
    const view = asPlayer(table());
    assert.equal(detachAllowed(view, p1, t(view, "thorn")), true);
    assert.equal(detachAllowed(view, p1, t(view, "torch")), true, "the holder's player puts it down");
    const statue = asPlayer(table((s) => (s.tokens.statue = { ...s.tokens.statue!, attached: { to: "horse", kind: "ride" } })));
    assert.equal(detachAllowed(statue, p1, t(statue, "statue")), true, "a locked creature's owner still gets off");
    assert.equal(detachAllowed(view, p1, t(view, "goblin")), false, "no link");
    assert.equal(offersAttach(view, p1, t(view, "thorn")), true);
    assert.equal(offersAttach(view, p1, t(view, "goblin")), false);
    assert.equal(offersAttach(table(), dm, t(table(), "goblin")), true);
  });
});

/**
 * Every kind of token a link can join, all in reach of each other and in
 * everyone's sight, so the server's "as every player sees it" reads as the
 * copy does: Thorn steering the DM's horse with its saddlebag, a pony of
 * p1's with the DM's locked chest on it, a lamp of p1's, p2's owl with its ring, a creature players see Grappled and
 * one only the DM does, a locked creature of p1's, p1's lynx steering a
 * locked camel with a pack on it, p1's hidden scout steering a mule, and a
 * captive Thorn drags.
 */
function crowd(who: MoveAnyToken, turn: "none" | "thorn" | "goblin" | "hero" | "hidden"): RoomState {
  const state = room();
  state.meta.settings.playersMoveAny = who;
  state.characters.hero = character("hero", { ownerIds: ["p1"] });
  const grappled = (hidden: boolean) => ({ inline: actor({ effects: [effect("g", { key: "grappled", ...(hidden ? { hiddenFromPlayers: true } : {}) })] }) });
  const list: Token[] = [
    token("thorn", { name: "Thorn", kind: "pc", actor: { ref: "hero" }, x: 6, y: 6, attached: { to: "horse", kind: "ride", steer: true } }),
    token("horse", { name: "Warhorse", size: "large", x: 6, y: 6 }),
    token("saddle", { name: "Saddlebag", kind: "object", size: "tiny", x: 7, y: 7, attached: { to: "horse", kind: "carry" } }),
    token("pony", { name: "Pony", size: "large", ownerIds: ["p1"], x: 4, y: 6 }),
    token("chest", { name: "Chest", kind: "object", size: "tiny", locked: true, x: 4, y: 6, attached: { to: "pony", kind: "carry" } }),
    token("lamp", { name: "Lamp", kind: "object", size: "tiny", ownerIds: ["p1"], x: 5, y: 5 }),
    token("owl", { name: "Owl", size: "tiny", ownerIds: ["p2"], x: 8, y: 5 }),
    token("ring", { name: "Ring", kind: "object", size: "tiny", ownerIds: ["p2"], x: 8, y: 5, attached: { to: "owl", kind: "carry" } }),
    token("goblin", { name: "Goblin", x: 5, y: 7, actor: grappled(false) }),
    token("kobold", { name: "Kobold", size: "small", x: 7, y: 5, actor: grappled(true) }),
    token("statue", { name: "Statue", locked: true, ownerIds: ["p1"], x: 5, y: 6 }),
    token("camel", { name: "Camel", size: "large", x: 8, y: 7, locked: true }),
    token("lynx", { name: "Lynx", ownerIds: ["p1"], x: 8, y: 7, attached: { to: "camel", kind: "ride", steer: true } }),
    token("pack", { name: "Pack", kind: "object", size: "tiny", x: 9, y: 8, attached: { to: "camel", kind: "carry" } }),
    token("mule", { name: "Mule", size: "large", x: 3, y: 8 }),
    token("scout", { name: "Scout", ownerIds: ["p1"], visibility: "dm", x: 3, y: 8, attached: { to: "mule", kind: "ride", steer: true } }),
    token("captive", { name: "Captive", x: 6, y: 7, attached: { to: "thorn", kind: "drag" } }),
  ];
  state.tokens = Object.fromEntries(list.map((t) => [t.id, t]));
  if (turn !== "none") {
    const rows = [entry("i-t", { tokenId: "thorn" }), entry("i-g", { tokenId: "goblin" }), entry("i-h", { characterId: "hero" }), entry("i-x", { tokenId: "goblin", hidden: true })];
    const active = { thorn: "i-t", goblin: "i-g", hero: "i-h", hidden: "i-x" }[turn];
    state.encounter = { rev: 1, round: 1, started: true, activeEntryId: active, entries: rows } as unknown as RoomState["encounter"];
  }
  return state;
}

const KINDS: AttachKind[] = ["ride", "perch", "carry", "drag"];
const DEPS = { canUseAsset: () => true };

describe("the rights agree with the server (shared/permissions.ts)", () => {
  const settings: MoveAnyToken[] = ["none", "all", ["p1"], ["p2"]];
  const turns = ["none", "thorn", "goblin", "hero", "hidden"] as const;
  const viewers: Viewer[] = [P1, P2];
  const each = (check: (state: RoomState, view: RoomState, viewer: Viewer, where: string) => void) => {
    for (const who of settings) {
      for (const turn of turns) {
        const state = crowd(who, turn);
        for (const viewer of viewers) check(state, copyFor(state, viewer), viewer, `${JSON.stringify(who)}, ${turn}'s turn, ${viewer.memberId}`);
      }
    }
  };

  test("on every attach of two tokens a player sees, by every kind", () => {
    each((state, view, viewer, where) => {
      const me = { role: "player" as const, memberId: viewer.memberId };
      for (const carried of Object.values(view.tokens)) {
        for (const holder of Object.values(view.tokens)) {
          if (!carried || !holder || carried.id === holder.id) continue;
          for (const kind of KINDS) {
            const offered = attachAllowed(view, me, kind, carried, holder);
            const taken = canApply({ t: "token.attach", tokenId: carried.id, to: holder.id, kind, x: carried.x, y: carried.y, elevation: carried.elevation }, viewer, state, DEPS).ok;
            assert.equal(offered, taken, `${where}: ${kind} ${carried.id} on ${holder.id}`);
          }
        }
      }
    });
  });

  test("on every Get off, Put down and Let go", () => {
    each((state, view, viewer, where) => {
      const me = { role: "player" as const, memberId: viewer.memberId };
      for (const carried of Object.values(view.tokens)) {
        if (!carried) continue;
        const taken = canApply({ t: "token.detach", tokenId: carried.id }, viewer, state, DEPS).ok;
        assert.equal(detachAllowed(view, me, carried), taken, `${where}: detach ${carried.id}`);
      }
    });
  });

  test("on every drag that keeps its token where it stands, by its own right, a mount's or a new seat", () => {
    each((state, view, viewer, where) => {
      const me = { role: "player" as const, memberId: viewer.memberId };
      for (const t of Object.values(view.tokens)) {
        if (!t) continue;
        const offered = dragsToken(view, me, t) || reseats(view, me, t);
        const taken = canApply({ t: "token.move", tokenId: t.id, x: t.x, y: t.y }, viewer, state, DEPS).ok;
        assert.equal(offered, taken, `${where}: drag ${t.id}`);
      }
    });
  });
});
