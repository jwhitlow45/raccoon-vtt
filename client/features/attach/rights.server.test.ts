import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AttachKind, CreatureSize, RoomState, Token, Viewer } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { projectState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { ATTACH_KINDS, linkHolds, seatSpot } from "#shared/rules/attach.ts";
import { actor, chance, effect, int, P1, P2, pick, rng, room, token } from "#shared/testutil.ts";
import { attachAllowed, detachAllowed, dragsToken, reseats } from "./rights.ts";
import { SQUARES } from "#shared/rules/grid.ts";

/**
 * The client's rights (rights.ts) against the server's (shared/permissions.ts
 * canApply) on random rooms, read from each player's own copy as the bar and
 * the map read them: every attach, detach and drag the client offers the
 * server takes, and every one it takes the client offers. Scenes here do
 * not stop moves, since the seat's and the get-off's leg tests belong to
 * the list and the detach button (list.ts, detach.ts), not to these rights.
 */

const deps = { canUseAsset: () => true };
const SIZES: readonly CreatureSize[] = ["tiny", "small", "medium", "large", "huge"];
const KINDS = ["pc", "npc", "monster", "object"] as const;

function randomRoom(r: () => number): RoomState {
  const state = room();
  state.meta.settings = { ...state.meta.settings, playersMoveAny: pick(r, ["none", "all", ["p1"], ["p2"]] as const) };
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  for (const id of ids) {
    const owner = r();
    state.tokens[id] = token(id, {
      name: id.toUpperCase(),
      kind: pick(r, KINDS),
      size: pick(r, SIZES),
      x: int(r, 2, 6),
      y: int(r, 2, 6),
      ...(owner < 0.3 ? { ownerIds: ["p1"] } : owner < 0.5 ? { ownerIds: ["p2"] } : {}),
      ...(chance(r, 0.15) ? { locked: true } : {}),
      ...(chance(r, 0.2) ? { visibility: "dm" as const } : {}),
      ...(chance(r, 0.3) ? { actor: { inline: actor({ effects: [effect(`g${id}`, { key: "grappled", ...(chance(r, 0.4) ? { hiddenFromPlayers: true } : {}) })] }) } } : {}),
    });
  }
  // Some links of each kind, seated where they hold, as the link pass leaves every room.
  for (const id of ids) {
    if (!chance(r, 0.4)) continue;
    const to = pick(r, ids);
    const holder = state.tokens[to]!;
    if (to === id || holder.attached?.to === id) continue;
    const kind = pick(r, ATTACH_KINDS);
    const carried = state.tokens[id]!;
    const seat = kind === "drag" ? { x: holder.x + 1, y: holder.y } : seatSpot(SQUARES, carried, holder);
    if (!seat) continue;
    const linked: Token = { ...carried, ...seat, attached: { to, kind, ...(kind === "ride" && chance(r, 0.6) ? { steer: true as const } : {}) } };
    if (linkHolds(SQUARES, state.meta.settings, kind, linked, holder)) state.tokens[id] = linked;
  }
  // A seat taken later can move a holder off the tokens it holds, and those come loose, as in the link pass.
  for (const t of Object.values(state.tokens)) {
    const holder = t.attached ? state.tokens[t.attached.to] : undefined;
    if (t.attached && (!holder || !linkHolds(SQUARES, state.meta.settings, t.attached.kind, t, holder))) {
      const { attached: _loose, ...rest } = t;
      state.tokens[t.id] = rest;
    }
  }
  if (chance(r, 0.6)) {
    const rows = ids.slice(0, 5).map((id, i) => ({ id: `e${id}`, tokenId: id, value: 20 - i, tieOrder: i, hidden: chance(r, 0.2), inLair: false, reactionUsed: false }));
    const active = chance(r, 0.8) ? pick(r, rows).id : null;
    state.encounter = { rev: 0, round: 1, activeEntryId: active, started: true, entries: rows };
  }
  return state;
}

/** The op the bar sends for a pair: the carried token's seat on the holder, or where a dragged one stands. */
function attachOp(carried: Token, holder: Token, kind: AttachKind): Op {
  const seat = kind === "drag" ? carried : (seatSpot(SQUARES, carried, holder) ?? holder);
  return { t: "token.attach", tokenId: carried.id, to: holder.id, kind, ...(kind === "ride" ? { steer: true as const } : {}), x: seat.x, y: seat.y, elevation: kind === "drag" ? carried.elevation : holder.elevation };
}

describe("the client's attach rights agree with the server's (docs/design-v1-attach.md 6)", () => {
  test("for every pair, kind, detach and drag a player's copy holds, on random rooms", () => {
    let compared = 0;
    let offered = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const state = randomRoom(rng(seed));
      for (const viewer of [P1, P2] as const) {
        const view = projectState(state, viewer, { sceneId: "s1" }) as unknown as RoomState;
        const who = { role: viewer.role, memberId: viewer.memberId };
        const tokens = Object.values(view.tokens);
        const taken = (op: Op) => canApply(op, viewer as Viewer, state, deps).ok;
        const where = (what: string) => `seed ${seed}, ${viewer.memberId}: ${what}`;
        for (const carried of tokens) {
          for (const holder of tokens) {
            if (carried.id === holder.id) continue;
            for (const kind of ATTACH_KINDS) {
              const client = attachAllowed(view, who, kind, carried, holder);
              assert.equal(client, taken(attachOp(carried, holder, kind)), where(`${kind} ${carried.id} on ${holder.id}`));
              compared++;
              if (client) offered++;
            }
          }
          if (carried.attached && view.tokens[carried.attached.to]) {
            assert.equal(detachAllowed(view, who, carried), taken({ t: "token.detach", tokenId: carried.id }), where(`detach ${carried.id}`));
            compared++;
          }
          // A press that keeps the token where it stands keeps any link, so it asks only whether the drag may start.
          const drag = dragsToken(view, who, carried) || reseats(view, who, carried);
          assert.equal(drag, taken({ t: "token.move", tokenId: carried.id, x: carried.x, y: carried.y }), where(`drag ${carried.id}`));
          compared++;
        }
      }
    }
    assert.ok(compared > 5000 && offered > 200, `compared ${compared}, offered ${offered}`);
  });
});
