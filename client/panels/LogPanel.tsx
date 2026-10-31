import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent, type Ref } from "react";
import type { LogEntry } from "#shared/model.ts";
import { displayLog } from "#shared/logText.ts";
import { MAX_CHAT } from "#shared/protocol.ts";
import { Button } from "../components/Button.tsx";
import { Checkbox } from "../components/Checkbox.tsx";
import { Empty } from "../components/Empty.tsx";
import { Input, Select } from "../components/Field.tsx";
import { stickyPaneFoot } from "../components/Sheet.tsx";
import {
  chatTargets,
  composerTarget,
  memberName,
  mergeLog,
  messageOp,
  targetKey,
  whisperHeading,
  type LogNames,
} from "../features/log/format.ts";
import { canUndoLogLine } from "../features/encounter/hpLog.ts";
import { ProficientEvent, type LevelOf } from "../features/dice/ProficientEvent.tsx";
import { useProficiency } from "../features/dice/useProficiency.ts";
import { usePreview } from "../features/dm/previewContext.ts";
import { ExportLog } from "../features/log/ExportLog.tsx";
import { TakeBack } from "../features/encounter/HpLog.tsx";
import type { PanelProps } from "../features/panels.ts";
import { HistoryWindow, type HistoryState } from "./historyWindow.ts";
import { logPage, pageErrorText } from "./olderLog.ts";
import { useUnsavedInput } from "../lib/sheetSwipe.ts";
import { theme } from "../lib/theme.ts";
import { useRoomActions, useRoomView } from "../state/view.ts";

const EMPTY_LOG: LogEntry[] = [];

const visuallyHidden: CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };

/** The nearest ancestor that scrolls: the sheet's body on phones, the side panel on wide screens. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/**
 * The log (features section 16): chat, whispers, and the room's events in
 * one list, each event rendered with this viewer's own names. The live
 * view holds the newest lines the room keeps for this viewer
 * (shared/logRings.ts). Older ones come a page at a time from the archive,
 * projected for this viewer by the server, into a window of at most 500
 * rows (historyWindow.ts, docs/design-v1-log-history.md 5.3). Past that the
 * window parts from the live log, and Show newer and Back to latest bring
 * the reader back.
 */
