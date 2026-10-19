import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "../components/Button.tsx";
import { Card, ErrorText, Field, Page } from "../components/Field.tsx";
import { RowDot } from "../components/Row.tsx";
import { Swatches } from "../components/Swatches.tsx";
import { useTurnstile } from "../components/Turnstile.tsx";
import { api, ApiError, type JoinStep, type Me } from "../lib/api.ts";
import { rememberedName, rememberName } from "../lib/device.ts";
import { readKnownRooms } from "../lib/knownRooms.ts";
import { freeColor, memberSwatches } from "../lib/memberColor.ts";
import type { LinkPassword } from "../lib/playerLink.ts";
import { formatRoomId } from "../lib/roomId.ts";
import { theme } from "../lib/theme.ts";
import { DmLinkEntry } from "./DmLinkEntry.tsx";
import { HomeHeader } from "./Home.tsx";
import {
  CHALLENGE_NOTICE,
  CHALLENGE_UNAVAILABLE,
  joinRefusal,
  joinSend,
  LINK_CUT_OFF,
  resumesWaiting,
} from "./joinChallenge.ts";

/** A password and where it came from. */
type Entered = { password: string; fromLink: boolean };

/** How the password step opens. */
type Start = Entered & {
  /** Send at once: a player link was just opened. */
  auto: boolean;
  notice: string | null;
  error: string | null;
};

function linkStart(link: LinkPassword | null): Start {
  const blank = { password: "", fromLink: false, auto: false, notice: null, error: null };
  if (!link) return blank;
  if (link.password === null) return { ...blank, error: LINK_CUT_OFF };
  return { ...blank, password: link.password, fromLink: true, auto: true };
}

/**
 * The player join (design section 10.2), in two steps so the roster is never
 * shown before the password: first the password, then "continue as" one of
 * the players it returns, or a new name and color.
 *
 * A player link fills in the password and sends it on its own, so the player
 * lands on the second step. When the ticket runs out on that step, the
 * password comes back filled in: a player who came by link never saw it.
 */
export function Join(props: { roomId: string; roomName: string; link: LinkPassword | null; onJoined(me: Me): void }) {
  const { roomId } = props;
  const [step, setStep] = useState<(JoinStep & { entered: Entered }) | null>(null);
  const [start, setStart] = useState(() => linkStart(props.link));
  // A device that was a DM here and lost its grant (signed out, a replaced
  // DM link, DM removed) comes back with the DM link, so that comes first.
  const [wasDm] = useState(() => !props.link && readKnownRooms().some((r) => r.roomId === roomId && r.role === "dm"));
  const dmEntry = wasDm ? (
    <DmLinkEntry
      title="Were you the DM?"
      hint="This device was a DM in this room and is signed out now. Paste your DM link, or an invite from another DM device, to come back as DM."
    />
  ) : (
    <DmLinkEntry />
  );

  return (
    <Page>
      <HomeHeader title={props.roomName} tagline={`Room ${formatRoomId(roomId)}`} />
      {wasDm ? dmEntry : null}
      {step ? (
        <PickPlayer
          roomId={roomId}
          ticket={step.ticket}
          players={step.players}
          dmColors={step.dmColors}
          onJoined={props.onJoined}
          onExpired={() => {
            setStart({ ...step.entered, auto: false, notice: "That took a while, so press Next again.", error: null });
            setStep(null);
          }}
        />
      ) : (
        <PasswordStep roomId={roomId} start={start} onOk={(ok, entered) => setStep({ ...ok, entered })} />
      )}
      {wasDm ? null : dmEntry}
    </Page>
  );
}

function PasswordStep(props: {
  roomId: string;
  start: Start;
  onOk(step: JoinStep, entered: Entered): void;
}) {
  const [password, setPassword] = useState(props.start.password);
  // Until the player edits the field, a refusal is about the link, not their typing.
  const [fromLink, setFromLink] = useState(props.start.fromLink);
  const [error, setError] = useState<string | null>(props.start.error);
  const [busy, setBusy] = useState(false);
  // Set once the server asks for the check (joinChallenge.ts). It stays set:
  // the room keeps asking for as long as the wrong passwords keep coming.
  const [challenged, setChallenged] = useState(false);
  // Next was pressed while the check had no token yet, so the password goes
  // out as soon as one arrives.
  const [waiting, setWaiting] = useState(false);
  const turnstile = useTurnstile();

  async function send(turnstileToken: string | undefined) {
    setBusy(true);
    setError(null);
    try {
      props.onOk(await api.join(props.roomId, password, turnstileToken), { password, fromLink });
    } catch (err) {
      const refusal = joinRefusal(err, fromLink);
      if (refusal.challenged) setChallenged(true);
      setWaiting(refusal.resend);
      setError(refusal.error);
      // A link's old password is no use for typing the new one over.
      if (refusal.wrongPassword && fromLink) {
        setPassword("");
        setFromLink(false);
      }
    } finally {
      setBusy(false);
      // A token works once, so every answer gets a fresh check.
      if (turnstileToken) turnstile.reset();
    }
  }

  function next() {
    const action = joinSend(challenged, turnstile);
    setWaiting(false);
    if (action.kind === "send") void send(action.turnstileToken);
    else if (action.kind === "wait") {
      setError(null);
      setWaiting(true);
    } else setError(CHALLENGE_UNAVAILABLE);
  }

  // The check usually solves itself within a second or two, so the player
  // does not have to press Next a second time. It also settles a wait that
  // can never end: when the site key could not be read, no check appears,
  // and the player is told to reload instead of watching "Waiting".
  useEffect(() => {
    if (waiting && !busy && resumesWaiting(challenged, turnstile)) next();
  }, [waiting, busy, challenged, turnstile.token, turnstile.pending, turnstile.required]);

  // A player link sends its password once, as if Next were pressed. The ref
  // holds across React's development double mount, so it is never sent
  // twice. When the room asks for the check, the answer brings it up and
  // the wait above sends again once it is solved.
  const autoSent = useRef(false);
  useEffect(() => {
    if (!props.start.auto || autoSent.current) return;
    autoSent.current = true;
    next();
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    // Next stays enabled while busy, so Enter in the field must not send twice.
    if (busy) return;
    next();
  }

  return (
    <Card title="Join the game">
      <form onSubmit={submit} style={{ display: "grid", gap: theme.space(3) }}>
        {props.start.notice ? <p style={{ margin: 0, color: theme.color.textMuted }}>{props.start.notice}</p> : null}
        <Field
          label="Player password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setFromLink(false);
          }}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          hint={fromLink ? "From your join link." : "Your DM has it."}
          error={error}
          // Not while a link's password is on its way, so a phone does not open its keyboard for nothing.
          autoFocus={!props.start.auto}
        />
        {challenged ? (
          <>
            <p style={{ margin: 0 }}>{CHALLENGE_NOTICE}</p>
            {turnstile.widget}
          </>
        ) : null}
        {/* Not disabled while waiting: a check that errors out must not leave the player stuck. */}
        <Button type="submit" variant="primary" busy={busy} disabled={password === ""}>
          {busy ? "Checking…" : waiting ? "Waiting for the check…" : "Next"}
        </Button>
      </form>
    </Card>
  );
}

