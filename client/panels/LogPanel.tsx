import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { LogEntry } from "#shared/model.ts";
import { MAX_CHAT } from "#shared/protocol.ts";
import { Button } from "../components/Button.tsx";
import { Checkbox } from "../components/Checkbox.tsx";
import { Empty } from "../components/Empty.tsx";
import { Input, Select } from "../components/Field.tsx";
import { stickyPaneFoot } from "../components/Sheet.tsx";
import {
  chatTargets,
  composerTarget,
  describeEvent,
  memberName,
  mergeLog,
  messageOp,
  olderCursor,
  targetKey,
  trimmedOff,
  whisperHeading,
  type LogNames,
} from "../features/log/format.ts";
import { canTakeBack } from "../features/encounter/hpLog.ts";
import { usePreview } from "../features/dm/previewContext.ts";
import { ExportLog } from "../features/log/ExportLog.tsx";
import { TakeBack } from "../features/encounter/HpLog.tsx";
import type { PanelProps } from "../features/panels.ts";
import { ApiError } from "../lib/api.ts";
import { olderLogPage } from "./olderLog.ts";
import { useUnsavedInput } from "../lib/sheetSwipe.ts";
import { theme } from "../lib/theme.ts";
import { useRoomActions, useRoomView } from "../state/view.ts";

type Paging =
  | { status: "idle" | "loading"; nextBefore?: string | null }
  | { status: "end" }
  | { status: "unavailable" }
  | { status: "error"; message: string; nextBefore?: string | null };

const EMPTY_LOG: LogEntry[] = [];

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
 * projected for this viewer by the server.
 */
export default function LogPanel(_props: PanelProps) {
  const actions = useRoomActions();
  const roomId = useRoomView((s) => s.roomId);
  const you = useRoomView((s) => s.you);
  const sceneId = useRoomView((s) => s.sceneId);
  const mainLog = useRoomView((s) => s.view?.log ?? EMPTY_LOG);
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

  const [older, setOlder] = useState<LogEntry[]>([]);
  const [paging, setPaging] = useState<Paging>({ status: "idle" });
  const [chatOnly, setChatOnly] = useState(false);
  const [exporting, setExporting] = useState(false);
  // The file comes from the server by this device's own grant, which in "view as a player" is the DM's.
  const preview = usePreview();

  // Once older pages are loaded, entries trimmed off the front of the live
  // log are kept, so no gap opens between the archive and the live tail.
  const prevLog = useRef(log);
  useEffect(() => {
    const prev = prevLog.current;
    prevLog.current = log;
    if (older.length === 0 || prev === log) return;
    const trimmed = trimmedOff(prev, mainLog);
    if (trimmed.length > 0) setOlder((list) => mergeLog(list, trimmed));
  }, [log, mainLog, older.length]);

  // Only the log the room holds in memory can be taken back from, so archived pages offer no Undo.
  const undoable = (entry: LogEntry): boolean => entry.data?.type === "hp" && log.includes(entry) && canTakeBack(names, log, { entry, data: entry.data });

  const entries = useMemo(() => {
    const all = older.length > 0 ? mergeLog(older, log) : log;
    return chatOnly ? all.filter((e) => e.kind !== "event") : all;
  }, [older, log, chatOnly]);

  // Stay at the bottom while the reader is there, and always after sending.
  // The scroll container is the sheet or side panel around this panel, and
  // the composer is sticky at its bottom, so "the end" means scrolled all
  // the way down, never an element scrolled into view under the composer.
  const listRef = useRef<HTMLOListElement>(null);
  const atEnd = useRef(true);
  const sentRef = useRef(false);
  const keepOffset = useRef<{ el: HTMLElement; height: number } | null>(null);
  useEffect(() => {
    const el = scrollParent(listRef.current);
    if (!el) return;
    const onScroll = () => {
      atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  const lastId = entries[entries.length - 1]?.id;
  useLayoutEffect(() => {
    const keep = keepOffset.current;
    if (keep) {
      // Older entries went in above: hold the reader's place instead of jumping.
      keepOffset.current = null;
      keep.el.scrollTop += keep.el.scrollHeight - keep.height;
      return;
    }
    const el = scrollParent(listRef.current);
    if (el && (atEnd.current || sentRef.current)) el.scrollTop = el.scrollHeight;
    sentRef.current = false;
  }, [lastId, entries.length]);

  const loadOlder = async () => {
    const before = olderCursor(mainLog, "nextBefore" in paging ? paging.nextBefore : undefined);
    if (!before) return;
    setPaging({ status: "loading", nextBefore: before });
    try {
      // In "view as a player" the older pages are that player's, as the preview's socket gives the rest (docs/design-v1-per-player-vision.md 7.4).
      const page = await olderLogPage(roomId, before, { sceneId: you?.role === "dm" ? sceneId : null, previewOf: preview?.memberId ?? null });
      const el = scrollParent(listRef.current);
      if (el && page.entries.length > 0) keepOffset.current = { el, height: el.scrollHeight };
      setOlder((list) => mergeLog(page.entries, list));
      setPaging(page.nextBefore === null ? { status: "end" } : { status: "idle", nextBefore: page.nextBefore });
    } catch (err) {
      // A server without the archive route yet answers 404.
      if (err instanceof ApiError && err.status === 404) setPaging({ status: "unavailable" });
      else setPaging({ status: "error", message: err instanceof Error ? err.message : "Could not load older messages.", nextBefore: before });
    }
  };

  return (
    // One column no wider than the sheet. An auto column grows to its widest unbreakable child, here the
    // composer's select and its field beside Send, and on a narrow phone at a large interface size it
    // pushed Send, Export and the times past the screen's edge.
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2), fontSize: theme.font.body14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>
        <Older paging={paging} hasEntries={entries.length > 0} onLoad={() => void loadOlder()} />
        <div style={{ flex: 1 }} />
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
      {entries.length === 0 ? <Empty>No messages yet. Chat, whispers and what happens at the table show here.</Empty> : null}
      <ol ref={listRef} aria-label="Log" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: theme.space(2) }}>
        {entries.map((entry) => (
          <EntryRow key={entry.id} entry={entry} names={names} me={me} dm={you?.role === "dm"} canUndo={you?.role === "dm" && undoable(entry)} />
        ))}
      </ol>
      {exporting ? <ExportLog onClose={() => setExporting(false)} /> : null}
      <Composer
        names={names}
        me={me}
        onSend={(op) => {
          sentRef.current = true;
          return actions.dispatch(op) !== null;
        }}
      />
    </div>
  );
}

