import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { ActorTarget, ClientOp } from "#shared/protocol.ts";
import { DM, actor, character, room, token } from "#shared/testutil.ts";

const { Children, createElement } = await import("react");
type Drawn = { props: { children?: unknown; label?: string; onChange?(used: number): void } };
const { renderToStaticMarkup } = await import("react-dom/server");
const { LegendaryPips } = await import("./Pips.tsx");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");

/*
 * Where the DM's pips write the counts (review S1-TEST-1): on the
 * character a token plays, where its actor lives, else on the token
 * itself. Each case taps the second pip of "Legendary Actions used" as the
 * DM would, through the pips' own onChange, and reads the op sent.
 */

const legendary = { actionsMax: 3, actionsUsed: 0, resistMax: 2, resistUsed: 0 };

function fixture(): RoomState {
  const state = room({ characters: { thorn: character("thorn", { name: "Thorn", actor: actor({ legendary }) }) } });
  state.tokens.thornT = token("thornT", { kind: "pc", name: "Thorn", actor: { ref: "thorn" } });
  state.tokens.dragon = token("dragon", { name: "Dragon", actor: { inline: actor({ legendary }) } });
  return state;
}

/** The op the DM's tap on "2 used" sends for `target`. */
function tapSecondPip(target: ActorTarget): ClientOp[] {
  const sent: ClientOp[] = [];
  // Calls LegendaryPips inside a render, so its hooks read the room, then presses its pips as a tap would.
  function Probe() {
    const drawn = LegendaryPips({ target }) as unknown as Drawn | null;
    const pips = Children.toArray(drawn?.props.children as never) as unknown as Drawn[];
    pips.find((p) => p.props.label === "Legendary Actions used")?.props.onChange?.(2);
    return null;
  }
  const view = projectState(fixture(), DM, { sceneId: "s1" });
  const store = createStore(() => ({ view, you: { memberId: DM.memberId, role: DM.role }, roomId: "r1", connection: "open", pending: [], local: { selectedIds: [], multi: false } }));
  renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: (op: ClientOp) => (sent.push(op), 1), newId: () => "x" } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(Probe) }),
    }),
  );
  return sent;
}

describe("the DM's pips write the counts where the actor lives (S1-TEST-1)", () => {
  const counts = { actor: { legendary: { ...legendary, actionsUsed: 2 } } };

  test("a token that plays a character writes to the character", () => {
    assert.deepEqual(tapSecondPip({ tokenId: "thornT" }), [{ t: "character.update", characterId: "thorn", patch: counts }]);
  });

  test("a character's own page writes to the character", () => {
    assert.deepEqual(tapSecondPip({ characterId: "thorn" }), [{ t: "character.update", characterId: "thorn", patch: counts }]);
  });

  test("a creature of its own writes to its token", () => {
    assert.deepEqual(tapSecondPip({ tokenId: "dragon" }), [{ t: "token.update", tokenId: "dragon", patch: counts }]);
  });
});
