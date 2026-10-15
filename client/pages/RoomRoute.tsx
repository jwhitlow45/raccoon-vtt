import { Suspense, useEffect, useState } from "react";
import { Button } from "../components/Button.tsx";
import { Card, ErrorText, Page } from "../components/Field.tsx";
import { LoadBoundary, LoadFailureNotice } from "../components/LoadBoundary.tsx";
import { Loading } from "../components/Loading.tsx";
import { api, ApiError, type Me } from "../lib/api.ts";
import { rememberRoom } from "../lib/knownRooms.ts";
import { navigate, replaceUrl } from "../lib/navigation.ts";
import { dropLinkPassword, type LinkPassword } from "../lib/playerLink.ts";
import { retryableLazy } from "../lib/retryableLazy.ts";
import { formatRoomId, roomPath } from "../lib/roomId.ts";
import { theme } from "../lib/theme.ts";
import { HomeHeader } from "./Home.tsx";
import { Join } from "./Join.tsx";

// The room pulls in Konva, so it loads only when someone enters a room, and
// the Home and Join pages stay small (design section 14.1). Its load can
// fail offline or after a redeploy, and then says so instead of a blank page.
const LiveRoom = retryableLazy(() => import("./LiveRoom.tsx"));

type State =
  | { kind: "checking" }
  | { kind: "join"; roomName: string }
  /** `roomName` is known from GET /me, or from the join page that came before. */
  | { kind: "room"; me: Me; roomName: string }
  | { kind: "missing" }
  | { kind: "error"; message: string };

/**
 * `/r/:roomId`. A device that already holds a grant goes straight in, since
 * rejoining never asks for the password again (features section 1). Any
 * other device gets the join page.
 *
 * A player link's password is taken from the store once, when this page
 * opens, and kept here for the join page. A device that goes straight in
 * never uses it. Either way it is not offered again, so coming back to the
 * room later never sends an old link's password on its own.
 */
export function RoomRoute(props: { roomId: string; link: LinkPassword | null }) {
  const { roomId } = props;
  const [state, setState] = useState<State>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);
  const [link] = useState(props.link);

  useEffect(() => {
    if (link) dropLinkPassword(link.seq);
  }, [link]);

  // Shared links may spell the ID loosely (lowercase, no hyphen). Show the
  // canonical form, which is also what people read out.
  useEffect(() => {
    if (location.pathname !== roomPath(roomId)) replaceUrl(roomPath(roomId) + location.search);
  }, [roomId]);

  useEffect(() => {
    let cancelled = false;
    const settle = (next: State) => {
      if (!cancelled) setState(next);
    };
    (async () => {
      try {
        const me = await api.getMe(roomId);
        settle({ kind: "room", me, roomName: me.roomName ?? "" });
      } catch (err) {
        if (!(err instanceof ApiError) || ![401, 403, 404].includes(err.status)) throw err;
        try {
          settle({ kind: "join", roomName: (await api.getRoom(roomId)).name });
        } catch (inner) {
          if (inner instanceof ApiError && inner.status === 404) settle({ kind: "missing" });
          else throw inner;
        }
      }
    })().catch((err: unknown) => settle({ kind: "error", message: err instanceof Error ? err.message : "Something went wrong." }));
    return () => {
      cancelled = true;
    };
  }, [roomId, attempt]);

  // The Home page lists the rooms this device has been in (UP-7).
  const entered = state.kind === "room" ? state : null;
  useEffect(() => {
    if (entered) rememberRoom({ roomId, name: entered.roomName, me: entered.me });
  }, [entered, roomId]);

  switch (state.kind) {
    case "checking":
      return <Page><p style={{ color: theme.color.textMuted }}>Opening room {formatRoomId(roomId)}…</p></Page>;
    case "join":
      return (
        <Join roomId={roomId} roomName={state.roomName} link={link} onJoined={(me) => setState({ kind: "room", me, roomName: state.roomName })} />
      );
    case "room":
      return (
        <LoadBoundary
          fallback={(f) => (
            <Page>
              <Card>
                <LoadFailureNotice {...f} subject="The room" />
              </Card>
            </Page>
          )}
        >
          {/*
           * The room's code is the largest download (Konva and the map),
           * seconds on a slow phone. Its wait sits on the page color, as the
           * boot text before it and the room after it do, so opening a room
           * does not flash black between them.
           */}
          <Suspense
            fallback={
              <div style={{ position: "fixed", inset: 0, background: theme.color.bg, display: "grid", placeItems: "center" }}>
                <Loading text="Opening the room…" />
              </div>
            }
          >
            <LiveRoom roomId={roomId} me={state.me} />
          </Suspense>
        </LoadBoundary>
      );
    case "missing":
      return (
        <Page>
          <HomeHeader />
          <Card title="No such room">
            <p style={{ margin: 0 }}>
              There is no room {formatRoomId(roomId)}. Check the ID with your DM.
            </p>
            <Button variant="primary" block onClick={() => navigate("/")}>
              Home
            </Button>
          </Card>
        </Page>
      );
    case "error":
      return (
        <Page>
          <HomeHeader />
          <Card>
            <ErrorText>{state.message}</ErrorText>
            <Button
              variant="primary"
              block
              onClick={() => {
                setState({ kind: "checking" });
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </Card>
        </Page>
      );
  }
}
