import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type Ref, type RefObject } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { clockNow } from "#shared/calendar.ts";
import { Button } from "../components/Button.tsx";
import { Icon } from "../components/Icon.tsx";
import { Loading, useDelayed } from "../components/Loading.tsx";
import { Menu, type MenuItem, type MenuPickResult, type MenuSection } from "../components/Menu.tsx";
import { Popover, usePopover, type PopoverHandle, type Rect } from "../components/Popover.tsx";
import { addsWords, useTooltip } from "../components/Tooltip.tsx";
import { ClockSteps } from "../features/clock/StepButtons.tsx";
import { chipName, chipText } from "../features/clock/words.ts";
import { uiScale } from "../features/device/settings.ts";
import { currentFocus, subscribeFocus } from "../features/dm/camera.ts";
import { usePreview } from "../features/dm/previewContext.ts";
import { viewAsSlot } from "../features/dm/viewAs.tsx";
import { handoutDraftSlot, withPick } from "../features/handouts/draft.ts";
import { viewerPagesOf } from "../features/handouts/handouts.ts";
import { ShowHandoutForm } from "../features/handouts/HandoutsSection.tsx";
import { HandoutViewer } from "../features/handouts/HandoutViewer.tsx";
import { JobBlock } from "../features/handouts/pdf/JobBlock.tsx";
import { loadRecent, recentHandoutsSlot, rememberShow } from "../features/handouts/recent.ts";
import { useLibrary } from "../features/images/library.ts";
import { movingPlayersTo } from "../features/scenes/movePlayers.ts";
import { useMovePlayers } from "../features/scenes/useMovePlayers.ts";
import { NowPlayerDialog } from "../features/sound/mini/NowChip.tsx";
import { characterPageSlot, openCharacterPage } from "../features/tokens/characterPage.ts";
import { SheetDialog } from "../features/tokens/SheetDialog.tsx";
import { XCardCard } from "../features/xcard/XCardButton.tsx";
import type { AssetRow } from "../lib/api.ts";
import { theme } from "../lib/theme.ts";
import { barDockSlot } from "../canvas/barDock.ts";
import { useUiScale } from "../features/device/settings.ts";
import { scopeSlot, useRoomScope, useScoped } from "../state/scope.ts";
import { useAssets, useRoomActions, useRoomUi, useRoomView } from "../state/view.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { onPlayersScene, openFloor } from "#shared/rules/floors.ts";
import {
  anywayId,
  asDrawn,
  blackoutItems,
  cancelId,
  dmMenuSections,
  itemsOf,
  youMenuSections,
  type ChipAnswer,
  type ChipAsk,
  type ChipEnv,
  type ChipItem,
  type ChipOpen,
  type ChipSection,
  type DmMenuView,
} from "./chipMenus.ts";
import { CHIP_WORDS, youChipName } from "./chipWords.ts";
import { memberDotStyle } from "./onBoard.ts";

/*
 * The top bar's chips that open something (docs/design/design-v1-qol.md 4,
 * C1, C2, C4, C5 and C7): the DM chip and its DM menu, Players see black and
 * its Blackout menu, the DM's clock chip and its steps, a player's chip and
 * its You menu, and the dialogs their items open. The menus' contents and
 * what each item does are chipMenus.ts's. This file draws them, keeps a
 * menu's asking and answers, and opens what an item opens.
 */

/** The pill's height inside the chip's 44 px target (docs/design/design-v1-visual.md 3.2). */
const CHIP_PX = 28;

function viewportBound(): Rect {
  const scale = uiScale();
  return { left: 0, top: 0, right: window.innerWidth / scale, bottom: window.innerHeight / scale };
}

/**
 * A chip that opens a menu or a popover (design-v1-qol.md 4, The chips' look, D-261106-129): the
 * 28 px pill in a 44 px tall target, its words, then a caret that says it
 * opens. The round forms, a member's dot or the crossed eye, stand where
 * the bar is shortest, so their caret is smaller and tighter: 32 px
 * against the plain dot's 28, as design-v1-qol.md 4, The chips' look, has it. Where its words are
 * cut, `tip` shows on hover and keyboard focus (useTooltip).
 */
