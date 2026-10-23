import { useMemo, useState } from "react";
import type { Token } from "#shared/model.ts";
import { Spinner, useDelayed } from "../../components/Loading.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { useAttachViewer } from "./BarParts.tsx";
import { waitsForServer } from "./list.ts";
import { panelLinkTags, STEER_OPTIONS, steerChoice, steerOp, steerWords } from "./tags.ts";

type Steer = "controlled" | "independent";

/** The token panel's link tags (docs/design-v1-attach.md 4.5): "Riding Warhorse", "Carries Bree and Torch". */
export function usePanelLinkTags(token: Token): string[] {
  const tokens = useRoomView((s) => s.view?.tokens);
  return useMemo(() => (tokens ? panelLinkTags(tokens, token) : []), [tokens, token]);
}

/**
 * A rider's Controlled or Independent under the name block's tags (4.5),
 * the Attach list's own choice, for whoever may attach the pair: two words
 * side by side, and under them a line that says what the chosen one does
 * (docs/design-v1-look-pass-2.md 2.7). Most
 * changes show at once, as the room predicts them. One a fight makes the
 * server's to answer (a player's controlled ride, 8.4, list.ts
 * waitsForServer) shows the new choice held still while it waits, with
 * the room's spinner after 200 ms. A refusal puts the old choice back, and
 * the room's toast says why.
 */
export function SteerControl(props: { token: Token }) {
  const { token } = props;
  const viewer = useAttachViewer();
  const view = useRoomView((s) => s.view);
  const choice = useMemo(() => (view ? steerChoice(view, viewer, token) : null), [view, viewer, token]);
  const actions = useRoomActions();
  // The choice sent and not yet answered: shown meanwhile, and no second change goes until it is.
  const [asked, setAsked] = useState<Steer | null>(null);
  const waiting = asked !== null;
  const spin = useDelayed(waiting);
  if (!choice) return null;
  const value: Steer = asked ?? (choice.controlled ? "controlled" : "independent");
  return (
    <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
      <div style={{ flex: "1 1 auto", minWidth: 0 }}>
        <Segmented<Steer>
          label={`How ${choice.holderName} moves`}
          value={value}
          disabled={waiting}
          options={STEER_OPTIONS}
          onChange={(next) => {
            if (waiting || next === value || !view) return;
            const op = steerOp(token, choice.holderId, next === "controlled");
            if (!waitsForServer(viewer, view, { kind: "ride" }, next === "controlled")) {
              actions.dispatch(op);
              return;
            }
            setAsked(next);
            if (actions.dispatch(op, { onAnswer: () => setAsked(null) }) === null) setAsked(null);
          }}
          even
          description={steerWords(value === "controlled", choice.holderName, choice.riderName)}
        />
      </div>
      {spin ? <Spinner label="Saving" /> : null}
    </div>
  );
}
