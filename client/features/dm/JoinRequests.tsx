import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { Button } from "../../components/Button.tsx";
import { ErrorText, Select } from "../../components/Field.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Group, Help, Section } from "../../components/Panel.tsx";
import { RadioCards } from "../../components/RadioCards.tsx";
import { Row, RowDot } from "../../components/Row.tsx";
import { api, ApiError, type JoinMode, type LetInAs } from "../../lib/api.ts";
import { theme } from "../../lib/theme.ts";
import { panelFocusSlot } from "../../pages/mapFocus.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import { realClock } from "../../state/timing.ts";
import { useRoomUi, useRoomView } from "../../state/view.ts";
import { usePreview } from "./previewContext.ts";
import { viewAsSlot } from "./viewAs.tsx";
import {
  answerErrorText,
  askedText,
  carryOnNote,
  carryOnPlayers,
  createJoinRequestsLoader,
  createJoinToaster,
  JOIN_MODE_ERRORS,
  JOIN_MODE_OPTIONS,
  nextAgeTickMs,
  ownAnswerOver,
  rosterKey,
  rowBusy,
  rowBusyText,
  turnAwayAllErrorText,
  typedNameMatch,
  waitingRows,
  type JoinRequestList,
  type JoinRequestRow,
  type JoinRequestsState,
  type OwnAnswer,
} from "./joinRequests.ts";

/**
 * The DM's side of join requests (docs/design/design-v1-join-requests.md 2.1
 * and 2.3). One list per room page lives in `joinRequestsSlot`: Room mounts
 * `useJoinRequestsRoom`, which fetches it on every `joinRequestsVersion`,
 * toasts and counts for the badge, and the DM panel's section and the
 * Members page's Joining setting read it from there. Neither fetches on its
 * own, so the three never disagree.
 */

type Hub = {
  readonly store: StoreApi<JoinRequestsState>;
  /** Starts a fresh fetch. A no-op while no DM device holds the list (a player, a preview). */
  refresh(): void;
  /** What a saved mode setting answered, shown at once. The signal's fetch follows it. */
  applyMode(mode: JoinMode): void;
  /** Set by `useJoinRequestsRoom` while it holds the list. */
  attach: { refresh: () => void } | null;
};

export const joinRequestsSlot = scopeSlot<Hub>(() => {
  const store = createStore<JoinRequestsState>(() => ({ kind: "loading" }));
  const hub: Hub = {
    store,
    attach: null,
    refresh() {
      hub.attach?.refresh();
    },
    applyMode(mode) {
      const state = store.getState();
      if (state.kind === "shown") store.setState({ ...state, list: { ...state.list, mode } }, true);
    },
  };
  return hub;
});

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "network") return err.message;
    if (err.code && JOIN_MODE_ERRORS[err.code]) return JOIN_MODE_ERRORS[err.code]!;
    if (err.code === "dm_only" || err.code === "no_access") return "Only a DM device can do that. This device may have been signed out.";
    if (err.code === "busy") return "The server is busy. Try again in a moment.";
  }
  return "Something went wrong. Try again.";
}

/**
 * Room mounts this once. It holds the list while this page is a DM's own
 * (a preview reads as a player and holds none), fetches it on every
 * signal, toasts, and gives the badge its count.
 */
