import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { character, room, token } from "#shared/testutil.ts";
import { INITIAL_LOCAL } from "../../state/types.ts";
import { secretStartIn } from "./useDicePanel.ts";

/**
 * Where the Dice panel's Secret starts (docs/design-v1-dice.md 8.2 and 17):
 * pressed only for a DM's roll for a monster. With no creature in the roll,
 * the panel's own, the DM's selection, decides, so the chip shows what its
 * next roll does.
 */
describe("the panel's Secret start", () => {
  const view = room({
    characters: { thorn: character("thorn", { ownerIds: ["p1"] }) },
    tokens: { goblin: token("goblin"), thorn: token("thorn", { kind: "pc", actor: { ref: "thorn" } }) },
  });
  const dm = (selectedIds: string[]) => ({ view, you: { memberId: "dm1", role: "dm" as const }, local: { ...INITIAL_LOCAL, selectedIds } });

  test("a DM's free formula with nothing selected starts in the open", () => {
    assert.equal(secretStartIn(dm([]), []), false);
  });

  test("a DM's panel opened for a goblin starts pressed, and for Thorn in the open", () => {
    assert.equal(secretStartIn(dm(["goblin"]), []), true);
    assert.equal(secretStartIn(dm(["thorn"]), []), false);
    assert.equal(secretStartIn(dm(["thorn", "goblin"]), []), true);
  });

  test("a roll's own creatures win over the selection", () => {
    assert.equal(secretStartIn(dm(["thorn"]), [{ tokenId: "goblin" }]), true);
    assert.equal(secretStartIn(dm(["goblin"]), [{ characterId: "thorn" }]), false);
  });

  test("a player's panel never starts pressed", () => {
    assert.equal(secretStartIn({ ...dm(["goblin"]), you: { memberId: "p1", role: "player" } }, [{ tokenId: "goblin" }]), false);
  });
});
