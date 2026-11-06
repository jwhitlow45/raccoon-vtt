import { useMemo } from "react";
import type { OpOf } from "#shared/protocol.ts";
import { scopeSlot, useScoped } from "../../../state/scope.ts";
import type { RoomActions } from "../../../state/types.ts";
import { useRoomActions } from "../../../state/view.ts";
import { send } from "../panel/ops.ts";

/**
 * The jumps still waiting for the server's answer
 * (docs/design/design-v1-music-player.md 4.2, PLR-35). The store predicts a
 * jump from the device's clock, so the position it shows for the new run
 * reads that clock against the server's. Previous counts the playing track
 * as at 0 s while one is pending, so two presses within a round trip go
 * back two tracks, never restart the first twice.
 */
export type Jumps = { pending(): boolean; send(op: OpOf<"music.jump">): void };

/** How many jumps wait, for one Room page. */
export type JumpCount = { n: number };

/**
 * One count for the Room page, not one per player
 * (docs/design/design-v1-sound-layout.md 5.3): Previous, Seek and Play now
 * from the Sound panel and from the chip's player count together, so a
 * jump pending from one counts in the other.
 */
export const jumpsSlot = scopeSlot<JumpCount>(() => ({ n: 0 }));

/** Jumps sent through `actions`, counted in `count`. */
export function jumpsOf(count: JumpCount, actions: Pick<RoomActions, "dispatch">): Jumps {
  return {
    pending: () => count.n > 0,
    send(op) {
      count.n += 1;
      let heard = false;
      send(actions, op, () => {
        // An answer comes once, but a resend after a reconnect must not count it down twice.
        if (heard) return;
        heard = true;
        count.n = Math.max(0, count.n - 1);
      });
    },
  };
}

/**
 * The Room page's jumps. Outside a Room this throws, as every scoped read
 * does: there is no count to fall back on that would not leave a player's
 * Previous and Seek sending nothing.
 */
export function useJumps(): Jumps {
  const count = useScoped(jumpsSlot);
  const actions = useRoomActions();
  return useMemo(() => jumpsOf(count, actions), [count, actions]);
}
