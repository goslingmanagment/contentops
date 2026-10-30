#!/usr/bin/env bash
# Smoke checks of the running stack (PLAN 6, SPEC §12.2): every process and integration of
# stages 1–5 through nginx, web, the database and the worker roles. Safe on the real base: the
# models of the agency are only read (plus one download with its receipt); writes go only
# into the model `smoke` and stay there (apps/server/src/smoke/run.ts). No AI, no external
# model. Run in the deploy checkout, as the owner of /srv/* (ops/README.md «Smoke-проверки»):
#
#   ops/smoke.sh                  the suite: host checks, reads of every model, writes in smoke
#   ops/smoke.sh --reads-only     without the writes
#   ops/smoke.sh --setup          once: the smoke model, its contractor and agent (repeat-safe)
#   ops/smoke.sh --setup --token  a new token of the smoke agent (printed once) → SMOKE_TOKEN
#
# The token: SMOKE_TOKEN in the shell or in .env. Agents work only while «Агенты» is on
# (Настройки › Интеграции, the owner). Exit 0 — passed, 1 — something failed.
set -euo pipefail

cd "$(dirname "$0")/.."
die() { printf 'smoke: %s\n' "$*" >&2; exit 1; }
[[ -f .env ]] || die ".env is missing (ops/README.md)"
# A variable set in the shell wins over .env, as for compose (ops/up.sh).
env_value() {
  if [[ -n ${!1+set} ]]; then printf '%s' "${!1}"; else sed -n "s/^$1=//p" .env | tail -n 1; fi
}

if [[ ${1:-} == --setup ]]; then
  shift
  exec docker compose exec -T worker node dist/ops.js smoke-setup "$@"
fi

token=$(env_value SMOKE_TOKEN)
[[ -n $token ]] || die "SMOKE_TOKEN is empty: ops/smoke.sh --setup --token, then put it into .env"
port=$(env_value PROXY_PORT)
public=$(env_value PUBLIC_URL)
failed=0
row() { printf '%-4s  %-12s  %-24s  %s\n' "$1" "$2" "$3" "$4"; }

# What a person reaches: loopback nginx, and the address of the tailnet (tailscale serve).
for target in "loopback http://127.0.0.1:${port:-8080}/healthz" "tailnet ${public%/}/healthz"; do
  name=${target%% *} url=${target#* }
  [[ $url == /healthz ]] && continue
  body=$(curl -sS --max-time 10 "$url" 2>&1) || true
  if [[ $body == *'"ok":true'* ]]; then row ok host "healthz $name" "$url"
  else row FAIL host "healthz $name" "$url: ${body:-no answer}"; failed=1; fi
done

# Every long-running service of docker-compose.yml is up (migrate is one-shot).
running=" $(docker compose ps --status running --format '{{.Service}}' | tr '\n' ' ') "
for service in db web proxy worker worker-video worker-image; do
  if [[ $running == *" $service "* ]]; then row ok host "service $service" running
  else row FAIL host "service $service" "not running (docker compose ps)"; failed=1; fi
done

# The suite runs in a container of the app image on the stack network, through nginx.
CONTENTOPS_TOKEN=$token docker compose --progress quiet run --rm -T --no-deps -e CONTENTOPS_TOKEN \
  -e CONTENTOPS_URL=http://proxy:8080 web node dist/smoke.js "$@" || failed=1
exit "$failed"