export default function LogPanel(_props: PanelProps) {
  const actions = useRoomActions();
  const roomId = useRoomView((s) => s.roomId);
  const you = useRoomView((s) => s.you);
  const sceneId = useRoomView((s) => s.sceneId);
  const mainLog = useRoomView((s) => s.view?.log ?? EMPTY_LOG);
  const hpUndoLogIds = useRoomView((s) => s.view?.meta.hpUndoLogIds);
  // An older server supplies no archive retention, so only its live lines
  // offer Undo. A new server keeps loaded pages current without a refetch.
  const retainedIds = useMemo(() => hpUndoLogIds ?? mainLog.map((entry) => entry.id), [hpUndoLogIds, mainLog]);
  // Trap lines keep logs of their own, so no players' line ever pushes out a DM's, and read in among the rest (docs/design-v1-traps.md 6.3).
  const trapLog = useRoomView((s) => s.view?.trapLog ?? EMPTY_LOG);
  const trapSeen = useRoomView((s) => s.view?.trapSeen ?? EMPTY_LOG);
  const log = useMemo(() => (trapLog.length + trapSeen.length === 0 ? mainLog : mergeLog(mergeLog(trapLog, trapSeen), mainLog)), [mainLog, trapLog, trapSeen]);
  const members = useRoomView((s) => s.view?.members);
  const tokens = useRoomView((s) => s.view?.tokens);
  const characters = useRoomView((s) => s.view?.characters);
  const handouts = useRoomView((s) => s.view?.handouts);
  const encounter = useRoomView((s) => s.view?.encounter ?? null);
  const traps = useRoomView((s) => s.view?.traps);
  const names = useMemo<LogNames>(
    () => ({ members: members ?? {}, tokens: tokens ?? {}, characters: characters ?? {}, handouts: handouts ?? {}, encounter, traps: traps ?? {} }),
    [members, tokens, characters, handouts, encounter, traps],
  );
  const me = you?.memberId ?? "";
  const levelOf = useProficiency();
  const loaded = useRoomView((s) => s.view != null);

  const [chatOnly, setChatOnly] = useState(false);
  const [exporting, setExporting] = useState(false);
  // The file comes from the server by this device's own grant, which in "view as a player" is the DM's.
  const preview = usePreview();
  const dm = you?.role === "dm";
  // In "view as a player" the pages are that player's, as the preview's socket gives the rest (docs/design-v1-per-player-vision.md 7.4).
  const viewer = { sceneId: dm && !preview ? sceneId : null, previewOf: preview?.memberId ?? null };
  // Whose window it is. A page for any other room, viewer, scene or preview never lands in it.
  const key = [roomId, me, you?.role ?? "", viewer.sceneId ?? "", viewer.previewOf ?? ""].join("|");
  const asked = useRef({ roomId, viewer });
  asked.current = { roomId, viewer };

  const listRef = useRef<HTMLOListElement>(null);
  const atEnd = useRef(true);
  const sentRef = useRef(false);
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const composerRef = useRef<HTMLInputElement>(null);
  const [win] = useState(
    () =>
      new HistoryWindow({
        key,
        fetch: (ask, signal) => logPage(asked.current.roomId, ask, asked.current.viewer, { signal }),
        // The row at the top of the reader's view stays where it is while rows go in or out around it.
        beforeMove: (why) => {
          if (why === "live" && atEnd.current) return;
          anchor.current = firstVisibleRow(listRef.current);
        },
      }),
  );
  useEffect(() => () => win.dispose(), [win]);
  const [subscribe, snapshot] = useMemo(() => [(listener: () => void) => win.subscribe(listener), () => win.state] as const, [win]);
  const history = useSyncExternalStore(subscribe, snapshot, snapshot);
  useLayoutEffect(() => win.sync(key, mainLog, log.length), [win, key, mainLog, log.length]);
  const apart = history.mode === "history";

  // Cached revert records may outlive retention. Check the live undo ids,
  // and include loaded take-backs even when they are outside the live tail.
  const allEntries = useMemo(() => (apart ? history.rows : history.rows.length > 0 ? mergeLog(history.rows, log) : log), [apart, history.rows, log]);
  const undoable = (entry: LogEntry): boolean => canUndoLogLine(names, allEntries, entry, retainedIds);

  const entries = useMemo(() => {
    return chatOnly ? allEntries.filter((e) => e.kind !== "event") : displayLog(allEntries);
  }, [allEntries, chatOnly]);

  // Stay at the bottom while the reader is there, and always after sending.
  // The scroll container is the sheet or side panel around this panel, and
  // the composer is sticky at its bottom, so "the end" means scrolled all
  // the way down, never an element scrolled into view under the composer.
  useEffect(() => {
    const el = scrollParent(listRef.current);
    if (!el) return;
    const onScroll = () => {
      atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    const held = anchor.current;
    const el = scrollParent(listRef.current);
    if (held) {
      // Rows went in or out around the reader: hold their place instead of jumping.
      anchor.current = null;
      const row = listRef.current?.querySelector(`[data-log-id="${CSS.escape(held.id)}"]`);
      if (el && row) {
        el.scrollTop += row.getBoundingClientRect().top - held.top;
        return;
      }
    }
    if (el && (atEnd.current || sentRef.current)) el.scrollTop = el.scrollHeight;
    sentRef.current = false;
  }, [entries]);

  // A button that has nothing left to do goes, and the focus it held moves to what took its place.
  const navigated = useRef<"older" | "newer" | null>(null);
  const startRef = useRef<HTMLParagraphElement>(null);
  const latestRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (!lost) return;
    if (navigated.current === "older" && (history.start || history.unavailable)) startRef.current?.focus();
    if (navigated.current === "newer" && history.end) latestRef.current?.focus();
  }, [history.start, history.unavailable, history.end]);

  const backToLatest = () => {
    navigated.current = null;
    win.latest();
    sentRef.current = true;
    composerRef.current?.focus({ preventScroll: true });
  };

  return (
    // One column no wider than the sheet. An auto column grows to its widest unbreakable child, here the
    // composer's select and its field beside Send, and on a narrow phone at a large interface size it
    // pushed Send, Export and the times past the screen's edge.
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2), fontSize: theme.font.body14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>
        {loaded ? (
          <Older
            state={history}
            startRef={startRef}
            onLoad={() => {
              navigated.current = "older";
              win.older();
            }}
          />
        ) : null}
        {/* Export and Chat only wrap together, so on a narrow phone Chat only never stands alone under the rest. */}
        <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), marginLeft: "auto" }}>
          <Button
            size="sm"
            icon="download"
            iconOnly="fine"
            disabled={preview !== null}
            title={preview ? "Not available while viewing as a player." : "Save the log as a Markdown file."}
            onClick={() => setExporting(true)}
          >
            Export
          </Button>
          {/* A filter of what shows, so a checkbox rather than a switch (docs/design-v1-visual.md 3.7). */}
          <div style={{ flex: "none" }}>
            <Checkbox label="Chat only" checked={chatOnly} onChange={setChatOnly} />
          </div>
        </div>
      </div>
      {entries.length === 0 ? <Empty>No messages yet. Chat, whispers and what happens at the table show here.</Empty> : null}
      <ol ref={listRef} aria-label={apart ? "Log history" : "Log"} style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: theme.space(2) }}>
        {entries.map((entry) => (
          <EntryRow key={entry.id} entry={entry} names={names} levelOf={levelOf} me={me} dm={dm} canUndo={dm && undoable(entry)} />
        ))}
      </ol>
      {apart ? (
        <Newer
          state={history}
          latestRef={latestRef}
          onNewer={() => {
            navigated.current = "newer";
            win.newer();
          }}
          onLatest={backToLatest}
        />
      ) : null}
      {/* What a page did, said once it lands, never how many lines it held. */}
      <span role="status" aria-live="polite" style={visuallyHidden}>
        {history.said}
      </span>
      {exporting ? <ExportLog onClose={() => setExporting(false)} /> : null}
      <Composer
        names={names}
        me={me}
        inputRef={composerRef}
        onSend={(op) => {
          sentRef.current = true;
          // A message goes to the live log, so the reader goes there with it.
          if (apart) win.latest();
          return actions.dispatch(op) !== null;
        }}
      />
    </div>
  );
}

