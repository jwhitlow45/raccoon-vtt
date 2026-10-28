/**
 * Universal VTT files written for the tests (docs/design-v1-maps-vision.md
 * section 6). Never a third-party map: those are not openly licensed test
 * data. Only the tests import this.
 */

type P = { x: number; y: number };

/** A PNG's signature and IHDR chunk: enough for the header sniff, never decoded. */
export function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export type FileInput = {
  origin?: P;
  size?: P;
  ppg?: number;
  walls?: P[][];
  objects?: P[][];
  /** `position` defaults to the midpoint, as Dungeondraft writes it. Arkenforge writes the portal's size there. */
  portals?: { a: P; b: P; closed?: boolean; position?: P }[];
  lights?: { at: P; range: number; color?: string; shadows?: boolean }[];
  image?: string;
};

/** A file as Dungeondraft writes one, from the parts a test cares about. */
export function uvttFile(input: FileInput = {}): Record<string, unknown> {
  const size = input.size ?? { x: 20, y: 20 };
  const ppg = input.ppg ?? 70;
  return {
    format: 0.3,
    resolution: { map_origin: input.origin ?? { x: 0, y: 0 }, map_size: size, pixels_per_grid: ppg },
    line_of_sight: input.walls ?? [],
    objects_line_of_sight: input.objects ?? [],
    portals: (input.portals ?? []).map((p) => ({
      position: p.position ?? { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 },
      bounds: [p.a, p.b],
      rotation: 0,
      closed: p.closed ?? true,
      freestanding: false,
    })),
    environment: { baked_lighting: true, ambient_light: "ffffffff" },
    lights: (input.lights ?? []).map((l) => ({ position: l.at, range: l.range, intensity: 1, color: l.color ?? "ffeccd8b", shadows: l.shadows ?? true })),
    image: input.image ?? base64(pngHeader(Math.round(size.x * ppg), Math.round(size.y * ppg))),
  };
}
