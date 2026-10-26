/** The badge's size on screen, in pixels: the wolf trap in a disc. */
export const BADGE_PX = 20;

/**
 * The box a trap's badge covers in Top-down, in cells (TrapLayer.tsx Badge):
 * its disc with its outline, and the eye beside it where it shows, for the
 * stand rule (docs/design-v1-isometric-view.md 5.2).
 */
export function trapBadgeBox(at: { x: number; y: number }, scale: number, found: boolean): { x0: number; y0: number; x1: number; y1: number } {
  const s = 1 / scale;
  const r = (BADGE_PX / 2) * s;
  // The outline is 1.5 px, centered on the disc's edge.
  const edge = s;
  // The eye's disc sits 1.15 r right of the badge's middle and 0.85 r up, 0.6 r across.
  return found
    ? { x0: at.x - r - edge, y0: at.y - r * 1.45 - edge, x1: at.x + r * 1.75 + edge, y1: at.y + r + edge }
    : { x0: at.x - r - edge, y0: at.y - r - edge, x1: at.x + r + edge, y1: at.y + r + edge };
}
