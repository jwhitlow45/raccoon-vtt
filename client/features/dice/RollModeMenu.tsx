import { useLayoutEffect } from "react";
import { Menu } from "../../components/Menu.tsx";
import { Popover, type PopoverHandle } from "../../components/Popover.tsx";
import { uiScale } from "../device/settings.ts";
import { theme } from "../../lib/theme.ts";
import { BATCH_HELP, REPEAT_HELP, rollModeItems, type RollModeCapability, type RollModeOverride } from "./rollMode.ts";

export type RollModeMenuProps = { handle: PopoverHandle; name: string; capability: RollModeCapability; dm: boolean; onPick(override: RollModeOverride): void };
export function RollModeMenu({ handle, name, capability, dm, onPick }: RollModeMenuProps) {
  useLayoutEffect(() => {
    if (!handle.open) return;
    const box = handle.box.current;
    // The popover's padding and scrollbar own touches as well as its rows.
    box?.setAttribute("data-roll-mode-menu", "");
    return () => box?.removeAttribute("data-roll-mode-menu");
  }, [handle.open, handle.box]);
  const items = rollModeItems(capability, dm);
  if (items.length === 0) return null;
  return (
    <Popover handle={handle} side="above" bound={() => ({ left: 0, top: 0, right: window.innerWidth / uiScale(), bottom: window.innerHeight / uiScale() })}>
      <div data-roll-mode-menu="" onContextMenu={(e) => e.preventDefault()}>
        <div style={{ fontSize: theme.font.small, color: theme.color.textMuted, maxWidth: 280, overflowWrap: "break-word", marginBottom: theme.space(2) }}>
          <p style={{ margin: 0 }}>{items.find((i) => i.id === "secret")?.description}</p>
          <p style={{ margin: 0 }}>{items.find((i) => i.id === "normal")?.description}</p>
          {capability.repeat ? <p style={{ margin: 0 }}>{REPEAT_HELP}</p> : null}
          {capability.batch ? <p style={{ margin: 0 }}>{BATCH_HELP}</p> : null}
        </div>
        <Menu label={`Roll options for ${name}`} sections={[{ key: "roll", items }]} skipDisabledOnOpen onPick={(id) => onPick(id as RollModeOverride)} />
      </div>
    </Popover>
  );
}
