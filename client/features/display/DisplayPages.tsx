import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "../../components/Button.tsx";
import { Card, ErrorText, Page } from "../../components/Field.tsx";
import { LoadBoundary, LoadFailureNotice } from "../../components/LoadBoundary.tsx";
import { Loading } from "../../components/Loading.tsx";
import { api, ApiError, type DisplayMe } from "../../lib/api.ts";
import { navigate, replaceUrl } from "../../lib/navigation.ts";
import { once } from "../../lib/once.ts";
import { retryableLazy } from "../../lib/retryableLazy.ts";
import { theme } from "../../lib/theme.ts";
import { codeFromHash, formatDisplayCode, normalizeDisplayCode } from "./logic.ts";
import { displayPath, rememberDisplayRoom } from "./remember.ts";
import { TV_BUTTON_HEIGHT, TV_CODE_FIELD_HEIGHT, TV_TEXT } from "./tvType.ts";

/*
 * The table display's pages (docs/design-v1-dm-tools.md 3.1): `/display`,
 * where a TV takes the code the DM's screen shows, and `/display/:roomId`,
 * the room drawn for the table. They load only on a device that opens
 * them. The room's canvas, the largest download, loads after the display
 * is known to be paired.
 */

const DisplayRoom = retryableLazy(() => import("./DisplayRoom.tsx"));

export default function DisplayPages(props: { roomId: string | null; badId?: boolean; hash: string }) {
  if (props.roomId) return <DisplayRoute key={props.roomId} roomId={props.roomId} />;
  return <CodePage hash={props.hash} badId={props.badId === true} />;
}

/** What a refused code says, for the people at the table. */
export function codeErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return "Something went wrong. Try again.";
  if (err.code === "displays_full") return "This room has 4 table displays. Sign one out first.";
  if (err.code === "bad_code") return "That code did not work. It may be mistyped, used already, or more than 10 minutes old. Ask the DM for a new one.";
  if (err.status === 429) return "Too many wrong codes from here. Wait a few minutes and try again.";
  return err.message;
}

/**
 * One large field for the code, typed with a TV's remote or a keyboard.
 * An "Open on this device" link brings its code in the fragment, which is
 * redeemed at once and taken out of the address bar first, so a reload
 * never tries a spent code and the code does not stay in the history.
 */
function CodePage(props: { hash: string; badId: boolean }) {
  const [fromLink] = useState(() => codeFromHash(props.hash));
  const [input, setInput] = useState(() => (fromLink ? formatDisplayCode(fromLink) : ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);

  const redeem = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      // A double tap, or React's development double mount, spends the code once.
      const { roomId } = await once(`display:${code}`, () => api.redeemDisplayCode(code));
      rememberDisplayRoom(roomId);
      navigate(displayPath(roomId), { replace: true });
    } catch (err) {
      setError(codeErrorText(err));
      setBusy(false);
      fieldRef.current?.focus();
    }
  };

  // Once, for the link this page opened with.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (/(?:^#|&)code=/.test(location.hash)) replaceUrl("/display");
    if (fromLink) void redeem(fromLink);
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const code = normalizeDisplayCode(input);
    if (!code) {
      setError("A code has 10 letters and numbers, like K7QH 2MXA 4F.");
      return;
    }
    void redeem(code);
  };

  return (
    <Page>
      <Card title="Set up a table display">
        <p style={{ margin: 0, color: theme.color.textMuted, lineHeight: theme.leading.body }}>
          This screen will show the map to the table, as the players see it, with nothing else on it. The DM gets a code
          from the DM panel, under Table display, with Add a TV.
        </p>
        {props.badId ? <ErrorText>That link does not name a room. Enter the code instead.</ErrorText> : null}
        <form onSubmit={submit} style={{ display: "grid", gap: theme.space(3) }}>
          <label htmlFor="display-code" style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong }}>
            Code from the DM's screen
          </label>
          <input
            id="display-code"
            ref={fieldRef}
            value={input}
            autoFocus
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={16}
            placeholder="K7QH 2MXA 4F"
            disabled={busy}
            onChange={(e) => {
              setInput(formatDisplayCode(e.target.value.replace(/[^0-9a-z\s-]/gi, "")));
              setError(null);
            }}
            style={{
              // Its own width would be 20 characters of 36 px type, wider than a phone, so it takes the card's.
              width: "100%",
              minWidth: 0,
              minHeight: TV_CODE_FIELD_HEIGHT,
              padding: `0 ${theme.space(4)}px`,
              borderRadius: theme.radius.md,
              // The field look (components/Field.tsx), with a line twice as strong, so its edge shows across a room.
              border: `${theme.line.strong}px solid ${error ? theme.color.danger : busy ? theme.color.border : theme.color.controlBorder}`,
              background: theme.color.bg,
              color: busy ? theme.color.textDisabled : theme.color.text,
              fontFamily: theme.font.mono,
              fontSize: TV_TEXT.code,
              letterSpacing: "0.08em",
              textAlign: "center",
            }}
          />
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={!busy && input.trim() === ""}
            style={{ minHeight: TV_BUTTON_HEIGHT, fontSize: TV_TEXT.body }}
          >
            {busy ? "Connecting this display…" : "Connect"}
          </Button>
          {busy ? <Loading text="Connecting this display to the room…" /> : null}
          <ErrorText>{error}</ErrorText>
        </form>
        <Button variant="quiet" onClick={() => navigate("/")} style={{ justifySelf: "start" }}>
          Home
        </Button>
      </Card>
    </Page>
  );
}

