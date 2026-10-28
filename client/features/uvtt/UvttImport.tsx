import { useState } from "react";
import { LIMITS } from "#shared/limits.ts";
import type { Scene } from "#shared/model.ts";
import { Help, Note } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { FilePicker, ImportDialog, type ImportTarget } from "./ImportDialog.tsx";
import { fileSizeProblem, thisDevice, type Device } from "./limits.ts";
import { entryShown } from "./rules.ts";

/**
 * Where a DM starts a Universal VTT import (docs/design-v1-maps-vision.md
 * section 3.1): New scene in the Scenes panel, or a scene's phases for the
 * image alone. The button opens the file picker at once, and the dialog
 * takes over from the picked file.
 */

function Entry(props: { label: string; hint: string; target: ImportTarget; full?: boolean }) {
  const [picked, setPicked] = useState<{ file: File; device: Device } | null>(null);
  const [tooBig, setTooBig] = useState<string | null>(null);
  const device = thisDevice();
  const shown = entryShown(props.full ?? false, picked !== null);
  if (!shown.picker && !shown.dialog) return null;
  return (
    <div style={{ display: "grid", gap: theme.space(1) }}>
      {shown.picker ? (
        <>
          <FilePicker
            label={props.label}
            device={device}
            disabled={picked !== null}
            onFile={(file) => {
              // A phone checks the size before reading a byte: a file too big for its memory could end the tab.
              const problem = fileSizeProblem(file.size, device);
              setTooBig(problem);
              if (!problem) setPicked({ file, device });
            }}
          />
          <Help>{props.hint}</Help>
          {tooBig ? (
            <div role="alert">
              <Note>{tooBig}</Note>
            </div>
          ) : null}
        </>
      ) : null}
      {picked && shown.dialog ? <ImportDialog file={picked.file} device={picked.device} target={props.target} onClose={() => setPicked(null)} /> : null}
    </div>
  );
}

/** "From a Universal VTT file" under New scene, while the room has room for another scene. */
export function UvttNewScene(props: { sceneCount: number }) {
  return (
    <Entry
      label="From a Universal VTT file"
      hint="A map from Dungeondraft, Dungeon Alchemist, Arkenforge or DungeonFog (.dd2vtt, .uvtt or .df2vtt), with its walls, doors and lights."
      target={{ kind: "scene" }}
      full={props.sceneCount >= LIMITS.scenesPerRoom}
    />
  );
}

/** A phase from a Universal VTT file: its image only. */
export function UvttAddPhase(props: { scene: Scene }) {
  return <Entry label="Add a phase from a Universal VTT file" hint="Only its image is added." target={{ kind: "phase", sceneId: props.scene.id }} />;
}
