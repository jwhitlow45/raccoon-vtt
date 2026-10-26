import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { Button } from "../components/Button.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import { Row } from "../components/Row.tsx";
import ThisDevice from "../features/device/ThisDevice.tsx";
import { usePreview } from "../features/dm/previewContext.ts";
import { GUIDE_PATH } from "../features/guide/guide.ts";
import { useJobActive } from "../features/handouts/pdf/live.ts";
import { joinLinkToShare } from "../features/dm/shareLink.ts";
import { XCardButton } from "../features/xcard/XCardButton.tsx";
import { usePanelHeader, type PanelProps } from "../features/panels.ts";
import { viewFoldSlot } from "../features/view/choice.ts";
import { useRoomViewChoice, ViewName, ViewSheetDialog } from "../features/view/ViewMenu.tsx";
import { api } from "../lib/api.ts";
import { fullscreenSupported } from "../lib/fullscreen.ts";
import { navigate } from "../lib/navigation.ts";
import { formatRoomId } from "../lib/roomId.ts";
import { theme } from "../lib/theme.ts";
import { useScoped } from "../state/scope.ts";
import { useRoomView } from "../state/view.ts";
import AboutPanel from "./AboutPanel.tsx";
import MembersPanel from "./MembersPanel.tsx";
import SettingsPanel from "./SettingsPanel.tsx";

type Page = "members" | "settings" | "about" | "device";

const PAGES: Record<Page, { title: string; Component: (props: PanelProps) => ReactNode }> = {
  members: { title: "Members", Component: MembersPanel },
  settings: { title: "Room settings", Component: SettingsPanel },
  about: { title: "About", Component: AboutPanel },
  device: { title: "This device", Component: ThisDevice },
};

/**
 * The room menu: the things a table needs now and then, not every turn.
 * One toolbar button opens it, so the phone toolbar keeps room for the
 * panels used in play. Members, settings and about are panels of their own
 * and open inside it as its subpages: the sheet or side panel around it
 * titles its header with the page and puts "Back to Menu" there
 * (usePanelHeader), so the body holds only the page itself.
 */
export default function MenuPanel(props: PanelProps) {
  const role = useRoomView((s) => s.you?.role ?? "player");
  const roomId = useRoomView((s) => s.roomId);
  const preview = usePreview();
  const [page, setPage] = useState<Page | null>(null);
  const [copied, setCopied] = useState(false);
  // Leave room asks once while a PDF upload is under way on this device (docs/design-v1-pdf-handouts.md 4.1.6).
  const uploading = useJobActive();
  const [asking, setAsking] = useState(false);
  const question = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (asking) question.current?.focus();
  }, [asking]);
  const playerLink = useDmPlayerLink(roomId, role === "dm" && preview === null, page === null);
  // "Copied, with the password" would vouch for a link the server has since replaced.
  useEffect(() => setCopied(false), [playerLink]);
  usePanelHeader(page ? { title: PAGES[page].title, parent: "Menu", onBack: () => setPage(null) } : null);

  if (page) {
    const { Component } = PAGES[page];
    return <Component {...props} />;
  }

  const share = joinLinkToShare({ roomId, origin: location.origin, playerLink });
  return (
    <nav aria-label="Room menu" style={{ display: "grid", gap: theme.space(2) }}>
      <XCardButton />
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap", paddingBottom: theme.space(1) }}>
        <span style={{ color: theme.color.textMuted, fontSize: theme.font.body14 }}>
          Room ID <strong style={{ fontFamily: theme.font.mono, color: theme.color.text }}>{formatRoomId(roomId)}</strong>
        </span>
        {/* It copies in place rather than going anywhere, so it is a quiet button with the copy icon, not accent text that reads as a link. */}
        <Button
          variant="quiet"
          size="sm"
          icon="copy"
          onClick={() => {
            navigator.clipboard.writeText(share.url).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? (share.withPassword ? "Copied, with the password" : "Copied") : share.label}
        </Button>
      </div>
      <ViewRow />
      <MenuItem icon="group" title="Members" detail={role === "dm" ? "Who is here, kicking, the player password and DM devices." : "Who is here and who is online."} page="members" onClick={() => setPage("members")} />
      {role === "dm" ? <MenuItem icon="settings" title="Room settings" detail="Movement, HP, combat, distance and backups." page="settings" onClick={() => setPage("settings")} /> : null}
      <MenuItem
        icon="device"
        title="This device"
        // A no-break space holds "sheet handle" together, so at 390 px and 130% "handle." never wraps onto a line alone.
        detail={fullscreenSupported() ? "Interface size, full screen, low power, map detail, sounds, shortcuts and sheet\u00a0handle." : "Interface size, low power, map detail, sounds, shortcuts and sheet\u00a0handle."}
        page="device"
        onClick={() => setPage("device")}
      />
      <MenuItem
        icon="guide"
        title="DM guide"
        detail={
          role === "dm"
            ? "How to build maps and run fights, step by step, with examples. Opens in a new tab."
            : "How the DM builds maps and runs fights, and what each tool does. Opens in a new tab."
        }
        // A new tab, so the room stays connected and where it was.
        onClick={() => window.open(GUIDE_PATH, "_blank", "noopener")}
      />
      <MenuItem icon="about" title="About" detail="Credits, licenses and the SRD notice." page="about" onClick={() => setPage("about")} />
      <MenuItem
        icon="leave"
        title="Leave room"
        detail={
          preview
            ? "Not available while viewing as a player."
            : "Back to the Home page. This device stays signed in, so you can come back without the password."
        }
        disabled={preview !== null}
        opener="menu-leave"
        onClick={() => (uploading && !asking ? setAsking(true) : navigate("/"))}
      />
      {asking ? (
        <div role="group" aria-label="Leave the room" style={{ display: "grid", gap: theme.space(2), padding: `0 ${theme.space(1)}px` }}>
          <p ref={question} tabIndex={-1} style={{ margin: 0, fontSize: theme.font.body14 }}>
            A PDF is still uploading. Leave anyway? This device offers to remove its pages next time.
          </p>
          <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
            <Button variant="danger" size="sm" onClick={() => navigate("/")}>
              Leave anyway
            </Button>
            <Button
              size="sm"
              onClick={(e) => {
                // Stay takes the question away, so focus goes back to Leave room rather than to the page.
                e.currentTarget.closest("nav")?.querySelector<HTMLElement>('[data-opener="menu-leave"]')?.focus();
                setAsking(false);
              }}
            >
              Stay
            </Button>
          </div>
        </div>
      ) : null}
    </nav>
  );
}

