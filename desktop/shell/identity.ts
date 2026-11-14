/**
 * The app's identity on each system: the macOS bundle ID, the Windows
 * AppUserModelID that notifications and the Start menu shortcut share, and
 * the key the NSIS installer derives its uninstall entry from. It is the
 * repository's address reversed, and it can never change once a release
 * ships, or updates would install a second copy beside the first.
 * desktop/build/electron-builder.yml writes the same value (identity.test.ts).
 */
export const APP_ID = "io.github.jwhitlow45.raccoonvtt";
