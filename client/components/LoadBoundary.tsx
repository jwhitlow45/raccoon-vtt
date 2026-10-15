import { Component, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { classifyLoadFailure, isChunkLoadError, reloadGate, type LoadFailure, type LoadProbe } from "../lib/chunkLoad.ts";
import type { ConnectionState } from "../lib/connection.ts";
import { retryFailedLoads } from "../lib/retryableLazy.ts";
import { theme } from "../lib/theme.ts";
import { Button } from "./Button.tsx";

/** `checking` while the page asks the server why a load failed, `error` for anything that is not a load. */
export type Failure = LoadFailure | "checking" | "error";

export type FallbackProps = { failure: Failure; retry(): void };

type State = { error: unknown; failure: Failure | null };

function browserProbe(): LoadProbe {
  return {
    online: () => navigator.onLine !== false,
    origin: location.origin,
    scripts: () =>
      Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'), (s) => new URL(s.src, location.href).pathname),
    async fetch(url) {
      // The page itself is read. A chunk only needs its status and type.
      const page = url.endsWith("/");
      const res = await fetch(url, { method: page ? "GET" : "HEAD", cache: "no-store", credentials: "same-origin" });
      const contentType = res.headers.get("content-type") ?? "";
      return { status: res.status, contentType, text: page && res.ok ? await res.text() : "" };
    },
  };
}

/**
 * Catches a lazy panel, tool option bar or page whose code failed to load,
 * or that threw while rendering, so only that part shows a notice and the
 * rest of the room keeps running: the socket, the queue of offline edits
 * and the map (client/lib/chunkLoad.ts says why this matters). Every
 * React.lazy in the client sits inside one of these.
 *
 * Retry lets every failed lazy load try again (client/lib/retryableLazy.ts)
 * and renders the children afresh.
 */
export class LoadBoundary extends Component<{ children: ReactNode; fallback(props: FallbackProps): ReactNode }, State> {
  override state: State = { error: null, failure: null };
  /** Ignores a classification that finishes after a retry. */
  #attempt = 0;

  static getDerivedStateFromError(error: unknown): State {
    return { error, failure: isChunkLoadError(error) ? "checking" : "error" };
  }

  override componentDidCatch(error: unknown): void {
    if (!isChunkLoadError(error)) {
      console.error("raccoon: part of the room failed to render", error);
      return;
    }
    const attempt = ++this.#attempt;
    classifyLoadFailure(error, browserProbe()).then(
      (failure) => {
        if (attempt === this.#attempt && this.state.error === error) this.setState({ failure });
      },
      () => {
        if (attempt === this.#attempt && this.state.error === error) this.setState({ failure: "failed" });
      },
    );
  }

  readonly retry = (): void => {
    this.#attempt += 1;
    retryFailedLoads();
    this.setState({ error: null, failure: null });
  };

  override render(): ReactNode {
    if (this.state.failure) return this.props.fallback({ failure: this.state.failure, retry: this.retry });
    return this.props.children;
  }
}

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** The browser's online flag, for a notice outside a room, which has no connection state of its own. */
function useBrowserConnection(): ConnectionState {
  return useSyncExternalStore(subscribeOnline, () => (navigator.onLine === false ? "offline" : "open"));
}

/** Tries again by itself when the browser says the network is back. */
function useRetryWhenOnline(failure: Failure, retry: () => void): void {
  useEffect(() => {
    if (failure !== "offline") return;
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [failure, retry]);
}

/**
 * A reload that never drops queued edits: once asked for, it waits until
 * the queue is empty and the connection is up (client/lib/chunkLoad.ts
 * reloadGate), then reloads. Outside a room there is no queue or room
 * connection, and the browser's online flag stands in for the connection.
 * `beforeReload` notes what to open again on the other side.
 */
function ReloadButton(props: { pending: number; connection: ConnectionState; beforeReload?(): void }) {
  const [asked, setAsked] = useState(false);
  const gate = reloadGate(props);
  const reload = () => {
    props.beforeReload?.();
    location.reload();
  };
  useEffect(() => {
    if (asked && gate.ready) reload();
  });
  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
        <Button variant="primary" disabled={asked} onClick={() => setAsked(true)}>
          {asked ? "Reloading…" : "Reload"}
        </Button>
        {asked && !gate.ready ? <Button onClick={reload}>Reload now and lose them</Button> : null}
      </div>
      {asked && gate.status ? <p style={{ margin: 0, color: theme.color.textMuted, fontSize: theme.font.body14 }}>{gate.status}</p> : null}
    </>
  );
}

/**
 * The notice a failed part shows in its place. `subject` names it in the
 * sentence: "This panel", "These options", "The room".
 *
 * Offline it offers Retry, and retries by itself when the network comes
 * back. Chrome remembers a module that failed to load for the life of the
 * page and never fetches it again, so when a retry fails online the answer
 * is a reload, which waits for the queued edits like the update's does.
 */
export function LoadFailureNotice(
  props: FallbackProps & {
    subject: string;
    verb?: "open" | "load";
    pending?: number;
    connection?: ConnectionState;
    compact?: boolean;
    beforeReload?(): void;
  },
) {
  const { failure, retry, subject } = props;
  useRetryWhenOnline(failure, retry);
  const browserConnection = useBrowserConnection();
  const verb = props.verb ?? "open";
  const text =
    failure === "checking"
      ? "Loading…"
      : failure === "offline"
        ? `${subject} can't ${verb} while offline.`
        : failure === "updated"
          ? "RaccoonVTT was updated. Reload to continue."
          : failure === "failed"
            ? `${subject} didn't ${verb}. Reload to try again.`
            : `Something went wrong in ${subject[0]!.toLowerCase()}${subject.slice(1)}.`;
  return (
    <div
      role={failure === "checking" ? undefined : "alert"}
      style={{
        display: "flex",
        flexDirection: props.compact ? "row" : "column",
        flexWrap: "wrap",
        alignItems: props.compact ? "center" : "flex-start",
        gap: theme.space(props.compact ? 2 : 3),
        padding: props.compact ? 0 : `${theme.space(2)}px 0`,
        fontSize: theme.font.body14,
      }}
    >
      <p style={{ margin: 0, color: failure === "checking" ? theme.color.textMuted : theme.color.text, flex: props.compact ? "1 1 180px" : undefined }}>
        {text}
      </p>
      {failure === "updated" || failure === "failed" ? (
        <ReloadButton pending={props.pending ?? 0} connection={props.connection ?? browserConnection} beforeReload={props.beforeReload} />
      ) : failure !== "checking" ? (
        <Button onClick={retry}>Retry</Button>
      ) : null}
    </div>
  );
}
