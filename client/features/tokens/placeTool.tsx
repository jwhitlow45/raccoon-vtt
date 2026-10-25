import { useStore } from "zustand";
import type { TokenKind } from "#shared/model.ts";
import type { ToolContext, ToolDef, ToolPointer } from "../tools.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomUi } from "../../state/view.ts";
import { ChoiceRows, OptButton, OptionsStrip, PickCloses, ValueChip } from "../measure/controls.tsx";
import { placeOnGround } from "../movement/ground.ts";
import type { Point } from "./factory.ts";
import { pendingTokens } from "./placeInputs.ts";
import { BLANK_KINDS, PLACE_TOOL_ID, describePending, placementSlot, resetPending, setPending, type Pending } from "./placement.ts";
import { placeCycle } from "../toolChoices.ts";
import { TOOL_ORDER } from "../toolbarOrder.ts";

/** A tap moves less than this on screen. More is a slip of the finger, and places nothing. */
const TAP_SLOP_PX = 10;

/**
 * Creates the tokens the pending choice describes, spread around the tapped
 * point so a batch of goblins never stacks, then selects the last one and
 * goes back to the select tool, so the next tap selects instead of placing
 * more by accident.
 */
function place(world: Point, ctx: ToolContext): void {
  const view = ctx.getState().view;
  if (!view) return;
  const scene = ctx.scene;
  const pending = ctx.scope.get(placementSlot).store.getState().pending;
  if (pending.kind === "batch") {
    const placed = pending.place(world, ctx);
    if (placed) ctx.ui.select(placed, { opens: true });
    ctx.ui.setTool("select");
    return;
  }
  if (pending.kind === "character" && !view.characters[pending.characterId]) return;
  const inputs = pendingTokens(pending, { view, scene, world, newId: ctx.actions.newId });

  let last: string | null = null;
  for (const token of inputs) if (ctx.actions.dispatch({ t: "token.create", token: placeOnGround(view.buildChunks, token) }) !== null) last = token.id;
  if (last) ctx.ui.select(last, { opens: true });
  ctx.ui.setTool("select");
}

export const placeTool: ToolDef = {
  id: PLACE_TOOL_ID,
  label: "Add token",
  shortLabel: "Add",
  icon: { path: "M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z" },
  roles: ["dm"],
  order: TOOL_ORDER[PLACE_TOOL_ID],
  cursor: "copy",
  pointer: {
    down(p: ToolPointer, ctx: ToolContext) {
      ctx.scope.get(placementSlot).downAt = p.screen;
    },
    up(p: ToolPointer, ctx: ToolContext) {
      const tool = ctx.scope.get(placementSlot);
      const start = tool.downAt;
      tool.downAt = null;
      if (!start || Math.hypot(p.screen.x - start.x, p.screen.y - start.y) > TAP_SLOP_PX) return;
      place(p.world, ctx);
    },
    cancel(ctx) {
      ctx.scope.get(placementSlot).downAt = null;
    },
  },
  deactivate(ctx) {
    ctx.scope.get(placementSlot).downAt = null;
    resetPending(ctx.scope);
  },
  Options: PlaceOptions,
  cycle: placeCycle,
};

/**
 * What the next tap will place, and the ways to pick something else
 * (docs/design-v1-tool-options.md 9.7): the blank kind as a chip, then
 * Monster… and Character…, or Cancel once something is chosen.
 */
function PlaceOptions() {
  const scope = useRoomScope();
  const pending = useStore(scope.get(placementSlot).store, (s) => s.pending);
  const ui = useRoomUi();
  if (pending.kind !== "blank") {
    return (
      <OptionsStrip
        tool="Add token"
        task
        line={{ tone: "hint", content: `Tap the map to place ${describePending(pending)}.` }}
        slots={[
          {
            id: "cancel",
            priority: 1,
            control: (
              <OptButton ends onClick={() => ui.setTool("select")}>
                Cancel
              </OptButton>
            ),
          },
        ]}
      />
    );
  }
  const kind = BLANK_KINDS.find((o) => o.value === pending.tokenKind)?.label ?? "";
  return (
    <OptionsStrip
      tool="Add token"
      line={{ tone: "hint", content: "Pick a blank token, a monster or a character, then tap the map." }}
      slots={[
        {
          id: "kind",
          priority: 1,
          control: (
            // No compact form: short words would read "Monster" beside "Monster…".
            <ValueChip label="Blank token kind" kind="choice" value={pending.tokenKind} valueName={kind} options={BLANK_KINDS.map((o) => ({ key: o.value, words: o.label }))}>
              <PickCloses>
                <ChoiceRows<TokenKind> label="Blank token kind" value={pending.tokenKind} options={BLANK_KINDS} onChange={(tokenKind) => setPending(scope, { kind: "blank", tokenKind } satisfies Pending)} />
              </PickCloses>
            </ValueChip>
          ),
        },
        { id: "monster", priority: 2, control: <OptButton onClick={() => ui.openPanel("monsters")}>Monster…</OptButton> },
        { id: "character", priority: 3, control: <OptButton onClick={() => ui.openPanel("characters")}>Character…</OptButton> },
      ]}
    />
  );
}
