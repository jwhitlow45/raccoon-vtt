import { useState, type FormEvent } from "react";
import { Button } from "../../components/Button.tsx";
import { Empty } from "../../components/Empty.tsx";
import { Card, ErrorText, Field } from "../../components/Field.tsx";
import { Help } from "../../components/Panel.tsx";
import { Row, RowList } from "../../components/Row.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { Tag } from "../../components/Tag.tsx";
import { ApiError } from "../../lib/api.ts";
import { formatRoomId } from "../../lib/roomId.ts";
import { theme } from "../../lib/theme.ts";
import { adminApi, type AdminRoom } from "./api.ts";
import { ago, confirmsRoom, day, formatBytes, plural, sortRooms, type RoomSort } from "./format.ts";

const SORTS = [
  { value: "active", label: "Last active" },
  { value: "size", label: "Size" },
] as const;

/**
 * Every room with its size and state, pin and delete (docs/design-v1-dm-tools.md
 * 3.18). Nothing here opens a room or shows what is in one.
 */
export function RoomsCard(props: { rooms: AdminRoom[]; now: number; onChanged(): void; onSignedOut(): void }) {
  const [sort, setSort] = useState<RoomSort>("active");
  const sorted = sortRooms(props.rooms, sort);
  return (
    <Card title={`Rooms (${props.rooms.length.toLocaleString()})`}>
      <Help>A room's size counts every image it holds, so an image two rooms share counts in both.</Help>
      <Segmented label="Sort rooms" value={sort} options={SORTS} onChange={setSort} />
      {sorted.length === 0 ? (
        <Empty>No rooms yet. Each room made on this server shows here.</Empty>
      ) : (
        <RowList>
          {sorted.map((room) => (
            <RoomRow key={room.id} room={room} now={props.now} onChanged={props.onChanged} onSignedOut={props.onSignedOut} />
          ))}
        </RowList>
      )}
    </Card>
  );
}

/**
 * A room as a list row: its name and ID over its size, then when it was
 * active, then its actions. The actions sit under the text rather than
 * beside it, as Pin and Delete beside the name would cut a phone's room
 * name to a few letters.
 */
function RoomRow(props: { room: AdminRoom; now: number; onChanged(): void; onSignedOut(): void }) {
  const { room } = props;
  const [busy, setBusy] = useState<"pin" | "delete" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function act(kind: "pin" | "delete", run: () => Promise<void>) {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      await run();
      props.onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return props.onSignedOut();
      setError(err instanceof ApiError && err.code === "room_not_found" ? "This room is gone already." : err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  function submitDelete(e: FormEvent) {
    e.preventDefault();
    if (!confirmsRoom(typed, room.id)) return;
    void act("delete", () => adminApi.deleteRoom(room.id, typed));
  }

  const status = room.loaded ? `Loaded, ${plural(room.sockets, "socket")} open` : "Not loaded";
  return (
    <div style={{ display: "grid", gap: theme.space(2), paddingBottom: theme.space(3) }}>
      <Row
        title={room.name}
        detail={`${formatRoomId(room.id)} · ${formatBytes(room.bytes)}, ${plural(room.images, "image")}`}
        style={{ padding: `${theme.space(2)}px 0 0` }}
      />
      <Help>
        {status}. Active {ago(room.lastActiveAt, props.now)}, created {day(room.createdAt)}.
      </Help>
      {confirming ? (
        <form onSubmit={submitDelete} style={{ display: "grid", gap: theme.space(2) }}>
          <Field
            label={`Type ${formatRoomId(room.id)} to delete this room for good`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            hint="Its players are sent out at once. Its images go too, unless another room uses them."
          />
          <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
            <Button type="submit" variant="danger" size="sm" armed busy={busy === "delete"} disabled={busy !== "delete" && !confirmsRoom(typed, room.id)}>
              {busy === "delete" ? "Deleting…" : "Delete room"}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setConfirming(false);
                setTyped("");
              }}
              disabled={busy !== null}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>
          <Button size="sm" busy={busy === "pin"} disabled={busy === "delete"} onClick={() => void act("pin", () => adminApi.pin(room.id, !room.pinned))}>
            {busy === "pin" ? (room.pinned ? "Unpinning…" : "Pinning…") : room.pinned ? "Unpin" : "Pin"}
          </Button>
          <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => setConfirming(true)}>
            Delete
          </Button>
          {room.pinned ? <Tag>Pinned</Tag> : null}
          {room.readOnly ? <Tag tone="warning">Read-only: at its quota</Tag> : null}
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
