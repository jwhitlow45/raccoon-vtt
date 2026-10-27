import { useMemo, useRef, useState, type RefObject } from "react";
import type { Scene } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Help, sectionLabelLook } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import type { OpAnswer, OpRefusal } from "../../state/types.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { groupScenes } from "../scenes/folders.ts";
import { COPY_HELP, COPY_UNDO, copiesNothing, copyButtonText, copyLine, copyPatch, copyResult, copyTitle, type CopyAnswer } from "./copyRules.ts";

/**
 * "Use these settings on other scenes…" at the end of What players see
 * (docs/design-v1-map-discovery.md 8.3): a sheet, from the bottom on a
 * phone, listing every other scene by folder with what players see there
 * now and what the copy would do there, so a room already full of scenes
 * takes one setup in one step. Only in a room with another scene.
 */
export function CopySettingsButton(props: { scene: Scene }) {
  const scenes = useRoomView((s) => s.view?.scenes);
  const others = useMemo(
    () =>
      Object.values(scenes ?? {})
        .filter((s): s is Scene => s !== undefined && s.id !== props.scene.id)
        .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)),
    [scenes, props.scene.id],
  );
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  if (others.length === 0) return null;
  return (
    <div style={{ display: "flex" }}>
      <Button ref={opener} size="sm" onClick={() => setOpen(true)}>
        Use these settings on other scenes…
      </Button>
      {open ? <CopySheet source={props.scene} scenes={others} opener={opener} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/**
 * The sheet. Copy sends one `scene.update` a scene under one undo group,
 * so one undo puts every scene back, and waits for every answer, busy and
 * refusing a second tap, before it says how it went in a polite status.
 * A scene that already has the settings is counted with nothing sent.
 * Escape and Close answer no, and focus goes back to the button.
 */
function CopySheet(props: { source: Scene; scenes: Scene[]; opener: RefObject<HTMLButtonElement | null>; onClose(): void }) {
  const { source, scenes } = props;
  const actions = useRoomActions();
  const playerSceneId = useRoomView((s) => s.view?.meta.playerSceneId ?? null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const patch = copyPatch(source);
  const groups = groupScenes(scenes);
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
      setBusy(false);
      setResult(copyResult(answers as CopyAnswer[]));
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
          {/* Both grow to share the line they stand on (docs/design-v1-polish.md R6), so Copy wrapped under Close fills its line. */}
          <Button onClick={props.onClose} style={{ flex: "1 1 auto" }}>
            Close
          </Button>
          <Button variant="primary" busy={busy} disabled={!busy && chosen.length === 0} onClick={copy} style={{ flex: "1 1 auto" }}>
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
        {groups.map((g) => (
          <div key={g.folder ?? ""} role="group" aria-label={g.folder ?? "Scenes in no folder"} style={{ display: "grid", minWidth: 0 }}>
            {g.folder !== null ? <span style={{ ...sectionLabelLook(), overflowWrap: "anywhere", padding: `${theme.space(1)}px 0` }}>{g.folder}</span> : null}
            {g.scenes.map((scene) => (
              <Checkbox
                key={scene.id}
                label={<span style={{ overflowWrap: "anywhere" }}>{scene.name}</span>}
                help={copyLine(scene, patch, playerSceneId)}
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
