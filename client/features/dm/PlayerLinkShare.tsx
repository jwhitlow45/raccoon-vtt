import { useState } from "react";
import { playerLink } from "#shared/playerLink.ts";
import { Icon } from "../../components/Icon.tsx";
import { QrCode } from "../../components/QrCode.tsx";
import { formatRoomId } from "../../lib/roomId.ts";
import { theme } from "../../lib/theme.ts";
import { SecretLink } from "./controls.tsx";
import { absoluteLink } from "./invite.ts";

/**
 * The player link for the DM to hand out (design section 10.2), with copy,
 * share and a QR code for a table of phones. The link carries the password,
 * so there is no separate password to send. It stays one tap away for
 * someone who would rather type it. `size` is the buttons' size: `sm` in a
 * panel, `md` on a page.
 */
export function PlayerLinkShare(props: { roomId: string; password: string; size?: "md" | "sm" }) {
  const url = absoluteLink(playerLink(props.roomId, props.password), location.origin);
  return (
    <div style={{ display: "grid", gap: theme.space(3) }}>
      <SecretLink value={url} label="Player link" size={props.size} />
      <div style={{ display: "grid", justifyItems: "center", gap: theme.space(2) }}>
        <QrCode value={url} label="QR code of the player link" />
        <span style={{ fontSize: theme.font.small, color: theme.color.textMuted, textAlign: "center" }}>Players scan this with their phone camera to join.</span>
      </div>
      <ShowPassword roomId={props.roomId} password={props.password} />
    </div>
  );
}

/**
 * The room ID and password in plain text, folded until asked for. A
 * disclosure is not a link, so it takes the text color, not the accent
 * (docs/design-v1-visual.md F24), as the DM link page's own disclosure
 * does (pages/Home.tsx). A flex summary draws no marker of its own, and
 * the chevron turns down while it is open.
 */
function ShowPassword(props: { roomId: string; password: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary
        style={{
          display: "flex",
          alignItems: "center",
          gap: theme.space(2),
          minHeight: theme.touch,
          listStyle: "none",
          cursor: "pointer",
          color: theme.color.text,
          fontSize: theme.font.body14,
          fontWeight: theme.weight.strong,
        }}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size="sm" />
        Show password
      </summary>
      <p style={{ margin: 0, fontSize: theme.font.body14, lineHeight: theme.leading.body }}>
        Room ID <strong style={{ fontFamily: theme.font.mono }}>{formatRoomId(props.roomId)}</strong>, password{" "}
        <strong style={{ fontFamily: theme.font.mono, overflowWrap: "anywhere" }}>{props.password}</strong>
      </p>
    </details>
  );
}
