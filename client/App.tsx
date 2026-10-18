import { Suspense, useState, useSyncExternalStore } from "react";
import { Button } from "./components/Button.tsx";
import { Card, Page } from "./components/Field.tsx";
import { LoadBoundary, LoadFailureNotice } from "./components/LoadBoundary.tsx";
import { Loading } from "./components/Loading.tsx";
import { parseFragment, type FragmentSecret } from "./lib/links.ts";
import { navigate, useLocation } from "./lib/navigation.ts";
import { linkState, subscribeLinkState } from "./lib/playerLink.ts";
import { retryableLazy } from "./lib/retryableLazy.ts";
import { roomPath } from "./lib/roomId.ts";
import { parseRoute } from "./lib/router.ts";
import { Claim } from "./pages/Claim.tsx";
import { Home, HomeHeader } from "./pages/Home.tsx";
import { RoomRoute } from "./pages/RoomRoute.tsx";

// Development only. In a production build import.meta.env.DEV is the
// constant false, so this branch and the fixture behind it are dropped.
const DevRoom = import.meta.env.DEV ? retryableLazy(() => import("./dev/DevRoom.tsx")) : null;
const Kit = import.meta.env.DEV ? retryableLazy(() => import("./dev/Kit.tsx")) : null;
// A table display's pages load only on the device that opens them (features/display).
const DisplayPages = retryableLazy(() => import("./features/display/DisplayPages.tsx"));
// A chunk of its own, which no room ever loads (docs/design-v1-dm-tools.md 3.18).
const Admin = retryableLazy(() => import("./pages/Admin.tsx"));
// The guide and its screenshots load only for a reader who opens it.
const DmGuide = retryableLazy(() => import("./pages/DmGuide.tsx"));

type ClaimTarget = { roomId: string; fragment: FragmentSecret };

/**
 * The router (design section 14.1): `/` is Home, `/r/:roomId` is the join
 * page or the room. A `#dm=` or `#invite=` fragment on a room path is a
 * claim. The claim is kept in state rather than read from the URL on every
 * render, because the claim removes the secret from the URL while its page
 * is still showing.
 *
 * A player link's `#pw=` is gone from the URL before this renders
 * (main.tsx), and waits in lib/playerLink.ts for the room's page. Each new
 * link starts that page over, so a link opened into a join page that is
 * already showing is used too.
 */
export function App() {
  const { pathname, hash } = useLocation();
  const link = useSyncExternalStore(subscribeLinkState, linkState);
  const route = parseRoute(pathname, { dev: import.meta.env.DEV });
  const fragment = route.name === "room" && route.roomId ? parseFragment(hash) : null;
  const [claim, setClaim] = useState<ClaimTarget | null>(null);
  if (fragment && route.name === "room" && route.roomId && claim?.fragment.secret !== fragment.secret) {
    setClaim({ roomId: route.roomId, fragment });
  }

  switch (route.name) {
    case "home":
      return <Home />;
    case "room":
      if (!route.roomId) return <NotFound message="That room ID does not look right. Room IDs look like K7QH-2MXA." />;
      if (claim && claim.roomId === route.roomId) {
        return (
          <Claim key={claim.fragment.secret} roomId={claim.roomId} fragment={claim.fragment} onDone={() => setClaim(null)} />
        );
      }
      if (/(^#|&)(dm|invite)=/.test(hash)) return <CutOffLink roomId={route.roomId} />;
      return (
        <RoomRoute
          key={`${route.roomId}:${link.opened}`}
          roomId={route.roomId}
          link={link.pending?.roomId === route.roomId ? link.pending : null}
        />
      );
    case "devRoom":
      return DevRoom ? (
        <LoadBoundary fallback={(f) => <LoadFailureNotice {...f} subject="The fixture room" />}>
          <Suspense fallback={null}>
            <DevRoom />
          </Suspense>
        </LoadBoundary>
      ) : (
        <NotFound />
      );
    case "devKit":
      return Kit ? (
        <LoadBoundary fallback={(f) => <LoadFailureNotice {...f} subject="The kit page" verb="load" />}>
          <Suspense fallback={null}>
            <Kit />
          </Suspense>
        </LoadBoundary>
      ) : (
        <NotFound />
      );
    case "display":
      return (
        <LoadBoundary fallback={(f) => <LoadFailureNotice {...f} subject="The table display" />}>
          <Suspense fallback={null}>
            <DisplayPages roomId={route.roomId} badId={route.badId === true} hash={hash} />
          </Suspense>
        </LoadBoundary>
      );
    case "admin":
      return (
        <LoadBoundary fallback={(f) => <LoadFailureNotice {...f} subject="The admin page" verb="load" />}>
          <Suspense fallback={null}>
            <Admin />
          </Suspense>
        </LoadBoundary>
      );
    case "guide":
      return (
        <LoadBoundary fallback={(f) => <LoadFailureNotice {...f} subject="The DM guide" verb="load" />}>
          <Suspense fallback={<Loading text="Loading the DM guide…" />}>
            <DmGuide />
          </Suspense>
        </LoadBoundary>
      );
    case "notFound":
      return <NotFound />;
  }
}

function NotFound(props: { message?: string }) {
  return (
    <Page>
      <HomeHeader />
      <Card title="Page not found">
        <p style={{ margin: 0 }}>{props.message ?? "There is nothing here."}</p>
        <Button variant="primary" block onClick={() => navigate("/")}>
          Home
        </Button>
      </Card>
    </Page>
  );
}

/** A DM link whose secret was cut short in copying. It cannot work, and leaving goes through replaceState. */
function CutOffLink(props: { roomId: string }) {
  return (
    <Page>
      <HomeHeader />
      <Card title="This link looks cut off">
        <p style={{ margin: 0 }}>Copy the whole DM link or invite and open it again.</p>
        <Button variant="primary" block onClick={() => navigate(roomPath(props.roomId), { replace: true })}>
          Go to the room
        </Button>
      </Card>
    </Page>
  );
}
