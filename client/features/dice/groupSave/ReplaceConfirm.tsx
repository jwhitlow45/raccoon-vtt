import { Button } from "../../../components/Button.tsx";
import { theme } from "../../../lib/theme.ts";
import { APPLYING } from "./chain.ts";
import { pageTitle } from "./GroupSave.tsx";
import { useGroupSave } from "./store.ts";

/**
 * What a start says when a group save is already open (5.1), the same for
 * every start: "Discard the Dexterity save for 6?" with Discard, which
 * closes its requests (start.ts), and Keep it. While the open one is
 * applying it cannot go, so only Keep it is offered.
 */
export function ReplaceConfirm(props: { onDiscard(): void; onKeep(): void }) {
  const open = useGroupSave((s) => s.page);
  const applying = open?.phase === "applying";
  return (
    <div role="alert" style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap", alignItems: "center" }}>
      <span>{applying ? APPLYING : `Discard the ${open ? pageTitle(open) : "group save"}?`}</span>
      {applying ? null : (
        <Button variant="danger" onClick={props.onDiscard}>
          Discard
        </Button>
      )}
      <Button onClick={props.onKeep}>{applying ? "OK" : "Keep it"}</Button>
    </div>
  );
}
