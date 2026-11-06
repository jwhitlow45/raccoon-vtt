import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Held } from "../../components/Held.tsx";
import { Help } from "../../components/Panel.tsx";
import { idle } from "../../lib/idle.ts";
import { theme } from "../../lib/theme.ts";
import { D20Icon } from "../dice/throw/D20Icon.tsx";
import { DICE_SETS } from "../dice/throw/sets.ts";
import { diceLoader } from "../dice/throw/hooks.ts";
import { useThrows, useThrowView } from "../dice/throw/useThrows.ts";
import { setDiceSetId, useDiceSetId, useLowPower, useRollAnimation } from "./settings.ts";

/**
 * "Dice" in This device's Rolls (docs/design/design-v1-roll-animation.md 9.2): a
 * radio group of tiles, each the set's d20 showing 20 above its name. The
 * choice is kept on this device, never in the room.
 *
 * Where the dice can be drawn, the dice chunk renders each set's d20 once,
 * in a quiet moment, and copies it into the tile. Until then, and with the
 * switch off, Low power, no WebGL or a failed load, each tile shows the
 * flat d20 in the set's colors. Nothing animates. While a throw is on
 * screen the renderer is busy, and the previews wait for it to end. On a
 * lost context the tiles keep their flat icons.
 */

/** The d20 in each tile, and the tile's narrowest: four to a row at 390 px, three at 320. */
const DIE_PX = 48;
const TILE_MIN_PX = 72;

/**
 * A tile's look, chosen or not, with the switch on or off. Every tile has
 * the same border and padding. The chosen tile's second pixel of ring is an
 * inset shadow, so a pick never makes its row taller than the other and the
 * alignment check sees equal padding on every tile.
 * With the switch off the chosen tile keeps a dim outline and no tint, as
 * every chosen option that cannot change now does (components/looks.ts),
 * so it still reads as the one chosen.
 */
export function tileStyle(picked: boolean, on: boolean): CSSProperties {
  const edge = !picked ? theme.color.border : on ? theme.color.accent : theme.color.textDisabled;
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
    background: picked && on ? theme.color.accentTint : "transparent",
    color: on ? theme.color.text : theme.color.textDisabled,
    cursor: on ? "pointer" : "default",
  };
}

export function DiceSetPicker() {
  const on = useRollAnimation();
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

  const previews = drawn && on && !lowPower;
  return (
    <Held held={!on}>
      <legend style={{ padding: 0, fontSize: theme.font.input, fontWeight: theme.weight.strong, color: on ? theme.color.text : theme.color.textDisabled }}>Dice</legend>
      {/*
       * One column under the legend, as RadioCards stands its cards (docs/design/design-v1-spacing-pass.md S2): the help space(1) under it and the
       * tiles space(2) under whatever stands above them, further than the tiles stand from each other. Margins, since a fieldset's gap never
       * reaches its legend.
       */}
      <div style={{ display: "grid", minWidth: 0 }}>
        {on ? null : <Help style={{ marginTop: theme.space(1) }}>Turn on Roll animation to throw dice.</Help>}
        {/* Marked as a card group for the spacing check (e2e/helpers/spacing.ts), as RadioCards' cards are. */}
        <div data-card-group="" style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_MIN_PX}px, 1fr))`, gap: theme.space(1), marginTop: theme.space(2) }}>
          {DICE_SETS.map((set) => {
            const picked = set.id === chosen;
            return (
              <label key={set.id} className="rvtt-choice" data-dice-set={set.id} style={tileStyle(picked, on)}>
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
    </Held>
  );
}
