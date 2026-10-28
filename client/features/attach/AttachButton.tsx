import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Scene, Token } from "#shared/model.ts";
import { isHex, sceneGrid } from "#shared/rules/grid.ts";
import { SCROLL_FOR_MORE_PX } from "../../canvas/TokenActionBar.tsx";
import { Button } from "../../components/Button.tsx";
import { Empty } from "../../components/Empty.tsx";
import { useDelayed } from "../../components/Loading.tsx";
import { menuAction } from "../../components/menuKeys.ts";
import { Help, SectionLabel } from "../../components/Panel.tsx";
import { Popover, usePopover, type PopoverSide, type Rect } from "../../components/Popover.tsx";
import { Row, RowChevron } from "../../components/Row.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { HEX_LIMITS } from "../grid/words.ts";
import { useLayoutSize } from "../device/layout.ts";
import { uiScale } from "../device/settings.ts";
import { Portrait } from "../encounter/parts.tsx";
import { SheetDialog } from "../tokens/SheetDialog.tsx";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { displayName } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { letterOf } from "../../state/shortcuts.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { AttachSends, asksControl, attachOp, attachRows, emptyWords, waitsForServer, type AttachRow } from "./list.ts";
import type { AttachViewer } from "./rights.ts";
import { STEER_OPTIONS, steerWords } from "./tags.ts";

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
  const scene = useRoomView((s) => s.view?.scenes[props.token.sceneId]);
  const off = attachOff(scene);
  if (off !== null) return <AttachOff reason={off} />;
  return wide ? <AttachPopover {...props} /> : <AttachSheet token={props.token} />;
}

/** Why Attach is off, or null where it works: riding and carrying are counted on squares until a later phase of hex grids. */
export function attachOff(scene: Pick<Scene, "gridShape"> | undefined): string | null {
  return scene !== undefined && isHex(sceneGrid(scene)) ? HEX_LIMITS.attach : null;
}

/** The button on a hex scene: still says Attach, takes no tap, and gives its reason to a screen reader through a hidden line it points at. */
export function AttachOff(props: { reason: string }) {
  const reasonId = useId();
  return (
    <>
      <Button size="sm" disabled aria-describedby={reasonId} style={{ flex: "1 1 auto" }}>
        Attach
      </Button>
      <span id={reasonId} style={VISUALLY_HIDDEN}>
        {props.reason}
      </span>
    </>
  );
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
        expanded={open}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setSide(r.top + r.height / 2 > window.innerHeight / 2 ? "above" : "below");
          onClick(e);
        }}
        // It stands only in the bar's play row, whose buttons grow to share their line (canvas/TokenActionBar.tsx ButtonRow).
        style={{ flex: "1 1 auto" }}
      >
        Attach
      </Button>
      <Popover handle={handle} side={side} bound={viewportBound} title={`Attach ${displayName(props.token)}`}>
        <AttachList token={props.token} capped onDone={() => handle.close("pick")} />
      </Popover>
    </>
  );
}

function AttachSheet(props: { token: Token }) {
  const opener = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button ref={opener} size="sm" aria-haspopup="dialog" expanded={open} onClick={() => setOpen(true)} style={{ flex: "1 1 auto" }}>
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
const ROW_DATA = { [ROW_ATTR]: "" };

/**
 * The rows, each a card `Row` with a portrait and its sentence, which wraps
 * rather than cut, so "Get on Treasure chest" reads whole on a small phone
 * (docs/design-v1-look-pass-2.md 2.5). Ride opens its one more question
 * under its row, Controlled or Independent, with Ride under it, and ends
 * in the chevron every unfolding row has. The rows take the keys every
 * list does (components/menuKeys.ts): Down and Up move and wrap, Home and
 * End go to the ends, across the near rows and "Farther away" alike, and
 * Enter and Space pick. A row that waits for the server (list.ts
 * waitsForServer) shows busy after the room's usual 200 ms and takes no
 * second tap meanwhile.
 *
 * `capped` is the pop-up's: it holds the list to a side panel's width. A
 * sheet and the card from 600 px have widths of their own, which the rows
 * span.
 */
export function AttachList(props: { token: Token; capped?: boolean; onDone(): void }) {
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
  const fartherId = useId();
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

  const cap = props.capped ? { maxWidth: theme.layout.sidePanelWidth } : null;
  if (rows.length === 0) {
    const [first, ...more] = emptyWords(viewer.role);
    return (
      <div style={{ display: "grid", gap: theme.space(1), ...cap }}>
        <Empty>{first}</Empty>
        {more.map((line) => (
          <Help key={line}>{line}</Help>
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
    const asks = asksControl(row);
    return (
      <div key={row.key} style={{ display: "grid", gap: theme.space(1) }}>
        <Row
          title={row.text}
          wrapTitle
          leading={<Portrait entry={{ tokenId: row.otherId }} size={32} />}
          trailing={asks ? <RowChevron open={open} /> : undefined}
          expanded={asks ? open : undefined}
          busy={rowBusy && busy}
          data={ROW_DATA}
          onClick={() => {
            if (asks) setRiding(open ? null : row.key);
            else send(row, false);
          }}
        />
        {open ? (
          // The margin keeps Ride clear of the fade that says "Scroll for more" where more rows follow.
          <div ref={askRef} style={{ display: "grid", gap: theme.space(1), paddingLeft: theme.space(2), scrollMarginBottom: SCROLL_FOR_MORE_PX }}>
            <Segmented<"controlled" | "independent">
              label={`How ${holderName(row)} moves`}
              value={steer}
              options={STEER_OPTIONS}
              onChange={setSteer}
              even
              description={steerWords(steer === "controlled", holderName(row), displayName(view?.tokens[row.carriedId] ?? props.token))}
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
    <div ref={listRef} onKeyDown={onKeyDown} style={{ display: "grid", gap: theme.space(1), ...(props.capped ? { minWidth: 240, ...cap } : null) }}>
      {near.map(renderRow)}
      {far.length > 0 ? (
        <div role="group" aria-labelledby={fartherId} style={{ display: "grid", gap: theme.space(1), marginTop: near.length > 0 ? theme.space(2) : 0 }}>
          <SectionLabel id={fartherId}>Farther away</SectionLabel>
          {far.map(renderRow)}
        </div>
      ) : null}
    </div>
  );
}
