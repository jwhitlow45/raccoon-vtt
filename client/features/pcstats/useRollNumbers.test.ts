import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { loadedMonsters } from "#shared/srd/monsters.ts";
import { DM, actor, character, room } from "#shared/testutil.ts";

/*
 * A shape's numbers wait on the rolls table alone (R2-01-SRC, QFU1-C-03):
 * a character in a shape needs the stat blocks too, for its actions, but a
 * failed load of those never says its numbers failed.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { useCharacterRollNumbers } = await import("./useRollNumbers.ts");
const { failSrdBlocksForTests } = await import("../monsters/srdBlocks.ts");
const { useDiceView } = await import("../dice/useDiceView.ts");

type Read = { numbers: unknown; loading: boolean; failed: boolean; chunkFailed: { monsters: boolean; rolls: boolean } };

/** What the hook says of Bree in a bear's shape, as text a server render shows. */
function read(state: RoomState): Read {
  const creatures = [{ characterId: "bree" }];
  function Probe() {
    const rolls = useCharacterRollNumbers("bree");
    const { chunkFailed } = useDiceView(creatures);
    return createElement("pre", null, JSON.stringify({ ...rolls, chunkFailed }));
  }
  const view = projectState(state, DM, { sceneId: "s1" });
  const store = createStore(() => ({ view, you: { memberId: DM.memberId, role: DM.role }, roomId: "r1", connection: "open", pending: [], local: { selectedIds: [], multi: false } }));
  const markup = renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => 1, newId: () => "x" } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(Probe) }),
    }),
  );
  return JSON.parse(/<pre>(.*)<\/pre>/.exec(markup)![1]!.replaceAll("&quot;", '"')) as Read;
}

test("qfu2-4: with the stat blocks failed and the rolls table still loading, a shape's numbers wait and never say they failed", (t) => {
  assert.equal(loadedMonsters(), null, "the stat blocks never load in this file");
  t.after(failSrdBlocksForTests());
  const state = room({ characters: { bree: character("bree", { name: "Bree", actor: actor({ srdId: "brown-bear", wildShape: true }) }) } });
  const r = read(state);
  assert.deepEqual(r.chunkFailed, { monsters: true, rolls: false }, "the blocks failed and the table did not");
  assert.deepEqual({ numbers: r.numbers, loading: r.loading, failed: r.failed }, { numbers: null, loading: true, failed: false });
});