export function ChipButton(props: {
  anchor: PopoverHandle["anchorProps"];
  label: string;
  tip?: string;
  outline: string;
  color?: string;
  round?: boolean;
  /** A round form without its caret, its mark centered at the dot's width: the crossed eye at the top bar's last step (topBarFit.ts eyeSlim). */
  slim?: boolean;
  /** A player's name gives way to the bar's buttons, cut with an ellipsis, down to its dot (features section 13). */
  shrink?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  data?: Readonly<Record<`data-${string}`, string>>;
  children: ReactNode;
}) {
  const { ref: anchorRef, ...anchor } = props.anchor;
  const tooltip = useTooltip(props.tip ?? props.label, { describes: addsWords(props.tip, props.label) });
  const { buttonRef } = props;
  const ref = useCallback(
    (el: HTMLButtonElement | null) => {
      anchorRef(el);
      if (typeof buttonRef === "function") buttonRef(el);
      else if (buttonRef) buttonRef.current = el;
    },
    [anchorRef, buttonRef],
  );
  return (
    <>
      <button
        type="button"
        {...props.data}
        {...(props.tip ? tooltip.anchor() : null)}
        {...anchor}
        ref={ref}
        aria-label={props.label}
        style={{
          flex: props.shrink ? "0 1 auto" : "none",
          minWidth: props.shrink ? 32 : undefined,
          display: "flex",
          alignItems: "center",
          height: theme.touch,
          padding: 0,
          background: "transparent",
          border: 0,
          color: props.color ?? theme.color.text,
          cursor: "pointer",
          font: "inherit",
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: props.round ? 1 : theme.space(1),
            minWidth: 0,
            boxSizing: "border-box",
            height: CHIP_PX,
            padding: props.slim ? `0 ${SLIM_PAD}px` : props.round ? `0 1px 0 ${theme.space(1.5)}px` : `0 ${theme.space(1.5)}px 0 ${theme.space(2.5)}px`,
            borderRadius: theme.radius.pill,
            border: `${theme.line.border}px solid ${props.outline}`,
            fontSize: theme.font.small,
            fontWeight: theme.weight.bold,
            whiteSpace: "nowrap",
          }}
        >
          {props.children}
          {props.slim ? null : <Icon name="caret" size={props.round ? 14 : "sm"} />}
        </span>
      </button>
      {props.tip ? tooltip.tip : null}
    </>
  );
}

/** The slim eye's sides: what the dot's form gives its 8 px dot, 1 px and 14 px caret around a 16 px mark, half each side, so the two forms are one width. */
const SLIM_PAD = (theme.space(1.5) + 8 + 1 + 14 + 1 - theme.icon.sm) / 2;

/** The member's color, as the dot in a chip. */
function ChipDot(props: { color: string }) {
  return <span aria-hidden style={memberDotStyle(props.color, 8)} />;
}

// ---------------------------------------------------------------- what an item opens

/** A chip dialog open in the room, and where focus goes back when it closes: the chip that opened it. */
type ChipDialog = { what: Extract<ChipOpen, { t: "handout" | "time" | "xcard" | "nowPlaying" }>; returnFocus: HTMLElement | null };

/** The one chip dialog open in this Room, opened by a menu item or the search's twin of it, drawn by ChipDialogs. */
export const chipDialogSlot = scopeSlot(() => createStore<{ open: ChipDialog | null }>(() => ({ open: null })));

/**
 * The room as a menu item's run reaches it (chipMenus.ts ChipEnv), for the
 * chips' menus and for the search, which runs the same items. What an
 * item opens hands focus back to `returnFocus` once it closes: the chip,
 * or the search's field.
 */
export function useChipEnv(returnFocus: () => HTMLElement | null): ChipEnv {
  const actions = useRoomActions();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const mover = useMovePlayers();
  const roomId = useRoomView((s) => s.roomId);
  const recent = useScoped(recentHandoutsSlot);
  const dialogs = useScoped(chipDialogSlot);
  const viewAs = useScoped(viewAsSlot);
  const latest = useRef(returnFocus);
  latest.current = returnFocus;
  return useMemo<ChipEnv>(
    () => ({
      actions,
      notify: (text, tone) => ui.notify(text, tone),
      moveRoom: mover.room,
      open(what) {
        const back = latest.current();
        if (what.t === "viewAs") viewAs.open({ memberId: what.memberId, name: what.name, returnFocus: back });
        else if (what.t === "sheet") {
          openCharacterPage(scope.get(characterPageSlot), what.characterId);
          ui.openPanel("characters");
        } else dialogs.setState({ open: { what, returnFocus: back } });
      },
      focus: () => currentFocus(scope),
      remember(show) {
        loadRecent(recent, roomId);
        rememberShow(recent, show, Date.now());
      },
    }),
    [actions, ui, scope, mover.room, roomId, recent, dialogs, viewAs],
  );
}

/**
 * The dialogs a chip's item opens: Show a handout… (C4), the clock's steps
 * from the DM menu (C5), a player's X-card (C7), and the Now playing
 * chip's player as a card or a sheet, opened by the chip under 900 px and
 * by the DM menu's Now playing while the chip is off the bar
 * (docs/design/design-v1-sound-layout.md 5.3). One at a time, in the
 * room's scope, so the search's twins open the same ones.
 */
