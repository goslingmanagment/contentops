#!/usr/bin/env bash
# The single launch script of the stack (SPEC §12.1, PLAN 1а): app, database, scheduler and
# workers from the checked-out tag. Safe to re-run; run as the user that owns /srv/* (uid
# 1000 in the VM), from the deploy checkout:
#
#   /opt/contentops/ops/up.sh
#
# 1. .env exists and is 0600 (secrets);
# 2. REQUIRE_HOST_MOUNTS (.env) are mount points here, on the host: inside a container a bind
#    mount always looks mounted. Each mounted storage root gets the volume mark the containers
#    check (.contentops-volume); without the disk the root is an empty immutable directory
#    and gets none. A missing mount: web, db and proxy start, the workers do not, and
#    /healthz stays red with the reason (SPEC §12.2);
# 3. docker compose up -d --build (migrate runs once before web and the workers);
# 4. waits for /healthz through nginx and prints a short status.
set -euo pipefail

cd "$(dirname "$0")/.."
log() { printf 'up: %s\n' "$*"; }
die() { printf 'up: %s\n' "$*" >&2; exit 1; }

[[ -f .env ]] || die ".env is missing: copy .env.example, fill the secrets, chmod 600 .env"
mode=$(stat -c '%a' .env)
[[ $mode == 600 ]] || die ".env has mode $mode, needs 600: chmod 600 .env"

# Only the values this script needs; compose reads the whole file itself.
env_value() { sed -n "s/^$1=//p" .env | tail -n 1; }
env_or() { local value; value=$(env_value "$1"); printf '%s' "${value:-$2}"; }
PROXY_PORT=$(env_or PROXY_PORT 8080)
IFS=, read -r -a required_mounts <<<"$(env_value REQUIRE_HOST_MOUNTS)"
volume_roots=("$(env_or DATA_ROOT /srv/content)" "$(env_or DERIVED_ROOT /srv/derived)"
  "$(env_or TMP_ROOT /srv/tmp)")

missing=()
for path in "${required_mounts[@]}"; do
  [[ -n $path ]] || continue
  mountpoint -q "$path" || missing+=("$path")
done
for root in "${volume_roots[@]}"; do
  [[ " ${missing[*]} " == *" $root "* ]] && continue
  [[ -e $root/.contentops-volume ]] || touch "$root/.contentops-volume" ||
    die "cannot write the volume mark into $root"
done

services=(db migrate web proxy)
workers=(worker worker-video worker-image)
if ((${#missing[@]} > 0)); then
  log "NOT MOUNTED: ${missing[*]} — the workers stay stopped, /healthz is red (ops/README.md)"
  docker compose stop "${workers[@]}" >/dev/null 2>&1 || true
else
  services+=("${workers[@]}")
fi

log "docker compose up: ${services[*]}"
docker compose up -d --build --remove-orphans "${services[@]}"

url="http://127.0.0.1:${PROXY_PORT}/healthz"
body=''
for _ in $(seq 1 90); do
  body=$(curl -sS --max-time 3 "$url" 2>/dev/null || true)
  [[ $body == *'"ok":true'* ]] && break
  # Without a disk it stays red: the first answer is the answer.
  ((${#missing[@]} > 0)) && [[ $body == *'"ok":false'* ]] && break
  sleep 2
done

docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
if [[ $body == *'"ok":true'* ]]; then
  log "healthz green: $url"
else
  log "healthz NOT green: ${body:-no answer} ($url)"
  log "logs: docker compose logs --tail 50 web migrate"
  exit 1
fi
