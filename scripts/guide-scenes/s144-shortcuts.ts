// shortcuts.webp and shortcuts-toolbar.webp (round 3): the tool keys with Trap's X, and the tool cycle's row.
export default async (c: any) => {
  const { shortcutsShots } = await import(`./tools/keys-part3.ts?t=${Date.now()}`);
  return await shortcutsShots(c);
};
