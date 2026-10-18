-- raccoon-vtt schema. server/db.ts runs this whole file on the first
-- connection after boot, so every statement must be idempotent: `if not
-- exists` everywhere, and a new column goes in as its own `alter table ...
-- add column if not exists` rather than an edit to a create statement above,
-- because an existing database never re-runs a create.
--
-- Room state itself is not modelled here. It lives as a jsonb snapshot plus
-- an op log (design section 16), validated by the shared zod schemas, so the
-- game's data model can change without a migration.

create table if not exists rooms (
  id text primary key,                         -- Crockford base32, 8 chars
  name text not null,
  player_pw_hash text not null,                -- argon2id PHC string
  player_epoch int not null default 1,
  dm_key_hash bytea not null,                  -- sha256 of the DM key
  dm_epoch int not null default 1,
  created_ip text,
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  read_only boolean not null default false,
  pinned boolean not null default false         -- never unloaded to make space (admin pin)
);
create table if not exists room_snapshots (
  room_id text primary key references rooms on delete cascade,
  seq bigint not null,
  state jsonb not null,
  schema_version int not null,
  written_at timestamptz not null default now()
);
create table if not exists room_ops (
  room_id text not null references rooms on delete cascade,
  seq bigint not null,
  at timestamptz not null,                     -- the envelope time the reducer saw
  actor_member_id text not null,
  actor_role text not null,
  op jsonb not null,
  op_version int not null,
  primary key (room_id, seq)
);
create table if not exists client_watermarks (
  room_id text not null references rooms on delete cascade,
  session_id uuid not null,
  client_id text not null,
  n bigint not null,
  updated_at timestamptz not null default now(),
  primary key (room_id, session_id, client_id)
);
create table if not exists room_log (
  room_id text not null references rooms on delete cascade,
  id text not null,                            -- "<seq>:<index>", so replay inserts are idempotent
  at timestamptz not null,
  entry jsonb not null,
  primary key (room_id, id)
);
create table if not exists sessions (
  id uuid primary key,
  token_hash bytea not null unique,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create table if not exists grants (
  session_id uuid not null references sessions on delete cascade,
  room_id text not null references rooms on delete cascade,
  member_id text not null,
  role text not null check (role in ('dm', 'player')),
  epoch int not null,
  created_at timestamptz not null default now(),
  primary key (session_id, room_id)
);
create table if not exists dm_invites (
  token_hash bytea primary key,
  room_id text not null references rooms on delete cascade,
  created_by_session uuid not null,             -- revoking that DM device deletes its unused invites
  dm_epoch int not null,
  expires_at timestamptz not null,
  used_at timestamptz
);
create table if not exists assets (
  id uuid primary key,                         -- random UUIDv4, never time-ordered
  room_id text not null references rooms on delete cascade,
  sha256 bytea not null,
  kind text not null check (kind in ('map', 'token', 'handout')),
  pipeline int not null,
  width int not null, height int not null,     -- canonical (full variant) size
  bytes bigint not null,
  variants text[] not null,
  created_at timestamptz not null default now(),
  unique (room_id, sha256, kind)
);
create index if not exists assets_file on assets (sha256, kind, pipeline);
create table if not exists asset_uploaders (
  asset_id uuid not null references assets on delete cascade,
  member_id text not null,
  primary key (asset_id, member_id)
);
create table if not exists search_cache (q text primary key, results jsonb not null, fetched_at timestamptz not null);
create table if not exists search_usage (bucket text primary key, count int not null);
  -- 'r:<room>:2026-10', 'ip:<ip>:2026-10-12'; the global count comes from SerpApi's Account API
create table if not exists rate_events (key text not null, at timestamptz not null);
create index if not exists rate_events_key_at on rate_events (key, at);
-- Every member that has ever held a DM grant in a room. "Continue as" refuses
-- them (design 10.2), so a member that stopped being a DM cannot be taken
-- over with the player password to read the whispers it had as DM. A row is
-- never deleted while its room lives. The insert backfills grants that
-- predate this table, and does nothing once they are in.
create table if not exists room_dm_members (
  room_id text not null references rooms on delete cascade,
  member_id text not null,
  primary key (room_id, member_id)
);
insert into room_dm_members (room_id, member_id)
  select distinct room_id, member_id from grants where role = 'dm'
  on conflict do nothing;
-- The player password under AES-256-GCM with ROOM_SECRET_KEY, beside its
-- argon2 hash, so the DM can show the player link at any time (design 10.2,
-- server/auth/playerSecret.ts). Null for a room whose password was set
-- before this column existed: its DM changes the password once to get it.
alter table rooms add column if not exists player_pw_sealed bytea;
-- Scene thumbnails (v1 wave 3) are assets of their own kind. The check on
-- the kind is replaced here rather than edited above, since an existing
-- database never re-runs a create. It is replaced only while it lacks the
-- new kind, so a boot does not re-check every asset row each time, and the
-- new check accepts every row the old one did.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'assets'::regclass and conname = 'assets_kind_check' and pg_get_constraintdef(oid) like '%''thumb''%'
  ) then
    alter table assets drop constraint if exists assets_kind_check,
      add constraint assets_kind_check check (kind in ('map', 'token', 'handout', 'thumb'));
  end if;
