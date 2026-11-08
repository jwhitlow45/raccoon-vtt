import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState, Token } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { loadedMonsters, loadMonsters } from "#shared/srd/monsters.ts";
import { DM, actor, room, token } from "#shared/testutil.ts";

/*
 * The SRD's two chunks fail apart (R2-01-SRC): a reader that waits on the
 * stat blocks alone, as the combat uses and the lair reads do, keeps
 * loading while they load, whatever the rolls table did. Only useDiceView's
 * joined failure, which the attacks read, says the table failed. The blocks
 * load part way through this file, as on a page.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { useCreaturesUses, useFightJoin, useLairCounts } = await import("./state.ts");
const { failSrdRollsForTests, useDiceView } = await import("../dice/useDiceView.ts");

const restore = failSrdRollsForTests();
after(restore);

function table(): RoomState {
  const state = room();
  state.tokens.dragon = token("dragon", { name: "Lair Dragon", size: "huge", x: 2, y: 2, actor: { inline: actor({ srdId: "adult-red-dragon", legendary: { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 } }) } });
  return state;
}

type Read = { uses: unknown[]; loading: boolean; failed: boolean; lair: string; join: string; dice: { failed: boolean; chunkFailed: { monsters: boolean; rolls: boolean } } };

/** What each reader says of the dragon, as text a server render shows. */
function read(state: RoomState): Read {
  const target = { tokenId: "dragon" };
  const targets = [target];
  const tokens = [state.tokens.dragon as Token];
  function Probe() {
    const uses = useCreaturesUses(targets);
    const lair = useLairCounts(target);
    const join = useFightJoin(tokens);
    const dice = useDiceView(targets);
    const out: Read = { ...uses, lair: lair.state, join: join.stateOf(tokens), dice: { failed: dice.failed, chunkFailed: dice.chunkFailed } };
    return createElement("pre", null, JSON.stringify(out));
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

test("qfu1-1: with the rolls table failed and the stat blocks still loading, the uses and the lair reads wait, and only the joined failure says the table failed", () => {
  assert.equal(loadedMonsters(), null, "this case runs before the SRD loads");
  const r = read(table());
  assert.deepEqual({ uses: r.uses, loading: r.loading, failed: r.failed }, { uses: [null], loading: true, failed: false }, "the uses wait for their blocks");
  assert.equal(r.lair, "loading", "In lair waits busy for its block");
  assert.equal(r.join, "loading", "a join waits for the block");
  assert.deepEqual(r.dice, { failed: true, chunkFailed: { monsters: false, rolls: true } });
});

test("qfu1-2: once the stat blocks load, the uses and the lair reads are ready though the rolls table stays failed", async () => {
  await loadMonsters();
  const r = read(table());
  assert.equal(r.loading, false);
  assert.equal(r.failed, false);
  assert.ok(Array.isArray(r.uses[0]), "the dragon's uses read from its block");
  assert.equal(r.lair, "ready");
  assert.equal(r.join, "ready");
  assert.deepEqual(r.dice.chunkFailed, { monsters: false, rolls: true });
});
