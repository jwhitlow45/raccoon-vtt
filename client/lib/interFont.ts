/**
 * Inter, the interface's one font, served from public/fonts/ rather than
 * left to each device. The system stack drew San Francisco on Apple
 * devices, Roboto on Android, Segoe UI on Windows and something else again
 * on Linux, so a row that fit on one could wrap on another. One bundled
 * font lays text out the same everywhere.
 *
 * scripts/inter.ts makes both files from Inter's own release and keeps
 * only these characters. interFont.test.ts holds globals.css's @font-face
 * rules and index.html's preload to the same names and ranges, so the
 * three cannot drift apart.
 */

/** The family name the @font-face rules give it, first in theme.font.body. */
export const INTER_FAMILY = "Inter";

/** The tagged release of github.com/rsms/inter the files come from. */
export const INTER_VERSION = "4.1";

/**
 * The characters the files keep: Basic Latin, Latin-1 Supplement, Latin
 * Extended-A, General Punctuation, the arrows and the minus sign, which
 * cover nearly every string the app prints. Anything else falls back to
 * the next font in the stack: an emoji, a name in another script, or a
 * rare symbol such as the midline ellipsis (U+22EF) in the DM guide.
 */
export const INTER_UNICODE_RANGE = ["U+0020-007E", "U+00A0-017F", "U+2000-206F", "U+2190-2199", "U+2212"] as const;

/**
 * Where the app serves each file. The roman one is preloaded by index.html.
 * Each name ends in the first 8 hex digits of its file's SHA-256, so a new
 * subset is a new URL and browsers may keep a file for good
 * (server/http/static.ts). That also lets a reload's preload find the font
 * in the browser's cache, where the page's own request finds it, rather
 * than ask the server again for a copy that then goes unused.
 */
export const INTER_FILES = {
  roman: "/fonts/InterVariable-8a540aa8.woff2",
  italic: "/fonts/InterVariable-Italic-7e4680fd.woff2",
} as const;
