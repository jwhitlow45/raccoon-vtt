#!/bin/sh
# Database and image backups (docs/design-v1-dm-tools.md 3.17).
#
# The `backup` service in docker-compose.server.yml runs this file, mounted
# read-only, in the postgres service's own pinned image, so pg_dump matches
# the server's version exactly:
#
#   sh /backup/backup.sh                     the nightly loop, at BACKUP_AT in TZ
#   sh /backup/backup.sh once                one backup now, or "A backup is running"
#   sh /backup/backup.sh restore <dump>      in the `restore` service only (README.md)
#
# The backup service runs as root with no capabilities, so it writes only
# what root owns (the backups volume) and reads the image volume through a
# read-only mount, which works because the app writes its files readable by
# others. The restore service runs as the app's own user, UID 1000, so every
# folder and file it puts back on the image volume is the app's.
#
# What makes a backup good is a completion record, `<name>.good`, written on
# the backups volume last of all, only by a run that passed every step. The
# `backup_runs` table is only a log for the admin page: retention never
# reads it and the dumps leave it out, so a database restored from an older
# dump can never make a run forget, or delete, the backups made after it.
#
# One run at a time: the nightly loop, `once` and `restore` all take one
# flock on /backups/.lock before anything else and hold it through the log.
#
# Variables named BACKUP_TEST_* exist for scripts/backup-check.ts alone.
# The compose files never set them, and unset they change nothing.

set -u
set -o pipefail
umask 022

BACKUPS=/backups
STORE="$BACKUPS/assets"
LOCK="$BACKUPS/.lock"
# The image volume: read-only for the backup, writable for the restore.
SOURCE=/assets
TARGET=/data/assets
FLOOR=${BACKUP_TEST_FLOOR_BYTES:-2147483648}
DAILY=7
WEEKLY=4
LOG_DAYS=90
RUN_ID_PATTERN='[a-z0-9]\{8\}'
NAME_PATTERN="^raccoon-[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}-[0-9]\{6\}-$RUN_ID_PATTERN\$"
NO_LOG="The database has no backup log yet. Start raccoon first, then run backup.sh once."

say() { printf '%s\n' "$*"; }
complain() { printf '%s\n' "$*" >&2; }

# psql with the PG* variables the service sets, SQL on stdin, so psql
# variables (-v name=value, used as :'name') are interpolated and quoted.
sql() { psql -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }

size_of() { stat -c %s "$1" 2>/dev/null; }

# The length of a regular file, or a failure for anything else: a missing
# path, a folder, or a size that cannot be read. Two missing files must
# never compare equal as two empty answers.
file_size() {
  [ -f "$1" ] || return 1
  n=$(stat -c %s "$1" 2>/dev/null) || return 1
  case $n in '' | *[!0-9]*) return 1 ;; esac
  printf '%s\n' "$n"
}

# A line of a dump's list, as list_dump writes it, so no line can name a
# path outside the image folders.
LIST_LINE='^[0-9a-f]\{2\}/[0-9a-f]\{64\}-[a-z]\{1,\}-[a-z]\{1,\}-v[1-9][0-9]*\.webp$'

# How many images a dump's list names that the restore could not put in
# place: neither a whole copy on the backups volume nor a file already on
# the image volume, which the restore never overwrites.
unrestorable() {
  bad=0
  while IFS= read -r path; do
    if ! printf '%s\n' "$path" | grep -q "$LIST_LINE"; then
      bad=$((bad + 1))
    elif ! file_size "$STORE/$path" > /dev/null && ! file_size "$TARGET/$path" > /dev/null; then
      bad=$((bad + 1))
    fi
  done < "$1"
  printf '%s\n' "$bad"
}

free_bytes() {
  kb=$(df -Pk "$BACKUPS" | awk 'NR == 2 { print $4 }')
  printf '%s\n' "$((kb * 1024))"
}

# A record's field, `key=value` on its own line.
field() { sed -n "s/^$2=//p" "$1" | head -n 1; }

