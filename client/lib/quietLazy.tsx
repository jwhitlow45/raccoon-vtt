import { Suspense, useEffect, useId, type ComponentType } from "react";
import { LoadBoundary, type FallbackProps } from "../components/LoadBoundary.tsx";
import { reportQuietFailure } from "./quietFailures.ts";
import { retryableLazy, roleMayLoad, type Role } from "./retryableLazy.ts";

/**
 * A layer of the map's canvas that only the DM draws now and then (the
 * height marks, the explored outline), loaded after the room opens so the
 * room's own chunk stays small and Konva's core goes in a chunk of its own.
 * The roles that may use it preload it once the connection is up
 * (preloadLazies), so by the time the DM needs it the code is here: until
 * then it draws nothing.
 *
 * A load that fails draws nothing on the canvas either, since a notice
 * there would cover the map. It reports to the room's one notice for these
 * parts instead (lib/quietFailures.ts, pages/QuietLoadNotice.tsx), named by
 * `subject`, with the reload that waits for queued edits a panel has, a
 * redeploy's chunk told from a dropped request by the boundary's own check.
 * It never imports the code again by itself: Chrome keeps a module that
 * failed for the life of the page, so only the reload can bring it.
 *
 * A viewer whose role is not in `roles` (the `role` its props carry, as a
 * map layer's do) gets nothing at all: the part is not mounted, so its code
 * never loads and no failure is ever reported for it (design section 14.1:
 * a DM-only module never loads for a player).
 *
 * Parts that cards or buttons depend on (the note after a stopped move,
 * the door pill, the token bar's Light, door and ground parts) are not
 * loaded this way: they are small, and a failed load would leave a player
 * without them.
 */
export function quietLazy<P extends object>(load: () => Promise<ComponentType<P>>, roles: readonly Role[], subject: string): ComponentType<P> {
  const Lazy = retryableLazy<P>(() => load().then((component): { default: ComponentType<P> } => ({ default: component })), { roles });
  function Quiet(props: P) {
    if (!roleMayLoad(roles, (props as { role?: unknown }).role)) return null;
    return (
      <LoadBoundary fallback={(f) => <Report {...f} subject={subject} />}>
        <Suspense fallback={null}>
          <Lazy {...props} />
        </Suspense>
      </LoadBoundary>
    );
  }
  return Quiet;
}

function Report(props: FallbackProps & { subject: string }) {
  const { failure, retry, subject } = props;
  const id = useId();
  useEffect(() => {
    reportQuietFailure(id, { subject, failure, retry });
    return () => reportQuietFailure(id, null);
  }, [id, subject, failure, retry]);
  return null;
}