/** The row of the list at the top of its scroll container's view, and where it sits. */
function firstVisibleRow(list: HTMLOListElement | null): { id: string; top: number } | null {
  const el = scrollParent(list);
  if (!list || !el) return null;
  const top = el.getBoundingClientRect().top;
  for (const row of list.children) {
    const box = row.getBoundingClientRect();
    const id = (row as HTMLElement).dataset.logId;
    if (id !== undefined && box.bottom > top) return { id, top: box.top };
  }
  return null;
}

const muted: CSSProperties = { margin: 0, color: theme.color.textMuted, fontSize: theme.font.small, lineHeight: theme.leading.body };

function Failed(props: { state: HistoryState; dir: "older" | "newer" }) {
  const failed = props.state.failed;
  if (failed?.dir !== props.dir) return null;
  return (
    <span role="alert" style={{ color: theme.color.dangerText, fontSize: theme.font.small }}>
      {pageErrorText(failed.dir, failed.error)}
    </span>
  );
}

function Older(props: { state: HistoryState; startRef: Ref<HTMLParagraphElement>; onLoad(): void }) {
  const { state } = props;
  if (state.start) {
    return (
      <p ref={props.startRef} tabIndex={-1} style={muted}>
        This is the start of the log.
      </p>
    );
  }
  if (state.unavailable) {
    return (
      <p ref={props.startRef} tabIndex={-1} style={muted}>
        Older messages are not available on this server yet.
      </p>
    );
  }
  return (
    <>
      <Button size="sm" onClick={props.onLoad} busy={state.loading === "older"} disabled={state.loading === "newer"}>
        {state.loading === "older" ? "Loading…" : "Show older"}
      </Button>
      <Failed state={state} dir="older" />
    </>
  );
}

/** Under a window apart from the live log: the next newer page, and the way back to the live log. */
function Newer(props: { state: HistoryState; latestRef: Ref<HTMLButtonElement>; onNewer(): void; onLatest(): void }) {
  const { state } = props;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>
      {!state.end ? (
        <Button size="sm" onClick={props.onNewer} busy={state.loading === "newer"} disabled={state.loading === "older"}>
          {state.loading === "newer" ? "Loading…" : "Show newer"}
        </Button>
      ) : null}
      <Button ref={props.latestRef} size="sm" variant="primary" onClick={props.onLatest}>
        Back to latest
      </Button>
      <Failed state={state} dir="newer" />
    </div>
  );
}

