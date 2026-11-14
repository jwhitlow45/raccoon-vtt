import { useEffect, useRef, useState } from "react";
import { Button } from "../../client/components/Button.tsx";
import { Loading } from "../../client/components/Loading.tsx";
import { theme } from "../../client/lib/theme.ts";
import { WORDS, type RaccoonLocal, type RoomSummary, type SupervisorStatus } from "../contract.ts";
import { formatRelative } from "./format.ts";
import { Card, Confirm, Help, useAction } from "./ui.tsx";
import { failureText, restoring, serverUp } from "./view.ts";

/**
 * Rooms on this computer (design 8.6 and 9, item 4): each room's name and
 * when it was last played, and New DM link, which opens the new link in the
 * browser and never shows it here. Rooms are made, renamed and deleted in
 * the browser, which tells the window nothing, so the list is asked for
 * again when the window comes forward or is shown, and so is a first list
 * that failed. No timer asks: each list runs the admin script, which sizes
 * every room's history on the database players are using.
 */
export function RoomsSection(props: { sup: SupervisorStatus; bridge: RaccoonLocal; now: Date }) {
  const { sup, bridge } = props;
  const up = serverUp(sup);
  const blocked = restoring(sup);
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [asking, setAsking] = useState<RoomSummary | null>(null);
  const [opened, setOpened] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);

  // Only the newest answer counts, so a slow one never puts back a list a newer one replaced.
  const asked = useRef(0);
  const [again, setAgain] = useState(0);
  // The background list runs only once the first has answered, rows or a
  // failure, so it never stands in for a first list still on its way.
  const listed = useRef(false);
  listed.current = up && (rooms !== null || failure !== null);

  // Lists again whenever the server comes up, so a restore, a port change or a restart never leaves rooms from before it.
  useEffect(() => {
    if (!up) {
      setRooms(null);
      return;
    }
    const mine = ++asked.current;
    setLoading(true);
    setFailure(null);
    bridge
      .listRooms()
      .then((result) => {
        if (mine !== asked.current) return;
        if (result.ok) setRooms(result.value.rooms);
        else setFailure(failureText(result.failure, "rooms"));
      })
      .catch(() => mine === asked.current && setFailure("RaccoonVTT did not answer. Try again."))
      .finally(() => mine === asked.current && setLoading(false));
  }, [up, bridge, sup.port]);

  // A quiet list in the background: the rows or the failure already shown
  // stay until it answers, and a failed one leaves them as they were.
  useEffect(() => {
    if (!up || again === 0) return;
    const mine = ++asked.current;
    bridge
      .listRooms()
      .then((result) => {
        if (mine !== asked.current || !result.ok) return;
        setRooms(result.value.rooms);
        setFailure(null);
      })
      .catch(() => undefined);
  }, [again]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!up) return;
    const ask = () => {
      if (document.visibilityState === "visible" && listed.current) setAgain((n) => n + 1);
    };
    window.addEventListener("focus", ask);
    document.addEventListener("visibilitychange", ask);
    return () => {
      window.removeEventListener("focus", ask);
      document.removeEventListener("visibilitychange", ask);
    };
  }, [up]);

  const link = useAction(async (roomId: string) => {
    const result = await bridge.newDmLink(roomId);
    if (!result.ok) return failureText(result.failure, "rooms");
    setOpened(true);
    return null;
  });

  return (
    <Card id="rooms" title={WORDS.rooms.heading}>
      {blocked ? (
        <Help>{WORDS.notDuringRestore}</Help>
      ) : !up ? (
        <Help>{WORDS.rooms.notRunning}</Help>
      ) : failure ? (
        <Help role="alert" tone="danger">{failure}</Help>
      ) : rooms === null ? (
        <Loading text={loadingWords} small />
      ) : rooms.length === 0 ? (
        <Help>{WORDS.rooms.empty}</Help>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid" }}>
          {rooms.map((room, i) => (
            <li
              key={room.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: theme.space(3),
                padding: `${theme.space(2)}px 0`,
                borderTop: i === 0 ? "none" : `${theme.line.border}px solid ${theme.color.border}`,
              }}
            >
              <div style={{ flex: "1 1 0", minWidth: 0, display: "grid", gap: 2 }}>
                <span style={{ fontSize: theme.font.input, fontWeight: theme.weight.strong, lineHeight: theme.leading.tight, overflowWrap: "anywhere" }}>{room.name}</span>
                {room.lastActiveAt ? <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>{WORDS.rooms.lastPlayed(formatRelative(room.lastActiveAt, props.now))}</span> : null}
              </div>
              <Button size="sm" aria-label={`${WORDS.rooms.newDmLink}, ${room.name}`} busy={link.busy && linking === room.id} onClick={() => (link.busy ? undefined : (setOpened(false), setAsking(room)))}>
                {WORDS.rooms.newDmLink}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {link.error ? <Help role="alert" tone="danger">{link.error}</Help> : null}
      {opened ? <Help role="status">{WORDS.rooms.opened}</Help> : null}
      {asking ? (
        <Confirm
          name={WORDS.rooms.newDmLink}
          question={WORDS.rooms.confirm(asking.name)}
          confirm={WORDS.rooms.makeLink}
          danger
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            const room = asking;
            setAsking(null);
            setLinking(room.id);
            void link.start(room.id);
          }}
        />
      ) : null}
    </Card>
  );
}

/** Not in the design's list of words: the rooms list needs a line while it loads. */
const loadingWords = "Loading rooms";
