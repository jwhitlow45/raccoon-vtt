import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { Button } from "../../components/Button.tsx";
import { Help } from "../../components/Panel.tsx";
import { useBackClose } from "../../lib/backClose.ts";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import { useAssets, useRoomView } from "../../state/view.ts";
import { closedSlot, closedStorageKey, closeHandout, loadClosed } from "./closed.ts";
import { useXCard } from "../xcard/XCardHost.tsx";
import { prefersShare, shareFile } from "../mapexport/save.ts";
import { downloadAction, fetchHandoutImage, handoutFile, saveBegin, saveForget, saveSettled, saveThroughLink, type SaveOutcome, type SaveStates } from "./download.ts";
import { nextPopup, popupShows, showingKey } from "./handouts.ts";
import { HandoutViewer } from "./HandoutViewer.tsx";

/**
 * A handout the DM shows pops up over the map for the players it was shown
 * to (features section 16). Closing it hides it on this device only, and
 * it stays closed across a reload (closed.ts). The Library panel opens it
 * again. The DM closes a handout for everyone from the DM panel, and then
 * it simply leaves this view. Mounted once by the Room page.
 *
 * DMs get no popup: the DM chose the handout, and the DM panel lists what
 * is showing.
 *
 * It is the handout viewer (HandoutViewer.tsx, docs/design-v1-layout-hierarchy.md
 * section 5): the whole screen on a phone, a wide card on a computer that
 * grows to the window as it zooms, with the close icon in its header. It
 * keeps a deeper backdrop than other dialogs, since a dim map helps the
 * handout read, and a tap beside the card does not close it, so a pinch
 * that strays past the picture never loses it. It stays open while one
 * handout follows another. Download, beside the close button, saves the
 * image to the device (download.ts).
 */
export function HandoutPopup() {
  const role = useRoomView((s) => s.you?.role);
  const roomId = useRoomView((s) => s.roomId);
  const memberId = useRoomView((s) => s.you?.memberId ?? null);
  const handouts = useRoomView((s) => s.view?.handouts);
  const assets = useAssets();
  const closedStore = useScoped(closedSlot);
  const { storageKey, closed, preferId } = useStore(closedStore);
  const wantKey = memberId ? closedStorageKey(roomId, memberId) : null;
  // Nothing pops up until this device's closed list is read, or a reload would flash every handout.
  const next = role === "player" && handouts && storageKey === wantKey && wantKey ? nextPopup(handouts, closed, preferId) : null;
  // Whether the dialog was open after the last render, so a handout that would open under the X-card waits for it (handouts.ts popupShows).
  const openRef = useRef(false);
  const xcard = useXCard();
  const shows = popupShows({ handout: next !== null, open: openRef.current, xcard: xcard.showing });
  useEffect(() => {
    openRef.current = shows;
  });
  const handout = shows ? next : null;
  const key = handout ? showingKey(handout) : null;

  useEffect(() => {
    if (wantKey) loadClosed(closedStore, wantKey);
  }, [closedStore, wantKey]);

  const close = () => {
    if (key && handouts) closeHandout(closedStore, key, handouts);
  };

  // Each handout's Download, by its key (download.ts SaveStates).
  const [saving, setSaving] = useState<SaveStates>({});
  const lastOp = useRef(0);
  const url = handout ? assets.url(handout.assetId, "full") : null;
  /*
   * The image in hand, fetched as the popup opens, so a tap on Download can
   * open the share sheet at once, inside the tap (download.ts). It comes
   * from the cache the picture just filled. A failure here is quiet: the
   * tap fetches again, and says so if that fails too. The image is let go
   * when the popup closes, and fetched again when it opens.
   */
  const [ready, setReady] = useState<{ key: string; blob: Blob } | null>(null);
  useEffect(() => {
    if (!key || !url) return;
    const controller = new AbortController();
    fetchHandoutImage(url, controller.signal).then(
      (blob) => setReady({ key, blob }),
      () => {},
    );
    return () => {
      controller.abort();
      setReady((r) => (r?.key === key ? null : r));
    };
  }, [key, url]);
  /*
   * A download under way goes on when the popup closes, since the player
   * asked for the file, and the same handout opened again from the Library
   * shows it still working until it ends (P3R-6). Cancelled instead, it
   * left that Download busy for good. A failure belongs to the popup that
   * saw it, so the handout opened again starts clean.
   */
  useEffect(
    () => () => {
      if (key) setSaving((s) => saveForget(s, key));
    },
    [key],
  );
  const mine = key ? saving[key] : undefined;
  const busy = mine?.state === "busy";
  const download = async () => {
    if (!handout || !key || !url || busy) return;
    const op = ++lastOp.current;
    // Every change goes through this handout's entry and this press's number (download.ts saveSettled).
    const settle = (outcome: SaveOutcome) => setSaving((s) => saveSettled(s, key, op, outcome));
    const blob = ready?.key === key ? ready.blob : null;
    const file = blob ? handoutFile(blob, handout.title) : null;
    const action = downloadAction(file !== null, file !== null && prefersShare(file));
    if (file && action === "share") {
      setSaving((s) => saveBegin(s, key, op, "sharing"));
      // Called before any wait, so the share sheet opens within the tap. Closing the sheet is a choice, not a failure.
      settle((await shareFile(file)) === "failed" ? "share failed" : "done");
      return;
    }
    if (file && action === "link") {
      saveThroughLink(file);
      setSaving((s) => saveSettled(saveBegin(s, key, op, "busy"), key, op, "done"));
      return;
    }
    setSaving((s) => saveBegin(s, key, op, "busy"));
    try {
      const fetched = await fetchHandoutImage(url);
      // Kept for a share's second tap, unless another handout's image is in hand by now.
      setReady((r) => (r && r.key !== key ? r : { key, blob: fetched }));
      const made = handoutFile(fetched, handout.title);
      if (prefersShare(made)) {
        settle("share");
        return;
      }
      saveThroughLink(made);
      settle("done");
    } catch {
      settle("fetch failed");
    }
  };
  const label = busy ? "Downloading…" : mine?.state === "share" ? "Share" : "Download";

  // Android's Back closes the handout before it leaves the room, one Back for each handout shown in turn.
  useBackClose(key, close);

  if (!handout || !key || !url) return null;
  return (
    <HandoutViewer
      title={handout.title}
      onClose={close}
      pages={[{ src: url, alt: handout.title }]}
      headerActions={
        // A busy button says so in its own words at once, and takes no second tap (components/Loading.tsx).
        <Button size="sm" busy={busy} onClick={() => void download()}>
          {label}
        </Button>
      }
      lead={
        <>
          <Help>The DM shows you</Help>
          {mine?.state === "failed" ? (
            <div role="alert" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), fontSize: theme.font.body14, color: theme.color.dangerText }}>
              <span style={{ flex: "1 1 200px" }}>
                {mine.why === "share" ? "The handout could not be shared." : "The handout could not be downloaded. Check your connection."}
              </span>
              <Button size="sm" onClick={() => void download()}>
                Try again
              </Button>
            </div>
          ) : null}
        </>
      }
    />
  );
}
