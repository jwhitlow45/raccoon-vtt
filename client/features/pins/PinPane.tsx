import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JournalPage, Member, Pin } from "#shared/model.ts";
import { MAX_NAME } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { Input, Select } from "../../components/Field.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Help, Note } from "../../components/Panel.tsx";
import { PaneHeader } from "../../components/SheetHeader.tsx";
import { Swatches } from "../../components/Swatches.tsx";
import { useBackClose } from "../../lib/backClose.ts";
import { DraftScope, useDraftRegistry, useSheetSwipe, useUnsavedSince } from "../../lib/sheetSwipe.ts";
import type { Camera, Insets, Size } from "../../lib/camera.ts";
import { isCoarsePointer } from "../../lib/device.ts";
import { MEMBER_COLORS, theme } from "../../lib/theme.ts";
import { paneDockFits, useAlertsLane, usePublishPaneLane } from "../../pages/fold.ts";
import { PaneDockRow, usePaneDock } from "../../pages/RoomDock.tsx";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { requestPan } from "../encounter/pan.ts";
import { CONFIRM_MS, paneEscape, panePlacement, sheetPanAnchor, SHEET_BELOW_PX, tapDelete } from "../builder/labelEdit.ts";
import { labelPaneFrame, PANE_HEIGHT_UNMEASURED } from "../builder/labelPaneFrame.ts";
import { PaneFooter } from "../builder/PaneFooter.tsx";
import { accessText, groupPages } from "../journal/draft.ts";
import { journalSlot } from "../journal/store.ts";
import { closedAnswerText, editDraft, pendingCloseText, saveAnswered, saveNotSent, saveSent, saveState } from "../journal/pendingSave.ts";
import { pinAudience, pinCommit, pinDraftOf, pinSaveAnswer, pinScreenBox, withDmOnly, withPage, withPageGone, type PinDraft, type PinView } from "./rules.ts";

const EMPTY_PAGES: Record<string, JournalPage> = {};
const EMPTY_MEMBERS: Record<string, Member> = {};

/**
 * A map pin's pane (docs/design-v1-dm-tools.md 3.8), for the DM: its label,
 * its linked page, its color, DM only, and a line that says who will see
 * it. It hangs beside the pin on a wide screen and is a bottom sheet on a
 * phone, as a label's pane is (builder/LabelPane.tsx).
 *
 * Edits apply on Done as one `pin.put`, so one step to undo. Changing the
 * link away from a page that is not for every player turns DM only on in
 * the same save (rules.ts withPage), so a pin never reaches more people than
 * before without the DM's say.
 */
export default function PinPane(props: { pin: Pin; camera: Camera; viewport: Size; insets: Insets; shown?: PinView; onClose(): void }) {
  const { pin } = props;
  const paneRef = useRef<HTMLDivElement>(null);
  // Escape and Android Back close the way × does, through the editor's own close, which knows whether Done is still pending and says so (W5-ASTRA-07).
  const dismissRef = useRef(props.onClose);
  useBackClose(true, () => dismissRef.current());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const editing = target !== null && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      const escape = paneEscape({
        key: e.key,
        handled: e.defaultPrevented,
        dialogOpen: document.querySelector('[aria-modal="true"]') !== null,
        editingElsewhere: editing && !paneRef.current?.contains(target),
      });
      if (!escape) return;
      e.preventDefault();
      dismissRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.scrollHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const box = pinScreenBox(pin, props.camera, props.shown);
  // As a bottom sheet it folds the alerts column, so its header and Close stay in reach, and their summary row docks on its top edge in room kept free under the top bars, and a toast that shows meanwhile starts under its header (pages/RoomDock.tsx usePaneDock).
  // As a card it keeps left of the column's cards, or under the summary row it has the column show where the lane leaves it no room (labelEdit.ts panePlacement).
  const sheet = props.viewport.width < SHEET_BELOW_PX;
  const dock = usePaneDock(sheet, paneDockFits({ viewport: props.viewport, insets: props.insets }), paneRef);
  const insets = dock.reserve > 0 ? { ...props.insets, top: props.insets.top + dock.reserve } : props.insets;
  const lane = useAlertsLane(props.viewport);
  const place = panePlacement({ viewport: props.viewport, insets, box, height: height ?? PANE_HEIGHT_UNMEASURED, lane });
  usePublishPaneLane(place.kind === "card" ? (place.lane ?? null) : null, () => dismissRef.current());

  // A bottom sheet brings its pin into view above it, once per pin.
  const scope = useRoomScope();
  const pannedFor = useRef<string | null>(null);
  useEffect(() => {
    if (place.kind !== "sheet" || height === null || pannedFor.current === pin.id) return;
    pannedFor.current = pin.id;
    const anchor = sheetPanAnchor({ viewport: props.viewport, insets, sheetHeight: height, box });
    if (anchor) requestPan(scope, { sceneId: pin.sceneId, x: pin.x, y: pin.y, anchor });
  });

  // As a bottom sheet it swipes down to close, through the editor's own close as × does (docs/design-v1-sheet-swipe.md section 3).
  const drafts = useDraftRegistry();
  useSheetSwipe(paneRef, { enabled: sheet, onClose: () => dismissRef.current(), item: pin.id, clip: "foot", riders: dock.riders, drafts });

  return (
    <>
      <div ref={paneRef} role="dialog" aria-label="Edit pin" data-map-pane="" style={{ ...labelPaneFrame(place), overflowY: "auto", overscrollBehavior: "contain", color: theme.color.text }}>
        {/* Keyed by pin, so a draft or an armed Delete never carries over to the next pin tapped. */}
        <DraftScope value={drafts}>
          <PinEditor key={pin.id} pin={pin} onClose={props.onClose} dismissRef={dismissRef} sheet={sheet} />
        </DraftScope>
      </div>
      {dock.summary && place.kind === "sheet" ? <PaneDockRow ref={dock.row} pane={paneRef} bottom={place.bottom} summary={dock.summary} onClose={() => dismissRef.current()} /> : null}
    </>
  );
}