function Older(props: { paging: Paging; hasEntries: boolean; onLoad(): void }) {
  const { paging } = props;
  const muted: CSSProperties = { margin: 0, color: theme.color.textMuted, fontSize: theme.font.small, lineHeight: theme.leading.body };
  if (paging.status === "end") return <p style={muted}>This is the start of the log.</p>;
  if (paging.status === "unavailable") return <p style={muted}>Older messages are not available on this server yet.</p>;
  if (!props.hasEntries) return null;
  return (
    <>
      <Button size="sm" onClick={props.onLoad} busy={paging.status === "loading"}>
        {paging.status === "loading" ? "Loading…" : "Show older"}
      </Button>
      {paging.status === "error" ? (
        <span role="alert" style={{ color: theme.color.dangerText, fontSize: theme.font.small }}>
          {paging.message}
        </span>
      ) : null}
    </>
  );
}

function time(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function EntryRow(props: { entry: LogEntry; names: LogNames; me: string; dm: boolean; canUndo: boolean }) {
  const { entry, names, me } = props;
  if (entry.kind === "event") {
    if (!entry.data) return null;
    return (
      <li style={{ display: "flex", alignItems: "center", gap: theme.space(2), color: theme.color.textMuted, fontSize: theme.font.small, lineHeight: theme.leading.body }}>
        {/* A name with no break in it, such as an 80-letter one, wraps anywhere rather than run past a narrow panel, as a chat line does. A line of several rolls puts each on its own line. */}
        <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", whiteSpace: "pre-line" }}>{describeEvent(entry.data, names, props.dm)}</span>
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

function Composer(props: { names: LogNames; me: string; onSend(op: NonNullable<ReturnType<typeof messageOp>>): boolean }) {
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
        ...stickyPaneFoot(theme.space(2)),
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        gap: theme.space(2),
        paddingTop: theme.space(2),
        background: theme.color.surface,
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
