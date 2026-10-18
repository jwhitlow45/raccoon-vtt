import { theme } from "../../../lib/theme.ts";

/**
 * A flat d20 drawn in SVG (docs/design-v1-roll-animation.md 9 and 9.2): a
 * hexagon with its triangle face, the face's number in the middle. Others'
 * toasts show it in the app's neutral colors with the kept face, and the
 * dice set picker in a set's colors wherever the dice cannot be drawn. No
 * three.js, so it costs nothing where the dice never load.
 */

/** The hexagon's corners, pointed top, in a 48 unit box. */
const HEX = [
  [24, 2],
  [43.05, 13],
  [43.05, 35],
  [24, 46],
  [4.95, 35],
  [4.95, 13],
] as const;
/** The face toward the viewer, a triangle pointing up. */
const FACE = [
  [24, 9],
  [37.5, 32.5],
  [10.5, 32.5],
] as const;
/** The edges from the face's corners out to the hexagon's. */
const SPOKES: readonly (readonly [number, number])[] = [
  [0, 0],
  [0, 1],
  [0, 5],
  [1, 1],
  [1, 2],
  [1, 3],
  [2, 3],
  [2, 4],
  [2, 5],
];

const points = (ps: readonly (readonly [number, number])[]) => ps.map(([x, y]) => `${x},${y}`).join(" ");

export function D20Icon(props: { size: number; text: string; body: string; edge: string; ink: string; outline?: string }) {
  const { size, text } = props;
  return (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 48 48" style={{ display: "block", flex: "none" }}>
      <polygon points={points(HEX)} fill={props.body} stroke={props.outline ?? props.edge} strokeWidth={props.outline ? 3 : 1.5} strokeLinejoin="round" />
      {SPOKES.map(([f, h], i) => (
        <line key={i} x1={FACE[f]![0]} y1={FACE[f]![1]} x2={HEX[h]![0]} y2={HEX[h]![1]} stroke={props.edge} strokeWidth={1} />
      ))}
      <polygon points={points(FACE)} fill={props.body} stroke={props.edge} strokeWidth={1.25} strokeLinejoin="round" />
      <text
        x={24}
        y={26}
        textAnchor="middle"
        dominantBaseline="middle"
        fill={props.ink}
        fontFamily={theme.font.body}
        fontWeight={theme.weight.bold}
        // Two digits draw a little smaller to stay inside the face.
        fontSize={text.length > 1 ? 11 : 13}
      >
        {text}
      </text>
    </svg>
  );
}