export function useJoinRequestsRoom(): number {
  const hub = useScoped(joinRequestsSlot);
  const roomId = useRoomView((s) => s.roomId);
  const dm = useRoomView((s) => s.you?.role === "dm");
  const version = useRoomView((s) => s.joinRequestsVersion);
  // Who may be carried on changes with the roster, which sends no join request signal.
  const roster = useRoomView((s) => rosterKey(s.view?.members));
  const preview = usePreview() !== null;
  const ui = useRoomUi();
  const viewAs = useScoped(viewAsSlot);
  const viewing = useStore(viewAs.store, (s) => s.target !== null);
  const active = dm && !preview;
  const viewingNow = useRef(viewing);
  viewingNow.current = viewing;
  const toaster = useRef<ReturnType<typeof createJoinToaster> | null>(null);

  useEffect(() => {
    if (!active) return;
    const loader = createJoinRequestsLoader({ clock: realClock, fetch: () => api.listJoinRequests(roomId), describe });
    const made = createJoinToaster({
      clock: realClock,
      show: (text) => ui.notify(text, "info", undefined, { label: "Review", run: () => ui.openPanel("dm") }),
    });
    toaster.current = made;
    hub.attach = { refresh: () => loader.refresh() };
    const unsubscribe = loader.subscribe(() => {
      const state = loader.state;
      hub.store.setState(state, true);
      if (state.kind === "shown") made.update(state.list, viewingNow.current);
    });
    // The first fetch waits for the effect below, so a fresh page and a signal take the same path.
    return () => {
      unsubscribe();
      loader.stop();
      made.stop();
      toaster.current = null;
      hub.attach = null;
      hub.store.setState({ kind: "loading" }, true);
    };
  }, [active, roomId, hub, ui]);

  useEffect(() => {
    if (active) hub.refresh();
  }, [active, version, roster, hub]);

  // Leaving View as a player lets the toasts held back show.
  useEffect(() => {
    const state = hub.store.getState();
    if (active && state.kind === "shown") toaster.current?.update(state.list, viewing);
  }, [active, viewing, hub]);

  return useStore(hub.store, (s) => (s.kind === "shown" ? waitingRows(s.list.requests).length : 0));
}

/** The room's join mode as the DM list last said it, or null before it answered. */
export function useJoinMode(): JoinMode | null {
  const hub = useScoped(joinRequestsSlot);
  return useStore(hub.store, (s) => (s.kind === "shown" ? s.list.mode : null));
}