export function ChipDialogs(props: { openTime(): void }) {
  const store = useScoped(chipDialogSlot);
  const open = useStore(store, (s) => s.open);
  const opener = useRef<HTMLElement | null>(null);
  // Kept through the render that closes the dialog, whose close hands focus back to it.
  if (open) opener.current = open.returnFocus;
  const close = useCallback(() => store.setState({ open: null }), [store]);
  // A Room that ends while one is open leaves none behind for the next.
  useEffect(() => close, [close]);
  if (!open) return null;
  if (open.what.t === "handout") return <HandoutDialog opener={opener} onClose={close} />;
  if (open.what.t === "time") {
    return (
      <SheetDialog title={CHIP_WORDS.timeTitle} opener={opener} onClose={close} width={theme.layout.dialog.sm}>
        <TimeSteps
          onOpenTime={() => {
            close();
            props.openTime();
          }}
        />
      </SheetDialog>
    );
  }
  if (open.what.t === "xcard") return <XCardSheet opener={opener} onClose={close} />;
  return <NowPlayerDialog opener={opener} onClose={close} />;
}

/** A player's X-card from their You menu: the Menu panel's small card, in a sheet of its own (design-v1-qol.md 4, C7). */
function XCardSheet(props: { opener: RefObject<HTMLElement | null>; onClose(): void }) {
  const words = useRef<HTMLParagraphElement>(null);
  // The card's words take focus as it opens, never the X, as in the Menu panel, so a second Enter reads what the X does.
  useLayoutEffect(() => words.current?.focus(), []);
  return (
    <SheetDialog title="X-card" opener={props.opener} onClose={props.onClose} width={theme.layout.dialog.sm}>
      <XCardCard words={words} onCancel={props.onClose} onSent={() => {}} closeSheet={props.onClose} />
    </SheetDialog>
  );
}

/** What the handout dialog's viewer shows: a picked document, or a picked image. */
type DialogViewing = { kind: "doc"; id: string; opener: HTMLElement | null } | { kind: "image"; asset: AssetRow; title: string; opener: HTMLElement | null };

/**
 * Show a handout… from the DM menu (design-v1-qol.md 4, C4, D-261106-176): the
 * Handouts panel's own form in a dialog, a card on a computer and a sheet
 * on a phone, sharing its draft, with the library listed at once and a
 * PDF's upload block above it.
 */
function HandoutDialog(props: { opener: RefObject<HTMLElement | null>; onClose(): void }) {
  const members = useRoomView((s) => s.view?.members);
  const docs = useRoomView((s) => s.view?.handoutDocs);
  const assets = useAssets();
  const draft = useScoped(handoutDraftSlot);
  const formRef = useRef<HTMLDivElement>(null);
  const unused = useRef<HTMLButtonElement>(null);
  const [viewing, setViewing] = useState<DialogViewing | null>(null);
  const viewOpener = useRef<HTMLElement | null>(null);
  viewOpener.current = viewing?.opener ?? null;
  const doc = viewing?.kind === "doc" ? docs?.[viewing.id] : undefined;
  const url = (id: string, variant: "full" | "thumb") => assets.url(id, variant);
  const viewer = doc
    ? { title: doc.title, pages: viewerPagesOf(doc.title, doc.pages, url), showing: `doc:${doc.id}` }
    : viewing?.kind === "image"
      ? { title: viewing.title, pages: viewerPagesOf(viewing.title, [{ assetId: viewing.asset.id, width: viewing.asset.width, height: viewing.asset.height }], url), showing: `image:${viewing.asset.id}` }
      : null;
  return (
    <ShowHandoutForm
      members={members ?? {}}
      docs={docs ?? {}}
      opener={unused}
      formRef={formRef}
      onViewDoc={(id, opener) => setViewing({ kind: "doc", id, opener })}
      onViewImage={(asset, title, opener) => setViewing({ kind: "image", asset, title, opener })}
      dialog={{
        onClose: props.onClose,
        frame: ({ body, buttons }) => (
          <SheetDialog title={CHIP_WORDS.handoutDialogTitle} opener={props.opener} onClose={props.onClose} width={theme.layout.dialog.sm} footer={buttons}>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(3) }}>
              <JobBlock
                onLeave={() => formRef.current?.querySelector<HTMLElement>("button, input")?.focus()}
                onShow={(docId) => draft.setState(withPick(draft.getState(), { kind: "doc", docId }, docs?.[docId]?.title ?? ""))}
                onView={(id, opener) => setViewing({ kind: "doc", id, opener })}
              />
              {body}
            </div>
            {viewer ? <HandoutViewer title={viewer.title} pages={viewer.pages} showing={viewer.showing} onClose={() => setViewing(null)} backClose opener={viewOpener} /> : null}
          </SheetDialog>
        ),
      }}
    />
  );
}

