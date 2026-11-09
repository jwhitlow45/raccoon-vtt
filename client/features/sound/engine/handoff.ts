/**
 * One page plays per browser (docs/design/design-v1-music.md 4.4). Pages of
 * one room in one browser post on a BroadcastChannel named for the room,
 * and choose the page that plays. The owner keeps playing while it stays
 * eligible, through tab switches. A new owner is chosen only when there is
 * none, the owner turns ineligible, its entry lapses, or a display becomes
 * eligible beside a member owner. The winner is a display first, then the
 * page shown last, then the lowest page id.
 *
 * Where the browser has Web Locks, ownership is the lock: a page plays only
 * while it holds it, so no two pages of a room ever play at once, a stalled
 * owner that still renders keeps it, and the browser frees a closed or
 * crashed page's lock. A page's freeze event releases it, so a frozen page
 * never keeps the sound from a working one (MUS-OPUS-76).
 *
 * Without Web Locks the owner holds an audio lease while another live page
 * posts: the audio clock fades the owner out 6 seconds ahead unless a post
 * renews it, so an owner whose main thread stalls goes quiet by itself, and
 * a winner takes over by time only 7 seconds after an armed post. From an
 * unarmed owner, a page alone when it last posted, it waits for the
 * released post and keeps that owner's claim after its entry lapses.
 * A hidden page's timers wait for the browser's throttled wake-ups
 * (STALL_MS), so it learns of a stall from a late post, posts when it
 * hears one and its own is due, and starts by time only from a post on
 * time, its own come back included, which runs after every post that
 * reached it first (#confirmed).
 *
 * Everything here is driven through `HandoffEnv`, so a test runs many pages
 * of one browser against a fake channel, fake locks and a fake clock.
 */

/** How often a page posts its entry, and so renews its lease. */
export const POST_MS = 2_000;
/** An entry lapses this long after its last post. */
export const LAPSE_MS = 5_000;
/** The lease's deadline, on the audio clock, from each renewal. */
export const LEASE_MS = 6_000;
/** Without Web Locks a winner takes over from an armed owner this long after its last post, when its lease has silenced it. */
export const TAKEOVER_MS = 7_000;
/** The owner fades out over this before it hands the sound to a winner. */
export const HANDOFF_FADE_MS = 300;
/** Without Web Locks a page that has just started or thawed listens this long before it claims, so it hears every live page first. */
export const LISTEN_MS = 2_500;
/** Without Web Locks a winner with no owner to wait for claims for this long before it plays, so two winners with views a post apart see each other first. */
export const CLAIM_MS = 400;
/**
 * A shown page's timer, or any page's post, this late means the page's main
 * thread stood still, so what it decides waits for the posts that arrived
 * meanwhile. A hidden page's timers say nothing: Chrome wakes them once a
 * second, and after 5 minutes a chained one once a minute, and Safari
 * aligns a deeply nested one to a grid that grows while the page is hidden.
 * Posts are never throttled.
 */
export const STALL_MS = 200;
/** A lease renewed this close to its deadline may already be fading, so the owner counts it as run out. */
const LEASE_MARGIN_MS = 500;

export type PageKind = "display" | "member";

/** What a page posts on the room's channel. `sentAt` is the sender's `Date.now()`, which every page of one browser shares. */
export type HandoffPost = {
  v: 1;
  page: string;
  kind: PageKind;
  /** Enabled (unmuted, or a display's Sound on with no blackout and Only DM devices play off, SoundHost.tsx soundEnabled) and unlocked, its context running. */
  eligible: boolean;
  /** It plays: the owner. A post with this false after it was true is its release. */
  owns: boolean;
  /** It is the winner and waits to play. */
  wants: boolean;
  /** Without Web Locks: its lease is armed, so 7 s after this post it is silent. */
  armed: boolean;
  /** When the page was last shown, for the tie-break. */
  shownAt: number;
  sentAt: number;
  /** Counts the page's posts, so an older one that comes late is told from a newer one sent in the same millisecond. */
  n: number;
  /** The page is going (pagehide, closed). */
  bye?: true;
};

