import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { FoundWork, StarterKind, StarterUse } from "#shared/starter.ts";
import { Button } from "../../components/Button.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { ErrorText } from "../../components/Field.tsx";
import { api, type AssetRow } from "../../lib/api.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { imageErrorMessage } from "../images/errors.ts";
import { CopyRun, IDLE, type CopyState } from "./copy.ts";
import { StarterBrowser } from "./StarterBrowser.tsx";

/**
 * The Starter source where a place has no picker of its own to hold it
 * (New scene's map image, Handouts): the browser in the one Dialog shell,
 * as the image picker is, whose Use copies the work into the room as an
 * image of `kind` and hands the new row to the place. While it copies, the
 * header says so, waits out a busy server ("Waiting for the server…") and
 * offers Cancel, and a refusal stays in plain words above the packs.
 */
export function StarterDialog(props: {
  title: string;
  uses: readonly StarterUse[];
  kind: StarterKind;
  hint?: ReactNode;
  note?(found: FoundWork): ReactNode;
  onPicked(row: AssetRow, found: FoundWork): void;
  onClose(): void;
  opener?: RefObject<HTMLElement | null>;
}) {
  const roomId = useRoomView((s) => s.roomId);
  const [state, setState] = useState<CopyState>(IDLE);
  const run = useRef<CopyRun | null>(null);
  // Made in the effect, so a remount (React's strict mode makes one) starts a run of its own after the old one closed.
  useEffect(() => {
    const mine = new CopyRun(setState, imageErrorMessage);
    run.current = mine;
    return () => {
      mine.close();
      if (run.current === mine) run.current = null;
    };
  }, []);
  const { onPicked, kind } = props;
  const use = (found: FoundWork) =>
    run.current?.start(
      (signal, onWaiting) => api.pickStarter(roomId, { work: found.work.key, kind }, { signal, onWaiting }),
      (row) => onPicked(row, found),
    );

  return (
    <Dialog
      title={props.title}
      onClose={props.onClose}
      width="lg"
      phone="fill"
      opener={props.opener}
      status={state.busy ? <span role="status">{state.waiting ? "Waiting for the server…" : "Adding to the room…"}</span> : undefined}
      footer={state.busy ? <Button onClick={() => run.current?.cancel()}>Cancel</Button> : undefined}
    >
      {state.error ? (
        <div style={{ marginBottom: theme.space(3) }}>
          <ErrorText>{state.error}</ErrorText>
        </div>
      ) : null}
      <StarterBrowser uses={props.uses} hint={props.hint} note={props.note} busy={state.busy} disabled={state.busy} onUse={use} />
    </Dialog>
  );
}
