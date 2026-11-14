import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { FAR, HARD, LIMITS, serializedBytes } from "#shared/limits.ts";
import type { Op } from "#shared/protocol.ts";
import { companionBlock } from "#shared/testutil.ts";
import { fullRoom } from "./limitsTesting.ts";
import { farRoomBytes, playerBlockBytes } from "./sizeGuard.ts";
import { scopeActor } from "./undoScopeTesting.ts";

/*
 * Players' companion stat blocks inside the far room line (sizeGuard.ts
 * farRoomBytes): the far reading counts them, so on the full room a
 * player's further blocks are refused and the stored room stays within
 * HARD.storedBytes and the import's room file cap.
 */

describe("players' companion blocks at the far room line", () => {
  test("on the full room a player's further blocks are refused, and the stored room stays within its bounds", async (t) => {
    const { state } = fullRoom();
    assert.ok(playerBlockBytes(state) > 0, "the full room holds players' blocks");
    assert.ok(farRoomBytes(state, true) <= FAR.roomBytes, `the full room reads ${farRoomBytes(state, true)}, within the line`);
    // Characters whose own caps leave room for blocks near the largest a block may be.
    const counts = new Map<string, number>();
    for (const block of Object.values(state.companionBlocks)) counts.set(block.characterId, (counts.get(block.characterId) ?? 0) + 1);
    const free = Object.values(state.characters).filter((c) => !counts.has(c.id) && c.ownerIds.length > 0);
    // The save budget refills while the clock moves, so only the room's lines can refuse.
    let now = Date.now();
    const clock = () => now;
    const h = await scopeActor(t, state, { now: clock });
    const traits = [1, 2, 3].map((i) => ({ name: `Trait ${i}`, text: "w".repeat(4_000) }));
    const perCharacter = Math.floor(LIMITS.companionBlockBytesPerCharacter / serializedBytes(companionBlock(uuidv7(), "c", { traits })));
    let taken = 0;
    let refused = 0;
    for (const character of free.slice(0, 3)) {
      const player = await h.connect(state.members[character.ownerIds[0]!]!, "player", clock);
      for (let i = 0; i < perCharacter; i++) {
        now += LIMITS.companionBlockWriteRefillMs;
        const { rev: _rev, ...block } = companionBlock(uuidv7(now), character.id, { traits });
        const event = await player.send({ t: "companionBlock.create", block } as Op);
        if (event.rejects?.length) refused++;
        else taken++;
      }
    }
    const after = h.actor.committed.state;
    const stored = serializedBytes(after);
    assert.ok(refused > 0, `every one of ${taken} blocks taken`);
    assert.ok(farRoomBytes(after, true) <= FAR.roomBytes, `the room reads ${farRoomBytes(after, true)} after ${taken} blocks`);
    assert.ok(stored <= HARD.storedBytes, `stored ${stored} after ${taken} blocks`);
    assert.ok(stored <= HARD.roomJsonBytes, `stored ${stored} within the import's room file cap`);
  });
});