# Pauses once at a named point for the check, which kills or resumes the run.
PAUSED=""
test_pause() {
  [ "${BACKUP_TEST_PAUSE:-}" = "$1" ] && [ -z "$PAUSED" ] || return 0
  PAUSED=$1
  : > "/tmp/.test-paused-$1"
  while [ ! -e /tmp/.test-resume ]; do sleep 0.1; done
  rm -f /tmp/.test-resume "/tmp/.test-paused-$1"
}

# The lock ----------------------------------------------------------------

# Made by the backup service, which owns the volume, readable by everyone so
# the restore service, as UID 1000 on a read-only mount, can take it too.
ensure_lock() {
  [ -e "$LOCK" ] || : > "$LOCK"
  chmod 0644 "$LOCK"
}

# BusyBox flock takes the lock on a read-only descriptor.
take_lock() {
  # A failed redirection on exec would end the whole script, so look first.
  [ -r "$LOCK" ] || return 1
  exec 9<"$LOCK"
  flock -n 9
}

release_lock() {
  flock -u 9 2>/dev/null
  exec 9<&-
}

# What the dump names and what is where -------------------------------------

# The variant files the dump's asset rows name, one per line as
# `<first two hex>/<sha256 hex>-<kind>-<variant>-v<pipeline>.webp`, the path
# server/assets/store.ts builds (variantPath). COPY's text format writes a
# bytea as \\x<hex> and a text[] as {a,b}. A row that does not parse fails
# the whole list, since a list that leaves an image out is not a backup.
list_dump() {
  pg_restore --data-only --table=assets --file=- "$1" | awk '
    /^COPY public\.assets \(/ {
      cols = $0
      sub(/^COPY public\.assets \(/, "", cols)
      sub(/\) FROM stdin;$/, "", cols)
      n = split(cols, names, ", ")
      for (i = 1; i <= n; i++) col[names[i]] = i
      inside = 1
      next
    }
    inside && $0 == "\\." { inside = 0; next }
    inside {
      split($0, f, "\t")
      hex = f[col["sha256"]]
      sub(/^\\\\x/, "", hex)
      kind = f[col["kind"]]
      pipeline = f[col["pipeline"]]
      variants = f[col["variants"]]
      gsub(/[{}]/, "", variants)
      nv = split(variants, v, ",")
      if (hex !~ /^[0-9a-f]{64}$/ || kind !~ /^[a-z]+$/ || pipeline !~ /^[1-9][0-9]*$/ || nv < 1) { bad = 1; exit 1 }
      for (j = 1; j <= nv; j++) {
        if (v[j] !~ /^[a-z]+$/) { bad = 1; exit 1 }
        print substr(hex, 1, 2) "/" hex "-" kind "-" v[j] "-v" pipeline ".webp"
      }
    }
    END { if (bad) exit 1 }
  ' | sort -u
}

# Sizes of what is on the image volume, in its trash, and in the copy, then
# one line per listed file:
#   ok <path> <size>              copied at the source's length
#   kept <path>                   its source is gone, and its copy is in place
#   copy <path> <size> <source>   missing from the copy, or at another length
#   missing <path>                gone everywhere
plan() {
  dir=$(mktemp -d)
  ( cd "$SOURCE" && find . -mindepth 2 -maxdepth 2 -type f -name '*.webp' | grep -E '^\./[0-9a-f]{2}/' | xargs -r stat -c '%s %n' ) > "$dir/live" 2>/dev/null
  if [ -d "$SOURCE/trash" ]; then
    ( cd "$SOURCE/trash" && find . -mindepth 3 -maxdepth 3 -type f -name '*.webp' | xargs -r stat -c '%s %n' ) > "$dir/trash" 2>/dev/null
  else
    : > "$dir/trash"
  fi
  ( cd "$STORE" && find . -type f ! -name '*.part' | xargs -r stat -c '%s %n' ) > "$dir/copy" 2>/dev/null
  awk -v LIVE="$dir/live" -v TRASH="$dir/trash" -v COPY="$dir/copy" -v SRC="$SOURCE" '
    FILENAME == LIVE { p = $2; sub(/^\.\//, "", p); live[p] = $1; next }
    FILENAME == TRASH { p = $2; sub(/^\.\/[^\/]+\//, "", p); if (!(p in trash)) { trash[p] = $1; where[p] = substr($2, 3) } next }
    FILENAME == COPY { p = $2; sub(/^\.\//, "", p); copy[p] = $1; next }
    {
      line = $0
      if (line in live) { size = live[line]; src = SRC "/" line }
      else if (line in trash) { size = trash[line]; src = SRC "/trash/" where[line] }
      else { print ((line in copy) ? "kept " : "missing ") line; next }
      if ((line in copy) && copy[line] == size) print "ok " line " " size
      else print "copy " line " " size " " src
    }
  ' "$dir/live" "$dir/trash" "$dir/copy" "$1"
  status=$?
  rm -rf "$dir"
  return $status
}

# One backup ---------------------------------------------------------------

# Set as the run goes, for the log step.
OUTCOME=failed
ERROR=""
DUMP_BYTES=""
COPIED=0

run_backup() {
  RUN_ID=$(tr -dc 'a-z0-9' </dev/urandom | head -c 8)
  START=$(date -u +%s)
  NAME="raccoon-$(date -u -d "@$START" +%Y-%m-%d-%H%M%S)-$RUN_ID"
  OUTCOME=failed
  ERROR=""
  DUMP_BYTES=""
  COPIED=0

  # 1. The log first, then what an interrupted run left. db/schema.sql is
  # the only definition of backup_runs, so a database the app has not set
  # up yet stops the run here, before anything is written.
  if ! exists=$(sql -c "select to_regclass('public.backup_runs') is not null"); then
    complain "backup $NAME: failed: the database did not answer"
    return 1
  fi
  if [ "$exists" != t ]; then
    complain "$NO_LOG"
    return 1
  fi
  # No other run is alive while the lock is held, so a row still "running"
  # belongs to a run that was stopped.
  if ! printf '%s\n' \
    "update backup_runs set outcome = 'failed', finished_at = now(), error = 'stopped before it finished' where outcome = 'running';" \
    "insert into backup_runs (id, started_at, outcome) values (:'id', to_timestamp(:'start'), 'running');" |
    sql -v id="$RUN_ID" -v start="$START"; then
    complain "backup $NAME: failed: could not write to the backup log"
    return 1
  fi
  mkdir -p "$STORE"
  rm -f "$BACKUPS"/*.part
  find "$STORE" -type f -name '*.part' -exec rm -f {} + 2>/dev/null
  for f in "$BACKUPS"/raccoon-*.files; do [ -e "$f" ] && [ ! -e "${f%.files}.dump" ] && rm -f "$f"; done
  for f in "$BACKUPS"/raccoon-*.dump; do [ -e "$f" ] && [ ! -e "${f%.dump}.good" ] && rm -f "$f" "${f%.dump}.files"; done
  for f in "$BACKUPS"/raccoon-*.good; do [ -e "$f" ] && [ ! -e "${f%.good}.dump" ] && rm -f "$f" "${f%.good}.files"; done

  backup_steps
  log_step
  case $OUTCOME in
    good) say "backup $NAME: good, $DUMP_BYTES byte dump, $COPIED images copied" ;;
    *) say "backup $NAME: $OUTCOME: $ERROR" ;;
  esac
  [ "$OUTCOME" = good ]
}

backup_steps() {
  part="$BACKUPS/$NAME.dump.part"
  list="$BACKUPS/$NAME.files"

  # 2. Space for the dump: the last good dump plus a quarter, or the
  # database's own size when that is larger or there is none, which a
  # compressed custom-format dump stays under.
  newest=$(ls "$BACKUPS"/raccoon-*.good 2>/dev/null | sort | tail -n 1)
  last=0
  [ -n "$newest" ] && last=$(field "$newest" bytes)
  estimate=$((last + last / 4))
  if ! db=$(sql -c "select pg_database_size(current_database())"); then ERROR="the database did not answer"; return; fi
  [ "$db" -gt "$estimate" ] && estimate=$db
  budget=$(($(free_bytes) - FLOOR))
  if [ "$estimate" -gt "$budget" ]; then
    ERROR="not enough space for the dump: about $estimate bytes needed, $budget free above the floor"
    return
  fi

  # 3. The dump, under a file size limit, writing straight to its file so
  # the archive stays seekable. A write past the budget kills pg_dump
  # (SIGXFSZ) or fails it (EFBIG), and its own exit status is the subshell's.
  # Then the whole archive is read back, every table's data and not only
  # the catalog, which pg_restore --list alone would read.
  limit=${BACKUP_TEST_DUMP_LIMIT_BYTES:-$budget}
  case ${BACKUP_TEST_DUMP:-} in
    kill) sh -c 'pg_dump --format=custom --exclude-table=backup_runs | head -c 4096 > "$1"; kill -KILL $$' sh "$part" ;;
    fail) sh -c 'printf PGDMP > "$1"; exit 3' sh "$part" ;;
    *) (ulimit -f "$((limit / 512))" && exec pg_dump --format=custom --exclude-table=backup_runs --file="$part") ;;
  esac
  status=$?
  if [ "$status" -ne 0 ]; then
    rm -f "$part"
    ERROR="pg_dump failed with status $status"
    return
  fi
  if ! pg_restore --file=/dev/null "$part"; then
    rm -f "$part"
    ERROR="the dump did not read back whole"
    return
  fi
  DUMP_BYTES=$(size_of "$part")

  # 4. What the dump names, written beside it before the rename, so a dump
  # under its final name always has its list.
  if ! list_dump "$part" > "$list.part"; then
    rm -f "$part" "$list.part"
    ERROR="the dump's image rows could not be listed"
    return
  fi
  mv "$list.part" "$list"
  test_pause listed
  mv "$part" "$BACKUPS/$NAME.dump"
  count=$(wc -l < "$list" | tr -d ' ')

  # 5. Space for the images the copy lacks.
  steps=$(mktemp)
  if ! plan "$list" > "$steps"; then
    rm -f "$steps"
    OUTCOME=partial
    ERROR="the image volume could not be read"
    return
  fi
  need=$(awk '$1 == "copy" { n += $3 } END { printf "%.0f\n", n }' "$steps")
  if [ $(($(free_bytes) - need)) -lt "$FLOOR" ]; then
    rm -f "$steps"
    OUTCOME=partial
    ERROR="not enough space for the images: $need bytes to copy"
    return
  fi

  # 6. The copy, each file through a .part checked by length, so a file
  # under its final name is always whole.
  failed=0
  done_n=0
  while read -r what path size src; do
    [ "$what" = copy ] || continue
    dest="$STORE/$path"
    mkdir -p "${dest%/*}"
    # Deleted since the plan was made: it waits in the trash.
    if [ ! -e "$src" ]; then
      for t in "$SOURCE"/trash/*/"$path"; do [ -e "$t" ] && src=$t && break; done
    fi
    if cp "$src" "$dest.part" 2>/dev/null; then
      test_pause copying
      if [ "$(size_of "$dest.part")" = "$size" ]; then
        mv "$dest.part" "$dest"
        COPIED=$((COPIED + 1))
      else
        rm -f "$dest.part"
        failed=$((failed + 1))
      fi
    else
      rm -f "$dest.part"
      failed=$((failed + 1))
    fi
    done_n=$((done_n + 1))
    if [ $((done_n % 100)) -eq 0 ] && [ "$(free_bytes)" -lt "$FLOOR" ]; then
      rm -f "$steps"
      OUTCOME=partial
      ERROR="the backups volume filled up during the copy"
      return
    fi
  done < "$steps"
  rm -f "$steps"

  # 7. The check, from a fresh look: every listed file in the copy at its
  # source's length, or in the copy under its final name once its source
  # left the trash.
  if ! short=$(plan "$list" | awk '$1 == "copy" || $1 == "missing" { n++ } END { printf "%.0f\n", n }'); then
    OUTCOME=partial
    ERROR="the image volume could not be read"
    return
  fi
  if [ "$short" -ne 0 ]; then
    OUTCOME=partial
    ERROR="$short of $count listed images are not in the copy"
    [ "$failed" -gt 0 ] && ERROR="$ERROR ($failed could not be read or copied whole)"
    return
  fi

  # 8. The completion record, last of all.
  {
    printf 'run=%s\n' "$RUN_ID"
    printf 'started=%s\n' "$START"
    printf 'dump=%s.dump\n' "$NAME"
    printf 'bytes=%s\n' "$DUMP_BYTES"
    printf 'files=%s.files\n' "$NAME"
    printf 'count=%s\n' "$count"
    printf 'copied=%s\n' "$COPIED"
    printf 'finished=%s\n' "$(date -u +%s)"
  } > "$BACKUPS/$NAME.good.part" && mv "$BACKUPS/$NAME.good.part" "$BACKUPS/$NAME.good"
  if [ ! -e "$BACKUPS/$NAME.good" ]; then
    ERROR="the completion record could not be written"
    return
  fi
  OUTCOME=good

  # 9. Retention, from the completion records only.
  retain
}

# Keeps this run, the 6 other newest, and the newest of each of the last 4
# weeks, then deletes every other dump, list and record, and every copied
# image no kept list names. A run therefore always survives its own
# retention, and the copy holds exactly the images the kept dumps need.
retain() {
  now=$(date -u +%s)
  for r in "$BACKUPS"/raccoon-*.good; do
    [ -e "$r" ] || continue
    printf '%s %s\n' "$(field "$r" started)" "$(basename "$r" .good)"
  done | sort -rn | awk -v now="$now" -v current="$NAME" -v daily="$DAILY" -v weekly="$WEEKLY" '
    {
      keep = ($2 == current)
      if (!keep && others < daily - 1) { keep = 1; others++ }
      week = int((now - $1) / 604800)
      if (week >= 0 && week < weekly && !(week in seen)) { seen[week] = 1; keep = 1 }
      print (keep ? "keep " : "drop ") $2
    }
  ' > /tmp/retention
  while read -r verdict name; do
    [ "$verdict" = drop ] && rm -f "$BACKUPS/$name.good" "$BACKUPS/$name.dump" "$BACKUPS/$name.files"
  done < /tmp/retention
  awk '$1 == "keep" { print $2 }' /tmp/retention | while read -r name; do cat "$BACKUPS/$name.files"; done | sort -u > /tmp/kept
  (cd "$STORE" && find . -type f | sed 's|^\./||' | sort) > /tmp/held
  comm -23 /tmp/held /tmp/kept | while read -r path; do rm -f "$STORE/$path"; done
  find "$STORE" -mindepth 1 -type d -empty -delete 2>/dev/null
  rm -f /tmp/retention /tmp/kept /tmp/held
}

# 10. The log: every completion record has a row marked good, a row marked
# good without a record is gone, this run's row gets its outcome, and rows
# older than 90 days go. The rows are only a log, rebuilt from the records.
log_step() {
  values=""
  ids=""
  for r in "$BACKUPS"/raccoon-*.good; do
    [ -e "$r" ] || continue
    name=$(basename "$r" .good)
    run=$(field "$r" run)
    started=$(field "$r" started)
    finished=$(field "$r" finished)
    bytes=$(field "$r" bytes)
    copied=$(field "$r" copied)
    # Every value is checked before it becomes SQL text.
    printf '%s\n' "$name" | grep -q "$NAME_PATTERN" || continue
    printf '%s\n' "$run" | grep -q "^$RUN_ID_PATTERN\$" || continue
    for n in "$started" "$finished" "$bytes" "${copied:-0}"; do
      case $n in '' | *[!0-9]*) continue 2 ;; esac
    done
    values="$values${values:+,}('$run', to_timestamp($started), to_timestamp($finished), 'good', '$name.dump', $bytes, ${copied:-0})"
    ids="$ids${ids:+,}'$run'"
  done
  {
    if [ -n "$values" ]; then
      printf '%s\n' "insert into backup_runs (id, started_at, finished_at, outcome, dump, dump_bytes, images_copied) values $values
        on conflict (id) do update set outcome = 'good', finished_at = excluded.finished_at, dump = excluded.dump,
          dump_bytes = excluded.dump_bytes, images_copied = excluded.images_copied, error = null
        where backup_runs.outcome <> 'good';"
      printf '%s\n' "update backup_runs set outcome = 'gone' where outcome = 'good' and id not in ($ids);"
    else
      printf '%s\n' "update backup_runs set outcome = 'gone' where outcome = 'good';"
    fi
    printf '%s\n' "update backup_runs set outcome = :'outcome', finished_at = now(), dump = nullif(:'dump', ''),
      dump_bytes = nullif(:'bytes', '')::bigint, images_copied = :'copied'::int, error = nullif(:'error', '')
      where id = :'id';"
    printf '%s\n' "delete from backup_runs where started_at < now() - make_interval(days => $LOG_DAYS);"
  } | sql -v id="$RUN_ID" -v outcome="$OUTCOME" -v dump="${DUMP_BYTES:+$NAME.dump}" -v bytes="$DUMP_BYTES" \
    -v copied="$COPIED" -v error="$ERROR" || complain "backup $NAME: the backup log could not be updated"
}

# Restore ------------------------------------------------------------------

restore() {
  name=${1:-}
  name=${name##*/}
  name=${name%.dump}
  # A brand new volume first mounted here, where the image has no
  # /data/assets, belongs to root, and every later upload into a folder made
  # here would fail. The app's image makes it the app's.
  if [ "$(stat -c %u "$TARGET" 2>/dev/null)" != 1000 ]; then
    complain "The image volume is not the app's yet. Start the stack once with docker compose up -d, then stop raccoon and restore."
    return 2
  fi
  if [ ! -e "$LOCK" ]; then
    complain "The backup service has not started yet. Start the stack once, then restore."
    return 2
  fi
  if ! printf '%s\n' "$name" | grep -q "$NAME_PATTERN"; then
    complain "Name the backup to restore, for example: backup.sh restore raccoon-2026-10-14-040000-abcd1234"
    list_good >&2
    return 2
  fi
  if ! take_lock; then
    complain "A backup is running. Wait for it to finish, then restore."
    return 1
  fi
  restore_locked "$name"
  status=$?
  release_lock
  return $status
}

list_good() {
  found=0
  for r in "$BACKUPS"/raccoon-*.good; do
    [ -e "$r" ] || continue
    [ $found -eq 0 ] && say "Good backups, oldest first:"
    found=1
    say "  $(basename "$r" .good)"
  done
  [ $found -eq 0 ] && say "There are no good backups."
}

restore_locked() {
  name=$1
  dump="$BACKUPS/$name.dump"
  if [ ! -f "$BACKUPS/$name.good" ] || [ ! -f "$dump" ] || [ ! -f "$BACKUPS/$name.files" ]; then
    complain "$name is not a good backup: it has no completion record."
    list_good >&2
    return 2
  fi
  # Every image the dump names must be at hand before the database changes,
  # or the rooms would come back with broken pictures.
  listed=$(wc -l < "$BACKUPS/$name.files" | tr -d ' ')
  lost=$(unrestorable "$BACKUPS/$name.files")
  if [ "$lost" -ne 0 ]; then
    complain "$lost of the $listed images $name lists are missing from the backups volume, so it cannot be restored whole. Nothing was restored. Choose another backup."
    list_good >&2
    return 1
  fi
  # The app holds rooms in memory and would write them back over the
  # restored rows, so nothing may be connected. pg_isready's brief
  # connections are the reason for the second look.
  for try in 1 2 3; do
    others=$(sql -c "select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'") || {
      complain "The database did not answer."
      return 1
    }
    [ "$others" = 0 ] && break
    [ "$try" = 3 ] && {
      complain "Something is still connected to the database. Stop raccoon first: docker compose -f docker-compose.server.yml stop raccoon"
      return 1
    }
    sleep 1
  done
  say "Restoring the database from $name..."
  if ! pg_restore --clean --if-exists --no-owner --single-transaction --exit-on-error --dbname="$PGDATABASE" "$dump"; then
    complain "The database restore failed, and was rolled back. Nothing changed."
    return 1
  fi
  test_pause restoring
  say "Copying the images..."
  # Never overwriting: a file under its final name on the volume is whole,
  # and the copy below makes it so through a .restoring file checked by length.
  find "$TARGET" -mindepth 2 -maxdepth 2 -type f -name '*.restoring' -exec rm -f {} + 2>/dev/null
  copied=0
  failed=0
  for src in $(cd "$STORE" && find . -mindepth 2 -maxdepth 2 -type f -name '*.webp' | sed 's|^\./||'); do
    dest="$TARGET/$src"
    [ -e "$dest" ] && continue
    mkdir -p "${dest%/*}"
    want=$(file_size "$STORE/$src") || want=""
    if [ -n "$want" ] && cp "$STORE/$src" "$dest.restoring" && [ "$(file_size "$dest.restoring")" = "$want" ]; then
      mv "$dest.restoring" "$dest"
      copied=$((copied + 1))
    else
      rm -f "$dest.restoring"
      failed=$((failed + 1))
    fi
  done
  # Each listed image must now be a regular file on the image volume, at its
  # copy's length where the backups volume holds one.
  missing=0
  while IFS= read -r path; do
    have=$(file_size "$TARGET/$path") || {
      missing=$((missing + 1))
      continue
    }
    want=$(file_size "$STORE/$path") || continue
    [ "$have" = "$want" ] || missing=$((missing + 1))
  done < "$BACKUPS/$name.files"
  if [ "$missing" -ne 0 ]; then
    complain "The database is restored, but $missing of its images are not on the image volume ($failed failed to copy)."
    return 1
  fi
  say "Restored $name, with $copied images copied. Now start raccoon, wait until it is healthy, then run backup.sh once."
  return 0
}

# The nightly loop -----------------------------------------------------------

# Minutes into the local day, with leading zeros taken off so the shell
# never reads 08 as octal.
minutes_of() {
  h=${1%%:*}
  m=${1#*:}
  h=${h#0}
  m=${m#0}
  printf '%s\n' "$((h * 60 + m))"
}

# The loop's variables are its own: every function here shares the shell's
# one set of names, and a run's own must never move the loop's day.
schedule() {
  BACKUP_TIME=${BACKUP_AT:-04:00}
  if ! printf '%s\n' "$BACKUP_TIME" | grep -Eq '^([01][0-9]|2[0-3]):[0-5][0-9]$'; then
    complain "BACKUP_AT must be HH:MM, such as 04:00, not $BACKUP_TIME"
    exit 1
  fi
  DUE_S=$(($(minutes_of "$BACKUP_TIME") * 60))
  ensure_lock
  say "Backups run every day at $BACKUP_TIME ($(date +%Z))."
  # Started after today's time, the first run is tomorrow's.
  LAST_DAY=""
  [ $(($(minutes_of "$(date +%H:%M)") * 60)) -ge "$DUE_S" ] && LAST_DAY=$(date +%Y-%m-%d)
  while :; do
    TODAY=$(date +%Y-%m-%d)
    CLOCK=$(date +%H:%M:%S)
    SECOND=${CLOCK##*:}
    NOW_S=$(($(minutes_of "${CLOCK%:*}") * 60 + ${SECOND#0}))
    if [ "$LAST_DAY" != "$TODAY" ] && [ "$NOW_S" -ge "$DUE_S" ]; then
      LAST_DAY=$TODAY
      if take_lock; then
        run_backup
        release_lock
      else
        say "Skipped tonight's backup: a backup or restore is running."
      fi
      continue
    fi
    SLEEP_S=$((DUE_S - NOW_S))
    [ "$SLEEP_S" -le 0 ] && SLEEP_S=$((SLEEP_S + 86400))
    # At most an hour at a time, so a clock change never skips a night.
    [ "$SLEEP_S" -gt 3600 ] && SLEEP_S=3600
    sleep "$SLEEP_S"
  done
}

case ${1:-} in
  "")
    schedule
    ;;
  once)
    ensure_lock
    if ! take_lock; then
      say "A backup is running."
      exit 1
    fi
    run_backup
    status=$?
    release_lock
    exit $status
    ;;
  restore)
    restore "${2:-}"
    exit $?
    ;;
  *)
    complain "Usage: backup.sh [once | restore <dump name>]"
    exit 2
    ;;
esac
