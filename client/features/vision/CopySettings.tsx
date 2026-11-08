import { useId, useMemo, useRef, useState, type RefObject } from "react";
import type { RoomState, Scene } from "#shared/model.ts";
import { floorsOf, playersSee } from "#shared/rules/floors.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Help, sectionLabelLook } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import type { OpAnswer, OpRefusal } from "../../state/types.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { groupScenes } from "../scenes/folders.ts";
import { COPY_BUTTON, COPY_BUTTON_HELP, COPY_HELP, COPY_UNDO, copiedAll, copiesNothing, copyButtonText, copyLine, copyPatch, copyResult, copyTitle, type CopyAnswer } from "./copyRules.ts";

/**
 * "Copy to other scenes…" at the end of Fog and vision
 * (docs/design/design-v1-map-discovery.md 8.3, docs/design/design-v1-scenes-reorg.md
 * 6), its help saying what it copies, since Light now sits in another
 * group: a sheet, from the bottom on a
 * phone, listing every other scene by folder with what players see there
 * now and what the copy would do there, so a room already full of scenes
 * takes one setup in one step. Only in a room with another scene.
 */
export function CopySettingsButton(props: { scene: Scene }) {
  const scenes = useRoomView((s) => s.view?.scenes);
  /*
   * The scene's other floors first, top first, then the other scenes by
   * their main floors (docs/design/design-v1-floors.md 7.1): a scene with
   * floors is one scene to copy to, and its own floors are the likeliest
   * targets, since a tower's floors share most of their setup.
   */
  const floors = useMemo(
    () =>
      scenes
        ? floorsOf({ scenes }, props.scene.id)
            .filter((s) => s.id !== props.scene.id)
            .reverse()
        : [],
    [scenes, props.scene.id],
  );
  const others = useMemo(() => {
    const own = new Set([props.scene.id, ...floors.map((f) => f.id)]);
    return Object.values(scenes ?? {})
      .filter((s): s is Scene => s !== undefined && !own.has(s.id) && (s.floor === undefined || s.floor.of === s.id))
      .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  }, [scenes, props.scene.id, floors]);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const helpId = useId();
  if (others.length === 0 && floors.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: theme.space(1), justifyItems: "start", minWidth: 0 }}>
      <Button ref={opener} size="sm" aria-describedby={helpId} onClick={() => setOpen(true)}>
        {COPY_BUTTON}
      </Button>
      <Help id={helpId}>{COPY_BUTTON_HELP}</Help>
      {open ? <CopySheet source={props.scene} floors={floors} scenes={others} opener={opener} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/**
 * The sheet. Copy sends one `scene.update` a scene under one undo group,
 * so one undo puts every scene back, and waits for every answer, busy and
 * refusing a second tap, before it says how it went in a polite status.
 * A scene that already has the settings is counted with nothing sent.
 * Once every scene took it the ticks clear, and focus on Copy, which that
 * leaves with nothing to do, moves to Close. Escape and Close answer no,
 * and focus goes back to the button.
 */
function CopySheet(props: { source: Scene; floors: Scene[]; scenes: Scene[]; opener: RefObject<HTMLButtonElement | null>; onClose(): void }) {
  const { source, floors } = props;
  const actions = useRoomActions();
  const view = useRoomView((s) => s.view);
  const seen = (id: string) => (view ? playersSee(view as RoomState, id) : false);
  // The scene's own floors lead the sheet's list, apart from the folders, and every pick counts alike below.
  const scenes = useMemo(() => [...floors, ...props.scenes], [floors, props.scenes]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const patch = copyPatch(source);
  const groups = groupScenes(props.scenes);
  const chosen = scenes.filter((s) => picked.has(s.id));

  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
    setResult(null);
  };

  const copy = () => {
    if (busy || chosen.length === 0) return;
    const answers: (CopyAnswer | undefined)[] = chosen.map(() => undefined);
    let left = chosen.length;
    const settle = (i: number, answer: OpAnswer, refusal?: OpRefusal) => {
      answers[i] = { name: chosen[i]!.name, answer, ...(refusal ? { refusal } : {}) };
      if (--left > 0) return;
      const all = answers as CopyAnswer[];
      setBusy(false);
      setResult(copyResult(all));
      if (!copiedAll(all)) return;
      setPicked(new Set());
      if (document.activeElement === copyButton.current) closeButton.current?.focus();
    };
    setBusy(true);
    setResult(null);
    const group = actions.newId();
    chosen.forEach((scene, i) => {
      if (copiesNothing(scene, patch)) settle(i, "taken");
      else if (actions.dispatch({ t: "scene.update", sceneId: scene.id, patch }, { group, quiet: true, onAnswer: (answer, refusal) => settle(i, answer, refusal) }) === null) settle(i, "refused");
    });
  };

  return (
    <Dialog
      title={copyTitle(source.name)}
      onClose={props.onClose}
      opener={props.opener}
      width="md"
      phone="sheet"
      backClose
      bodyStyle={{ fontSize: theme.font.body14 }}
      footer={
        <>
          {/* Both grow to share the line they stand on (docs/design/design-v1-polish.md R6), so Copy wrapped under Close fills its line. */}
          <Button ref={closeButton} onClick={props.onClose} style={{ flex: "1 1 auto" }}>
            Close
          </Button>
          <Button ref={copyButton} variant="primary" busy={busy} disabled={!busy && chosen.length === 0} onClick={copy} style={{ flex: "1 1 auto" }}>
            {busy ? "Copying…" : copyButtonText(chosen.length)}
          </Button>
        </>
      }
    >
      <div style={{ display: "grid", gap: theme.space(3), minWidth: 0 }}>
        <Help>{COPY_HELP}</Help>
        <div style={{ display: "flex" }}>
          <Button
            size="sm"
            disabled={busy || chosen.length === scenes.length}
            onClick={() => {
              setPicked(new Set(scenes.map((s) => s.id)));
              setResult(null);
            }}
          >
            Select all
          </Button>
        </div>
        {floors.length > 0 ? (
          <div role="group" aria-label={`Floors of ${source.name}`} style={{ display: "grid", minWidth: 0 }}>
            <span style={{ ...sectionLabelLook(), overflowWrap: "anywhere", padding: `${theme.space(1)}px 0` }}>Floors of {source.name}</span>
            {floors.map((floor) => (
              <Checkbox
                key={floor.id}
                label={<span style={{ overflowWrap: "anywhere" }}>{floor.floor?.name ?? floor.name}</span>}
                help={copyLine(floor, patch, seen(floor.id))}
                checked={picked.has(floor.id)}
                disabled={busy}
                onChange={(on) => toggle(floor.id, on)}
              />
            ))}
          </div>
        ) : null}
        {groups.map((g) => (
          <div key={g.folder ?? ""} role="group" aria-label={g.folder ?? "Scenes in no folder"} style={{ display: "grid", minWidth: 0 }}>
            {g.folder !== null ? <span style={{ ...sectionLabelLook(), overflowWrap: "anywhere", padding: `${theme.space(1)}px 0` }}>{g.folder}</span> : null}
            {g.scenes.map((scene) => (
              <Checkbox
                key={scene.id}
                label={<span style={{ overflowWrap: "anywhere" }}>{scene.name}</span>}
                help={copyLine(scene, patch, seen(scene.id))}
                checked={picked.has(scene.id)}
                disabled={busy}
                onChange={(on) => toggle(scene.id, on)}
              />
            ))}
          </div>
        ))}
        <Help>{COPY_UNDO}</Help>
        <p role="status" style={{ margin: 0, fontSize: theme.font.body14, lineHeight: theme.leading.body, overflowWrap: "anywhere" }}>
          {result}
        </p>
      </div>
    </Dialog>
  );
}
