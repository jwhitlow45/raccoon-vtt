/** Places portal hosts in display order without remounting their toast contents. */
export function putToastHosts(stack: HTMLElement, hosts: readonly HTMLElement[]): void {
  const focused = stack.ownerDocument.activeElement as HTMLElement | null;
  let movedFocus = false;
  let at: ChildNode | null = stack.firstChild;
  for (const host of hosts) {
    if (host !== at) {
      movedFocus ||= focused !== null && host.contains(focused);
      stack.insertBefore(host, at);
    }
    at = host.nextSibling;
  }
  // insertBefore detaches even a live portal host, which blurs its action.
  if (movedFocus && focused && stack.ownerDocument.activeElement !== focused) focused.focus({ preventScroll: true });
}

/** The bottom of map toasts that can keep a new toast from moving under its card. */
export function keptMapFoot(boxes: readonly { id: number; bottom: number }[], awaitCard: ReadonlySet<number>, zoom: number): number | null {
  const kept = boxes.filter((b) => !awaitCard.has(b.id));
  return kept.length ? Math.max(...kept.map((b) => b.bottom)) / zoom : null;
}

/** Visible map toasts block a summary row, but only toasts staying there reserve space above a card. */
export function mapToastBox(boxes: readonly { id: number; top: number; bottom: number }[], awaitCard: ReadonlySet<number>, zoom: number, clip: { top: number; bottom: number }): { top: number; bottom: number; keptBottom: number | null } | null {
  const visible = boxes.map((b) => ({ id: b.id, top: Math.max(b.top, clip.top), bottom: Math.min(b.bottom, clip.bottom) })).filter((b) => b.bottom > b.top);
  if (visible.length === 0) return null;
  return { top: Math.min(...visible.map((b) => b.top)) / zoom, bottom: Math.max(...visible.map((b) => b.bottom)) / zoom, keptBottom: keptMapFoot(visible, awaitCard, zoom) };
}