function time(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function EntryRow(props: { entry: LogEntry; names: LogNames; levelOf: LevelOf; me: string; dm: boolean; canUndo: boolean }) {
  const { entry, names, me } = props;
  if (entry.kind === "event") {
    if (!entry.data) return null;
    return (
      <li data-log-id={entry.id} style={{ display: "flex", alignItems: "center", gap: theme.space(2), color: theme.color.textMuted, fontSize: theme.font.small, lineHeight: theme.leading.body }}>
        {/* A name with no break in it, such as an 80-letter one, wraps anywhere rather than run past a narrow panel, as a chat line does. A line of several rolls puts each on its own line. */}
        <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", whiteSpace: "pre-line" }}><ProficientEvent data={entry.data} names={names} dm={props.dm} levelOf={props.levelOf} /></span>
        {/* The DM takes an HP change back from the log (features section 10). */}
        {props.canUndo ? <TakeBack logId={entry.id} /> : null}
        <time dateTime={entry.at} style={{ flex: "none", fontVariantNumeric: "tabular-nums" }}>
          {time(entry.at)}
        </time>
      </li>
    );
  }
  const whisper = entry.kind === "whisper";
  const from = entry.from !== undefined ? names.members[entry.from] : undefined;
  return (
    <li
      data-log-id={entry.id}
      style={{
        display: "grid",
        gap: theme.space(0.5),
        lineHeight: theme.leading.body,
        ...(whisper ? { borderLeft: `${theme.line.stripe}px solid ${theme.color.accentSoft}`, paddingLeft: theme.space(2) } : {}),
      }}
    >
      {whisper ? (
        <span style={{ fontSize: theme.font.small, color: theme.color.accentSoft, fontStyle: "italic" }}>
          {whisperHeading(entry, names.members, me)}
        </span>
      ) : null}
      <span style={{ display: "flex", alignItems: "baseline", gap: theme.space(2) }}>
        <strong style={{ color: from?.color ?? theme.color.text }}>{memberName(names, entry.from)}</strong>
        <time dateTime={entry.at} style={{ color: theme.color.textMuted, fontSize: theme.font.small, fontVariantNumeric: "tabular-nums" }}>
          {time(entry.at)}
        </time>
      </span>
      <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{entry.text}</span>
    </li>
  );
}

function Composer(props: { names: LogNames; me: string; inputRef: Ref<HTMLInputElement>; onSend(op: NonNullable<ReturnType<typeof messageOp>>): boolean }) {
  const [text, setText] = useState("");
  // A half-typed message keeps the sheet from a swipe's close (docs/design-v1-sheet-swipe.md 4.5).
  useUnsavedInput(text.trim() !== "");
  const [targetId, setTargetId] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const targets = useMemo(() => chatTargets(props.names.members, props.me), [props.names.members, props.me]);
  const chosen = composerTarget(targets, targetId, props.names.members);
  const whisper = chosen.gone || chosen.target.kind !== "all";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const message = text.trim();
    if (!message || chosen.gone) return;
    const op = messageOp(chosen.target, message, props.names.members, props.me);
    if (!op) return setError("There is nobody to whisper to.");
    if (props.onSend(op)) {
      setText("");
      setError(null);
    }
  };

  return (
    <form
      onSubmit={submit}
      style={{
        // Flush on the pane's foot, so no entry shows under it.
        ...stickyPaneFoot(theme.space(2), theme.color.surface),
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        gap: theme.space(2),
        paddingTop: theme.space(2),
        borderTop: `${theme.line.border}px solid ${theme.color.border}`,
      }}
    >
      <Select
        aria-label="Send to"
        error={chosen.gone}
        value={targetId}
        onChange={(e) => {
          setTargetId(e.target.value);
          setError(null);
        }}
      >
        {chosen.gone ? (
          <option value={targetId} disabled>
            To: {chosen.label}
          </option>
        ) : null}
        {targets.map((t) => (
          <option key={targetKey(t.target)} value={targetKey(t.target)}>
            To: {t.label}
          </option>
        ))}
      </Select>
      {chosen.gone ? (
        <span role="alert" style={{ color: theme.color.dangerText, fontSize: theme.font.small }}>
          Whoever this whisper was for can no longer get it. Pick who to send it to.
        </span>
      ) : null}
      <div style={{ display: "flex", gap: theme.space(2) }}>
        <Input
          ref={props.inputRef}
          aria-label={whisper ? "Whisper" : "Message"}
          value={text}
          maxLength={MAX_CHAT}
          enterKeyHint="send"
          placeholder={whisper ? "Whisper" : "Message everyone"}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          style={{ flex: 1, minWidth: 0 }}
        />
        <Button type="submit" variant="primary" disabled={text.trim() === "" || chosen.gone}>
          Send
        </Button>
      </div>
      {error ? (
        <span role="alert" style={{ color: theme.color.dangerText, fontSize: theme.font.small }}>
          {error}
        </span>
      ) : null}
    </form>
  );
}
