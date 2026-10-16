import { ReloadButton } from "../../components/LoadBoundary.tsx";
import { Notice } from "../../components/Notice.tsx";
import { rememberReopen, type Reopen } from "../../lib/reopen.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";

/**
 * What a part says when the SRD's monsters did not load (shared/srd/monsters.ts):
 * "The monster list did not load. Reload to try again." and the reload,
 * which waits for the queued edits and the connection first
 * (components/LoadBoundary.tsx ReloadButton), and opens `reopen` again on
 * the other side. Never a Retry: the list is a module, and Chrome keeps a
 * module that failed to load for the life of the page and never fetches it
 * again. `inline` sits in a line of the token bar or a section, a notice
 * elsewhere.
 */
export function SrdLoadFailed(props: { what: string; reopen?: Reopen; inline?: boolean }) {
  const roomId = useRoomView((s) => s.roomId);
  const pending = useRoomView((s) => s.pending.length);
  const connection = useRoomView((s) => s.connection);
  const text = `${props.what} did not load. Reload to try again.`;
  const reload = <ReloadButton pending={pending} connection={connection} beforeReload={props.reopen ? () => rememberReopen(roomId, props.reopen!) : undefined} />;
  if (props.inline) {
    return (
      <div role="alert" style={{ display: "grid", gap: theme.space(1), fontSize: theme.font.body14 }}>
        <p style={{ margin: 0, color: theme.color.dangerText }}>{text}</p>
        {reload}
      </div>
    );
  }
  return (
    <Notice tone="danger" role="alert" action={reload}>
      {text}
    </Notice>
  );
}