end $$;
-- Wave 5 (docs/design-v1-dm-tools.md 2.3), each step idempotent as the thumb
-- kind's was.
--
-- A session's purpose: 'room' for a browser's session in rooms, 'display' for
-- a table display's (section 3.1). The server decides by the purpose, never
-- by the cookie a token arrived in, so every ordinary route treats a display
-- session as no session at all. Every existing row is a room session.
alter table sessions add column if not exists purpose text not null default 'room' check (purpose in ('room', 'display'));
-- A table display holds a grant of its own role, whose member id is
-- 'display:<12 random characters>', an id no member can have.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'grants'::regclass and conname = 'grants_role_check' and pg_get_constraintdef(oid) like '%''display''%'
  ) then
    alter table grants drop constraint if exists grants_role_check,
      add constraint grants_role_check check (role in ('dm', 'player', 'display'));
  end if;
end $$;
-- One-time codes that pair a table display with a room (section 3.1): 10
-- Crockford base32 characters, stored only as their sha256, valid 10
-- minutes, once. A change of the player password (player_epoch) voids them.
create table if not exists display_codes (
  token_hash bytea primary key,
  room_id text not null references rooms on delete cascade,
  created_by_session uuid not null,            -- the DM device that minted it
  player_epoch int not null,
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists display_codes_room on display_codes (room_id, expires_at);
-- The admin page's sessions (section 3.18). They are not room sessions and
-- hold no grants. Only the sha256 of the cookie's 32 random bytes is kept,
-- with a fingerprint of the ADMIN_PASSWORD_HASH it was made under, so a
-- changed hash ends every admin session. 12 hours, never extended.
create table if not exists admin_sessions (
  token_hash bytea primary key,
  password_fingerprint bytea not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
-- What the backup service did (section 3.17), for the admin page. Only a log:
-- the completion records on the backups volume are the only truth for
-- retention, each run rebuilds these rows from them, and the dumps leave this
-- table out. This file is the table's only definition, so backup.sh holds
-- none of its own.
create table if not exists backup_runs (
  id text primary key,                          -- the run id in its file names
  started_at timestamptz not null,
  finished_at timestamptz,
  outcome text not null check (outcome in ('running', 'good', 'partial', 'failed', 'gone')),
  dump text,                                    -- the dump's file name
  dump_bytes bigint,
  images_copied int,
  error text
);
create index if not exists backup_runs_started on backup_runs (started_at);
-- Image cleanup (section 3.19): since when a row's image has not been named
-- by its room's state, for scene thumbnails, which cleanup deletes a day
-- after they stop being used. Null while in use.
alter table assets add column if not exists unused_since timestamptz;
-- An Openverse image's credit (section 3.13), from the cached search result
-- and never from a client: shared/protocol.ts assetCreditSchema. Null for
-- every other image.
alter table assets add column if not exists credit jsonb;
-- Wave 7 (docs/design-v1-dice.md 1.2): the receipt of every admitted op
-- that rolls or applies, by member, client tag and batch part, written in
-- the same transaction as the batch that settles it. It holds the outcome
-- alone (committed with the op's seq, or refused with the words), never the
-- result, which the log rows the seq names hold and the archive may prune.
-- The room actor holds every row younger than 24 hours in memory, so the
-- primary key starting with the room keeps one member's tag from ever
-- meeting another's. The daily prune deletes rows older than 7 days, and of
-- those older than 24 hours keeps each room's newest 10,000.
create table if not exists roll_receipts (
  room_id text not null references rooms on delete cascade,
  member_id text not null,
  tag text not null,
  part int not null,
  state text not null check (state in ('committed', 'refused')),
  seq bigint,
  code text,
  message text,
  at timestamptz not null,
  primary key (room_id, member_id, tag, part)
);
create index if not exists roll_receipts_room_at on roll_receipts (room_id, at);
-- A starter pick's work key, `<pack>/<work>` (docs/design-v1-starter-art.md
-- 5), set by the server from its own catalog. Such a row stays out of the
-- room's storage quota. Null for every upload.
alter table assets add column if not exists starter text;