/** The output gate's controls, all on the audio thread, so they hold while the page's main thread stalls. */
export interface HandoffAudio {
  /** Sound at full gain from now: this page owns. */
  play(): void;
  /** Fades to silence over `ms` and holds there. */
  fadeOut(ms: number): void;
  /** Silent at once and held there, any lease schedule cancelled. */
  hold(): void;
  /** Without Web Locks: fade to silence `ms` from now on the audio clock unless renewed, or with null cancel that schedule. */
  lease(ms: number | null): void;
}

/**
 * The part of Web Locks this uses, as a callback rather than a promise, so a
 * test runs many pages in one synchronous world. `granted` runs once the
 * lock is held, with the function that lets it go. An abort before the
 * grant drops the request. browserLocks() wraps `navigator.locks`.
 */
export interface LockApi {
  request(name: string, signal: AbortSignal, granted: (release: () => void) => void): void;
}

/** `navigator.locks` where the browser has it, as join requests use it for its asks. */
export function browserLocks(): LockApi | null {
  const locks = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks || typeof locks.request !== "function") return null;
  return {
    request(name, signal, granted) {
      locks
        .request(name, { signal }, () => new Promise<void>((resolve) => granted(resolve)))
        .catch(() => {
          // Aborted: another page is the winner now.
        });
    },
  };
}

export type HandoffEnv = {
  room: string;
  page: string;
  kind: PageKind;
  now(): number;
  setTimer(ms: number, fn: () => void): unknown;
  clearTimer(handle: unknown): void;
  post(msg: HandoffPost): void;
  /**
   * The page's own posts come back to `receive` too, each behind every post
   * that reached the page before it, as a second object on the room's
   * channel hears them. False only without a channel, when the page hears
   * no other page either.
   */
  echo: boolean;
  locks: LockApi | null;
  audio: HandoffAudio;
  /** Told after every change of what the page does, for the lines in the Sound panel. */
  onChange?(): void;
};

type Peer = { post: HandoffPost };

/** The lock every page of a room asks for. */
export function lockName(room: string): string {
  return `rvtt-sound:${room}`;
}

/** The channel every page of a room posts on. */
export function channelName(room: string): string {
  return `rvtt-sound:${room}`;
}

type Candidate = { page: string; kind: PageKind; shownAt: number };

/** Whether `a` wins over `b`: a display first, then the page shown last, then the lowest page id. */
export function outranks(a: Candidate, b: Candidate): boolean {
  if (a.kind !== b.kind) return a.kind === "display";
  if (a.shownAt !== b.shownAt) return a.shownAt > b.shownAt;
  return a.page < b.page;
}

export class Handoff {
  readonly #env: HandoffEnv;
  readonly #peers = new Map<string, Peer>();
  #eligible = false;
  #shown = false;
  #shownAt = 0;
  #owns = false;
  #wants = false;
  #armed = false;
  #yielding = false;
  #frozen = false;
  #closed = false;
  #started = false;
  /** Without Web Locks: no claim before this, so a page that starts or wakes from a freeze hears every live page first. */
  #listenUntil = 0;
  /** Without Web Locks: when this page began its claim window, or null. */
  #claimSince: number | null = null;
  /** Without Web Locks: no start by itself before this, after a stall, so the posts that waited arrive first. */
  #settleUntil = 0;
  /** Without Web Locks: counts claim windows, and the window whose confirming post is out, so each sends one. */
  #window = 0;
  #confirmFor = 0;
  /** While a post on time is handled: every post that arrived before it has run, and the main thread is not stalled. */
  #onTime = false;
  #leaseRenewedAt = 0;
  /** The lock request in flight, and the release of the lock once held. */
  #lockRequest: AbortController | null = null;
  #releaseLock: (() => void) | null = null;
  #posted = 0;
  #postTimer: unknown = null;
  #postDue = Infinity;
  #decideTimer: unknown = null;
  #decideAt = Infinity;
  #yieldTimer: unknown = null;

  constructor(env: HandoffEnv) {
    this.#env = env;
  }

  /** This page plays. */
  get owns(): boolean {
    return this.#owns;
  }

