import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, withStairs } from "#shared/floorLinksTestutil.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { DM } from "#shared/testutil.ts";
import { RoomScope } from "../../state/scope.ts";
import { shortcutFor, type KeyPress, type ShortcutEnv } from "../../state/shortcuts.ts";
import type { RoomUi } from "../../state/store.ts";
import type { RoomActions, RoomView } from "../../state/types.ts";

/*
 * `}` and `{` (docs/design/design-v1-floors.md phase 2, 6.2): Go up and Go
 * down for the one selected creature, through the bar's one wait, and a
 * note elsewhere. On the shared tower, Thorn on stairs from Ground floor up
 * to Upper floor.
 */

function room(viewer: Viewer, state: RoomState, selected: string[]) {
  const ops: ClientOp[] = [];
  const notes: string[] = [];
  const page = {
    you: viewer,
    sceneId: "s1",
    pending: [] as { n: number }[],
    local: { selectedIds: selected, selectedId: selected.at(-1) ?? null, tool: "select" },
    view: state,
    floorView: state,
  };
  const env: ShortcutEnv = {
    role: viewer.role,
    tools: [{ id: "select" }],
    getState: () => page as unknown as RoomView,
    actions: {
      dispatch: (op: ClientOp) => {
        ops.push(op);
        const n = ops.length;
        page.pending = [...page.pending, { n }];
        return n;
      },
    } as unknown as RoomActions,
    ui: { notify: (text: string) => void notes.push(text) } as unknown as RoomUi,
    scope: new RoomScope(),
  };
  const key = (k: string) => {
    const p: KeyPress = { key: k, code: k === "}" ? "BracketRight" : "BracketLeft", ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, repeat: false, defaultPrevented: false, target: { tagName: "BODY" } };
    const row = shortcutFor(p, env, { dialogOpen: false, preview: false });
    row?.run(env, p);
    return row?.id ?? null;
  };
  return { ops, notes, page, key };
}

describe("} and {", () => {
  test("} climbs the selected creature the bar would, and a second press while it is out sends nothing", () => {
    for (const viewer of [DM, ANA]) {
      const r = room(viewer, withStairs(), ["thorn"]);
      assert.equal(r.key("}"), "goUp");
      assert.deepEqual(r.ops, [{ t: "token.climb", tokenId: "thorn", linkId: "l1" }], viewer.role);
      r.key("}");
      assert.equal(r.ops.length, 1, `${viewer.role}: one climb while the first is out`);
      r.page.pending = [];
      r.key("}");
      assert.equal(r.ops.length, 2, `${viewer.role}: the answer frees the next`);
    }
  });

  test("{ on stairs that lead up, or a creature on none, says so and sends nothing", () => {
    const r = room(DM, withStairs(), ["thorn"]);
    assert.equal(r.key("{"), "goDown");
    const s = withStairs();
    const off = room(DM, { ...s, tokens: { ...s.tokens, thorn: { ...s.tokens.thorn!, x: 9, y: 9 } } }, ["thorn"]);
    off.key("}");
    assert.deepEqual([...r.notes, ...off.notes], ["Thorn isn't on stairs or a ladder going down.", "Thorn isn't on stairs or a ladder."]);
    assert.deepEqual([...r.ops, ...off.ops], []);
  });

  test("locked stairs say so", () => {
    const s = withStairs();
    const locked = { ...s, floorLinks: { ...s.floorLinks!, l1: { ...s.floorLinks!.l1!, locked: true as const } } };
    const r = room(DM, locked, ["thorn"]);
    r.key("}");
    assert.deepEqual([r.ops, r.notes], [[], ["It's locked."]]);
  });

  test("with two selected or none, the keys are nobody's", () => {
    assert.equal(room(DM, withStairs(), []).key("}"), null);
    assert.equal(room(DM, withStairs(), ["thorn", "other"]).key("}"), null);
  });
});
