import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Token } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { useDelayed } from "../../components/Loading.tsx";
import { menuAction } from "../../components/menuKeys.ts";
import { sectionLabelLook } from "../../components/Panel.tsx";
import { Popover, usePopover, type PopoverSide, type Rect } from "../../components/Popover.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { useLayoutSize } from "../device/layout.ts";
import { uiScale } from "../device/settings.ts";
import { Portrait } from "../encounter/parts.tsx";
import { SheetDialog } from "../tokens/SheetDialog.tsx";
import { displayName } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { letterOf } from "../../state/shortcuts.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { AttachSends, asksControl, attachOp, attachRows, emptyWords, waitsForServer, type AttachRow } from "./list.ts";
import type { AttachViewer } from "./rights.ts";

/**
 * Attach in the token's bar (docs/design-v1-attach.md 4.1): a popover from
 * 900 px up, a bottom sheet on a phone, listing what the selected token can
 * ride, carry or drag within reach (list.ts). `onOpen` hears whether the
 * popover is open, so the bar can stand over the notices while it is
 * (docs/design-v1-tool-options.md 7.6).
 */
export function AttachButton(props: { token: Token; onOpen?(open: boolean): void }) {
  const layout = useLayoutSize();
  const wide = layout.width >= theme.layout.wideMinWidth;
  return wide ? <AttachPopover {...props} /> : <AttachSheet token={props.token} />;
}

function AttachPopover(props: { token: Token; onOpen?(open: boolean): void }) {
  const handle = usePopover({ kind: "dialog" });
  // Opened toward the larger room: a bar docked low opens it above, one hung high below.
  const [side, setSide] = useState<PopoverSide>("above");
  const { onOpen } = props;
  const open = handle.open;
  useEffect(() => {
    onOpen?.(open);
  }, [open, onOpen]);
  useEffect(() => () => onOpen?.(false), [onOpen]);
  const { onClick, ...anchor } = handle.anchorProps;
  return (
    <>
      <Button
        size="sm"
        {...anchor}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setSide(r.top + r.height / 2 > window.innerHeight / 2 ? "above" : "below");
          onClick(e);
        }}
        style={{ flex: "none" }}
      >
        Attach
      </Button>
      <Popover handle={handle} side={side} bound={viewportBound} title="Attach">
        <AttachList token={props.token} onDone={() => handle.close("pick")} />
      </Popover>
    </>
  );
}

function AttachSheet(props: { token: Token }) {
  const opener = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button ref={opener} size="sm" aria-haspopup="dialog" expanded={open} onClick={() => setOpen(true)} style={{ flex: "none" }}>
        Attach
      </Button>
      {open ? (
        <SheetDialog title={`Attach ${displayName(props.token)}`} opener={opener} onClose={() => setOpen(false)} width={theme.layout.dialog.sm}>
          <AttachList token={props.token} onDone={() => setOpen(false)} />
        </SheetDialog>
      ) : null}
    </>
  );
}

function viewportBound(): Rect {
  const scale = uiScale();
  return { left: 0, top: 0, right: window.innerWidth / scale, bottom: window.innerHeight / scale };
}

const ROW_ATTR = "data-attach-row";

/**
 * The rows, each a portrait and its sentence. Ride opens its one more
 * question under its row, Controlled or Independent, with Ride under it.
 * The rows take the keys every list does (components/menuKeys.ts): Down
 * and Up move and wrap, Home and End go to the ends, Enter and Space pick.
 * A row that waits for the server (list.ts waitsForServer) shows busy
 * after the room's usual 200 ms and takes no second tap meanwhile.
 */
