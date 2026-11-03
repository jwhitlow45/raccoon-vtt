import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../components/Button.tsx";
import { Help } from "../../../components/Panel.tsx";
import { Loading } from "../../../components/Loading.tsx";
import { api, type RoomStorage } from "../../../lib/api.ts";
import { theme } from "../../../lib/theme.ts";
import { storageLine, STORAGE_CHECKING, STORAGE_FAILED } from "./words.ts";

type Read = { kind: "loading" } | { kind: "ok"; storage: RoomStorage } | { kind: "failed" };

/**
 * The storage line (docs/design/design-v1-music.md 4.1 item 6, from
 * `GET /api/rooms/:id/storage`): what sounds use of the room's quota,
 * which images share. It asks when it mounts and
 * again whenever `version` changes, after an upload settles or a sound is
 * deleted. A check in flight that a newer one replaces is dropped.
 */
export function StorageLine(props: { roomId: string; version: string }) {
  const [read, setRead] = useState<Read>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const last = useRef<RoomStorage | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    // A recheck keeps the last line while it runs, so it never flickers to "Checking storage…".
    if (last.current === null) setRead({ kind: "loading" });
    api.roomStorage(props.roomId).then(
      (storage) => {
        last.current = storage;
        setRead({ kind: "ok", storage });
      },
      () => {
        if (!abort.signal.aborted) setRead({ kind: "failed" });
      },
    );
    return () => abort.abort();
  }, [props.roomId, props.version, attempt]);
  const retry = useCallback(() => {
    last.current = null;
    setAttempt((n) => n + 1);
  }, []);
  return (
    <div data-sound-storage="" style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
      {read.kind === "loading" ? <Loading text={STORAGE_CHECKING} small /> : null}
      {read.kind === "ok" ? <Help>{storageLine(read.storage)}</Help> : null}
      {read.kind === "failed" ? (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
          <Help>{STORAGE_FAILED}</Help>
          <Button size="sm" icon="retry" onClick={retry}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
