import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "../components/Button.tsx";
import { Card, ErrorText, Field } from "../components/Field.tsx";
import { Loading } from "../components/Loading.tsx";
import { Swatches } from "../components/Swatches.tsx";
import { useTurnstile } from "../components/Turnstile.tsx";
import { api, ApiError, type MyJoinRequest, type Me } from "../lib/api.ts";
import { rememberedName, rememberName } from "../lib/device.ts";
import { memberSwatches } from "../lib/memberColor.ts";
import { theme } from "../lib/theme.ts";
import { useWakeLock } from "../lib/wakeLock.ts";
import {
  advance,
  reduceAsk,
  askStartColor,
  hasMember,
  initialAskState,
  LETTING_IN,
  OUTCOME_CARDS,
  outcomeButtons,
  reconnecting,
  waitingLine,
  type AskEvent,
  type AskState,
  type Effect,
  type Outcome,
} from "./askToJoin.ts";
import { askRefusal, CHALLENGE_NOTICE, CHALLENGE_UNAVAILABLE, joinSend, resumesWaiting } from "./joinChallenge.ts";

/** The notice in Only by asking when a player link was opened: it sends nothing here. */
export const LINK_IN_ASK_ONLY = "This room lets new players in when a DM says yes, so ask here.";

/** Moves focus to a card's heading when the card appears, as the join's second step does. */
function useHeadingFocus() {
  const ref = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}

/** A card the page stops on. Its heading takes focus. */
export function OutcomeCard(props: { outcome: Outcome; children?: React.ReactNode }) {
  const heading = useHeadingFocus();
  const words = OUTCOME_CARDS[props.outcome];
  return (
    <Card title={words.title} titleRef={heading}>
      <p style={{ margin: 0 }}>{words.body}</p>
      {props.children}
    </Card>
  );
}

/**
 * The ask flow (design join-requests 2.2): the ask card, the waiting card
 * and the cards it stops on. The wait loop is the reducer in askToJoin.ts.
 * This component only runs the one call the reducer names and reports each
 * answer back, so a late or failed answer can move nothing it should not.
 */