function AttachList(props: { token: Token; onDone(): void }) {
  const actions = useRoomActions();
  const you = useRoomView((s) => s.you);
  const view = useRoomView((s) => s.view);
  const viewer = useMemo<AttachViewer>(() => ({ role: you?.role ?? "player", memberId: you?.memberId ?? null }), [you]);
  const rows = useMemo(() => (view ? attachRows(view, viewer, props.token.id) : []), [view, viewer, props.token.id]);
  const [riding, setRiding] = useState<string | null>(null);
  const [steer, setSteer] = useState<"controlled" | "independent">("controlled");
  const sends = useRef(new AttachSends());
  const [pending, setPending] = useState<string | null>(null);
  const busy = useDelayed(pending !== null);
  const listRef = useRef<HTMLDivElement>(null);
  /*
   * A pop-up keeps the size it opened with (components/Popover.tsx), so a
   * Ride row near its foot opens its question and its Ride past the box,
   * under "Scroll for more". They scroll into view as the row opens.
   */
  const askRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (riding !== null) askRef.current?.scrollIntoView({ block: "nearest" });
  }, [riding]);
  const done = useRef(props.onDone);
  done.current = props.onDone;
  // A list that unmounts with an answer still on its way hears nothing more of it. A fresh one on each mount, as React may mount it twice.
  useEffect(() => {
    const machine = new AttachSends();
    sends.current = machine;
    return () => machine.gone();
  }, []);

  const send = (row: AttachRow, controlled: boolean) => {
    if (!view) return;
    const waits = waitsForServer(viewer, view, row, controlled);
    if (!sends.current.tap(row.key, waits)) return;
    const op = attachOp(row, controlled);
    if (!waits) {
      if (actions.dispatch(op) !== null) done.current();
      return;
    }
    setPending(row.key);
    const n = actions.dispatch(op, {
      onAnswer: (answer) => {
        const next = sends.current.answer(row.key, answer);
        if (next === null) return;
        setPending(null);
        // A refusal says why in the room's toast and leaves the list open for another choice.
        if (next === "close") done.current();
      },
    });
    if (n === null) {
      sends.current.unsent(row.key);
      setPending(null);
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target;
    if (!(target instanceof HTMLElement) || !target.hasAttribute(ROW_ATTR)) return;
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>(`[${ROW_ATTR}]`) ?? [])];
    const action = menuAction({ key: e.key, letter: letterOf(e.nativeEvent), ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey }, buttons.indexOf(target as HTMLButtonElement), buttons.length, false);
    // Enter and Space are the row button's own press. A letter has no typeahead here, and goes on to the room.
    if (action.type !== "focus") return;
    e.preventDefault();
    buttons[action.index]?.focus();
  };

  if (rows.length === 0) {
    return (
      <div style={{ display: "grid", gap: theme.space(1), maxWidth: 320, color: theme.color.textMuted, fontSize: theme.font.body14 }}>
        {emptyWords(viewer.role).map((line) => (
          <p key={line} style={{ margin: 0 }}>
            {line}
          </p>
        ))}
      </div>
    );
  }

  const near = rows.filter((r) => !r.farther);
  const far = rows.filter((r) => r.farther);
  const holderName = (row: AttachRow) => displayName(view?.tokens[row.holderId] ?? props.token);
  const renderRow = (row: AttachRow) => {
    const open = riding === row.key;
    const rowBusy = pending === row.key;
    return (
      <div key={row.key} style={{ display: "grid", gap: theme.space(1) }}>
        <button
          type="button"
          {...{ [ROW_ATTR]: "" }}
          aria-expanded={asksControl(row) ? open : undefined}
          aria-busy={rowBusy && busy ? true : undefined}
          onClick={() => {
            if (asksControl(row)) setRiding(open ? null : row.key);
            else send(row, false);
          }}
          style={rowStyle(open)}
        >
          <Portrait entry={{ tokenId: row.otherId }} size={32} />
          <span style={{ flex: "1 1 auto", minWidth: 0, overflowWrap: "anywhere" }}>{row.text}</span>
        </button>
        {open ? (
          // The margin keeps Ride clear of the fade that says "Scroll for more" where more rows follow.
          <div ref={askRef} style={{ display: "grid", gap: theme.space(1), paddingLeft: theme.space(2), scrollMarginBottom: theme.space(12) }}>
            <Segmented<"controlled" | "independent">
              label={`How ${holderName(row)} moves`}
              value={steer}
              options={[
                { value: "controlled", label: `Controlled: moves on ${displayName(view?.tokens[row.carriedId] ?? props.token)}'s turn` },
                { value: "independent", label: "Independent: keeps its own turn" },
              ]}
              onChange={setSteer}
              wrap
            />
            <Button size="sm" variant="primary" busy={rowBusy && busy} onClick={() => send(row, steer === "controlled")} style={{ justifySelf: "start" }}>
              Ride
            </Button>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div ref={listRef} onKeyDown={onKeyDown} style={{ display: "grid", gap: theme.space(1), minWidth: 240, maxWidth: 360 }}>
      {near.map(renderRow)}
      {far.length > 0 ? (
        <>
          <div style={{ ...sectionLabelLook(), marginTop: near.length > 0 ? theme.space(2) : 0 }}>Farther away</div>
          {far.map(renderRow)}
        </>
      ) : null}
    </div>
  );
}

function rowStyle(open: boolean) {
  return {
    display: "flex",
    alignItems: "center",
    gap: theme.space(2),
    minHeight: theme.touch,
    width: "100%",
    padding: `${theme.space(1)}px ${theme.space(2)}px`,
    border: `${theme.line.border}px solid ${open ? theme.color.accent : theme.color.border}`,
    borderRadius: theme.radius.md,
    background: open ? theme.color.accentTint : theme.color.surfaceRaised,
    color: theme.color.text,
    font: "inherit",
    fontSize: theme.font.input,
    textAlign: "left" as const,
    cursor: "pointer",
  };
}
