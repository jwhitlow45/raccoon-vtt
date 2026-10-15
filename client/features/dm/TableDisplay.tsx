import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { ErrorText } from "../../components/Field.tsx";
import { Notice } from "../../components/Notice.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { QrCode } from "../../components/QrCode.tsx";
import { Switch } from "../../components/Switch.tsx";
import { api, ApiError, type DisplayCode } from "../../lib/api.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { formatDisplayCode } from "../display/logic.ts";
import { SecretLink } from "./controls.tsx";
import { absoluteLink, inviteCountdown } from "./invite.ts";
import { usePreview } from "./previewContext.ts";
import { displaysText, setShowView, useShowView } from "./tableDisplay.ts";

/**
 * The DM panel's Table display section (docs/design-v1-dm-tools.md 3.1).
 *
 * - "Open on this device" is for a laptop wired to the TV: a new window
 *   redeems a fresh code and draws only from the display's own session, so
 *   a hidden monster dragged here never shows there. It is still this
 *   browser, which holds the DM's sign-in too.
 * - "Add a TV" is for a TV's own browser or a spare device, which then
 *   holds nothing of the DM's: the code large, grouped for a remote, its
 *   link and the link's QR code, good once within 10 minutes.
 *
 * Displays also show in Members, DM devices, where each can be signed out.
 */
export function TableDisplaySection() {
  const roomId = useRoomView((s) => s.roomId);
  const displays = useRoomView((s) => s.displays ?? 0);
  const showView = useShowView(roomId);
  const preview = usePreview() !== null;
  const [code, setCode] = useState<DisplayCode | null>(null);
  const [busy, setBusy] = useState<"open" | "add" | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<DisplayCode | null>(null);

  const mint = async (what: "open" | "add", then: (c: DisplayCode) => void, onFail?: () => void) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(what);
    setError(null);
    try {
      then(await api.mintDisplayCode(roomId));
    } catch (err) {
      onFail?.();
      setError(mintErrorText(err));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const openHere = () => {
    // Opened by the tap itself, before the code arrives, or a browser's popup blocker refuses it.
    const win = window.open("about:blank", "_blank");
    void mint(
      "open",
      (c) => {
        if (!win || win.closed) {
          setBlocked(c);
          return;
        }
        win.opener = null;
        win.location.href = c.link;
      },
      () => win?.close(),
    );
  };

  return (
    <Section label="Table display">
      <Help>
        Show the map on a TV for the table, as the players see it, with nothing else on it. On the TV, open RaccoonVTT
        and choose Set up a table display.
      </Help>
      <p role="status" style={{ margin: 0, fontSize: theme.font.body14 }}>
        {displaysText(displays)}
      </p>
      <Switch
        label="Show my view on the table display"
        help="A display following the DM shows the part of the map this device shows, as you pan and zoom. Only while you view the players' scene."
        checked={showView}
        disabled={preview}
        onChange={(on) => setShowView(roomId, on)}
      />
      {code ? (
        <CodeCard code={code} minting={busy === "add"} onAnother={() => void mint("add", setCode)} onDone={() => setCode(null)} />
      ) : (
        <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
          <Button size="sm" busy={busy === "add"} disabled={(busy !== null && busy !== "add") || preview} onClick={() => void mint("add", setCode)}>
            {busy === "add" ? "Making a code…" : "Add a TV"}
          </Button>
          <Button size="sm" busy={busy === "open"} disabled={(busy !== null && busy !== "open") || preview} onClick={openHere}>
            {busy === "open" ? "Opening…" : "Open on this device"}
          </Button>
        </div>
      )}
      {blocked ? (
        <Notice role="status">
          The browser kept the new window from opening.{" "}
          <a href={blocked.link} target="_blank" rel="noopener noreferrer" onClick={() => setBlocked(null)} style={{ color: theme.color.accent, fontWeight: theme.weight.bold }}>
            Open the table display
          </a>
          , good for 10 minutes.
        </Notice>
      ) : null}
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}

export function mintErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "too_many_codes") return "There are already 3 unused display codes. Use one, or wait up to 10 minutes for them to expire.";
    if (err.code === "dm_only" || err.code === "no_access") return "Only a DM device can do that. This device may have been signed out.";
    return err.message;
  }
  return "Something went wrong. Try again.";
}

/** Ticks once a second while the code is on screen and still good, then stops. */
function useCountdown(expiresAt: string) {
  const [now, setNow] = useState(() => Date.now());
  const countdown = inviteCountdown(expiresAt, now);
  useEffect(() => {
    if (countdown.expired) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(1000, countdown.msLeft));
    return () => clearTimeout(timer);
  }, [countdown.expired, countdown.msLeft]);
  return countdown;
}

/**
 * The code at the size the TV's own code page shows it (features/display),
 * so the DM can read it out across the table while someone types it with
 * the TV's remote. A table display size, outside the interface's scale.
 */
const CODE_PX = 36;

/** The code large enough to read across a room and type with a remote, with its link and QR code. */
function CodeCard(props: { code: DisplayCode; minting: boolean; onAnother(): void; onDone(): void }) {
  const countdown = useCountdown(props.code.expiresAt);
  const url = absoluteLink(props.code.link, location.origin);
  return (
    <div style={{ display: "grid", gap: theme.space(3), padding: theme.space(3), borderRadius: theme.radius.md, border: `${theme.line.border}px solid ${theme.color.border}`, background: theme.color.bg }}>
      {countdown.expired ? (
        <>
          <Notice role="status">This code expired. Make a new one.</Notice>
          <div style={{ display: "flex", gap: theme.space(2) }}>
            <Button variant="primary" size="sm" busy={props.minting} onClick={props.onAnother}>
              {props.minting ? "Making a code…" : "New code"}
            </Button>
            <Button size="sm" onClick={props.onDone}>
              Done
            </Button>
          </div>
        </>
      ) : (
        <>
          <div style={{ display: "grid", justifyItems: "center", gap: theme.space(2) }}>
            <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>Type this on the TV</span>
            <strong
              aria-label={`Display code ${props.code.code.split("").join(" ")}`}
              style={{ fontFamily: theme.font.mono, fontSize: CODE_PX, letterSpacing: "0.08em", lineHeight: theme.leading.tight, textAlign: "center", overflowWrap: "anywhere" }}
            >
              {formatDisplayCode(props.code.code)}
            </strong>
            <span aria-live="polite" style={{ fontVariantNumeric: "tabular-nums", fontSize: theme.font.body14 }}>
              Valid for 10 minutes, once. {countdown.text}.
            </span>
            <QrCode value={url} label="QR code of the table display link" />
          </div>
          <Help>Or scan the QR code with the device that will be the display, or open the link on it.</Help>
          <SecretLink value={url} label="Table display link" size="sm" />
          <Button size="sm" onClick={props.onDone} style={{ justifySelf: "start" }}>
            Done
          </Button>
        </>
      )}
    </div>
  );
}