export function AskToJoin(props: {
  roomId: string;
  /** In `ask` the password card is the page's other way in, and Back returns to it. */
  mode: "ask" | "ask_only";
  /** A request this device already holds, found before any card showed. */
  mine: MyJoinRequest | null;
  /** A player link was opened here. It sends nothing in Only by asking. */
  linkOpened: boolean;
  onBack?: () => void;
  onJoined(me: Me): void;
  /** The DM changed how new players join: read the room again. */
  onModeChanged(): void;
  /** The request ended because the DM chose With the password. */
  onClosed(): void;
}) {
  const { roomId, mine } = props;
  // A request found on load shows its own card at the first paint, never the ask card for a moment first.
  const [state, setState] = useState<AskState>(() =>
    mine ? reduceAsk(initialAskState(), { type: "found", requestId: mine.requestId, name: mine.name, state: mine.state }) : initialAskState(),
  );
  const stateRef = useRef(state);
  const issued = useRef(0);
  const calls = useRef(new Map<number, AbortController>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const live = useRef(true);
  const callbacks = useRef(props);
  callbacks.current = props;

  const [name, setName] = useState(rememberedName);
  const [color, setColor] = useState(askStartColor);
  const [error, setError] = useState<string | null>(null);
  const [challenged, setChallenged] = useState(false);
  const [resend, setResend] = useState(false);
  const turnstile = useTurnstile();

  // The reducer's one pump. It runs synchronously outside React's render, so
  // a call is started exactly once even where effects run twice.
  const dispatch = useCallback((event: AskEvent) => {
    if (!live.current) return;
    const next = advance(stateRef.current, event, issued.current);
    stateRef.current = next.state;
    setState(next.state);
    // A call whose answer can no longer matter is cut off.
    const current = next.state.kind === "waiting" || next.state.kind === "checking" ? next.state.io : null;
    for (const [seq, controller] of calls.current) {
      if (!current || current.step !== "inflight" || current.seq !== seq) {
        controller.abort();
        calls.current.delete(seq);
      }
    }
    if (next.effect) {
      if ("seq" in next.effect) issued.current = Math.max(issued.current, next.effect.seq);
      run(next.effect);
    }
  }, []);

  function run(effect: Effect) {
    switch (effect.kind) {
      case "sleep": {
        const timer = setTimeout(() => {
          timers.current.delete(timer);
          dispatch({ type: "slept", seq: effect.seq });
        }, effect.ms);
        timers.current.add(timer);
        return;
      }
      case "wait": {
        const controller = new AbortController();
        calls.current.set(effect.seq, controller);
        api.waitForJoinRequest(roomId, effect.requestId, controller.signal).then(
          (answer) => dispatch({ type: "answer", seq: effect.seq, requestId: answer.requestId ?? effect.requestId, state: answer.state, me: answer.state === "in" ? answer.me : undefined }),
          (err: unknown) => {
            if (controller.signal.aborted) return;
            dispatch({ type: "waitFailed", seq: effect.seq, requestId: effect.requestId, gone: err instanceof ApiError && err.code === "request_gone" });
          },
        );
        return;
      }
      case "me": {
        const controller = new AbortController();
        calls.current.set(effect.seq, controller);
        api.getMe(roomId).then(
          // A grant whose member is gone is not a way in (design 2.2).
          (me) => !controller.signal.aborted && dispatch({ type: "meResult", seq: effect.seq, me: hasMember(me) ? me : null }),
          (err: unknown) => {
            if (controller.signal.aborted) return;
            const none = err instanceof ApiError && [401, 403, 404].includes(err.status);
            dispatch({ type: "meResult", seq: effect.seq, me: none ? null : "error" });
          },
        );
        return;
      }
      case "cancel":
        api.cancelJoinRequest(roomId, effect.requestId).then(
          () => dispatch({ type: "cancelDone", requestId: effect.requestId }),
          (err: unknown) => {
            if (err instanceof ApiError && err.code === "request_deciding") dispatch({ type: "cancelDeciding", requestId: effect.requestId });
            // Gone, or answered before Cancel landed: GET /me says whether the device is in.
            else dispatch({ type: "cancelFailed", requestId: effect.requestId, gone: err instanceof ApiError && (err.code === "request_gone" || err.code === "request_answered") });
          },
        );
        return;
    }
  }

  // Mount starts the call the state calls for. The cleanup rewinds the call
  // in flight, so a development double mount, or a real remount, starts it
  // again instead of losing it.
  useEffect(() => {
    live.current = true;
    dispatch({ type: "rewind" });
    return () => {
      for (const controller of calls.current.values()) controller.abort();
      calls.current.clear();
      for (const timer of timers.current) clearTimeout(timer);
      timers.current.clear();
      stateRef.current = reduceAsk(stateRef.current, { type: "rewind" });
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (state.kind === "in") callbacks.current.onJoined(state.me);
  }, [state.kind === "in" ? state.me : null]);

  const closedOnce = useRef(false);
  useEffect(() => {
    if (state.kind === "outcome" && state.outcome === "closed" && !closedOnce.current) {
      closedOnce.current = true;
      callbacks.current.onClosed();
    }
  }, [state]);

  async function ask(turnstileToken: string | undefined) {
    dispatch({ type: "send" });
    setError(null);
    const trimmed = name.trim();
    const send = async () => {
      try {
        const sent = await api.askToJoin(roomId, { name: trimmed, color, ...(turnstileToken ? { turnstileToken } : {}) });
        rememberName(trimmed);
        dispatch({ type: "asked", requestId: sent.requestId, name: trimmed });
      } catch (err) {
        const refusal = askRefusal(err);
        if (refusal.challenged) setChallenged(true);
        setResend(refusal.resend);
        setError(refusal.error);
        if (refusal.modeChanged) callbacks.current.onModeChanged();
        if (refusal.alreadyHere === "in") dispatch({ type: "alreadyIn" });
        else if (refusal.alreadyHere === "deciding") {
          // A request of this device is being decided: wait on that one.
          dispatch({ type: "askFailed" });
          void api.getMyJoinRequest(roomId).then(
            (found) => (found ? dispatch({ type: "found", requestId: found.requestId, name: found.name, state: found.state }) : setError("Something went wrong. Try again.")),
            () => setError("Something went wrong. Try again."),
          );
        } else dispatch({ type: "askFailed" });
      } finally {
        // A token works once, so every answer gets a fresh check.
        if (turnstileToken) turnstile.reset();
      }
    };
    // Two tabs of one browser never ask at once, so the second carries the cookie the first was given.
    if ("locks" in navigator) await navigator.locks.request("rvtt-ask", send);
    else await send();
  }

  function next() {
    if (!name.trim()) {
      setError("Enter a name.");
      return;
    }
    const action = joinSend(challenged, turnstile);
    setResend(false);
    if (action.kind === "send") void ask(action.turnstileToken);
    else if (action.kind === "wait") {
      setError(null);
      setResend(true);
    } else setError(CHALLENGE_UNAVAILABLE);
  }

  // The check usually solves itself within a second or two, so Ask to join
  // does not need a second tap (the password step does the same).
  useEffect(() => {
    if (resend && state.kind === "form" && resumesWaiting(challenged, turnstile)) next();
  }, [resend, state.kind, challenged, turnstile.token, turnstile.pending, turnstile.required]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (state.kind === "asking") return;
    next();
  }

  const colorLabel = useId();
  const swatches = memberSwatches({ players: [] });

  switch (state.kind) {
    case "form":
    case "asking":
      return (
        <Card title="Ask to join">
          <form onSubmit={submit} style={{ display: "grid", gap: theme.space(3) }}>
            {props.mode === "ask_only" && props.linkOpened ? <p style={{ margin: 0, color: theme.color.textMuted }}>{LINK_IN_ASK_ONLY}</p> : null}
            <p style={{ margin: 0, color: theme.color.textMuted, fontSize: theme.font.body14 }}>The DM sees your name and color, then lets you in or says no.</p>
            <Field label="Your name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="nickname" />
            <div style={{ display: "grid", gap: theme.space(1) }}>
              <span id={colorLabel} style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong }}>
                Your color
              </span>
              <Swatches labelledBy={colorLabel} value={color} options={swatches} onChange={setColor} />
            </div>
            {challenged ? (
              <>
                <p style={{ margin: 0 }}>{CHALLENGE_NOTICE_ASK}</p>
                {turnstile.widget}
              </>
            ) : null}
            <ErrorText>{error}</ErrorText>
            <Button type="submit" variant="primary" busy={state.kind === "asking"}>
              {state.kind === "asking" ? "Asking…" : resend ? "Waiting for the check…" : "Ask to join"}
            </Button>
            {props.mode === "ask" && props.onBack ? (
              <Button onClick={props.onBack} disabled={state.kind === "asking"}>
                Back
              </Button>
            ) : null}
          </form>
        </Card>
      );
    case "waiting":
      return <WaitingCard state={state} onCancel={() => dispatch({ type: "cancel" })} />;
    case "checking":
      return (
        <Card>
          <Loading text="Checking…" />
        </Card>
      );
    case "in":
      return (
        <Card>
          <Loading text="Opening the room…" />
        </Card>
      );
    case "outcome":
      return (
        <OutcomeCard key={state.outcome} outcome={state.outcome}>
          {outcomeButtons(state.outcome).length > 0 ? (
            <div style={{ display: "grid", gap: theme.space(2) }}>
              {outcomeButtons(state.outcome).map((button) =>
                button === "here" ? (
                  <Button key={button} variant="primary" onClick={() => dispatch({ type: "waitHere" })}>
                    Wait here
                  </Button>
                ) : button === "again" ? (
                  <Button key={button} variant="primary" onClick={() => dispatch({ type: "reset" })}>
                    Ask again
                  </Button>
                ) : (
                  <Button
                    key={button}
                    onClick={() => {
                      dispatch({ type: "reset" });
                      if (props.mode === "ask") props.onBack?.();
                    }}
                  >
                    Back
                  </Button>
                ),
              )}
            </div>
          ) : null}
        </OutcomeCard>
      );
  }
}

