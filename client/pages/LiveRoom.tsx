import { useEffect, useState } from "react";
import { ephRate, lowPower } from "../features/device/settings.ts";
import { api, ApiError, type Me } from "../lib/api.ts";
import { theme } from "../lib/theme.ts";
import { createRoomActions } from "../state/actions.ts";
import { browserEnv, createRoomSocket, roomSocketUrl } from "../state/socket.ts";
import { createRoomStore, type RoomStore } from "../state/store.ts";
import type { RoomActions, You } from "../state/types.ts";
import { RoomProvider } from "../state/view.ts";
import { XCardHost } from "../features/xcard/XCardHost.tsx";
import { Room } from "./Room.tsx";

/**
 * Who this device is in the room, asked again after a 4001 close. A grant
 * still on file means the close was a role change and the socket reconnects
 * as the new role. 401, 403 and 404 mean the grant is gone. Anything else is
 * a network problem, which the socket retries like any other close.
 */
async function recheck(roomId: string): Promise<You | null> {
  try {
    const me = await api.getMe(roomId);
    return { memberId: me.member.id, role: me.role };
  } catch (err) {
    if (err instanceof ApiError && [401, 403, 404].includes(err.status)) return null;
    throw err;
  }
}

type Live = { room: RoomStore; actions: RoomActions };

/**
 * A real room: one store and one socket for as long as the page shows it
 * (design section 14.1). `me` is the caller's member and role from GET
 * /api/rooms/:id/me, which RoomRoute already asked before choosing this
 * page over the join page. It shapes the UI until the snapshot's own `you`
 * arrives.
 *
 * Both are made in an effect, not during render, so React's development
 * double mount tears down the first pair cleanly instead of leaving a
 * second socket open.
 */
export default function LiveRoom(props: { roomId: string; me: Me }) {
  const { roomId } = props;
  const memberId = props.me.member.id;
  const role = props.me.role;
  const [live, setLive] = useState<Live | null>(null);

  useEffect(() => {
    const room = createRoomStore({ roomId, you: { memberId, role } });
    const socket = createRoomSocket({
      url: roomSocketUrl(roomId),
      room,
      env: browserEnv(),
      recheck: () => recheck(roomId),
      // Low power sends fewer drag and ruler frames (docs/design-v1-dm-tools.md 3.15).
      ephPerSecond: () => ephRate(lowPower()),
    });
    socket.start();
    setLive({ room, actions: createRoomActions(room, socket) });
    return () => {
      socket.dispose();
      room.dispose();
      setLive(null);
    };
  }, [roomId, memberId, role]);

  // The page color, as the room's own wait before it (RoomRoute.tsx), so the room opens without a black flash.
  if (!live) return <div style={{ position: "fixed", inset: 0, background: theme.color.bg }} />;
  return (
    <RoomProvider store={live.room.store} actions={live.actions} ui={live.room.ui}>
      <Room />
      <XCardHost />
    </RoomProvider>
  );
}
