import type { ReactNode } from "react";
import type { RoomStore } from "../state/store.ts";
import type { RoomActions } from "../state/types.ts";
import { RoomProvider } from "../state/view.ts";

const keys = new WeakMap<RoomStore, number>();
let made = 0;

/**
 * A live room's tree for one store (LiveRoom.tsx), under a key of that
 * store's own. A store that gives way to another, as for a new member or
 * role, then mounts the tree anew, so nothing Room's scope keeps for one
 * store outlives it. The toasts' voice keeps the last toast id it said
 * there (Room.tsx toastVoiceSlot), and a new store counts its toast ids
 * from one again, so the new store's toasts would stay silent until they
 * passed the old one's (review FU22B-OP-9). No path gives the page a new
 * store under the same tree today, so this is a guard.
 */
export function RoomTree(props: { room: RoomStore; actions: RoomActions; children: ReactNode }) {
  let key = keys.get(props.room);
  if (key === undefined) {
    key = ++made;
    keys.set(props.room, key);
  }
  return (
    <RoomProvider key={key} store={props.room.store} actions={props.actions} ui={props.room.ui}>
      {props.children}
    </RoomProvider>
  );
}
