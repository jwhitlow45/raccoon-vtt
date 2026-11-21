// Two players join from phones, then the second phone closes. Pat stays open for player-view shots.
async function join(c: any, name: string) {
  const context = await c.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`${c.origin}/r/${c.state.roomId}`);
  await page.getByLabel("Player password").fill(c.state.password);
  await page.getByRole("button", { name: "Next" }).tap();
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Join", exact: true }).tap();
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  const me = await context.request.get(`${c.origin}/api/rooms/${c.state.roomId}/me`, { headers: { Origin: c.origin } });
  const body = await me.json();
  return { context, page, body };
}
export default async (c: any) => {
  const pat = await join(c, "Pat");
  c.state.patContext = pat.context;
  c.state.pat = pat.page;
  const sam = await join(c, "Sam");
  c.state.samBody = sam.body;
  c.state.patId = pat.body.memberId;
  c.state.samId = sam.body.memberId;
  await sam.context.close();
  return { pat: pat.body, sam: sam.body };
};