/**
 * The player link, fetched when a DM's menu page shows rather than on the
 * tap: Safari only lets a page write the clipboard straight from the tap,
 * not after a request finishes. Null for players, while it loads, and when
 * the server holds no password it can show, so the plain room link is
 * copied.
 *
 * The menu stays open while the DM changes the password on its Members
 * page, and another DM device can change it at any time, so a link fetched
 * once would copy a password that no longer works. It is fetched again
 * each time the menu's own page shows, on the server's `access` signal, and
 * after a reconnect, when a signal may have been missed (accessVersion).
 */
function useDmPlayerLink(roomId: string, dm: boolean, shown: boolean): string | null {
  const accessVersion = useRoomView((s) => s.accessVersion);
  const [link, setLink] = useState<string | null>(null);
  useEffect(() => {
    setLink(null);
    if (!dm || !shown) return;
    let live = true;
    api.getPlayerLink(roomId).then(
      (res) => live && setLink(res.playerLink),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [roomId, dm, shown, accessVersion]);
  return link;
}

/**
 * The View row, while the narrowest phone's top bar has folded its View
 * button away (features/view/choice.ts viewFoldSlot, D-261026-12): it
 * opens the same View sheet the button does, over the menu. Its place
 * stays in the menu, empty while the bar holds the button, so the menu's
 * sheet can still be found from it once the row is gone.
 */
/**
 * Where focus goes when the Menu loses the control that held it: a phone
 * sheet's title, or in the side panel, which draws no title, the tab or the
 * split bar's name that labels the pane (pages/Room.tsx SidePane). The wide
 * bar folds View into the Menu too, and there the Menu is no <dialog>.
 */
function menuFallback(place: HTMLElement | null): HTMLElement | null {
  const sheet = place?.closest("dialog");
  if (sheet) return sheet.querySelector<HTMLElement>("h1, h2, h3");
  const pane = place?.closest('[role="tabpanel"][aria-labelledby], [role="group"][aria-labelledby]');
  const label = pane?.getAttribute("aria-labelledby");
  return label ? document.getElementById(label) : null;
}

function ViewRow() {
  const folded = useStore(useScoped(viewFoldSlot), (s) => s.folded);
  const choice = useRoomViewChoice();
  const [open, setOpen] = useState(false);
  const place = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (folded || !open) return;
    // A widening that unfolds the row closes its sheet for good, so a narrowing after never opens it unasked (ISO5-ASTRA-04).
    setOpen(false);
    // Focus was in that sheet, and the row it would go back to is gone with it, so it goes where a panel's subpage hands it when its title is gone (features/panels.ts useSubpageFocus).
    const active = document.activeElement;
    const target = menuFallback(place.current);
    if (target && (active === null || active === document.body)) target.focus({ preventScroll: true });
  }, [folded, open]);
  return (
    <div ref={place} style={{ display: "contents" }}>
      {folded ? (
        <>
          <MenuItem
            icon={choice.shown.kind === "isometric" ? "viewIsometric" : "viewTopDown"}
            title="View"
            detail={
              <>
                Showing <ViewName kind={choice.shown.kind} /> on this device. Follow the scene, <ViewName kind="topDown" /> or Isometric, and turning the map.
              </>
            }
            onClick={() => setOpen(true)}
          />
          {open ? <ViewSheetDialog choice={choice} onClose={() => setOpen(false)} /> : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * A menu item as a card row (docs/design-v1-visual.md 2.3). Its detail
 * wraps rather than ending in an ellipsis, since it is the only place that
 * says what the page holds. One that opens a page of the menu ends in a
 * chevron and carries the page's key for Back to find it by
 * (features/panels.ts useSubpageFocus), and Leave room, which leaves, does
 * neither.
 */
function MenuItem(props: { icon: IconName; title: string; detail: ReactNode; page?: Page; opener?: string; disabled?: boolean; onClick(): void }) {
  return (
    <Row
      // Before the words, so a list read by scanning is found by its icons (docs/design-v1-icons.md 10.2).
      leading={<Icon name={props.icon} style={{ color: props.disabled ? theme.color.textDisabled : theme.color.textMuted }} />}
      title={props.title}
      detail={<span style={{ whiteSpace: "normal" }}>{props.detail}</span>}
      trailing={props.page ? <Icon name="chevronRight" style={{ color: theme.color.textMuted }} /> : undefined}
      opener={props.page ? `menu-${props.page}` : props.opener}
      disabled={props.disabled}
      onClick={props.onClick}
    />
  );
}