/** The DM clock's date line, "Day 4, 8:00 PM, Night": the chip's name less its "Time: ", which the popover's title says. */
function dateLine(t: number, clock: Parameters<typeof chipName>[1]): string {
  return chipName(t, clock).replace(/^Time: /, "");
}

/**
 * The clock's quick steps (design-v1-qol.md 4, C5): the date line, the four steps two
 * by two, and Open Time for the rest. In the DM clock chip's popover, and
 * in a sheet from the DM menu's Time while the chip gave way.
 */
export function TimeSteps(props: { onOpenTime(): void }) {
  const clock = useRoomView((s) => s.view?.clock);
  const encounter = useRoomView((s) => s.view?.encounter);
  if (!clock) return null;
  const now = clockNow(clock, encounter);
  return (
    <div data-chip-time="" style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
      <div style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong }}>{dateLine(now, clock)}</div>
      <div role="group" aria-label="Move the clock on" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(120px, 1fr))", gap: theme.space(2) }}>
        <ClockSteps now={now} clock={clock} />
      </div>
      <Button variant="quiet" onClick={props.onOpenTime} style={{ justifySelf: "start" }}>
        {CHIP_WORDS.openTime}
      </Button>
    </div>
  );
}

/** Tells the top bar while a chip's popover is open, so the bar stands over the notices with it (docs/design/design-v1-tool-options.md 7.6). */
function useRaise(open: boolean, onOpen: ((open: boolean) => void) | undefined): void {
  useLayoutEffect(() => onOpen?.(open), [open, onOpen]);
  useLayoutEffect(() => () => onOpen?.(false), [onOpen]);
}

/**
 * Tells the page where an open popover's box ends (viewport px, null once closed or
 * gone), as it opens and whenever its size or place changes. The notices over the map
 * start below it, so a toast such as "Blessed ended on Thorn." never stands under the
 * clock's steps while a second step is taken (docs/design/design-v1-calendar-c2c3.md 9).
 */
function useClearance(open: boolean, box: RefObject<HTMLElement | null>, report: ((bottom: number | null) => void) | undefined): void {
  useEffect(() => {
    if (!open || !report) return;
    let last: number | null = null;
    let frame = 0;
    let stop = () => {};
    const measure = () => {
      const el = box.current;
      const r = el?.getBoundingClientRect();
      // Unplaced, the box has no size yet: the observers report it again once it has.
      const bottom = r && r.height > 0 ? r.bottom : null;
      if (bottom !== last) report((last = bottom));
    };
    // The box is drawn after the open state commits, so it is watched from the first frame that has it.
    const attach = () => {
      const el = box.current;
      if (!el) {
        frame = requestAnimationFrame(attach);
        return;
      }
      measure();
      const resize = new ResizeObserver(measure);
      resize.observe(el);
      // Placement moves the box with its style, which a resize observer does not hear.
      const style = new MutationObserver(measure);
      style.observe(el, { attributes: true, attributeFilter: ["style"] });
      stop = () => {
        resize.disconnect();
        style.disconnect();
      };
    };
    attach();
    return () => {
      cancelAnimationFrame(frame);
      stop();
      report(null);
    };
  }, [open, box, report]);
}

/**
 * The DM's clock chip from 900 px up (design-v1-qol.md 4, C5, D-261106-126): its
 * words and a caret, opening the quick steps under it, which stay open
 * for a second step, so moving the clock no longer swaps the side panel's
 * tab. Open Time opens the Time panel. A player's clock chip still opens
 * Time (features/clock/ClockChip.tsx).
 */
export function DmClockChip(props: { onOpenTime(): void; onOpen?(open: boolean): void }) {
  const pop = usePopover({ kind: "dialog" });
  useRaise(pop.open, props.onOpen);
  const dock = useScoped(barDockSlot);
  const zoom = useUiScale();
  const report = useCallback(
    (bottom: number | null) => {
      // The dock reads the map's own px: from the page's top and in the chrome's zoom, as the lasting notices are.
      const top = pop.anchor.current?.closest("[data-rvtt-topbar]")?.getBoundingClientRect().top ?? 0;
      dock.setState({ popoverFoot: bottom === null ? null : (bottom - top) / zoom });
    },
    [dock, pop.anchor, zoom],
  );
  useClearance(pop.open, pop.box, report);
  const clock = useRoomView((s) => s.view?.clock);
  const encounter = useRoomView((s) => s.view?.encounter);
  if (!clock) return null;
  const now = clockNow(clock, encounter);
  return (
    <>
      <ChipButton anchor={pop.anchorProps} label={chipName(now, clock)} outline={theme.color.border} data={{ "data-chip": "clock" }}>
        {chipText(now, clock.calendar)}
      </ChipButton>
      <Popover handle={pop} side="below" flip bound={viewportBound} title={CHIP_WORDS.timeTitle}>
        <TimeSteps
          onOpenTime={() => {
            pop.close("pick");
            props.onOpenTime();
          }}
        />
      </Popover>
    </>
  );
}

