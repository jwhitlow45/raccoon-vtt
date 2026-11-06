import { createContext, createElement, useContext, useMemo, useRef, type ReactNode } from "react";
import type { OpOf } from "#shared/protocol.ts";
import type { RoomActions } from "../../../state/types.ts";
import { send } from "../panel/ops.ts";

/**
 * The window's jumps still waiting for the server's answer
 * (docs/design/design-v1-music-player.md 4.2, PLR-35). The store predicts a
 * jump from the device's clock, so the position it shows for the new run
 * reads that clock against the server's. Previous counts the playing track
 * as at 0 s while one is pending, so two presses within a round trip go
 * back two tracks, never restart the first twice.
 */
export type Jumps = { pending(): boolean; send(op: OpOf<"music.jump">): void };

const JumpsContext = createContext<Jumps | null>(null);

export function JumpsScope(props: { actions: Pick<RoomActions, "dispatch">; children: ReactNode }) {
  const count = useRef(0);
  const { actions } = props;
  const jumps = useMemo<Jumps>(
    () => ({
      pending: () => count.current > 0,
      send(op) {
        count.current += 1;
        let heard = false;
        send(actions, op, () => {
          // An answer comes once, but a resend after a reconnect must not count it down twice.
          if (heard) return;
          heard = true;
          count.current = Math.max(0, count.current - 1);
        });
      },
    }),
    [actions],
  );
  return createElement(JumpsContext.Provider, { value: jumps }, props.children);
}

/** Outside a window, as in a render test, a jump is sent with nothing to count. */
export function useJumps(): Jumps {
  return useContext(JumpsContext) ?? UNCOUNTED;
}

const UNCOUNTED: Jumps = { pending: () => false, send: () => {} };
