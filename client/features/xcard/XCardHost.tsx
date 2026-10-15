import { useMemo } from "react";
import { Button } from "../../components/Button.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { XMark } from "./XCardButton.tsx";

/**
 * The X-card as every device in the room shows it (docs/design-v1-dm-tools.md
 * 3.11), the sender's included, so nobody can tell from a screen who tapped
 * it. It is mounted once per room page, outside the room's own screens, so
 * it shows on a player behind a blackout too.
 *
 * It is a modal dialog, so it shows over any sheet or dialog already open
 * and everyone reads it before going on. Dismiss, Escape or a tap beside
 * it closes it. The DM's card adds "Pause the game", which turns the
 * blackout on. A table display, where a tap anywhere closes the card and
 * does nothing else (section 3.1), mounts it with `tapCloses` and passes
 * its own `card`, so its tap and key rules know while the card shows.
 */
export function XCardHost(props: { tapCloses?: boolean; card?: XCardShowing }) {
  const own = useXCard();
  const card = props.card ?? own;
  if (!card.showing) return null;
  return <XCard tapCloses={props.tapCloses === true} onDismiss={card.dismiss} />;
}

/** Whether the X-card shows on this device, and the Dismiss that hides it here. */
export type XCardShowing = { showing: boolean; dismiss(): void };

/** The dismissal is the room store's, so the handout popup, which waits while a card shows, agrees with the card. */
export function useXCard(): XCardShowing {
  const id = useRoomView((s) => s.xcard?.id ?? 0);
  const dismissed = useRoomView((s) => s.xcardDismissed ?? 0);
  const ui = useRoomUi();
  const showing = id > dismissed;
  return useMemo(() => ({ showing, dismiss: () => ui.dismissXcard(id) }), [showing, id, ui]);
}

/**
 * The card in the one dialog shell (components/Dialog.tsx), without a
 * title row: the card is its own message, and the title still names the
 * dialog. On the table display a tap anywhere closes it, on the card as
 * beside it, so that tap does nothing else.
 */
function XCard(props: { tapCloses: boolean; onDismiss(): void }) {
  const dm = useRoomView((s) => s.you?.role === "dm");
  const blackout = useRoomView((s) => s.view?.meta.view.blackout === true);
  const actions = useRoomActions();

  return (
    // The body's padding moves onto the card's content, so a tap anywhere on the card lands on it.
    <Dialog title="X-card" header={false} width="md" phone="sheet" onClose={props.onDismiss} bodyStyle={{ padding: 0 }}>
      <div
        role="alert"
        onClick={props.tapCloses ? props.onDismiss : undefined}
        style={{ display: "flex", gap: theme.space(4), alignItems: "flex-start", padding: theme.space(5) }}
      >
        <span style={{ display: "grid", placeItems: "center", flex: "none", width: 56, height: 56, borderRadius: theme.radius.md, border: `${theme.line.strong}px solid ${theme.color.text}` }}>
          <XMark size={36} />
        </span>
        <div style={{ display: "grid", gap: theme.space(3), minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: theme.font.heading, lineHeight: theme.leading.body }}>Someone tapped the X-card. Edit out what just happened, with no questions asked.</p>
          <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
            <Button variant="primary" onClick={props.onDismiss}>
              Dismiss
            </Button>
            {dm ? (
              <Button disabled={blackout} onClick={() => actions.dispatch({ t: "view.blackout", blackout: true })}>
                {blackout ? "The game is paused" : "Pause the game"}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