// ---------------------------------------------------------------- a menu's asking and answers

/**
 * What an open chip menu keeps of its items (design-v1-qol.md 4, C2's move, D-261106-136):
 * an item that asked first, armed as its anyway item; the words of a
 * refusal said in place; and the item focus moves to. Kept by the chip,
 * not the menu, since an answer may come after the menu closed, and
 * cleared as it closes.
 */
function useChipHost(handle: PopoverHandle) {
  const ui = useRoomUi();
  const [ask, setAsk] = useState<ChipAsk | null>(null);
  const [said, setSaid] = useState<ReadonlyMap<string, string>>(new Map());
  const [target, setTarget] = useState<string | null>(null);
  /*
   * The drawn items' ids and lines, as the popover's content key: the box
   * is placed once as it opens and lets its content scroll after, so an
   * item that arms or answers, growing a line and Cancel, places it again
   * to stand whole (Popover.tsx contentKey).
   */
  const [shape, setShape] = useState("");
  // What the open menu draws now, for an answer that comes later: in place while its item is there, else a toast.
  const drawn = useRef<{ open: boolean; ids: ReadonlySet<string> }>({ open: false, ids: new Set() });
  const open = handle.open;
  useEffect(() => {
    if (open) return;
    drawn.current = { open: false, ids: new Set() };
    setAsk(null);
    setSaid(new Map());
    setTarget(null);
  }, [open]);

  const settle = (id: string, answer: ChipAnswer) => {
    if (answer.t === "taken") {
      // Accepted: the menu closes, and focus goes back to its chip.
      if (drawn.current.open) handle.close("pick");
      return;
    }
    if (drawn.current.open && drawn.current.ids.has(id)) setSaid((m) => new Map(m).set(id, answer.words));
    else ui.notify(answer.words, "error");
  };

  const pick = (env: ChipEnv, items: readonly ChipItem[], id: string): MenuPickResult => {
    const item = items.find((i) => i.id === id);
    if (!item) return undefined;
    if (ask && id === cancelId(ask.id)) {
      setAsk(null);
      setTarget(ask.id);
      return "stay";
    }
    const base = ask && id === anywayId(ask.id) ? ask.id : id;
    setAsk(null);
    if (said.has(base)) {
      const next = new Map(said);
      next.delete(base);
      setSaid(next);
    }
    const result = item.run(env);
    if (result.t === "ask") {
      setAsk({ id: base, warning: result.warning, anyway: result.anyway });
      setTarget(anywayId(base));
      return "stay";
    }
    if (result.t === "wait") {
      setTarget(base);
      void result.answer.then((answer) => settle(base, answer));
      return "stay";
    }
    return undefined;
  };

  return { ask, said, target, drawn, pick, shape, setShape };
}

type ChipHost = ReturnType<typeof useChipHost>;

/** An item's line under its words: the warning in the warning color, a refusal in red, or the shared wait. */
function underLine(item: ChipItem): ReactNode {
  const under = item.under;
  if (!under) return null;
  if (under.tone === "busy") return <Loading small delay={0} live={false} text={under.text} />;
  return <span style={{ fontSize: theme.font.small, fontWeight: theme.weight.regular, lineHeight: theme.leading.body, color: under.tone === "warning" ? theme.color.warning : theme.color.dangerText }}>{under.text}</span>;
}

/** The shared Menu's items for chipMenus.ts's: a line under the words goes in the item's content, named by its title, its words heard as its description. */
export function menuItemOf(item: ChipItem): MenuItem {
  const base: MenuItem = {
    id: item.id,
    title: item.title,
    kind: item.role,
    ...(item.role !== "action" ? { checked: item.checked === true } : {}),
    ...(item.note !== undefined ? { note: item.note } : {}),
    ...(item.description !== undefined ? { description: item.description } : {}),
    ...(item.disabled ? { disabled: true } : {}),
    ...(item.busy ? { busy: true } : {}),
    data: { "data-chip-item": item.id },
  };
  if (!item.under) return base;
  return {
    ...base,
    // A busy item says it waits in its name. Otherwise the line is the item's description, and its name stays its title.
    ...(item.under.tone !== "busy" ? { label: item.title } : {}),
    content: (
      <span style={{ flex: "1 1 auto", minWidth: 0, display: "grid", gap: theme.space(0.5), padding: `${theme.space(1.5)}px 0`, whiteSpace: "normal", overflowWrap: "break-word", wordBreak: "normal" }}>
        <span>{item.title}</span>
        {underLine(item)}
      </span>
    ),
  };
}

