import { useState } from "react";
import { LIMITS } from "#shared/limits.ts";
import type { Scene } from "#shared/model.ts";
import { Help, Note } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { FloorsImportDialog } from "./FloorsImportDialog.tsx";
import { fileError } from "./floorsImport.ts";
import { FilePicker, ImportDialog, type ImportTarget } from "./ImportDialog.tsx";
import { fileSizeProblem, thisDevice, type Device } from "./limits.ts";
import { entryShown } from "./rules.ts";

/**
 * Where a DM starts a Universal VTT import (docs/design/design-v1-maps-vision.md
 * section 3.1): New scene in the Scenes panel, or a scene's phases for the
 * image alone. The button opens the file picker at once, and the dialog
 * takes over from the picked file. New scene takes several files too, which
 * make one scene with a floor for each (docs/design/design-v1-floors.md
 * phase 4, 9.5, FloorsImportDialog.tsx).
 */

/** Under New scene's file picker, which takes several files for a scene of several floors. */
export const SEVERAL_HINT = "Pick several files to make one scene with a floor for each.";

function Entry(props: { label: string; hint: string; target: ImportTarget; full?: boolean; several?: boolean }) {
  const [picked, setPicked] = useState<{ file: File; device: Device } | null>(null);
  const [many, setMany] = useState<{ files: File[]; device: Device } | null>(null);
  const [tooBig, setTooBig] = useState<string | null>(null);
  const device = thisDevice();
  const shown = entryShown(props.full ?? false, picked !== null || many !== null);
  if (!shown.picker && !shown.dialog) return null;
  return (
    <div style={{ display: "grid", gap: theme.space(1) }}>
      {shown.picker ? (
        <>
          <FilePicker
            label={props.label}
            device={device}
            disabled={picked !== null || many !== null}
            onFile={(file) => {
              // A phone checks the size before reading a byte: a file too big for its memory could end the tab.
              const problem = fileSizeProblem(file.size, device);
              setTooBig(problem);
              if (!problem) setPicked({ file, device });
            }}
            {...(props.several
              ? {
                  onFiles: (files: File[]) => {
                    // Each file is read alone, so each is held to a phone's limit, named where one passes it.
                    const big = files.map((f) => ({ f, problem: fileSizeProblem(f.size, device) })).find((x) => x.problem !== null);
                    setTooBig(big ? fileError(big.f.name, big.problem!) : null);
                    if (!big) setMany({ files, device });
                  },
                }
              : {})}
          />
          {/* One hint under the picker, as the scene phases' picker has: a second would line up with the first, an edge the picker's padded words miss. */}
          <Help>
            <span>{props.hint}</span>
            {props.several ? (
              <>
                {" "}
                <span>{SEVERAL_HINT}</span>
              </>
            ) : null}
          </Help>
          {tooBig ? (
            <div role="alert">
              <Note>{tooBig}</Note>
            </div>
          ) : null}
        </>
      ) : null}
      {picked && shown.dialog ? <ImportDialog file={picked.file} device={picked.device} target={props.target} onClose={() => setPicked(null)} /> : null}
      {many && shown.dialog ? <FloorsImportDialog files={many.files} device={many.device} onClose={() => setMany(null)} /> : null}
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
      several
    />
  );
}

/** A phase from a Universal VTT file: its image only. */
export function UvttAddPhase(props: { scene: Scene }) {
  return <Entry label="Add a phase from a Universal VTT file" hint="Only its image is added." target={{ kind: "phase", sceneId: props.scene.id }} />;
}
