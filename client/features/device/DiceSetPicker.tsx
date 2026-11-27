import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { idle } from "../../lib/idle.ts";
import { theme } from "../../lib/theme.ts";
import { D20Icon } from "../dice/throw/D20Icon.tsx";
import { DICE_SETS } from "../dice/throw/sets.ts";
import { diceLoader } from "../dice/throw/hooks.ts";
import { useThrows, useThrowView } from "../dice/throw/useThrows.ts";
import { partMark } from "../modules/gate.ts";
import { useModule } from "../modules/Gate.tsx";
import { setDiceSetId, useDiceSetId, useLowPower } from "./settings.ts";

/**
 * "Dice" in This device's Rolls (docs/design/design-v1-roll-animation.md 9.2): a
 * radio group of tiles, each the set's d20 showing 20 above its name. The
 * choice is kept on this device, never in the room.
 *
 * Where the dice can be drawn, the dice chunk renders each set's d20 once,
 * in a quiet moment, and copies it into the tile. Until then, and with Low
 * power, no WebGL or a failed load, each tile shows the flat d20 in the
 * set's colors. Nothing animates. While a throw is on screen the renderer
 * is busy, and the previews wait for it to end. On a lost context the tiles
 * keep their flat icons.
 *
 * It shows only while Dice animation shows for this role, which the Roll
 * animation switch above it turns on and off, so no dice set waits to be
 * picked for dice that never throw (docs/design/design-v1-features.md 3,
 * D-261127-396).
 */

/** The d20 in each tile, and the tile's narrowest: four to a row at 390 px, three at 320. */
const DIE_PX = 48;
const TILE_MIN_PX = 72;

/**
 * A tile's look, chosen or not. Every tile has the same border and
 * padding. The chosen tile's second pixel of ring is an inset shadow, so a
 * pick never makes its row taller than the other and the alignment check
 * sees equal padding on every tile.
 */
export function tileStyle(picked: boolean): CSSProperties {
  const edge = picked ? theme.color.accent : theme.color.border;
  // The strong line is the border plus this 1 px ring, in the tile's edge color rather than the text color.
  const ring = theme.shadow.markInside.replace("currentColor", edge);
  return {
    position: "relative",
    display: "grid",
    justifyItems: "center",
    gap: theme.space(1),
    minHeight: theme.touch,
    padding: `${theme.space(2)}px ${theme.space(1)}px`,
    borderRadius: theme.radius.md,
    border: `${theme.line.border}px solid ${edge}`,
    boxShadow: picked ? ring : undefined,
    background: picked ? theme.color.accentTint : "transparent",
    color: theme.color.text,
    cursor: "pointer",
  };
}

export function DiceSetPicker() {
  const on = useModule("diceAnimation");
  const lowPower = useLowPower();
  const chosen = useDiceSetId();
  const store = useThrows();
  const throwing = useThrowView().shown !== null;
  const loaded = useSyncExternalStore(diceLoader.subscribe, diceLoader.state, diceLoader.state);
  const name = useId();
  const canvases = useRef(new Map<string, HTMLCanvasElement>());
  const [drawn, setDrawn] = useState(false);
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);

  useEffect(() => {
    if (!on || lowPower || loaded !== "ready" || drawn || throwing || !store.previewsAllowed) return;
    const module = diceLoader.loaded();
    if (!module?.drawPreviews) return;
    let live = true;
    const cancel = idle(() => {
      // A context lost meanwhile: drawPreviews would make a renderer of its own for blank pictures.
      if (!store.previewsAllowed) return;
      const targets = DICE_SETS.flatMap((set) => {
        const canvas = canvases.current.get(set.id);
        return canvas ? [{ set: set.id, canvas }] : [];
      });
      module.drawPreviews!(targets, DIE_PX, store.stage).then(
        (ok) => live && ok && setDrawn(true),
        () => undefined,
      );
    }, 1000);
    return () => {
      live = false;
      cancel();
    };
  }, [on, lowPower, loaded, drawn, throwing, store]);

  if (!on) return null;
  const previews = drawn && !lowPower;
  return (
    <fieldset {...partMark("diceAnimation")} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      <legend style={{ padding: 0, fontSize: theme.font.input, fontWeight: theme.weight.strong, color: theme.color.text }}>Dice</legend>
      {/*
       * One column under the legend, as RadioCards stands its cards (docs/design/design-v1-spacing-pass.md S2): the tiles space(2) under it,
       * further than the tiles stand from each other. A margin, since a fieldset's gap never reaches its legend.
       */}
      <div style={{ display: "grid", minWidth: 0 }}>
        {/* Marked as a card group for the spacing check (e2e/helpers/spacing.ts), as RadioCards' cards are. */}
        <div data-card-group="" data-search="menu.this-device.rolls.dice-set" style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_MIN_PX}px, 1fr))`, gap: theme.space(1), marginTop: theme.space(2) }}>
          {DICE_SETS.map((set) => {
            const picked = set.id === chosen;
            return (
              <label key={set.id} className="rvtt-choice" data-dice-set={set.id} style={tileStyle(picked)}>
                <input
                  type="radio"
                  name={name}
                  value={set.id}
                  checked={picked}
                  onChange={() => setDiceSetId(set.id)}
                  // Unseen over its whole tile, as Segmented's: a tap anywhere hits it, the arrow keys move along the group, and a screen reader reads "Dice: Ruby, selected".
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%", margin: 0, opacity: 0, cursor: "inherit" }}
                />
                {/* Drawn over the radio, so taps pass through it to the radio under it. */}
                {/* The canvas flows in this box (it and the flat die never show together), so the alignment check measures the die and not only the name. */}
                <span style={{ position: "relative", width: DIE_PX, height: DIE_PX, pointerEvents: "none" }}>
                  {previews ? null : <D20Icon size={DIE_PX} text="20" body={set.body} edge={set.edge} ink={set.ink} />}
                  <canvas
                    aria-hidden="true"
                    ref={(el) => {
                      if (el) canvases.current.set(set.id, el);
                      else canvases.current.delete(set.id);
                    }}
                    width={DIE_PX * ratio}
                    height={DIE_PX * ratio}
                    style={{ width: DIE_PX, height: DIE_PX, display: previews ? "block" : "none" }}
                  />
                </span>
                <span style={{ fontSize: theme.font.small, fontWeight: theme.weight.strong, textAlign: "center", overflowWrap: "anywhere" }}>{set.name}</span>
              </label>
            );
          })}
        </div>
      </div>
    </fieldset>
  );
}