/** One chip's menu, drawn while open: the sections as the host draws them, the pick through the host, and focus where the host moves it. */
function ChipMenuBody(props: { host: ChipHost; env: ChipEnv; label: string; sections: readonly ChipSection[]; mark: string }) {
  const { host } = props;
  const drawn = asDrawn(props.sections, { ask: host.ask, said: host.said });
  const items = itemsOf(drawn);
  useLayoutEffect(() => {
    host.drawn.current = { open: true, ids: new Set(items.map((i) => i.id)) };
  });
  const shape = items.map((i) => (i.under ? `${i.id}:${i.under.tone}` : i.id)).join(" ");
  const { setShape } = host;
  useLayoutEffect(() => setShape(shape), [shape, setShape]);
  const sections: MenuSection[] = drawn.map((s) => ({ key: s.key, ...(s.heading ? { heading: s.heading } : {}), ...(s.separator ? { separator: true } : {}), items: s.items.map(menuItemOf) }));
  return (
    // Held to a side panel's width, as the other menus are, so a long title or a move's warning wraps there.
    <div style={{ maxWidth: theme.layout.listCap }}>
      <Menu label={props.label} sections={sections} onPick={(id) => host.pick(props.env, items, id)} focus={host.target} openAtEdge data={{ "data-chip-menu": props.mark }} />
    </div>
  );
}

// ---------------------------------------------------------------- the DM's chips

/** A guarded lift this page sent and the server has not answered: the reveal's (movePlayers.ts), which leaves the blackout on until it lands. */
function revealingTo(pending: readonly { op: ClientOp }[]): string | null {
  for (const p of pending) if (p.op.t === "view.blackout" && p.op.whilePlayersOn !== undefined) return p.op.whilePlayersOn;
  return null;
}

/** Whether the players still see black: the blackout, or a reveal's lift that is still out. The top bar keeps Players see black that long. */
export function useBlackoutShown(): boolean {
  return useRoomView((s) => s.view?.meta.view.blackout === true || revealingTo(s.pending) !== null);
}

/**
 * The DM's view as the DM menu reads it (chipMenus.ts DmMenuView), for the
 * menu while it is open and the search's twins. `timeGaveWay`: the clock
 * chip is off the bar. `nowPlayingGaveWay`: Now playing's is. `images`:
 * the library's handout images once listed (LibraryProbe), else null.
 */
export function useDmMenuView(timeGaveWay: boolean, nowPlayingGaveWay: boolean, images: ReadonlySet<string> | null): DmMenuView {
  const roomId = useRoomView((s) => s.roomId);
  const blackout = useRoomView((s) => s.view?.meta.view.blackout === true);
  const follow = useRoomView((s) => s.view?.meta.view.follow === true);
  const viewing = useRoomView((s) => (s.sceneId ? s.view?.scenes[s.sceneId] : undefined)) ?? null;
  const playerId = useRoomView((s) => s.view?.meta.playerSceneId ?? null);
  const playerName = useRoomView((s) => (playerId ? s.view?.scenes[playerId]?.name : undefined));
  const playersHoldHere = useRoomView((s) => (s.view && s.sceneId ? openFloor(s.view, s.sceneId) : false));
  const playersSceneHere = useRoomView((s) => (s.view && s.sceneId ? onPlayersScene(s.view, s.sceneId) : false));
  const handouts = useRoomView((s) => s.view?.handouts);
  const handoutDocs = useRoomView((s) => s.view?.handoutDocs);
  const members = useRoomView((s) => s.view?.members);
  const clock = useRoomView((s) => s.view?.clock);
  const encounter = useRoomView((s) => s.view?.encounter);
  const movingTo = useRoomView((s) => movingPlayersTo(s.pending));
  const revealing = useRoomView((s) => revealingTo(s.pending));
  const outShown = useDelayed(movingTo !== null || revealing !== null);
  const recentStore = useScoped(recentHandoutsSlot);
  // This device's list for the room, read once, as the Handouts panel reads it.
  useEffect(() => loadRecent(recentStore, roomId), [recentStore, roomId]);
  const recent = useStore(recentStore, (s) => s.entries);
  const scope = useRoomScope();
  const subscribe = useCallback((listener: () => void) => subscribeFocus(scope, listener), [scope]);
  const readFocus = () => currentFocus(scope)?.sceneId ?? null;
  // The same read serves a render to markup, so the room search's test can draw the menu's view (features/search/SearchSheet.test.ts).
  const focusScene = useSyncExternalStore(subscribe, readFocus, readFocus);
  const now = clock ? clockNow(clock, encounter) : null;
  return {
    blackout,
    follow,
    viewing,
    playerScene: playerId && playerName !== undefined ? { id: playerId, name: playerName } : null,
    playersHoldHere,
    playersSceneHere,
    focusHere: viewing !== null && focusScene === viewing.id,
    handouts: handouts ?? {},
    handoutDocs: handoutDocs ?? {},
    members: members ?? {},
    recent,
    images,
    time: timeGaveWay && clock && now !== null ? { text: chipText(now, clock.calendar), name: chipName(now, clock) } : null,
    nowPlaying: nowPlayingGaveWay,
    movingTo,
    revealing,
    outShown,
  };
}

