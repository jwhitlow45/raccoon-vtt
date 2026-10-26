/**
 * The sheet grabber's designs (docs/design-v1-sheet-swipe.md 4.8), in the
 * order This device offers them, the default first. Each is drawn in one
 * color (components/SheetGrabber.tsx), in a `width` x `height` box of
 * layout px, which the interface size scales as it scales the header
 * around it. They are the project's own drawings, so no credit is owed.
 *
 * A plain module with no imports, so the device's settings
 * (features/device/settings.ts) can read a stored choice without loading
 * the component.
 */

export type GrabberShape = readonly ["rect", { x: number; y: number; width: number; height: number; rx?: number }] | readonly ["circle", { cx: number; cy: number; r: number }] | readonly ["path", { d: string }];

export type GrabberDesign = {
  id: string;
  /** Its name in This device's Sheet handle choice. */
  name: string;
  width: number;
  height: number;
  /** Its holes are cut by the even-odd rule: the mask's eyes. */
  evenOdd?: boolean;
  shapes: readonly GrabberShape[];
};

export const GRABBER_DESIGNS = [
  {
    id: "tail",
    name: "Ringed tail",
    // A raccoon's banded tail: the plain pill pinched at two rings, so it keeps the pill's size and room.
    width: 36,
    height: 4,
    shapes: [
      ["rect", { x: 0, y: 0, width: 11, height: 4, rx: 2 }],
      ["rect", { x: 11, y: 1, width: 3, height: 2 }],
      ["rect", { x: 14, y: 0, width: 8, height: 4, rx: 1 }],
      ["rect", { x: 22, y: 1, width: 3, height: 2 }],
      ["rect", { x: 25, y: 0, width: 11, height: 4, rx: 2 }],
    ],
  },
  {
    id: "mask",
    name: "Bandit mask",
    width: 40,
    height: 9,
    evenOdd: true,
    shapes: [
      [
        "path",
        {
          d: "M0 4.5 C3 1.5 8 0.5 13 1.2 C16 1.6 18 2.6 20 2.6 C22 2.6 24 1.6 27 1.2 C32 0.5 37 1.5 40 4.5 C37 7.2 32 8.4 27 7.8 C24 7.4 22 6.4 20 6.4 C18 6.4 16 7.4 13 7.8 C8 8.4 3 7.2 0 4.5 Z M8.5 4.6 C9.5 3.2 13 3 15.5 4.2 C14 5.8 10.5 6 8.5 4.6 Z M31.5 4.6 C30.5 3.2 27 3 24.5 4.2 C26 5.8 29.5 6 31.5 4.6 Z",
        },
      ],
    ],
  },
  {
    id: "beans",
    name: "Paw beans",
    width: 24,
    height: 8,
    shapes: [
      ["circle", { cx: 4, cy: 5, r: 3 }],
      ["circle", { cx: 12, cy: 3, r: 3 }],
      ["circle", { cx: 20, cy: 5, r: 3 }],
    ],
  },
  {
    id: "rod",
    name: "Scroll rod",
    width: 40,
    height: 6,
    shapes: [
      ["rect", { x: 4, y: 1.5, width: 32, height: 3, rx: 1.5 }],
      ["circle", { cx: 3, cy: 3, r: 3 }],
      ["circle", { cx: 37, cy: 3, r: 3 }],
    ],
  },
  {
    id: "rune",
    name: "Rune divider",
    width: 40,
    height: 6,
    shapes: [
      ["rect", { x: 0, y: 2, width: 15, height: 2, rx: 1 }],
      ["rect", { x: 25, y: 2, width: 15, height: 2, rx: 1 }],
      ["path", { d: "M20 0 L23 3 L20 6 L17 3 Z" }],
    ],
  },
  {
    id: "pill",
    name: "Plain pill",
    width: 36,
    height: 4,
    shapes: [["rect", { x: 0, y: 0, width: 36, height: 4, rx: 2 }]],
  },
] as const satisfies readonly GrabberDesign[];

export type GrabberId = (typeof GRABBER_DESIGNS)[number]["id"];

export const DEFAULT_GRABBER: GrabberId = "tail";

/** The design a stored id names, or the default for one this version does not know (an older or a newer build's, or a hand edit). */
export function parseGrabber(raw: string | null): GrabberId {
  return GRABBER_DESIGNS.find((d) => d.id === raw)?.id ?? DEFAULT_GRABBER;
}

export function grabberDesign(id: GrabberId): GrabberDesign {
  return GRABBER_DESIGNS.find((d) => d.id === id) ?? GRABBER_DESIGNS[0];
}

/** Where every design sits: 5 layout px under the surface's top edge, inside its 1 px border, so it has visible room above it. */
export const GRABBER_TOP = 5;

/**
 * The room a header keeps above its first line where it holds the
 * grabber: the grabber's place, its height and 1 px clear of the buttons
 * under it, so it never touches the dock's outlined chip, an armed Back or
 * Close. 10 for the tail and the pill, 15 for the mask, the tallest.
 */
export function grabberRoom(id: GrabberId): number {
  return GRABBER_TOP + grabberDesign(id).height + 1;
}