function PickPlayer(props: {
  roomId: string;
  ticket: string;
  players: JoinStep["players"];
  dmColors: readonly string[];
  onJoined(me: Me): void;
  onExpired(): void;
}) {
  const [name, setName] = useState(rememberedName);
  // A color nobody uses yet, so each player draws in their own (lib/memberColor.ts).
  const [color, setColor] = useState<string>(() => freeColor(props.players.map((p) => p.color), props.dmColors));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Players removed from the roster while this list was open. */
  const [gone, setGone] = useState<readonly string[]>([]);
  const players = props.players.filter((p) => !gone.includes(p.id));
  const swatches = memberSwatches({ players, dmColors: props.dmColors });
  const colorLabel = useId();

  /*
   * The password step's form unmounts with its Next button, and focus fell
   * to the page, so a screen reader heard nothing of this step. It starts
   * at the list of players to continue as, or at the name when there is
   * none to pick.
   */
  const pickRef = useRef<HTMLHeadingElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    (pickRef.current ?? nameRef.current)?.focus();
  }, []);

  async function complete(input: { memberId: string } | { name: string; color: string }, remembered: string) {
    setBusy(true);
    setError(null);
    try {
      const me = await api.completeJoin(props.roomId, { ticket: props.ticket, ...input });
      rememberName(remembered);
      props.onJoined(me);
    } catch (err) {
      // The DM removed that player from the roster as this device picked it.
      // The rest of the list still stands, so the player stays on this step.
      if (err instanceof ApiError && err.code === "member_removed") {
        if ("memberId" in input) setGone((g) => [...g, input.memberId]);
        setError("That member was just removed from the room. Join as someone new.");
        return;
      }
      // The ticket lives 5 minutes and is single use, and a password change
      // voids it. A refused ticket sends the player back a step. A 400 is
      // about the input instead, so it stays on this step.
      const ticketRefused = err instanceof ApiError && err.status > 400 && err.status < 500 && err.status !== 429;
      if (ticketRefused) props.onExpired();
      else setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function submitNew(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a name.");
      return;
    }
    void complete({ name: trimmed, color }, trimmed);
  }

  return (
    <>
      {players.length > 0 ? (
        <Card title="Who are you?" titleRef={pickRef}>
          <p style={{ margin: 0, color: theme.color.textMuted, fontSize: theme.font.body14 }}>
            Joining from a new phone? Pick yourself to carry on as the same player.
          </p>
          <div style={{ display: "grid", gap: theme.space(2) }}>
            {players.map((p) => (
              <Button
                key={p.id}
                disabled={busy}
                onClick={() => void complete({ memberId: p.id }, p.name)}
                // Button centers its content. A list of names reads down its left edge.
                style={{ justifyContent: "flex-start", gap: theme.space(3), textAlign: "left" }}
              >
                <RowDot color={p.color} size={14} />
                Continue as {p.name}
              </Button>
            ))}
          </div>
        </Card>
      ) : null}
      <Card title={players.length > 0 ? "Or join as someone new" : "Join as a new player"}>
        <form onSubmit={submitNew} style={{ display: "grid", gap: theme.space(3) }}>
          <Field ref={nameRef} label="Your name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="nickname" />
          <div style={{ display: "grid", gap: theme.space(1) }}>
            <span id={colorLabel} style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong }}>
              Your color
            </span>
            {/* A color in use keeps its full color and a badge, and stays pickable: two players may share one. */}
            <Swatches labelledBy={colorLabel} value={color} options={swatches} onChange={setColor} />
          </div>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" variant="primary" busy={busy}>
            {busy ? "Joining…" : "Join"}
          </Button>
        </form>
      </Card>
    </>
  );
}