function PinEditor(props: { pin: Pin; onClose(): void; dismissRef: { current: () => void }; sheet: boolean }) {
  const { pin } = props;
  const actions = useRoomActions();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const pages = useRoomView((s) => s.view?.journal ?? EMPTY_PAGES);
  const members = useRoomView((s) => s.view?.members ?? EMPTY_MEMBERS);
  const playerSceneId = useRoomView((s) => s.view?.meta.playerSceneId ?? null);
  const fog = useRoomView((s) => s.view?.scenes[pin.sceneId]?.fogEnabled === true);
  // The draft locks while Done is pending (journal/pendingSave.ts), so nothing changed then is lost when the acknowledgment closes the pane.
  const [state, setState] = useState(() => saveState<PinDraft>(pinDraftOf(pin)));
  const { draft, pending: saving, failure } = state;
  // Only Done sends it, so a swipe springs back once the draft changed, until Done has sent it (docs/design-v1-sheet-swipe.md 4.5).
  useUnsavedSince(draft, !saving);
  const setDraft = (change: (d: PinDraft) => PinDraft) => setState((s) => editDraft(s, change));
  const [armedAt, setArmedAt] = useState<number | null>(null);
  // A page deleted on another DM device takes the link with it, and the pin is DM only now (rules.ts withPageGone).
  // While Done is pending the draft stays locked, and this runs again once the answer unlocks it.
  const pageGone = draft.pageId !== null && pages[draft.pageId] === undefined;
  useEffect(() => {
    if (pageGone && !saving) setState((s) => editDraft(s, (d) => withPageGone(d, pages)));
  }, [pageGone, saving, pages]);
  const connected = useRoomView((s) => s.connection === "open");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const fieldRef = useRef<HTMLDivElement>(null);
  const ordered = useMemo(() => groupPages(Object.values(pages)).flatMap((g) => g.pages), [pages]);
  const commit = pinCommit(pin, draft);
  const audience = pinAudience({ visibility: draft.dmOnly ? "dm" : "all", pageId: draft.pageId }, pages, members);

  useEffect(() => {
    if (isCoarsePointer()) return;
    const input = fieldRef.current?.querySelector("input");
    input?.focus();
    input?.select();
  }, []);

  useEffect(() => {
    if (armedAt === null) return;
    const timer = setTimeout(() => setArmedAt(null), Math.max(0, armedAt + CONFIRM_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [armedAt]);

  // The pane stays until the server has taken the pin (rules.ts pinSaveAnswer), and says itself why it did not.
  const done = () => {
    if (saving || commit.kind === "tooLong") return;
    if (commit.kind === "unchanged") {
      props.onClose();
      return;
    }
    const n = actions.dispatch(
      { t: "pin.put", pin: commit.pin },
      {
        quiet: true,
        onAnswer: (answer, refusal) => {
          if (!mounted.current) {
            // Closed while pending: no draft is left to show why, so a failure says so in a toast.
            const text = closedAnswerText("pin", answer, refusal);
            if (text) ui.notify(text, "error");
            return;
          }
          const outcome = pinSaveAnswer(answer, refusal);
          if (outcome.kind === "closed") {
            props.onClose();
            return;
          }
          setState((s) => saveAnswered(s, outcome).state);
        },
      },
    );
    if (n === null) {
      setState((s) => saveNotSent(s, "The pin could not be sent. Your changes are still here."));
      return;
    }
    setState(saveSent);
  };
  // Done already sent the pin as it is, and it still lands, so closing then discards nothing and says where the save stands.
  const close = () => {
    if (saving) ui.notify(pendingCloseText("pin", connected));
    props.onClose();
  };
  props.dismissRef.current = close;
  const tapDeleteButton = () => {
    const next = tapDelete(armedAt, Date.now());
    setArmedAt(next.armedAt);
    if (!next.confirmed) return;
    actions.dispatch({ t: "pin.remove", pinId: pin.id });
    props.onClose();
  };
  const openPage = (pageId: string) => {
    scope.get(journalSlot).setState({ pageId });
    ui.openPanel("journal");
  };

  // One column no wider than the pane: a field's own minimum width would otherwise widen it and scroll the pane sideways.
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}>
      <PaneHeader title="Pin" closeLabel={saving ? "Close" : "Close without saving"} onClose={close} grab={props.sheet} />
      {/*
        Disabled as a whole while Done is pending, as editDraft refuses their edits: the label, the page, the color and DM only.
        Each control is told as well, since a fieldset disables its controls but cannot give them the disabled look
        (docs/design-v1-visual.md 2.3). Done stays outside it, busy, and Delete waits.
      */}
      <fieldset disabled={saving} aria-busy={saving} style={{ margin: 0, padding: 0, border: "none", minWidth: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}>
          <div ref={fieldRef}>
            <Input
              type="text"
              aria-label="Pin label"
              placeholder="Label (optional)"
              maxLength={MAX_NAME}
              value={draft.label}
              disabled={saving}
              onChange={(e) => {
                const label = e.target.value;
                setDraft((d) => ({ ...d, label }));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") done();
              }}
              style={{ width: "100%" }}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>
            <Select
              aria-label="Linked page"
              value={draft.pageId ?? ""}
              disabled={saving}
              onChange={(e) => {
                const pageId = e.target.value === "" ? null : e.target.value;
                setDraft((d) => withPage(pin, d, pageId, pages));
              }}
              style={{ flex: "1 1 180px", maxWidth: "100%" }}
            >
              <option value="">No page</option>
              {ordered.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} ({accessText(p.access, members)})
                </option>
              ))}
            </Select>
            {draft.pageId !== null && pages[draft.pageId] ? (
              <Button size="sm" disabled={saving} onClick={() => openPage(draft.pageId!)}>
                Open page
              </Button>
            ) : null}
          </div>
          <Swatches label="Pin color" value={draft.color} options={MEMBER_COLORS} disabled={saving} onChange={(color) => setDraft((d) => ({ ...d, color }))} />
          <Checkbox checked={draft.dmOnly} disabled={saving} onChange={(on) => setDraft((d) => withDmOnly(d, on))} label="DM only" />
        </div>
      </fieldset>
      <div role="status" style={{ fontSize: theme.font.body14 }}>
        <span style={{ color: theme.color.textMuted }}>Who will see it: </span>
        {audience}
      </div>
      {draft.autoDmOnly === "restricted" ? <Note>DM only turned on, because the page it was linked to is not for every player. Turn DM only off to let players see the pin.</Note> : null}
      {draft.autoDmOnly === "deleted" ? <Note>DM only turned on, because the page it was linked to was deleted. Turn DM only off to let players see the pin.</Note> : null}
      {!draft.dmOnly && audience !== "Only the DM" && playerSceneId !== pin.sceneId ? <Help>Players are on another scene, so they see it once they come here.</Help> : null}
      {fog && !draft.dmOnly && audience !== "Only the DM" ? <Help>The fog still hides it while it covers the pin.</Help> : null}
      {commit.kind === "tooLong" ? <Note>A label is at most {MAX_NAME} characters.</Note> : null}
      {failure !== null ? (
        <p role="alert" style={{ margin: 0, fontSize: theme.font.small, color: theme.color.dangerText }}>
          {failure}
        </p>
      ) : null}
      {saving ? <Loading text={connected ? "Saving the pin…" : "Waiting for the connection to save…"} /> : null}
      <PaneFooter>
        <Button
          size="sm"
          variant="danger"
          armed={armedAt !== null}
          disabled={saving}
          icon="delete"
          iconOnly={armedAt === null ? "always" : undefined}
          title="Delete this pin"
          aria-label={armedAt !== null ? "Tap again to delete" : "Delete this pin"}
          onClick={tapDeleteButton}
        >
          {armedAt !== null ? "Tap again to delete" : "Delete"}
        </Button>
        <Button size="sm" variant="primary" busy={saving} disabled={commit.kind === "tooLong"} onClick={done}>
          {saving ? "Saving…" : "Done"}
        </Button>
      </PaneFooter>
    </div>
  );
}