/**
 * Lists the library while a recent image might be offered, as the
 * Handouts panel's Recent list does, and hands up its handout images'
 * ids, so a deleted image leaves the menu, and the room search, which
 * reads the menu's view (features/search/SearchSheet.tsx). Until they
 * come, an image is offered and the server's own check decides
 * (D-261106-208).
 */
export function LibraryProbe(props: { onImages(ids: string | null): void }) {
  const roomId = useRoomView((s) => s.roomId);
  const library = useLibrary(roomId);
  const ids = library.rows ? library.rows.filter((a) => a.kind === "handout").map((a) => a.id).join(" ") : null;
  const { onImages } = props;
  useEffect(() => onImages(ids), [ids, onImages]);
  return null;
}

/** The library's handout image ids as LibraryProbe hands them up, a string so an unchanged list is the same value. */
export function useImages(): [ReadonlySet<string> | null, (ids: string | null) => void] {
  const [ids, setIds] = useState<string | null>(null);
  const images = useMemo(() => (ids === null ? null : new Set(ids.split(" ").filter((id) => id !== ""))), [ids]);
  return [images, setIds];
}

function DmMenuBody(props: { host: ChipHost; anchor: () => HTMLElement | null; timeGaveWay: boolean; nowPlayingGaveWay: boolean; blackoutOnly: boolean }) {
  const [images, setImages] = useImages();
  const view = useDmMenuView(props.timeGaveWay, props.nowPlayingGaveWay, images);
  const env = useChipEnv(props.anchor);
  const sections: ChipSection[] = props.blackoutOnly ? [{ key: "blackout", items: blackoutItems(view) }] : dmMenuSections(view);
  return (
    <>
      {!props.blackoutOnly && view.recent.some((e) => e.kind === "image") ? <LibraryProbe onImages={setImages} /> : null}
      <ChipMenuBody host={props.host} env={env} label={props.blackoutOnly ? CHIP_WORDS.blackoutMenuName : CHIP_WORDS.dmMenuName} sections={sections} mark={props.blackoutOnly ? "blackout" : "dm"} />
    </>
  );
}

/**
 * The DM chip (design-v1-qol.md 4, C1, The chips' look and Words): the member dot, "DM" and a caret,
 * opening the DM menu under it, on a computer and a phone alike
 * (D-261106-120, D-261106-176). Where the bar is short it is its dot, and
 * during a blackout there the crossed eye, whose menu leads with the
 * blackout's items (D-261106-123).
 */
