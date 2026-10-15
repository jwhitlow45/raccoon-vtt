import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../components/Button.tsx";
import { Card, ErrorText } from "../components/Field.tsx";
import { Loading } from "../components/Loading.tsx";
import { adminApi, type AdminRoom, type AdminStorage } from "../features/admin/api.ts";
import { LoginCard } from "../features/admin/LoginCard.tsx";
import { RoomsCard } from "../features/admin/RoomsCard.tsx";
import { StorageCard } from "../features/admin/StorageCard.tsx";
import { ApiError } from "../lib/api.ts";
import { navigate } from "../lib/navigation.ts";
import { theme } from "../lib/theme.ts";
import { APP_TITLE } from "../lib/title.ts";
import { HomeHeader } from "./Home.tsx";

type Phase =
  | { name: "checking" }
  | { name: "notFound" }
  | { name: "signedOut"; notice: string | null }
  | { name: "ready"; storage: AdminStorage; rooms: AdminRoom[]; at: number }
  | { name: "failed"; message: string };

/**
 * The admin page (docs/design-v1-dm-tools.md 3.18), a chunk of its own that
 * no room ever loads. It exists only when the server has an admin password:
 * otherwise the server answers 404 and this is the not-found page. The page
 * lists rooms and storage and can pin or delete a room. It never shows what
 * is in a room and cannot enter one.
 */
export default function Admin() {
  const [phase, setPhase] = useState<Phase>({ name: "checking" });
  const [refreshing, setRefreshing] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);

  useEffect(() => {
    document.title = `${APP_TITLE} · Admin`;
    live.current = true;
    return () => {
      live.current = false;
      document.title = APP_TITLE;
    };
  }, []);

  const load = useCallback(async (from: "first" | "refresh") => {
    if (from === "refresh") setRefreshing(true);
    setError(null);
    try {
      const [storage, rooms] = await Promise.all([adminApi.storage(), adminApi.rooms()]);
      if (live.current) setPhase({ name: "ready", storage, rooms, at: Date.now() });
    } catch (err) {
      if (!live.current) return;
      if (err instanceof ApiError && err.status === 404) setPhase({ name: "notFound" });
      else if (err instanceof ApiError && err.status === 401)
        setPhase({ name: "signedOut", notice: from === "refresh" ? "Your admin session ended. Sign in again." : null });
      else if (from === "first") setPhase({ name: "failed", message: err instanceof Error ? err.message : "Something went wrong." });
      else setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      if (live.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load("first");
  }, [load]);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await adminApi.signOut();
      setPhase({ name: "signedOut", notice: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign out.");
    } finally {
      setSigningOut(false);
    }
  }

  if (phase.name === "notFound") {
    return (
      <AdminPage>
        <HomeHeader />
        <Card title="Page not found">
          <p style={{ margin: 0 }}>There is nothing here.</p>
          <Button variant="primary" block onClick={() => navigate("/")}>
            Home
          </Button>
        </Card>
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      <HomeHeader
        title="Server admin"
        actions={
          phase.name === "ready" ? (
            <>
              <Button busy={refreshing} onClick={() => void load("refresh")}>
                {refreshing ? "Refreshing…" : "Refresh"}
              </Button>
              <Button variant="danger" busy={signingOut} onClick={() => void signOut()}>
                {signingOut ? "Signing out…" : "Sign out"}
              </Button>
            </>
          ) : null
        }
      />
      {phase.name === "checking" ? <Loading text="Loading the admin page…" /> : null}
      {phase.name === "failed" ? (
        <Card title="The admin page did not load">
          <ErrorText>{phase.message}</ErrorText>
          <Button variant="primary" block onClick={() => void load("first")}>
            Try again
          </Button>
        </Card>
      ) : null}
      {phase.name === "signedOut" ? <LoginCard notice={phase.notice} onSignedIn={() => void load("first")} /> : null}
      {phase.name === "ready" ? (
        <>
          <ErrorText>{error}</ErrorText>
          <StorageCard storage={phase.storage} />
          <RoomsCard
            rooms={phase.rooms}
            now={phase.at}
            onChanged={() => void load("refresh")}
            onSignedOut={() => setPhase({ name: "signedOut", notice: "Your admin session ended. Sign in again." })}
          />
        </>
      ) : null}
    </AdminPage>
  );
}

/** The app's page frame, wider than Home's, since a room row reads better on a laptop with room to spare. */
function AdminPage(props: { children: ReactNode }) {
  return (
    <main
      style={{
        minHeight: "100dvh",
        background: theme.color.bg,
        color: theme.color.text,
        fontFamily: theme.font.body,
        padding: `calc(${theme.safe.top} + ${theme.space(6)}px) calc(${theme.safe.right} + ${theme.space(4)}px) calc(${theme.safe.bottom} + ${theme.space(6)}px) calc(${theme.safe.left} + ${theme.space(4)}px)`,
      }}
    >
      <div style={{ maxWidth: 760, margin: "0 auto", display: "grid", gap: theme.space(4) }}>{props.children}</div>
    </main>
  );
}
