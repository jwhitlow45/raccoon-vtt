import { useRef, type ReactNode, type Ref, type RefObject } from "react";
import { chromeZoom, smallUi } from "../features/device/layout.ts";
import { useUiScale } from "../features/device/settings.ts";
import { subpageBack, useSubpageFocus, type PanelHeader } from "../features/panels.ts";
import { theme } from "../lib/theme.ts";
import { sheetMaxHeight } from "./sheetCap.ts";
import { SheetHeader, type HeaderBack } from "./SheetHeader.tsx";

/**
 * A panel over the map on phones (design section 14.4): a bottom sheet in
 * portrait, a sheet docked on the right in landscape, where the short
 * screen height has no room for one at the bottom. `inset` keeps it clear
 * of the top bar and the bottom toolbar, which both also grow by the safe
 * area, so the sheet adds that too. `onBack` puts a back button before the
 * title, for a sheet opened from another sheet.
 *
 * A sheet takes this device's interface size (features/device/layout.ts),
 * as the bars it stands between do, so its insets in its own pixels meet
 * theirs.
 *
 * `subpage` is the panel's subpage, from usePanelHeader through
 * PanelHeaderHost (features/panels.ts): while set, the header shows the
 * subpage's title, and its back button returns to the panel's first page
 * ("Back to Menu") instead of doing `onBack`. The sheet keeps its own name,
 * the panel's, for its region and its close button. Focus follows: to the
 * title on entry, back to the opener on Back (useSubpageFocus).
 *
 * `reserveTop` keeps that many pixels free above a bottom sheet for what
 * docks on its edge (docs/design-v1-visual.md 3.2.1), in place of the
 * usual 24 px gap, and the sheet never goes below 120 px (sheetCap.ts).
 * A sheet on the right runs the screen's height, so it has no reserve.
 */
export function Sheet(props: {
  ref?: Ref<HTMLElement>;
  title: string;
  placement: "bottom" | "right";
  inset: { top: number; bottom: number };
  onClose(): void;
  onBack?(): void;
  backLabel?: string;
  subpage?: PanelHeader | null;
  reserveTop?: number;
  /** In the header, between the title and the close button, such as the dock's buttons when the dock has no room (3.2.1). */
  actions?: ReactNode;
  /** Focus moves to the back button, or the close button without one, once the token bar's Close leaves the sheet (3.2.1). */
  backRef?: Ref<HTMLButtonElement>;
  closeRef?: Ref<HTMLButtonElement>;
  /** The header's title, a heading that takes focus from script, for a room that moves focus into the sheet it just opened. */
  titleRef?: RefObject<HTMLHeadingElement | null>;
  children: ReactNode;
}) {
  const { placement, inset, subpage } = props;
  const zoom = useUiScale();
  const ownTitleRef = useRef<HTMLHeadingElement>(null);
  const titleRef = props.titleRef ?? ownTitleRef;
  const bodyRef = useRef<HTMLDivElement>(null);
  useSubpageFocus(subpage ?? null, { title: titleRef, body: bodyRef });
  const bottom = placement === "bottom";
  const insetTop = `calc(${theme.safe.top} + ${inset.top}px)`;
  const insetBottom = `calc(${theme.safe.bottom} + ${inset.bottom}px)`;
  const back: HeaderBack | null = subpage ? subpageBack(subpage) : props.onBack ? { label: props.backLabel ?? "Back", onBack: props.onBack } : null;
  return (
    <section
      ref={props.ref}
      aria-label={props.title}
      {...smallUi(zoom)}
      style={{
        ...chromeZoom(zoom),
        position: "absolute",
        zIndex: theme.z.sheet,
        display: "flex",
        flexDirection: "column",
        background: theme.color.surface,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        boxShadow: theme.shadow.sheet,
        ...(bottom
          ? {
              left: 0,
              right: 0,
              bottom: insetBottom,
              maxHeight: sheetMaxHeight(inset, props.reserveTop),
              borderRadius: `${theme.radius.lg}px ${theme.radius.lg}px 0 0`,
              paddingLeft: theme.safe.left,
              paddingRight: theme.safe.right,
            }
          : {
              top: insetTop,
              bottom: insetBottom,
              right: 0,
              width: theme.layout.landscapeSheetWidth,
              maxWidth: "60%",
              borderRadius: `${theme.radius.lg}px 0 0 ${theme.radius.lg}px`,
              paddingRight: theme.safe.right,
            }),
      }}
    >
      <SheetHeader
        title={subpage?.title ?? props.title}
        back={back}
        actions={props.actions}
        onClose={props.onClose}
        closeLabel={`Close ${props.title}`}
        backRef={props.backRef}
        closeRef={props.closeRef}
        titleRef={titleRef}
      />
      {/* The 4 px on top hold the focus ring of a first full-width control (2 px out, 2 px wide), which the scrolling body would clip. */}
      <div ref={bodyRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: `${theme.space(1)}px ${theme.space(4)}px ${theme.space(4)}px`, overscrollBehavior: "contain" }}>
        {props.children}
      </div>
    </section>
  );
}
