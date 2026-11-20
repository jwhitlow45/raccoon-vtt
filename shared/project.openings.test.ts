import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, BREE, GROUND, UPPER, applied, tower, withHiddenStairs, withStairs } from "./floorLinksTestutil.ts";
import { keys, tileKey } from "./keys.ts";
import type { FloorLink, ProjectedFloorLink, RoomState, Viewer } from "./model.ts";
import { canApply } from "./permissions.ts";
import { dependents, projectEntity, projectState } from "./project.ts";
import type { Op } from "./protocol.ts";
import { LINK_WORDS } from "./rules/floorLinks.ts";
import { DM, FULL_TILE_BITS, deepClone, reveal } from "./testutil.ts";

/*
 * What players get of ends (docs/design/design-v1-floors.md phase 4, 8.1
 * and 8.2, 10.1): nothing of a hidden end, no key, count or id, so a climb
 * there, its undo and a ruler naming it answer as on no stairs; and a far
 * end's offset, `shift`, only while that far end is itself projected, so
 * it never tells a fogged end's place (D-261119-008, 094).
 */

const DISPLAY: Viewer = { memberId: "display:table", role: "player" };
const opened = (state: RoomState): RoomState => ({ ...state, openFloors: { ...state.openFloors, [UPPER]: { sceneId: UPPER, rev: 0 } } });
const decide = (state: RoomState, op: Op, who: Viewer = ANA) => {
  const d = canApply(op, who, state, { canUseAsset: () => true });
  return d.ok ? "ok" : `${d.code}: ${d.message}`;
};
const climb: Op = { t: "token.climb", tokenId: "thorn", linkId: "l1" };

describe("a hidden pair (8.1)", () => {
  const hidden = opened(withHiddenStairs());
  const none = opened(tower());

  test("no player and no display gets either end, its key, count or id, and the DM gets both", () => {
    for (const viewer of [ANA, BREE, DISPLAY]) {
      const copy = projectState(hidden, viewer, { sceneId: null });
      assert.equal(copy.floorLinks, undefined, viewer.memberId);
      for (const id of ["l1", "l2"]) assert.equal(projectEntity(keys.floorLink(id), hidden, viewer, { sceneId: null }), null, `${viewer.memberId} ${id}`);
      assert.deepEqual(copy, projectState(none, viewer, { sceneId: null }), `${viewer.memberId}: the same copy as with no stairs`);
    }
    assert.deepEqual(Object.keys(projectState(hidden, DM, { sceneId: GROUND }).floorLinks ?? {}).sort(), ["l1", "l2"]);
  });

  test("Ana's climb on them is refused as on no stairs, and the DM's is not", () => {
    assert.equal(decide(hidden, climb), `invalid: ${LINK_WORDS.noStairs}`);
    assert.equal(decide(hidden, climb, DM), "ok");
  });

  test("the undo of a climb made before the DM hid them answers as stairs that changed", () => {
    const before = withStairs();
    const r = applied(before, climb, ANA);
    const link = before.floorLinks!.l1!;
    const undo: Op = { t: "sys.restore", entries: [...(r.inverse ?? [])], from: "undo", deps: true, climb: { tokenId: "thorn", linkId: "l1", rev: link.rev, made: link.made, from: GROUND, to: UPPER } };
    assert.equal(decide(r.state, undo), "ok");
    const hide = (s: RoomState): RoomState => ({ ...s, floorLinks: Object.fromEntries(Object.entries(s.floorLinks!).map(([id, l]) => [id, { ...l, hidden: true as const }])) });
    assert.equal(decide(hide(r.state), undo), `invalid: ${LINK_WORDS.changed("stairs")}`);
  });
});

describe("a far end on other squares (8.2)", () => {
  /** Stairs l1 on Ground floor at 3, 3, and their far end l2 on Upper floor 3 squares east, fog on upstairs over everything. */
  function moved(): RoomState {
    const s = opened(withStairs());
    const upper = { ...s.scenes[UPPER]!, fogEnabled: true };
    const l2: FloorLink = { ...s.floorLinks!.l2!, rect: { ...s.floorLinks!.l2!.rect, x: 6 } };
    return { ...s, scenes: { ...s.scenes, [UPPER]: upper }, floorLinks: { ...s.floorLinks!, l2 } };
  }
  const near = (s: RoomState, viewer: Viewer = ANA) => projectEntity(keys.floorLink("l1"), s, viewer, { sceneId: null }) as ProjectedFloorLink | null;

  test("while the far end lies under full fog the near end carries no shift, and once it is revealed it does", () => {
    const fogged = moved();
    assert.equal(projectEntity(keys.floorLink("l2"), fogged, ANA, { sceneId: null }), null, "the far end is not projected");
    assert.ok(near(fogged));
    assert.equal(near(fogged)!.shift, undefined);
    const shown = deepClone(fogged);
    reveal(shown, UPPER, { x: 6, y: 3, w: 2, h: 1 });
    assert.ok(projectEntity(keys.floorLink("l2"), shown, ANA, { sceneId: null }));
    assert.deepEqual(near(shown)!.shift, { dx: 3, dy: 0 });
    assert.deepEqual(near(shown, DISPLAY)!.shift, { dx: 3, dy: 0 });
    // The far end's own shift points back.
    assert.deepEqual((projectEntity(keys.floorLink("l2"), shown, ANA, { sceneId: null }) as ProjectedFloorLink).shift, { dx: -3, dy: 0 });
  });

  test("ends on the same squares carry no shift, and the DM gets ends as stored", () => {
    const same = opened(withStairs());
    assert.equal(near(same)!.shift, undefined);
    assert.equal((projectEntity(keys.floorLink("l1"), moved(), DM, { sceneId: GROUND }) as FloorLink & { shift?: unknown }).shift, undefined);
  });

  test("a far end on a floor the viewer does not hold sends no shift", () => {
    const s = moved();
    const unreached = { ...s, openFloors: {}, scenes: { ...s.scenes, [UPPER]: { ...s.scenes[UPPER]!, fogEnabled: false } } };
    assert.equal(near(unreached)!.shift, undefined);
    assert.equal(near(unreached)!.to, undefined);
  });

  test("the reveal that projects the far end re-projects the near one (D-261119-094)", () => {
    const s = moved();
    const explored = { ...s, exploredTiles: { ...s.exploredTiles, [tileKey(UPPER, 0, 0)]: { sceneId: UPPER, tx: 0, ty: 0, rev: 1, bits: FULL_TILE_BITS } } };
    const deps = dependents(explored, [keys.explored(UPPER, 0, 0)], s);
    assert.ok(deps.includes(keys.floorLink("l2")));
    assert.ok(deps.includes(keys.floorLink("l1")), "the near end, on another floor, reads the far end's fog");
    assert.ok(dependents(s, [keys.floorLink("l2")]).includes(keys.floorLink("l1")), "a write to one end re-projects its pair");
  });
});