export function DmChip(props: { dot: boolean; eye: boolean; eyeSlim?: boolean; timeGaveWay: boolean; nowPlayingGaveWay?: boolean; chipRef?: Ref<HTMLButtonElement>; onOpen?(open: boolean): void }) {
  const menu = usePopover({ kind: "menu" });
  useRaise(menu.open, props.onOpen);
  const host = useChipHost(menu);
  const color = useRoomView((s) => (s.you ? s.view?.members[s.you.memberId]?.color : undefined)) ?? theme.color.accent;
  const anchor = useCallback(() => menu.anchor.current, [menu.anchor]);
  const chip = props.eye ? (
    <ChipButton anchor={menu.anchorProps} label={CHIP_WORDS.eyeName} tip={CHIP_WORDS.eyeName} outline={theme.color.danger} color={theme.color.dangerText} round slim={props.eyeSlim} buttonRef={props.chipRef} data={{ "data-chip": "dm", "data-chip-form": "eye" }}>
      <Icon name="hidden" size="sm" />
    </ChipButton>
  ) : props.dot ? (
    <ChipButton anchor={menu.anchorProps} label={CHIP_WORDS.dmChipName} tip={CHIP_WORDS.dmDotDescription} outline={theme.color.accent} round buttonRef={props.chipRef} data={{ "data-chip": "dm", "data-chip-form": "dot" }}>
      <ChipDot color={color} />
    </ChipButton>
  ) : (
    <ChipButton anchor={menu.anchorProps} label={CHIP_WORDS.dmChipName} outline={theme.color.accent} buttonRef={props.chipRef} data={{ "data-chip": "dm" }}>
      <ChipDot color={color} />
      {CHIP_WORDS.dmChip}
    </ChipButton>
  );
  return (
    <>
      {chip}
      <Popover handle={menu} side="below" bound={viewportBound} contentKey={host.shape}>
        <DmMenuBody host={host} anchor={anchor} timeGaveWay={props.timeGaveWay} nowPlayingGaveWay={props.nowPlayingGaveWay === true} blackoutOnly={false} />
      </Popover>
    </>
  );
}

/**
 * Players see black (design-v1-qol.md 4, C2, D-261106-122): its words and a caret,
 * opening the Blackout menu: End the blackout, and while the DM looks at
 * another scene, Show players <scene>. It stays while a reveal is out
 * (useBlackoutShown). When it goes with the blackout, focus goes to the
 * DM chip (`fallbackFocus`).
 */
export function BlackoutChip(props: { fallbackFocus(): HTMLElement | null; onOpen?(open: boolean): void }) {
  const menu = usePopover({ kind: "menu", fallbackFocus: props.fallbackFocus });
  useRaise(menu.open, props.onOpen);
  const host = useChipHost(menu);
  const anchor = useCallback(() => menu.anchor.current ?? props.fallbackFocus(), [menu.anchor, props]);
  return (
    <>
      <ChipButton anchor={menu.anchorProps} label={CHIP_WORDS.playersSeeBlack} outline={theme.color.danger} color={theme.color.dangerText} data={{ "data-chip": "blackout" }}>
        {CHIP_WORDS.playersSeeBlack}
      </ChipButton>
      <Popover handle={menu} side="below" bound={viewportBound} contentKey={host.shape}>
        <DmMenuBody host={host} anchor={anchor} timeGaveWay={false} nowPlayingGaveWay={false} blackoutOnly />
      </Popover>
    </>
  );
}

// ---------------------------------------------------------------- a player's chip

function YouMenuBody(props: { host: ChipHost; anchor: () => HTMLElement | null }) {
  const memberId = useRoomView((s) => s.you?.memberId ?? "");
  const member = useRoomView((s) => (s.you ? s.view?.members[s.you.memberId] : undefined));
  const characters = useRoomView((s) => s.view?.characters);
  const preview = usePreview() !== null;
  const env = useChipEnv(props.anchor);
  const sections = youMenuSections({ memberId, member, characters: characters ?? {}, preview });
  return <ChipMenuBody host={props.host} env={env} label={CHIP_WORDS.youMenuName} sections={sections} mark="you" />;
}

/**
 * A player's chip (design-v1-qol.md 4, C7, D-261106-130): their dot, their name and a
 * caret, or only the dot where the bar is short, opening the You menu:
 * each of their characters' sheets and the X-card. In View as a player it
 * is that player's, from the preview's projection, its X-card off
 * (D-261106-134).
 */
export function YouChip(props: { dot: boolean; onOpen?(open: boolean): void }) {
  const menu = usePopover({ kind: "menu" });
  useRaise(menu.open, props.onOpen);
  const host = useChipHost(menu);
  const member = useRoomView((s) => (s.you ? s.view?.members[s.you.memberId] : undefined));
  const anchor = useCallback(() => menu.anchor.current, [menu.anchor]);
  if (!member) return null;
  const you = `You are ${member.name}`;
  return (
    <>
      {props.dot ? (
        <ChipButton anchor={menu.anchorProps} label={youChipName(member.name)} tip={you} outline={theme.color.accent} round data={{ "data-chip": "you", "data-chip-form": "dot" }}>
          <ChipDot color={member.color} />
        </ChipButton>
      ) : (
        <ChipButton anchor={menu.anchorProps} label={youChipName(member.name)} tip={you} outline={theme.color.accent} shrink data={{ "data-chip": "you" }}>
          <ChipDot color={member.color} />
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{member.name}</span>
        </ChipButton>
      )}
      <Popover handle={menu} side="below" bound={viewportBound} contentKey={host.shape}>
        <YouMenuBody host={host} anchor={anchor} />
      </Popover>
    </>
  );
}
