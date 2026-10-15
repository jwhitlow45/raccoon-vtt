import { useState, type FormEvent } from "react";
import { Button } from "../components/Button.tsx";
import { Card, Field } from "../components/Field.tsx";
import { api, ApiError } from "../lib/api.ts";
import { parseClaimInput } from "../lib/links.ts";
import { navigate } from "../lib/navigation.ts";
import { parseRoomId, roomPath } from "../lib/roomId.ts";
import { once } from "../lib/once.ts";
import { theme } from "../lib/theme.ts";

/**
 * "Enter a DM link or invite" (design section 10.2). An iPhone Home Screen
 * app keeps its own cookies and opens tapped links in Safari, so pasting the
 * link here is how a DM signs in inside the installed app.
 *
 * A full link goes to the room page with its fragment, which claims it the
 * same way as opening the link. A bare invite token has no room in it, so it
 * is sent here first: a device already in the room is signed in at once,
 * and any other is told the room, then goes on to the claim page with the
 * invite as a link, where it picks who it is. Asking spends nothing.
 */
export function DmLinkEntry(props: { title?: string; hint?: string }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = parseClaimInput(input);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!parsed) {
      setError("That is not a DM link or invite. Paste the whole link.");
      return;
    }
    if (parsed.kind !== "bareInvite") {
      navigate(`${roomPath(parsed.roomId)}#${parsed.kind}=${parsed.secret}`);
      return;
    }
    setBusy(true);
    try {
      const res = await once(`bare:${parsed.secret}`, () => api.redeemBareInvite({ token: parsed.secret }));
      navigate(roomPath(res.roomId));
    } catch (err) {
      const named = err instanceof ApiError && err.code === "choose_member" ? err.detail.roomId : null;
      const roomId = typeof named === "string" ? parseRoomId(named) : null;
      if (roomId) {
        navigate(`${roomPath(roomId)}#invite=${parsed.secret}`);
        return;
      }
      setError(
        err instanceof ApiError && err.status !== 0 && err.status !== 429 && err.status !== 503
          ? "That invite has expired or was already used. Ask for a new one."
          : err instanceof Error
            ? err.message
            : "Something went wrong.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={props.title ?? "Enter a DM link or invite"}>
      <form onSubmit={submit} style={{ display: "grid", gap: theme.space(3) }}>
        <Field
          label="DM link or invite"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="https://…/r/K7QH-2MXA#dm=…"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          hint={props.hint ?? "Paste the DM link you saved, or an invite from another DM device."}
          error={error}
        />
        <Button type="submit" block busy={busy} disabled={!busy && input.trim() === ""}>
          {busy ? "Checking…" : "Continue"}
        </Button>
      </form>
    </Card>
  );
}
