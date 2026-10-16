import { Suspense } from "react";
import { LoadBoundary, LoadFailureNotice, type FallbackProps } from "../components/LoadBoundary.tsx";
import { Loading } from "../components/Loading.tsx";
import { PanelHeaderHost, panelById, type PanelHeader } from "../features/panels.ts";
import { rememberReopen, type Reopen } from "../lib/reopen.ts";
import { useRoomView } from "../state/view.ts";

/**
 * The body of one panel from the registry in client/features/panels.ts.
 * Each panel's code loads the first time it opens (design section 14.1).
 * A load that fails, offline or after a redeploy, shows a notice in the
 * panel and leaves the rest of the room running.
 *
 * `onHeader` hears the subpage the panel names (usePanelHeader), such as
 * Members inside Menu, so the sheet or side panel around it can title its
 * header with it and put "Back to Menu" there.
 */
export function PanelBody(props: { id: string; shown: boolean; selectedTokenId: string | null; close(): void; onHeader?(header: PanelHeader | null): void }) {
  const def = panelById(props.id);
  if (!def) return null;
  const Component = def.Component;
  const body = (
    // Keyed by panel, so a panel that failed does not keep its notice when another one opens.
    <LoadBoundary key={props.id} fallback={(f) => <RoomLoadNotice {...f} subject="This panel" reopen={{ panel: props.id }} />}>
      <Suspense fallback={<Loading text="Loading…" />}>
        <Component selectedTokenId={props.selectedTokenId} close={props.close} shown={props.shown} />
      </Suspense>
    </LoadBoundary>
  );
  return props.onHeader ? <PanelHeaderHost onHeader={props.onHeader}>{body}</PanelHeaderHost> : body;
}

/**
 * A load failure inside the room, where a reload must first wait for the
 * queued edits, and then opens the same panel or tool again.
 */
export function RoomLoadNotice(props: FallbackProps & { subject: string; verb?: "open" | "load"; compact?: boolean; line?: boolean; reopen: Reopen }) {
  const { reopen, ...rest } = props;
  const roomId = useRoomView((s) => s.roomId);
  const pending = useRoomView((s) => s.pending.length);
  const connection = useRoomView((s) => s.connection);
  return <LoadFailureNotice {...rest} pending={pending} connection={connection} beforeReload={() => rememberReopen(roomId, reopen)} />;
}
