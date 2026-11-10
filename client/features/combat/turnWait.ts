import { useDelayed } from "../../components/Loading.tsx";
import { turnPending } from "../../state/store.ts";
import { useRoomView } from "../../state/view.ts";

/**
 * A turn change that waits for its answer (state/store.ts turnPending):
 * `waits` from the moment it is sent, for `aria-busy` and to send nothing,
 * and `shown` once it has lasted the shared delay, for the spinner, since
 * the answer usually lands well before anyone would see one.
 */
export function useTurnWait(): { waits: boolean; shown: boolean } {
  const waits = useRoomView(turnPending);
  return { waits, shown: useDelayed(waits) };
}
