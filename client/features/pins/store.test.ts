import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import { RoomScope } from "../../state/scope.ts";
import { closePopoverOnSelect, pinSlot } from "./store.ts";

describe("a pin's popover", () => {
  test("goes when a tap selects a token, since the token is on the map, and stays through a deselect", () => {
    const scope = new RoomScope();
    const room = createStore<{ local: { selectedIds: readonly string[] } }>(() => ({ local: { selectedIds: [] } }));
    const pins = scope.get(pinSlot).store;
    const stop = closePopoverOnSelect(room, scope);
    pins.setState({ popover: { id: "pin", at: 0 } });
    room.setState({ local: { selectedIds: ["thorn"] } });
    assert.equal(pins.getState().popover, null);

    // A pin tapped next deselects first (canvas/emptyTap.ts), and that leaves its popover be.
    room.setState({ local: { selectedIds: [] } });
    pins.setState({ popover: { id: "pin", at: 1 } });
    assert.deepEqual(pins.getState().popover, { id: "pin", at: 1 });

    stop();
    room.setState({ local: { selectedIds: ["goblin"] } });
    assert.deepEqual(pins.getState().popover, { id: "pin", at: 1 }, "nothing watches once stopped");
  });
});