/** The Joining setting on the Members page (design 2.1). */
export function JoiningSetting() {
  const roomId = useRoomView((s) => s.roomId);
  const hub = useScoped(joinRequestsSlot);
  const state = useStore(hub.store);
  const [busy, setBusy] = useState<JoinMode | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const mode = state.kind === "shown" ? state.list.mode : null;

  const choose = async (next: JoinMode) => {
    if (busyRef.current || next === mode) return;
    busyRef.current = true;
    setBusy(next);
    setSaved(false);
    setError(null);
    try {
      const answer = await api.setJoinMode(roomId, next);
      hub.applyMode(answer.mode);
      hub.refresh();
      setSaved(true);
    } catch (err) {
      setError(describe(err));
      hub.refresh();
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  return (
    <Section label="Joining">
      {state.kind === "loading" ? (
        <Loading text="Loading…" />
      ) : mode === null ? (
        <>
          <ErrorText>{state.kind === "error" ? state.message : null}</ErrorText>
          <Help>Trying again…</Help>
        </>
      ) : (
        <RadioCards<JoinMode>
          legend="How new players join"
          value={busy ?? mode}
          options={JOIN_MODE_OPTIONS}
          busy={busy !== null}
          status={
            busy !== null ? (
              <Loading small live={false} delay={0} text="Saving…" />
            ) : error ? (
              <span style={{ fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.dangerText }}>{error}</span>
            ) : saved ? (
              <span style={{ fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.textMuted }}>Saved.</span>
            ) : null
          }
          onChange={(next) => void choose(next)}
        />
      )}
    </Section>
  );
}

/** One line under the player link's buttons while the room is Only by asking (design 2.1). */
export const ASK_ONLY_LINK_NOTE = "Only by asking is on. This link opens the join page, where new players ask to join.";

/** Ticks at the next minute an age on screen changes, then stops, so a closed panel costs nothing. */
function useNow(requests: readonly JoinRequestRow[]): number {
  const [now, setNow] = useState(() => Date.now());
  const wait = nextAgeTickMs(requests, now);
  useEffect(() => {
    if (wait === null) return;
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [wait, now]);
  return now;
}

/** Whether the DM panel shows its Join requests section: while any request waits or is being let in. */
export function useJoinRequestsShown(): boolean {
  const hub = useScoped(joinRequestsSlot);
  return useStore(hub.store, (s) => s.kind === "shown" && s.list.requests.length > 0);
}

/**
 * The DM panel's Join requests section (design 2.3). Gone while no request
 * waits or is being let in. A group that never folds, since someone is
 * waiting on it (docs/design/design-v1-panel-groups.md 6.1): it keeps the
 * chevron's space, so its name lines up with the folding groups under it,
 * and as the panel's first group it draws no line under the header.
 */
export function JoinRequestsSection() {
  const hub = useScoped(joinRequestsSlot);
  const state = useStore(hub.store);
  const online = useRoomView((s) => s.online);
  const members = useRoomView((s) => s.view?.members);
  const requests = state.kind === "shown" ? state.list.requests : [];
  const now = useNow(requests);
  const panelFocus = useScoped(panelFocusSlot);
  const names = useRef(new Map<string, HTMLElement>());
  /** Where focus goes once the answered request leaves the list. */
  const focusAfter = useRef<{ answered: string[]; next: string | null } | null>(null);

  useEffect(() => {
    const target = focusAfter.current;
    if (!target || state.kind !== "shown") return;
    if (target.answered.some((id) => requests.some((r) => r.id === id))) return;
    focusAfter.current = null;
    const next = requests.find((r) => r.id === target.next) ?? requests[0];
    if (next) names.current.get(next.id)?.focus();
    else panelFocus.focus?.("dm");
  }, [state, requests, panelFocus]);

  const answered = useCallback(
    (ids: string[]) => {
      const rest = requests.filter((r) => !ids.includes(r.id));
      const first = requests.findIndex((r) => ids.includes(r.id));
      focusAfter.current = { answered: ids, next: (rest.find((r) => requests.indexOf(r) > first) ?? rest[0])?.id ?? null };
      hub.refresh();
    },
    [requests, hub],
  );

  if (state.kind !== "shown" || requests.length === 0) return null;
  const { list } = state;
  const onlineSet = new Set(online);
  const players = carryOnPlayers(list.players, members);
  // A request being let in is no one Turn away all may turn away.
  const waiting = waitingRows(requests);
  return (
    <Group label="Join requests" reserve="chevron" divider={false}>
      <div style={{ display: "grid", gap: theme.space(3) }}>
        {requests.map((r) => (
          <RequestRow
            key={r.id}
            request={r}
            players={players}
            online={onlineSet}
            now={now}
            listed={state}
            nameRef={(el) => {
              if (el) names.current.set(r.id, el);
              else names.current.delete(r.id);
            }}
            onAnswered={() => answered([r.id])}
            onRefused={() => hub.refresh()}
          />
        ))}
      </div>
      {state.stale ? <Help>Could not refresh. Trying again…</Help> : null}
      {waiting.length >= 2 ? <TurnAwayAll ids={waiting.map((r) => r.id)} onAnswered={answered} onRefused={() => hub.refresh()} /> : null}
    </Group>
  );
}

function TurnAwayAll(props: { ids: string[]; onAnswered(ids: string[]): void; onRefused(): void }) {
  const roomId = useRoomView((s) => s.roomId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  // Only the requests on screen when tapped, so one that arrives while the call is out is never turned away unseen.
  const go = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const ids = props.ids.slice(0, 50);
    try {
      await api.turnAway(roomId, ids);
      props.onAnswered(ids);
    } catch (err) {
      setError(turnAwayAllErrorText(err instanceof ApiError ? err.code : undefined));
      props.onRefused();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      <Button size="sm" busy={busy} onClick={() => void go()} style={{ justifySelf: "start" }}>
        {busy ? "Turning away…" : "Turn away all"}
      </Button>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

function RequestRow(props: {
  request: JoinRequestRow;
  players: JoinRequestList["players"];
  online: ReadonlySet<string>;
  now: number;
  /** The list state this row was drawn from: a new one settles a row that was still being let in. */
  listed: JoinRequestsState;
  nameRef(el: HTMLElement | null): void;
  onAnswered(): void;
  onRefused(): void;
}) {
  const { request } = props;
  const roomId = useRoomView((s) => s.roomId);
  const [as, setAs] = useState("");
  const [own, setOwn] = useState<OwnAnswer<JoinRequestsState> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  // The list on screen now, for an answer that comes back after newer lists did.
  const listedNow = useRef(props.listed);
  const selectId = useId();
  const noteId = useId();
  const player = as === "" ? null : (props.players.find((p) => p.id === as) ?? null);
  // A pick whose player left the list falls back to Someone new, so a stale choice never goes to the server.
  const pick = player ? player.id : "";
  const hinted = typedNameMatch(request.name, props.players);
  const note = player ? carryOnNote(player, props.online.has(player.id), hinted?.id === player.id) : null;

  useEffect(() => {
    listedNow.current = props.listed;
  }, [props.listed]);
  // This device's answer holds the row busy until the lists show the let-in over: the row gone, or waiting again with no let-in running.
  // Checked whenever the answer or the list changes, since the list that settles a 202 can arrive before it.
  useEffect(() => {
    if (own && ownAnswerOver(own, props.listed, request.deciding === true)) setOwn(null);
  }, [own, props.listed, request.deciding]);

  const run = async (kind: "letting" | "turning") => {
    if (busyRef.current) return;
    busyRef.current = true;
    setOwn({ busy: kind, sent: props.listed, heard: "none", finalAt: null });
    setError(null);
    try {
      if (kind === "turning") {
        await api.turnAway(roomId, [request.id]);
      } else {
        const target: LetInAs = pick === "" ? { kind: "new" } : { kind: "member", memberId: pick };
        const answer = await api.letIn(roomId, request.id, target);
        // A 202 means the grant is still being written. The signal that settles it brings the next list, so none is asked for here.
        if (answer.pending) {
          setOwn((o) => o && { ...o, busy: "still", heard: "pending" });
          return;
        }
      }
      // The row stays busy until the next list replaces it, so it never flashes idle between the answer and its leaving.
      setOwn((o) => o && { ...o, heard: "final", finalAt: listedNow.current });
      props.onAnswered();
    } catch (err) {
      setError(answerErrorText(err instanceof ApiError ? err.code : undefined, request.name));
      props.onRefused();
      setOwn(null);
    } finally {
      busyRef.current = false;
    }
  };

  // The list keeps a request on screen while any DM device lets it in, so this row stays, with its words, until the let-in settles.
  const shown = rowBusy(own?.busy ?? null, request);
  const disabled = shown !== null;
  // A let-in that failed after its 202, or on another DM device, says why from the list.
  const refusal = error ?? (request.refused && shown === null ? answerErrorText(request.refused, request.name) : null);
  return (
    <div
      role="group"
      aria-label={`Join request from ${request.name}`}
      style={{ display: "grid", gap: theme.space(2), minWidth: 0, border: `${theme.line.border}px solid ${theme.color.border}`, borderRadius: theme.radius.md, background: theme.color.surfaceRaised, paddingBottom: theme.space(3) }}
    >
      <Row
        leading={<RowDot color={request.color} />}
        title={
          <span ref={props.nameRef} tabIndex={-1} style={{ outline: "none" }}>
            {request.name}
          </span>
        }
        wrapTitle
        detail={askedText(request.askedAt, props.now)}
        style={{ minHeight: 56 }}
      />
      <div style={{ display: "grid", gap: theme.space(2), padding: `0 ${theme.space(3)}px`, minWidth: 0 }}>
        {props.players.length > 0 ? (
          <div style={{ display: "grid", gap: theme.space(1) }}>
            <label htmlFor={selectId} style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong }}>
              Let in as
            </label>
            <Select id={selectId} value={pick} disabled={disabled} aria-label={`Let ${request.name} in as`} aria-describedby={note ? noteId : undefined} onChange={(e) => setAs(e.target.value)} style={{ width: "100%" }}>
              <option value="">Someone new</option>
              {props.players.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            {note ? (
              <Help id={noteId} style={{ overflowWrap: "anywhere" }}>
                {note}
              </Help>
            ) : null}
          </div>
        ) : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
          <Button variant="primary" size="sm" aria-label={`Let ${request.name} in`} busy={shown === "letting" || shown === "still"} disabled={disabled && shown !== "letting" && shown !== "still"} onClick={() => void run("letting")} style={{ flex: "1 1 120px" }}>
            {shown === "letting" || shown === "still" ? rowBusyText(shown, request.name) : "Let in"}
          </Button>
          <Button size="sm" aria-label={`Turn ${request.name} away`} busy={shown === "turning"} disabled={disabled && shown !== "turning"} onClick={() => void run("turning")} style={{ flex: "1 1 120px" }}>
            {shown === "turning" ? rowBusyText("turning", request.name) : "Turn away"}
          </Button>
        </div>
        <ErrorText>{refusal}</ErrorText>
      </div>
    </div>
  );
}