  /** Another live page of this browser plays, so this one is quiet for it. */
  get otherPlays(): boolean {
    const now = this.#env.now();
    for (const peer of this.#peers.values()) if (peer.post.owns && this.#live(peer, now)) return true;
    return false;
  }

  /** Without Web Locks: the lease is armed (another live page posts). */
  get armed(): boolean {
    return this.#armed;
  }

  start(shown: boolean): void {
    if (this.#started) return;
    this.#started = true;
    const now = this.#env.now();
    this.#listenUntil = now + LISTEN_MS;
    this.#shown = shown;
    this.#shownAt = shown ? now : 0;
    this.#env.audio.hold();
    this.#post();
    this.#tickLater();
    this.#evaluate();
  }

  setEligible(eligible: boolean): void {
    if (eligible === this.#eligible) return;
    this.#eligible = eligible;
    this.#post();
    this.#evaluate();
  }

  setShown(shown: boolean): void {
    if (shown === this.#shown) return;
    this.#shown = shown;
    if (shown) this.#shownAt = this.#env.now();
    this.#post();
    this.#evaluate();
  }

  /**
   * The context left `running`, or its clock stood still: the audio clock
   * proves nothing now and rendering may resume before the page hears of
   * it. So the lease's schedule goes, the gate holds at 0, and ownership
   * goes with the lock, until a fresh election once the page is eligible
   * again (the engine reports that with setEligible).
   */
  contextLeft(): void {
    this.#eligible = false;
    if (this.#owns || this.#yielding) this.#giveUp();
    else this.#env.audio.hold();
    this.#abortClaim();
    this.#post();
    this.#changed();
  }

  /** Page Lifecycle's freeze: release everything, since a frozen page runs nothing (MUS-OPUS-76). */
  freeze(): void {
    if (this.#frozen || this.#closed) return;
    this.#frozen = true;
    this.#letGo();
    this.#post();
    this.#clearTimers();
    this.#changed();
  }

  resume(): void {
    if (!this.#frozen || this.#closed) return;
    this.#frozen = false;
    // What others posted while it was frozen never reached it.
    this.#listenUntil = this.#env.now() + LISTEN_MS;
    this.#post();
    this.#tickLater();
    this.#evaluate();
  }

  /** pagehide, or the room page going: release and say goodbye. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#letGo();
    this.#post(true);
    this.#clearTimers();
    this.#changed();
  }

  /** Gives up ownership and any claim without choosing again, for a page that stops taking part. */
  #letGo(): void {
    if (this.#owns || this.#yielding) this.#giveUp(false);
    else this.#env.audio.hold();
    this.#claimSince = null;
    this.#wants = false;
    if (this.#lockRequest) {
      this.#lockRequest.abort();
      this.#lockRequest = null;
    }
  }

  /**
   * A post from another page of the room, or the page's own come back
   * (HandoffEnv.echo). Its own tells nothing of its peers, only that every
   * post that reached the page before it has run (#confirmed).
   */
  receive(msg: HandoffPost): void {
    if (this.#closed || msg.v !== 1) return;
    // Posts are never throttled, so a late one shows a stall on a hidden page too, whose timers cannot. The page's own as well.
    const onTime = this.#env.now() - msg.sentAt <= STALL_MS;
    if (!onTime) this.#stalled();
    if (msg.bye) {
      this.#peers.delete(msg.page);
    } else if (msg.page !== this.#env.page) {
      const before = this.#peers.get(msg.page);
      // Posts from one page arrive in order, but a stalled page may hand over an old one after a newer one.
      if (before && before.post.n >= msg.n) return;
      const now = this.#env.now();
      const fresh = before === undefined || !this.#live(before, now);
      this.#peers.set(msg.page, { post: msg });
      // A post that waited out a freeze may run before the resume event does: it still counts, but nothing acts on it until then.
      if (this.#frozen) return;
      // A hidden page's post timer may wait long for a throttled wake-up (STALL_MS), and its entry lapse meanwhile, so a post heard once its own is due sends it, from a task no throttling holds back.
      if (this.#postTimer !== null && now >= this.#postDue) this.#tick();
      // A page that just started, or came back from a freeze or a stall, hears every live page at once rather than in up to a post's time.
      else if (fresh) this.#post();
    }
    // A decide timer set in its own callback nests deeper each time, and a hidden page's deeply nested timer wakes far later (STALL_MS), so a post sets it afresh.
    if (this.#decideTimer !== null) {
      this.#env.clearTimer(this.#decideTimer);
      this.#decideTimer = null;
      this.#decideAt = Infinity;
    }
    this.#onTime = onTime;
    try {
      this.#evaluate();
    } finally {
      this.#onTime = false;
    }
  }

  // ---------------------------------------------------------------- deciding

  #live(peer: Peer, now: number): boolean {
    return now - peer.post.sentAt < LAPSE_MS;
  }

  /** The peer this page counts as the owner, or null. */
  #ownerClaim(now: number): Peer | null {
    let owner: Peer | null = null;
    for (const peer of this.#peers.values()) {
      const p = peer.post;
      if (!p.owns) continue;
      let claims: boolean;
      if (this.#env.locks) claims = this.#live(peer, now);
      // An unarmed owner may still sound, stalled, so its claim outlives its entry. An armed one is silent 7 s after its post.
      else claims = this.#live(peer, now) || !p.armed || now - p.sentAt < TAKEOVER_MS;
      if (claims && (owner === null || outranks(p, owner.post))) owner = peer;
    }
    return owner;
  }

  #self(): Candidate {
    return { page: this.#env.page, kind: this.#env.kind, shownAt: this.#shownAt };
  }

  /** The winner among live eligible pages, this one included while eligible. */
  #winner(now: number): Candidate | null {
    let best: Candidate | null = this.#eligible ? this.#self() : null;
    for (const peer of this.#peers.values()) {
      if (!this.#live(peer, now) || !peer.post.eligible) continue;
      if (best === null || outranks(peer.post, best)) best = peer.post;
    }
    return best;
  }

  #displayEligible(now: number): boolean {
    if (this.#eligible && this.#env.kind === "display") return true;
    for (const peer of this.#peers.values()) if (peer.post.kind === "display" && peer.post.eligible && this.#live(peer, now)) return true;
    return false;
  }

  #evaluate(): void {
    if (this.#closed || this.#frozen || !this.#started) return;
    const now = this.#env.now();
    // A lease that ran out silenced this page while its main thread stood still, and another page may play since, so it gives up before anything can renew or cancel it.
    if (this.#leaseRanOut(now)) return this.#giveUp();
    this.#updateLease(now);
    if (this.#yielding) {
      // A fade toward a display is no reason to sound beside another page that claims to play, so it goes quiet at once, as an owner does.
      if (!this.#env.locks && this.#ownerClaim(now) !== null) return this.#giveUp();
      return this.#scheduleDecision(now);
    }
    if (this.#owns) {
      if (!this.#eligible) return this.#giveUp();
      // Without Web Locks it gives way to any page that claims to play, a lapsed one too while that one may still sound (#ownerClaim).
      if (!this.#env.locks && this.#ownerClaim(now) !== null) return this.#giveUp();
      if (this.#env.kind === "member") {
        for (const peer of this.#peers.values()) {
          const p = peer.post;
          if (p.kind === "display" && p.wants && p.eligible && this.#live(peer, now)) return this.#yield();
        }
      }
      return this.#scheduleDecision(now);
    }
    if (!this.#eligible) {
      this.#abortClaim();
      return this.#scheduleDecision(now);
    }
    const owner = this.#ownerClaim(now);
    const due = owner === null || !owner.post.eligible || (owner.post.kind === "member" && this.#displayEligible(now));
    const winner = due ? this.#winner(now) : null;
    if (!due || winner === null || winner.page !== this.#env.page) {
      this.#abortClaim();
      return this.#scheduleDecision(now);
    }
    this.#claim(owner, now);
  }

  #claim(owner: Peer | null, now: number): void {
    if (!this.#wants) {
      this.#wants = true;
      this.#post();
    }
    if (this.#env.locks) {
      this.#requestLock();
      return this.#scheduleDecision(now);
    }
    if (owner !== null && owner.post.owns) {
      // Waiting for its release, or for its armed lease to have silenced it (#ownerClaim drops it then).
      this.#claimSince = null;
      return this.#scheduleDecision(now);
    }
    // Once a stall ends, another timer or a post may run before the window's own timer, so the window's end is checked for lateness here too.
    if (this.#claimSince !== null) this.#late(this.#claimSince + CLAIM_MS);
    if (now < this.#listenUntil || now < this.#settleUntil) return this.#scheduleDecision(now);
    if (this.#claimSince === null) {
      this.#claimSince = now;
      this.#window++;
      return this.#scheduleDecision(now);
    }
    if (now < this.#claimSince + CLAIM_MS || !this.#confirmed()) return this.#scheduleDecision(now);
    this.#become();
  }

  /**
   * Whether this task may start the sound once the claim window has run
   * out. After a stall the browser runs what waited in any order, timers
   * before posts too, and a hidden page cannot tell a stall by its timers.
   * So the start comes only from a post on time: every post that reached
   * the page before it has run, and the page has not stood still since it
   * was sent. With none at hand the page posts, and its own post comes back
   * behind everything that waited (HandoffEnv.echo). A post that waited out
   * a stall is late and restarts the claim (#stalled), its own too, where a
   * timer set before the stall could run first and start (MB-ASTRA-06).
   */
  #confirmed(): boolean {
    // Without a channel the page hears no other, so no post can be waiting.
    if (this.#onTime || !this.#env.echo) return true;
    if (this.#confirmFor !== this.#window) {
      this.#confirmFor = this.#window;
      this.#post();
    }
    return false;
  }

  #become(): void {
    this.#claimSince = null;
    this.#wants = false;
    this.#owns = true;
    this.#env.audio.play();
    const now = this.#env.now();
    this.#armed = false;
    this.#updateLease(now);
    this.#post();
    this.#changed();
    this.#scheduleDecision(now);
  }

  #abortClaim(): void {
    this.#claimSince = null;
    if (this.#lockRequest) {
      this.#lockRequest.abort();
      this.#lockRequest = null;
    }
    if (this.#wants) {
      this.#wants = false;
      if (!this.#closed && !this.#frozen && this.#started) this.#post();
    }
  }

  #requestLock(): void {
    const locks = this.#env.locks;
    if (!locks || this.#lockRequest || this.#releaseLock) return;
    const request = new AbortController();
    this.#lockRequest = request;
    locks.request(lockName(this.#env.room), request.signal, (release) => {
      // An abort that came after the grant does nothing to it, so the grant checks.
      if (request.signal.aborted || this.#lockRequest !== request || this.#closed || this.#frozen || !this.#eligible) {
        if (this.#lockRequest === request) this.#lockRequest = null;
        release();
        return;
      }
      this.#lockRequest = null;
      this.#releaseLock = release;
      this.#become();
    });
  }

  /** Hands the sound to a display that wants it: fade, hold at 0, post released, release. */
  #yield(): void {
    if (this.#yielding) return;
    this.#yielding = true;
    this.#env.audio.fadeOut(HANDOFF_FADE_MS);
    this.#yieldTimer = this.#env.setTimer(HANDOFF_FADE_MS, () => {
      this.#yieldTimer = null;
      if (this.#yielding) this.#giveUp();
    });
  }

  /** Gives up ownership at once: hold at 0, post released, release the lock, then choose again unless the page is going. */
  #giveUp(choose = true): void {
    if (this.#yieldTimer !== null) {
      this.#env.clearTimer(this.#yieldTimer);
      this.#yieldTimer = null;
    }
    this.#yielding = false;
    const owned = this.#owns;
    this.#owns = false;
    this.#armed = false;
    this.#env.audio.hold();
    if (owned) this.#post();
    const release = this.#releaseLock;
    this.#releaseLock = null;
    release?.();
    this.#changed();
    if (choose) this.#evaluate();
  }

  #leaseRanOut(now: number): boolean {
    return this.#owns && this.#armed && !this.#yielding && now - this.#leaseRenewedAt > LEASE_MS - LEASE_MARGIN_MS;
  }

  /** Without Web Locks the lease is armed while this page owns and another live page posts, and renewed with every post. */
  #updateLease(now: number): void {
    // A yield's fade is on the same gain, so the lease leaves it alone.
    if (this.#env.locks || this.#yielding) return;
    let other = false;
    for (const peer of this.#peers.values()) if (this.#live(peer, now)) other = true;
    const armed = this.#owns && !this.#yielding && other;
    if (armed === this.#armed) return;
    this.#armed = armed;
    if (armed) {
      this.#env.audio.lease(LEASE_MS);
      this.#leaseRenewedAt = now;
    } else if (this.#owns) {
      this.#env.audio.lease(null);
    }
    this.#post();
  }

  #scheduleDecision(now: number): void {
    let at = Infinity;
    for (const peer of this.#peers.values()) {
      const p = peer.post;
      if (this.#live(peer, now)) at = Math.min(at, p.sentAt + LAPSE_MS);
      if (!this.#env.locks && p.owns && p.armed && now - p.sentAt < TAKEOVER_MS) at = Math.min(at, p.sentAt + TAKEOVER_MS);
    }
    if (this.#wants && !this.#env.locks) {
      if (now < this.#listenUntil) at = Math.min(at, this.#listenUntil);
      if (now < this.#settleUntil) at = Math.min(at, this.#settleUntil);
      // A window that has run out waits for its confirming post to come back, not for a timer (#confirmed).
      if (this.#claimSince !== null && this.#confirmFor !== this.#window) at = Math.min(at, this.#claimSince + CLAIM_MS);
    }
    if (!Number.isFinite(at)) return;
    at = Math.max(at, now + 1);
    if (this.#decideTimer !== null && this.#decideAt <= at) return;
    if (this.#decideTimer !== null) this.#env.clearTimer(this.#decideTimer);
    this.#decideAt = at;
    this.#decideTimer = this.#env.setTimer(at - now, () => {
      this.#decideTimer = null;
      this.#decideAt = Infinity;
      this.#late(at);
      this.#evaluate();
    });
  }

  /** A shown page's timer that fired late means the main thread stood still. A hidden page's timers wait for the browser's wake-ups, so their lateness proves nothing (STALL_MS). */
  #late(due: number): void {
    if (this.#shown && this.#env.now() - due > STALL_MS) this.#stalled();
  }

  /** The main thread stood still: nothing starts by time until the posts that waited are in. */
  #stalled(): void {
    this.#settleUntil = this.#env.now() + CLAIM_MS;
    this.#claimSince = null;
  }

  #tickLater(): void {
    this.#postDue = this.#env.now() + POST_MS;
    this.#postTimer = this.#env.setTimer(POST_MS, () => {
      this.#postTimer = null;
      this.#tick();
    });
  }

  /**
   * The post that renews the entry and the lease, from its timer or from a
   * post heard once it is due. It decides nothing itself: the post timer
   * re-arms in its own callback, so a timer set from it nests ever deeper
   * and on a hidden page may wake only once a minute (STALL_MS). Decisions
   * come from posts and the decide timer, which a post sets afresh.
   */
  #tick(): void {
    if (this.#postTimer !== null) this.#env.clearTimer(this.#postTimer);
    this.#postTimer = null;
    if (this.#closed || this.#frozen) return;
    this.#late(this.#postDue);
    const now = this.#env.now();
    // A renewal this late may come after the lease began to fade, so the owner gives up rather than sound again.
    if (this.#leaseRanOut(now)) {
      this.#giveUp();
    } else {
      // Only while another page is still live: alone again, the lease goes.
      this.#updateLease(now);
      if (this.#owns && this.#armed && !this.#yielding) {
        this.#env.audio.lease(LEASE_MS);
        this.#leaseRenewedAt = now;
      }
    }
    this.#post();
    this.#tickLater();
  }

  #post(bye = false): void {
    if (!this.#started) return;
    this.#env.post({
      v: 1,
      page: this.#env.page,
      kind: this.#env.kind,
      eligible: this.#eligible && !this.#frozen,
      owns: this.#owns,
      wants: this.#wants,
      armed: this.#armed,
      shownAt: this.#shownAt,
      sentAt: this.#env.now(),
      n: ++this.#posted,
      ...(bye ? { bye: true as const } : {}),
    });
  }

  #clearTimers(): void {
    for (const t of [this.#postTimer, this.#decideTimer, this.#yieldTimer]) if (t !== null) this.#env.clearTimer(t);
    this.#postTimer = null;
    this.#decideTimer = null;
    this.#decideAt = Infinity;
    this.#yieldTimer = null;
  }

  #changed(): void {
    this.#env.onChange?.();
  }
}