const CHALLENGE_NOTICE_ASK = CHALLENGE_NOTICE.startsWith("Too many wrong passwords") ? "Please confirm you're human before asking." : CHALLENGE_NOTICE;

function WaitingCard(props: { state: Extract<AskState, { kind: "waiting" }>; onCancel(): void }) {
  const heading = useHeadingFocus();
  useWakeLock();
  const { state } = props;
  const cancelling = state.cancel === "queued" || state.cancel === "sent";
  return (
    <Card title="Waiting for the DM" titleRef={heading}>
      <p style={{ margin: 0 }}>{waitingLine(state.name)}</p>
      <Loading text={state.cancel === "deciding" ? LETTING_IN : "Waiting for the DM…"} delay={0} />
      {reconnecting(state) ? (
        <p role="status" style={{ margin: 0, color: theme.color.textMuted, fontSize: theme.font.body14 }}>
          Reconnecting…
        </p>
      ) : null}
      <p style={{ margin: 0, color: theme.color.textMuted, fontSize: theme.font.body14 }}>Keep this page open. A request ends after 10 minutes.</p>
      <ErrorText>{state.cancelFailed ? "Could not cancel. Try again." : null}</ErrorText>
      <Button busy={cancelling} disabled={state.cancel === "deciding"} onClick={props.onCancel}>
        {cancelling ? "Cancelling…" : "Cancel"}
      </Button>
    </Card>
  );
}