type RouteState = { kind: "checking" } | { kind: "ready"; me: DisplayMe } | { kind: "unpaired" } | { kind: "error"; message: string };

/** `/display/:roomId`: a device paired as this room's display goes straight in. Any other is told how to pair. */
function DisplayRoute(props: { roomId: string }) {
  const { roomId } = props;
  const [state, setState] = useState<RouteState>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    api.getDisplayMe(roomId).then(
      (me) => {
        if (!live) return;
        rememberDisplayRoom(roomId);
        setState({ kind: "ready", me });
      },
      (err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && [401, 403, 404].includes(err.status)) setState({ kind: "unpaired" });
        else setState({ kind: "error", message: err instanceof Error ? err.message : "Something went wrong." });
      },
    );
    return () => {
      live = false;
    };
  }, [roomId, attempt]);

  switch (state.kind) {
    case "checking":
      return (
        <div style={{ position: "fixed", inset: 0, background: theme.color.stage, display: "grid", placeItems: "center" }}>
          <Loading text="Opening the table display…" />
        </div>
      );
    case "unpaired":
      return (
        <Page>
          <Card title="This device is not a table display for this room">
            <p style={{ margin: 0 }}>
              It may have been signed out, or the player password changed. Enter a new code from the DM's Table display
              section.
            </p>
            <Button variant="primary" onClick={() => navigate("/display")}>
              Enter a code
            </Button>
            <Button onClick={() => navigate("/")}>Home</Button>
          </Card>
        </Page>
      );
    case "error":
      return (
        <Page>
          <Card>
            <ErrorText>{state.message}</ErrorText>
            <Button
              variant="primary"
              onClick={() => {
                setState({ kind: "checking" });
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </Card>
        </Page>
      );
    case "ready":
      return (
        <LoadBoundary
          fallback={(f) => (
            <Page>
              <Card>
                <LoadFailureNotice {...f} subject="The table display" />
              </Card>
            </Page>
          )}
        >
          <Suspense
            fallback={
              <div style={{ position: "fixed", inset: 0, background: theme.color.stage, display: "grid", placeItems: "center" }}>
                <Loading text="Opening the table display…" />
              </div>
            }
          >
            <DisplayRoom roomId={roomId} memberId={state.me.memberId} />
          </Suspense>
        </LoadBoundary>
      );
  }
}
