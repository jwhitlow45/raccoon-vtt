import { FORGET_ASK } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Help } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomUi, useRoomView } from "../../state/view.ts";

/** The forget question's title, and what it says the yes does. */
export const FORGET_TITLE = "Remembered map";
export const FORGET_HELP = "Their map can keep only so much that changed out of their sight. The ground this change runs past that goes back under the fog for them, as if never seen, and Undo does not bring it back.";
export const FORGET_YES = "Go ahead";
export const FORGET_BUSY = "Saving…";

/**
 * The builder's forget question (docs/design-v1-map-discovery.md 5.3): a
 * DM's builder op, a paste or a Clear the build that would push players'
 * remembered map past its cap is refused with FORGET_ASK, and this asks
 * once per gesture before it is sent again with `forget`
 * (RoomView.forgetAsk). Escape, Cancel or the close button answer no, and
 * the change stays unmade. Go ahead is busy until the server answers, and
 * takes no second tap. The dialog traps focus and gives it back to what
 * had it. Undo and Redo ask in their own toast instead (state/store.ts).
 */
export function ForgetQuestion() {
  const ask = useRoomView((s) => (s.you?.role === "dm" ? (s.forgetAsk ?? null) : null));
  const ui = useRoomUi();
  if (!ask || ask.asks.length === 0) return null;
  const sending = ask.sending !== undefined;
  return (
    <Dialog
      title={FORGET_TITLE}
      width="sm"
      phone="sheet"
      onClose={() => ui.answerForget(false)}
      dismissOnBackdrop={!sending}
      footer={
        <>
          <Button disabled={sending} onClick={() => ui.answerForget(false)}>
            Cancel
          </Button>
          <Button variant="primary" busy={sending} onClick={() => ui.answerForget(true)}>
            {sending ? FORGET_BUSY : FORGET_YES}
          </Button>
        </>
      }
    >
      <div data-forget-question="" style={{ display: "grid", gap: theme.space(2) }}>
        <p role="status" style={{ margin: 0, fontSize: theme.font.input, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight }}>
          {FORGET_ASK}
        </p>
        <Help>{FORGET_HELP}</Help>
      </div>
    </Dialog>
  );
}
