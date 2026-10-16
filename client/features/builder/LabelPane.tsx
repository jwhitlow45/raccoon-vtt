import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { Label } from "#shared/model.ts";
import { MAX_NAME } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { Input } from "../../components/Field.tsx";
import { Note } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { PaneHeader } from "../../components/SheetHeader.tsx";
import { useBackClose } from "../../lib/backClose.ts";
import type { Camera, Insets, Size } from "../../lib/camera.ts";
import { isCoarsePointer } from "../../lib/device.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions } from "../../state/view.ts";
import { requestPan } from "../encounter/pan.ts";
import { CONFIRM_MS, commitDraft, paneEscape, panePlacement, paneSizes, sheetPanAnchor, tapDelete, type LabelDraft } from "./labelEdit.ts";
import { labelPaneFrame, labelScreenBox, PANE_HEIGHT_UNMEASURED } from "./labelPaneFrame.ts";
import { PaneFooter } from "./PaneFooter.tsx";
import { useBuilderStore } from "./store.ts";

/**
 * A map label's edit pane (features section 3), for the DM: its text, its
 * size, Delete and Done. It hangs beside the label on a wide screen and is
 * a bottom sheet on a phone (labelEdit.ts panePlacement).
 *
 * Edits apply on Done, as one `build.label` op and so one step to undo. A
 * live edit would send an op, and leave an undo step, for every letter
 * typed. Closing any other way (the close button, Escape, Back, a tap away
 * on the map) drops the draft, as Escape does in the room's other fields.
 */
export default function LabelPane(props: { label: Label; camera: Camera; viewport: Size; insets: Insets; onClose(): void }) {
  const { label, camera } = props;
  const paneRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  useBackClose(true, () => closeRef.current());

  // The room's own Escape handler runs first, since it listened first, and
  // marks an Escape it used, so one press closes one thing (labelEdit.ts paneEscape).
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
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** The pane's height once laid out, which placing it and panning to its label wait for. */
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.scrollHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A label being dragged in the builder takes its pane along.
  const moving = useStore(useBuilderStore(), (b) => b.labelMove);
  const screenBox = labelScreenBox(moving?.id === label.id ? { ...label, x: moving.x, y: moving.y } : label, camera);
  const place = panePlacement({ viewport: props.viewport, insets: props.insets, box: screenBox, height: height ?? PANE_HEIGHT_UNMEASURED });

  // A bottom sheet brings the label it opened for into view above it, once
  // per label, so a later pan away is the DM's to keep.
  const scope = useRoomScope();
  const pannedFor = useRef<string | null>(null);
  useEffect(() => {
    if (place.kind !== "sheet" || height === null || pannedFor.current === label.id) return;
    pannedFor.current = label.id;
    const anchor = sheetPanAnchor({ viewport: props.viewport, insets: props.insets, sheetHeight: height, box: screenBox });
    if (anchor) requestPan(scope, { sceneId: label.sceneId, x: label.x, y: label.y, anchor });
  });

  return (
    <div
      ref={paneRef}
      role="dialog"
      aria-label="Edit label"
      data-map-pane=""
      style={{ ...labelPaneFrame(place), overflowY: "auto", overscrollBehavior: "contain", color: theme.color.text }}
    >
      {/* Keyed by label, so a draft or an armed Delete never carries over to the next label tapped. */}
      <LabelEditor key={label.id} label={label} onClose={props.onClose} />
    </div>
  );
}

function LabelEditor(props: { label: Label; onClose(): void }) {
  const { label } = props;
  const actions = useRoomActions();
  const [draft, setDraft] = useState<LabelDraft>({ text: label.text, size: label.size });
  const [armedAt, setArmedAt] = useState<number | null>(null);
  const fieldRef = useRef<HTMLDivElement>(null);

  // With a keyboard at hand the text is ready to retype. A phone would
  // throw its keyboard over the map, so there the DM taps the field first.
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

  const commit = commitDraft(label, draft);
  const done = () => {
    if (commit.kind === "update") actions.dispatch({ t: "build.label", sceneId: label.sceneId, labelId: label.id, label: commit.label });
    if (commit.kind === "update" || commit.kind === "unchanged") props.onClose();
  };
  const tapDeleteButton = () => {
    const next = tapDelete(armedAt, Date.now());
    setArmedAt(next.armedAt);
    if (!next.confirmed) return;
    actions.dispatch({ t: "build.label", sceneId: label.sceneId, labelId: label.id, label: null });
    props.onClose();
  };

  // One column no wider than the pane: a field's own minimum width would otherwise widen it and scroll the pane sideways.
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}>
      <PaneHeader title="Label" closeLabel="Close without saving" onClose={props.onClose} />
      <div ref={fieldRef}>
        <Input
          type="text"
          aria-label="Label text"
          placeholder="Label text"
          maxLength={MAX_NAME}
          value={draft.text}
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") done();
          }}
          style={{ width: "100%" }}
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
        <span style={{ flex: 1, color: theme.color.textMuted }}>Size</span>
        <Segmented<number>
          label="Label size"
          value={draft.size}
          options={paneSizes(label.size).map((o) => ({ value: o.value, label: o.label, title: `Size ${o.label}` }))}
          onChange={(size) => setDraft({ ...draft, size })}
        />
      </div>
      {commit.kind === "empty" ? <Note>A label needs text. Delete removes it.</Note> : null}
      <PaneFooter>
        <Button size="sm" variant="danger" armed={armedAt !== null} title="Delete this label" aria-label={armedAt !== null ? "Tap again to delete" : "Delete this label"} onClick={tapDeleteButton}>
          {armedAt !== null ? "Tap again to delete" : "Delete"}
        </Button>
        <Button size="sm" variant="primary" disabled={commit.kind === "empty" || commit.kind === "tooLong"} onClick={done}>
          Done
        </Button>
      </PaneFooter>
    </div>
  );
}
