import type { ReactNode } from "react";
import { useStore } from "zustand";
import type { TokenKind } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import type { ToolContext, ToolDef, ToolPointer } from "../tools.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomUi } from "../../state/view.ts";
import { InfoLine, OptionsColumn } from "../measure/controls.tsx";
import { placeOnGround } from "../movement/ground.ts";
import type { Point } from "./factory.ts";
import { pendingTokens } from "./placeInputs.ts";
import { PLACE_TOOL_ID, describePending, placementSlot, resetPending, setPending, type Pending } from "./placement.ts";
import { Select } from "./ui.tsx";

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
    if (placed) ctx.ui.select(placed);
    ctx.ui.setTool("select");
    return;
  }
  if (pending.kind === "character" && !view.characters[pending.characterId]) return;
  const inputs = pendingTokens(pending, { view, scene, world, newId: ctx.actions.newId });

  let last: string | null = null;
  for (const token of inputs) if (ctx.actions.dispatch({ t: "token.create", token: placeOnGround(view.buildChunks, token) }) !== null) last = token.id;
  if (last) ctx.ui.select(last);
  ctx.ui.setTool("select");
}

export const placeTool: ToolDef = {
  id: PLACE_TOOL_ID,
  label: "Add token",
  shortLabel: "Add",
  icon: { path: "M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z" },
  roles: ["dm"],
  // Right after select: the DM adds tokens all session long.
  order: 10,
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
};

const KIND_OPTIONS: { value: TokenKind; label: string }[] = [
  { value: "monster", label: "Blank monster" },
  { value: "npc", label: "Blank NPC" },
  { value: "object", label: "Blank object" },
  { value: "pc", label: "Blank player character" },
];

/** What the next tap will place, and the ways to pick something else. */
function PlaceOptions() {
  const scope = useRoomScope();
  const pending = useStore(scope.get(placementSlot).store, (s) => s.pending);
  const ui = useRoomUi();
  if (pending.kind !== "blank") {
    return (
      <OptionsLayout hint={`Tap the map to place ${describePending(pending)}.`}>
        <Group>
          <Button size="sm" onClick={() => ui.setTool("select")}>
            Cancel
          </Button>
        </Group>
      </OptionsLayout>
    );
  }
  return (
    <OptionsLayout hint="Pick a blank token, a monster or a character, then tap the map.">
      <Group>
        <div style={{ minWidth: 170 }}>
          <Select<TokenKind>
            label="Blank token kind"
            value={pending.tokenKind}
            options={KIND_OPTIONS}
            onChange={(tokenKind) => setPending(scope, { kind: "blank", tokenKind } satisfies Pending)}
          />
        </div>
      </Group>
      <Group>
        <Button size="sm" onClick={() => ui.openPanel("monsters")}>
          Monster…
        </Button>
        <Button size="sm" onClick={() => ui.openPanel("characters")}>
          Character…
        </Button>
      </Group>
    </OptionsLayout>
  );
}

/**
 * The layout every options bar shares (docs/design-v1-visual.md 3.4), from
 * the measure tools' controls so this bar matches theirs: the hint first,
 * so it reads before the controls it explains, then the controls in groups
 * that wrap rather than scroll, so none hides past the edge of a phone.
 */
function OptionsLayout(props: { hint: string; children: ReactNode }) {
  return (
    <OptionsColumn>
      <InfoLine tone="muted">{props.hint}</InfoLine>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), minWidth: 0 }}>{props.children}</div>
    </OptionsColumn>
  );
}

function Group(props: { children: ReactNode }) {
  return <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1), minWidth: 0 }}>{props.children}</div>;
}
