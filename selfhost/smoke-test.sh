#!/bin/sh
# The smoke test of compose.yml, which .github/workflows/image.yml runs on
# every image before it is pushed. A host never needs it.
#
#   sh selfhost/smoke-test.sh <image:tag>
#
# It brings the stack up with <image:tag> as raccoon, the way a host does:
# an .env made from env.example with throwaway secrets, and the https
# profile, with Caddy serving plain HTTP for a name that never resolves, so
# nothing asks a certificate authority for anything. Then it checks that the
# app answers /healthz on raccoon-edge, where a front end reaches it, and
# through Caddy, that the files the services mount are docker/squid.conf
# and docker/backup.sh byte for byte, and that a backup runs. It removes the
# stack with its volumes and networks however it ends.
#
#   SMOKE_PROJECT     the compose project name (raccoon-smoke)
#   SMOKE_HTTP        where Caddy's port 80 answers on this machine (127.0.0.1:80)
#   SMOKE_OVERRIDE    one more compose file, for a machine whose ports or Docker differ
#   SMOKE_DOCKER_MIN  the oldest Docker Engine major version to accept (28)

set -eu

image=${1:?usage: sh selfhost/smoke-test.sh <image:tag>}
root=$(cd "$(dirname "$0")/.." && pwd)
project=${SMOKE_PROJECT:-raccoon-smoke}
http=${SMOKE_HTTP:-127.0.0.1:80}

server=$(docker version --format '{{.Server.Version}}')
if [ "${server%%.*}" -lt "${SMOKE_DOCKER_MIN:-28}" ]; then
  echo "Docker Engine $server is too old. compose.yml's internal networks set gateway_mode_ipv4: isolated, which needs Docker Engine 28 or later." >&2
  exit 1
fi
docker compose version

dir=$(mktemp -d)
compose() {
  docker compose --file "$dir/compose.yml" ${SMOKE_OVERRIDE:+--file "$SMOKE_OVERRIDE"} --project-name "$project" "$@"
}

passed=false
cleanup() {
  # Both profiles named, because a --profile flag replaces COMPOSE_PROFILES
  # from .env rather than adding to it.
  if [ "$passed" != true ]; then
    compose --profile https --profile restore ps --all || true
    compose --profile https --profile restore logs --no-color || true
  fi
  compose --profile https --profile restore down --volumes --remove-orphans || true
  rm -rf "$dir"
}
trap cleanup EXIT

cp "$root/selfhost/compose.yml" "$dir/compose.yml"
(
  umask 077
  sed -e "s/^POSTGRES_PASSWORD=\$/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" \
    -e "s|^ROOM_SECRET_KEY=\$|ROOM_SECRET_KEY=$(openssl rand -base64 32)|" \
    -e "s|^PUBLIC_ORIGIN=\$|PUBLIC_ORIGIN=https://smoke.invalid|" \
    "$root/selfhost/env.example" > "$dir/.env"
  printf '%s\n' "RACCOON_IMAGE=${image%:*}" "RACCOON_VERSION=${image##*:}" COMPOSE_PROFILES=https SITE_ADDRESS=http://smoke.invalid >> "$dir/.env"
)

echo "Bringing the stack up with $image:"
compose up --detach --wait --wait-timeout 300

echo "The app answers /healthz on raccoon-edge, where a front end reaches it:"
docker run --rm --network raccoon-edge --read-only --cap-drop ALL --security-opt no-new-privileges "$image" \
  node -e "fetch('http://raccoon:3000/healthz').then(async (r) => { const body = await r.text(); console.log(r.status, body); process.exit(r.ok && JSON.parse(body).status === 'ok' ? 0 : 1) }).catch((e) => { console.error(e); process.exit(1) })"

echo "Caddy passes it through:"
curl -fsS --max-time 10 --retry 5 --retry-connrefused -H 'Host: smoke.invalid' "http://$http/healthz"
echo

echo "The mounted files are the sources, byte for byte:"
compose exec -T egress cat /etc/squid/squid.conf | cmp - "$root/docker/squid.conf"
compose exec -T backup cat /backup/backup.sh | cmp - "$root/docker/backup.sh"
compose --profile restore run --rm -T restore cat /backup/backup.sh | cmp - "$root/docker/backup.sh"
echo "Same bytes in egress, backup and restore."

echo "A backup runs:"
out=$(compose exec -T backup sh /backup/backup.sh once)
echo "$out"
case $out in
  *": good"*) ;;
  *) echo "The backup did not end good." >&2; exit 1 ;;
esac

passed=true
echo "Smoke test passed."
