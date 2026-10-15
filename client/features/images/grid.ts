/**
 * The rows of a windowed grid of square tiles that a scroll box shows, with
 * a few rows either side so a quick scroll does not show blank space first.
 * The icon picker lists up to 4,180 tiles, and only these are mounted, so
 * only these fetch their art.
 */
export type GridWindow = {
  columns: number;
  rows: number;
  /** The scrolled content's height. */
  height: number;
  /** The first and one past the last tile index to mount. */
  start: number;
  end: number;
};

export function gridWindow(input: { count: number; width: number; viewHeight: number; scrollTop: number; tile: number; gap: number; overscanRows?: number }): GridWindow {
  const { count, tile, gap } = input;
  const step = tile + gap;
  const columns = Math.max(1, Math.floor((Math.max(0, input.width) + gap) / step));
  const rows = Math.ceil(count / columns);
  const height = rows === 0 ? 0 : rows * step - gap;
  const overscan = input.overscanRows ?? 2;
  const firstRow = Math.max(0, Math.floor(Math.max(0, input.scrollTop) / step) - overscan);
  const lastRow = Math.min(rows, Math.ceil((Math.max(0, input.scrollTop) + Math.max(0, input.viewHeight)) / step) + overscan);
  return { columns, rows, height, start: Math.min(count, firstRow * columns), end: Math.min(count, lastRow * columns) };
}

/** Where tile `i` sits in the scrolled content. */
export function tilePosition(i: number, columns: number, tile: number, gap: number): { left: number; top: number } {
  const step = tile + gap;
  return { left: (i % columns) * step, top: Math.floor(i / columns) * step };
}
