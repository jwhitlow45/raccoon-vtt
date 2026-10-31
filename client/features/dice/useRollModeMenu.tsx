import { useEffect, useId, useLayoutEffect, useRef, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { usePopover } from "../../components/Popover.tsx";
import { theme } from "../../lib/theme.ts";
import { RollModeMenu } from "./RollModeMenu.tsx";
import { attachConsumedTouch, RollPress } from "./rollPress.ts";
import { hasRollModeMenu, rollModeHint, rollModeItems, type RollModeCapability, type RollModeOverride } from "./rollMode.ts";

export type UseRollModeMenuOptions = {
  /** Include every input that can change the roll or its route. Stable primitives work best. */
  source: string;
  name: string;
  capability: RollModeCapability;
  /** Only cases where the base tap did nothing, such as native disabled or busy. Ordinary taps call onTap when not disabled and the press allows them. */
  disabled?: boolean;
  dm: boolean;
  onTap(): void;
  onRoll(override: RollModeOverride): void;
  /** Guards menu opening and picking only. Ordinary taps still reach their existing handler and error feedback. */
  valid?(): boolean;
  fallbackFocus?(): HTMLElement | null;
};
export type RollModeButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { ref(node: HTMLButtonElement | null): void; tooltipHold?: boolean };
export type RollModeMenuBinding = {
  buttonProps: RollModeButtonProps;
  menu: ReactNode;
  open: boolean;
  /** Compose existing proficiency/route descriptions, then spread the result on the button. */
  describe(existing?: string): string | undefined;
  /** Paint-only styles. Merge after the source button's styles. No geometry changes. */
  pressStyle: CSSProperties;
};

/** Browser scroll anchoring may move the panel as results land. Keep an open menu while its source is still in view. */
export function handleRollModeScroll(input: { target: EventTarget | null; anchor: HTMLElement | null; open: boolean; cancel(): void; close(): void }): void {
  const { target, anchor } = input;
  if (!anchor || !(target === document || target instanceof Element && target.contains(anchor))) return;
  if (input.open) {
    const source = anchor.getBoundingClientRect();
    const viewport = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const container = target instanceof Element ? target.getBoundingClientRect() : viewport;
    const left = Math.max(source.left, container.left, viewport.left);
    const top = Math.max(source.top, container.top, viewport.top);
    const right = Math.min(source.right, container.right, viewport.right);
    const bottom = Math.min(source.bottom, container.bottom, viewport.bottom);
    if (left < right && top < bottom) return;
  }
  input.cancel();
  input.close();
}

export function useRollModeMenu(options: UseRollModeMenuOptions): RollModeMenuBinding {
  const latest = useRef(options);
  latest.current = options;
  const openedSource = useRef<string | null>(null);
  const hintId = useId();
  const heldShadow = useRef<{ node: HTMLElement; before: string; painted: string } | null>(null);
  const sourceGroup = useRef<HTMLElement | null>(null);
  const sourceRoot = useRef<HTMLElement | null>(null);
  const hint = rollModeHint(options.capability);
  const enabled = hasRollModeMenu(options.capability) && !options.disabled;
  const handle = usePopover({ kind: "menu", onClose: () => { openedSource.current = null; }, fallbackFocus: () => {
    if (latest.current.fallbackFocus) return latest.current.fallbackFocus();
    const group = sourceGroup.current;
    const parent = group?.isConnected ? group : sourceRoot.current;
    return parent?.isConnected ? parent.querySelector<HTMLElement>("button[data-group-fold], button:not([disabled]), [tabindex='0']") : null;
  } });
  const current = useRef(handle);
  current.current = handle;
  const machine = useRef<RollPress | null>(null);
  const detach = useRef<(() => void) | null>(null);
  const touchId = useRef<number | null>(null);
  const clearTouch = () => { detach.current?.(); detach.current = null; };
  const press = () => machine.current ??= new RollPress({
    releaseTouch: clearTouch,
    open: () => current.current.open,
    show: (by) => {
      if (!latest.current.disabled && latest.current.valid?.() !== false) {
        openedSource.current = latest.current.source;
        current.current.show({ by, from: "first" });
      }
    },
    close: () => current.current.close("anchor"),
    hint: (on) => {
      const node = current.current.anchor.current;
      // A paint-only ring avoids a React render during the held press and keeps proficiency borders intact.
      if (on && node) {
        const before = node.style.boxShadow;
        node.style.boxShadow = [before, `inset 0 0 0 2px ${theme.color.accent}`].filter(Boolean).join(", ");
        heldShadow.current = { node, before, painted: node.style.boxShadow };
      } else if (heldShadow.current) {
        const held = heldShadow.current;
        // A render may have changed the proficiency frame during the hold.
        if (held.node.style.boxShadow === held.painted) held.node.style.boxShadow = held.before;
        heldShadow.current = null;
      }
    },
  });
  const source = options.source;
  const capabilityKey = JSON.stringify(options.capability);
  useLayoutEffect(() => {
    machine.current?.cancel();
    clearTouch();
    current.current.close("anchor");
  }, [source, enabled, capabilityKey]);
  useLayoutEffect(() => {
    if (!handle.open) return;
    return raiseRollModeHosts(handle.anchor.current);
  }, [handle.open]);
  useEffect(() => {
    if (!enabled) return;
    const down = (e: PointerEvent) => {
      const p = machine.current;
      if (!p) return;
      if (p.activeId !== null && p.activeId !== e.pointerId) { p.cancel(); clearTouch(); }
      else if (p.activeId === null) p.fresh();
    };
    const move = (e: PointerEvent) => { machine.current?.move({ id: e.pointerId, x: e.clientX, y: e.clientY }); if (machine.current?.activeId === null) clearTouch(); };
    const end = (e: PointerEvent) => { if (machine.current?.activeId === e.pointerId) { e.type === "pointerup" ? machine.current.up(e.pointerId) : machine.current.cancel(); clearTouch(); } };
    const cancel = () => { machine.current?.cancel(); clearTouch(); };
    const scroll = (e: Event) => handleRollModeScroll({ target: e.target, anchor: current.current.anchor.current, open: openedSource.current !== null, cancel, close: () => current.current.close("anchor") });
    const key = () => { machine.current?.key(); clearTouch(); };
    const blur = () => { cancel(); current.current.close("anchor"); };
    const hidden = () => { if (document.hidden) { cancel(); current.current.close("anchor"); } };
    const click = (e: MouseEvent) => {
      if (machine.current && !machine.current.click(e.detail, false)) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("click", click, true);
    window.addEventListener("blur", blur);
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      cancel();
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("click", click, true);
      window.removeEventListener("blur", blur);
      document.removeEventListener("scroll", scroll, true);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [enabled]);
  useEffect(() => () => { machine.current?.dispose(); machine.current = null; clearTouch(); }, []);
  const describe = (existing?: string) => [existing, enabled && hint ? hintId : undefined].filter(Boolean).join(" ") || undefined;
  const buttonProps: RollModeButtonProps = {
    ref: (node) => {
      if (node) {
        sourceGroup.current = node.closest<HTMLElement>("[data-panel-group], [data-dice-panel], [data-roll-row]") ?? node.parentElement;
        sourceRoot.current = node.closest<HTMLElement>("[data-dice-panel]");
      }
      handle.anchorProps.ref(node);
    },
    onClick: (e) => { if (!latest.current.disabled && press().click(e.detail)) latest.current.onTap(); },
  };
  if (enabled) Object.assign(buttonProps, {
    "aria-haspopup": "menu", "aria-expanded": handle.open, "aria-controls": handle.open ? handle.contentId : undefined,
    "aria-keyshortcuts": "ContextMenu Shift+F10", "aria-describedby": describe(), tooltipHold: false,
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      press().down({ id: e.pointerId, x: e.clientX, y: e.clientY }, e.pointerType, e.isPrimary, e.button);
      if (e.pointerType === "touch" && press().activeId !== null) { clearTouch(); detach.current = attachConsumedTouch(document, () => press().consumed, touchId.current); }
    },
    onTouchStart: (e: React.TouchEvent<HTMLButtonElement>) => {
      touchId.current = e.changedTouches[0]?.identifier ?? null;
      if (!detach.current && press().activeId !== null) detach.current = attachConsumedTouch(document, () => press().consumed, touchId.current);
    },
    onTouchEnd: () => { touchId.current = null; clearTouch(); },
    onTouchCancel: () => { touchId.current = null; press().cancel(); clearTouch(); },
    onLostPointerCapture: () => { press().cancel(); clearTouch(); },
    onContextMenu: (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      const native = e.nativeEvent as PointerEvent;
      const touch = native.pointerType === "touch" || (native.pointerType !== "mouse" && press().touchSequence) || (native as PointerEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents;
      const by = touch ? "touch" : !native.pointerType && e.detail === 0 ? "key" : "mouse";
      press().context(by);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if ((e.key === "ContextMenu" || e.key === "F10" && e.shiftKey) && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); press().context("key"); }
    },
  });
  return {
    buttonProps, describe, open: handle.open, pressStyle: enabled ? { WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" } : {},
    menu: <>{enabled && hint ? <span hidden id={hintId}>{hint}</span> : null}{enabled ? <RollModeMenu handle={handle} name={options.name} capability={options.capability} dm={options.dm} onPick={(override) => {
      const at = latest.current;
      if (openedSource.current !== at.source) return;
      if (!rollModeItems(at.capability, at.dm).some((item) => item.id === override && !item.disabled)) return;
      const identity = at.source;
      flushSync(() => current.current.close("pick"));
      if (identity === latest.current.source && !latest.current.disabled && at.valid?.() !== false) {
        current.current.anchor.current?.dispatchEvent(new CustomEvent("rvtt-roll-mode-origin", { bubbles: true }));
        at.onRoll(override);
      }
    }} /> : null}</>,
  };
}

/** Keep higher overlays above the menu and leave later host updates alone. */
export function raiseRollModeHosts(anchor: HTMLElement | null): () => void {
  const hosts: { node: HTMLElement; before: string; painted: string }[] = [];
  for (let node = anchor?.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.position === "static" || style.zIndex !== "auto" && Number(style.zIndex) >= theme.z.popover) continue;
    const before = node.style.zIndex;
    node.style.zIndex = String(theme.z.popover);
    hosts.push({ node, before, painted: node.style.zIndex });
  }
  return () => { for (const host of hosts) if (host.node.style.zIndex === host.painted) host.node.style.zIndex = host.before; };
}
