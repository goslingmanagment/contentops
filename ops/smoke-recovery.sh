#!/usr/bin/env bash
# Recovery of the stack after typical failures (PLAN 6, SPEC §5 «Фоновые работы …
# продолжаются после перезапуска», §12.2). ON DEMAND ONLY: every check breaks the stack on
# purpose for a minute or two. Run in the deploy checkout like ops/up.sh; the smoke suite
# (ops/smoke.sh, SMOKE_TOKEN) is part of several checks.
#
#   ops/smoke-recovery.sh worker db restart          the checks that also suit the VM
#   ops/smoke-recovery.sh --local offline mounts …   + the ones for a local stack only
#
# worker   SIGKILL of `worker` in the middle of a verify-blobs run (one blob row is held by a
#          lock for 25 s, so the run waits on it): the run stays `running` with the lease of
#          the dead holder; the new worker takes it over once the lease (60 s) is out, with
#          the next fence generation, and finishes it; one run, every blob counted once.
# db       the database stopped and started (`docker compose stop db`, `start db`): /healthz
#          red while it is away, green again;
#          web and the workers reconnect by themselves; nothing lost; the smoke suite passes.
# restart  the whole stack stopped and started again with ops/up.sh: running works went back
#          to the queue, the scheduler made one row per stream and interval and never two;
#          the smoke suite passes.
# offline  LOCAL ONLY. Hub and Я.Диск unreachable (a closed port, 127.0.0.1:9): Hub receiving
#          and the Я.Диск scan of the first model are switched on in the database, their
#          integrations turn «down / unreachable» (временно недоступно), the smoke writes
#          still pass. Stays on for the checks after it; switched off and restored at the end.
# mounts   LOCAL ONLY. The gate of ops/up.sh for a missing disk (E: in the VM), never done on
#          the VM: DERIVED_ROOT without its volume mark and listed in REQUIRE_HOST_MOUNTS →
#          db, web and proxy up, the workers stopped, /healthz 503 «volumes»; a worker started
#          by hand waits and claims nothing; ops/up.sh with the disk back → green.
#
# --local is refused when .env lists REQUIRE_HOST_MOUNTS: that is the VM. Exit 1 on a failure.
set -euo pipefail

cd "$(dirname "$0")/.."
die() { printf 'recovery: %s\n' "$*" >&2; exit 1; }
log() { printf '\nrecovery: %s\n' "$*"; }
[[ -f .env ]] || die ".env is missing"
env_value() {
  if [[ -n ${!1+set} ]]; then printf '%s' "${!1}"; else sed -n "s/^$1=//p" .env | tail -n 1; fi
}

local_stack=0
checks=()
for arg in "$@"; do
  case $arg in
    --local) local_stack=1 ;;
    worker | db | restart) checks+=("$arg") ;;
    offline | mounts) checks+=("$arg") ;;
    *) die "unknown check $arg (worker db restart offline mounts, --local)" ;;
  esac
done
((${#checks[@]} > 0)) || die "name the checks: worker db restart [--local offline mounts]"
for check in "${checks[@]}"; do
  if [[ $check == offline || $check == mounts ]] && ((!local_stack)); then
    die "$check is for a local stack only: add --local"
  fi
done
if ((local_stack)) && [[ -n $(env_value REQUIRE_HOST_MOUNTS) ]]; then
  die "--local on a stack with REQUIRE_HOST_MOUNTS (the VM): refused"
fi

PORT=$(env_value PROXY_PORT)
HEALTH="http://127.0.0.1:${PORT:-8080}/healthz"
results=()
pass() { results+=("ok    $1"); printf 'ok    %s\n' "$1"; }
fail() { results+=("FAIL  $1"); printf 'FAIL  %s\n' "$1"; }
# Read-only questions to the database, as the superuser inside the db container.
sql() { docker compose exec -T db psql -U postgres -d contentops -XAtq -v ON_ERROR_STOP=1 -c "$1"; }
# Changes of the local stack only, with the journal context the triggers want.
sql_change() {
  docker compose exec -T db psql -U postgres -d contentops -XAtq -v ON_ERROR_STOP=1 >/dev/null <<SQL
BEGIN;
SELECT set_config('app.actor_type', 'system', true), set_config('app.actor_id', '', true),
       set_config('app.actor_label', 'smoke-recovery', true),
       set_config('app.action', 'smoke.recovery', true),
       set_config('app.request_id', gen_random_uuid()::text, true),
       set_config('app.item_id', '', true), set_config('app.work_id', '', true);
$1
COMMIT;
SQL
}
health_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH" || true; }
wait_health() { # wait_health <code> <seconds>
  local deadline=$((SECONDS + $2))
  while ((SECONDS < deadline)); do
    [[ $(health_code) == "$1" ]] && return 0
    sleep 1
  done
  return 1
}
container() { docker compose ps -q "$1"; }
smoke() { ops/smoke.sh "$@" >"$tmp/smoke.txt" 2>&1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# --- offline: Hub and Я.Диск unreachable -----------------------------------------------
offline_on=0
offline_restore() {
  ((offline_on)) || return 0
  log "offline: switching Hub and the Я.Диск scan off again, the stack back to .env"
  sql_change "UPDATE policy_settings SET value = 'false'::jsonb
                WHERE key IN ('hub.receive', 'ydisk.scan') AND updated_by IS NULL
                  AND value = 'true'::jsonb;"
  unset HUB_BASE_URL HUB_API_KEY YDISK_TOKEN COMPOSE_FILE
  docker compose up -d --no-build web worker >/dev/null 2>&1 || true
  offline_on=0
}
check_offline() {
  log "offline: Hub and Я.Диск pointed at a closed port"
  local model
  model=$(sql "SELECT code FROM models WHERE code <> 'smoke' AND archived_at IS NULL ORDER BY id LIMIT 1")
  [[ -n $model ]] || { fail "offline: no model to switch on"; return; }
  override="$tmp/offline.yml"
  # YDISK_API_BASE is not in docker-compose.yml: the closed port reaches the roles by this file.
  cat >"$override" <<'YAML'
services:
  web: { environment: { YDISK_API_BASE: "http://127.0.0.1:9" } }
  worker: { environment: { YDISK_API_BASE: "http://127.0.0.1:9" } }
YAML
  export COMPOSE_FILE="${COMPOSE_FILE:-$(env_value COMPOSE_FILE)}"
  COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}:$override"
  export HUB_BASE_URL=http://127.0.0.1:9 HUB_API_KEY=smoke-offline YDISK_TOKEN=smoke-offline
  offline_on=1
  docker compose up -d --no-build web worker >/dev/null 2>&1
  wait_health 200 120 || { fail "offline: healthz not green after recreate"; return; }
  sql_change "INSERT INTO policy_settings (model_id, account_id, key, value)
                SELECT a.model_id, a.id, 'hub.receive', 'true'::jsonb FROM accounts a
                  JOIN models m ON m.id = a.model_id
                 WHERE m.code = '$model' AND a.hub_page_ref IS NOT NULL
              ON CONFLICT ON CONSTRAINT policy_settings_scope DO UPDATE SET value = excluded.value;
              INSERT INTO policy_settings (model_id, key, value)
                SELECT id, 'ydisk.scan', 'true'::jsonb FROM models WHERE code = '$model'
              ON CONFLICT ON CONSTRAINT policy_settings_scope DO UPDATE SET value = excluded.value;
              -- What switching on does in the app (resumeSwitch): paused works are due again.
              UPDATE work_operations SET paused_reason = NULL, next_attempt_at = now()
               WHERE paused_reason IN ('switch_off:hub.receive', 'switch_off:ydisk.scan')
                 AND state IN ('pending', 'retry_wait');"
  # One line per switched-on integration: «hub lora-1 down unreachable».
  local states='' hub_down=0 ydisk_down=0 deadline=$((SECONDS + 240))
  while ((SECONDS < deadline)); do
    states=$(curl -s --max-time 10 -H "Authorization: Bearer $(env_value SMOKE_TOKEN)" \
      "http://127.0.0.1:${PORT:-8080}/api/v1/admin/integrations" |
      docker compose exec -T web node -e '
        let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
          for (const i of JSON.parse(s).items) {
            if ((i.kind === "hub" || i.kind === "ydisk") && i.state !== "off" && i.state !== "unset")
              console.log(i.kind, i.account ?? i.model, i.state, i.down_reason ?? "-")
          }
        })' 2>/dev/null)
    hub_down=$(grep -c '^hub .* down unreachable$' <<<"$states" || true)
    ydisk_down=$(grep -c '^ydisk .* down unreachable$' <<<"$states" || true)
    ((hub_down > 0 && ydisk_down > 0)) && break
    sleep 5
  done
  if ((hub_down > 0 && ydisk_down > 0)); then
    pass "offline: «недоступен» — $(tr '\n' ',' <<<"$states" | sed 's/,$//; s/,/, /g')"
  else
    fail "offline: integrations did not turn unreachable — $(tr '\n' ',' <<<"${states:-no answer}")"
  fi
  if smoke; then pass "offline: smoke suite passes with Hub and Я.Диск away"
  else fail "offline: smoke suite failed (below)"; cat "$tmp/smoke.txt"; fi
}

# --- worker: SIGKILL in the middle of a job --------------------------------------------
check_worker() {
  log "worker: SIGKILL in the middle of verify-blobs"
  local blobs id state last deadline
  blobs=$(sql "SELECT count(*) FROM blobs WHERE state = 'present'")
  ((blobs > 0)) || { fail "worker: no blobs to verify"; return; }
  last=$(sql "SELECT encode(max(sha256), 'hex') FROM blobs WHERE state = 'present'")
  # The last blob of the run's order is held by a lock: the run hashes the others and then
  # waits on it, `running`, with its lease renewed — the middle of a job. The lock goes when
  # this script ends its session (at most 5 min).
  docker compose exec -T -e PGAPPNAME=smoke-recovery-lock db psql -U postgres -d contentops \
    -XAtq -c "BEGIN; SELECT 1 FROM blobs WHERE sha256 = decode('$last', 'hex') FOR UPDATE;
              SELECT pg_sleep(300); COMMIT;" >/dev/null 2>&1 &
  local holder=$!
  release() {
    sql "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity
          WHERE application_name = 'smoke-recovery-lock'" >/dev/null
    wait "$holder" 2>/dev/null || true
  }
  sleep 2
  id=$(docker compose --progress quiet run --rm -T --no-deps web node dist/ops.js verify-blobs \
    2>/dev/null | sed -n 's/.*"operation_id": "\([^"]*\)".*/\1/p')
  [[ -n $id ]] || { fail "worker: verify-blobs not queued"; release; return; }
  # verify-blobs has the lowest priority of the light works: it may wait for its turn.
  deadline=$((SECONDS + 240))
  state=''
  while ((SECONDS < deadline)); do
    state=$(sql "SELECT w.state || ':' || (SELECT count(*) FROM pg_stat_activity
                   WHERE application_name = 'worker' AND wait_event_type = 'Lock')
                   FROM work_operations w WHERE id = '$id'")
    [[ $state == running:[1-9]* ]] && break
    sleep 0.5
  done
  if [[ $state != running:[1-9]* ]]; then
    fail "worker: the run did not reach the held blob ($state)"
    release
    return
  fi
  local before
  before=$(sql "SELECT 'generation ' || fence_generation || ', lease to ' ||
                       to_char(lease_until, 'HH24:MI:SS') FROM work_operations WHERE id = '$id'")
  docker kill --signal KILL "$(container worker)" >/dev/null
  pass "worker: SIGKILL while the run waited in the middle ($before)"
  release
  docker compose up -d --no-build worker >/dev/null 2>&1
  # The lease of the dead holder runs out (60 s), then the new worker takes the run over.
  deadline=$((SECONDS + 240))
  while ((SECONDS < deadline)); do
    state=$(sql "SELECT state FROM work_operations WHERE id = '$id'")
    [[ $state == succeeded || $state == failed ]] && break
    sleep 2
  done
  local row generation attempts checked copies
  row=$(sql "SELECT state, fence_generation, attempt_no, coalesce(report->>'checked', '0'),
                    (SELECT count(*) FROM work_operations w2 WHERE w2.kind = 'verify_blobs'
                        AND w2.work_key = w.work_key)
               FROM work_operations w WHERE id = '$id'")
  IFS='|' read -r state generation attempts checked copies <<<"$row"
  if [[ $state == succeeded ]] && ((generation >= 2 && copies == 1 && checked == blobs)); then
    pass "worker: taken over after the lease and finished — generation $generation, attempt $attempts, $checked of $blobs blobs counted once, one row"
  else
    fail "worker: after the kill — $state, generation $generation, attempt $attempts, checked $checked of $blobs, rows $copies"
  fi
}

# --- db: restart of the database ------------------------------------------------------
check_db() {
  log "db: the database stopped and started again"
  local items works web_started worker_started saw_red=0
  items=$(sql "SELECT count(*) FROM content_items")
  works=$(sql "SELECT count(*) FROM work_operations")
  web_started=$(docker inspect -f '{{.State.StartedAt}}' "$(container web)")
  worker_started=$(docker inspect -f '{{.State.StartedAt}}' "$(container worker)")
  # A restart in two steps, so the red /healthz is seen for sure: a quick restart of
  # PostgreSQL may slip between two polls.
  docker compose stop db >/dev/null 2>&1
  if wait_health 503 30; then saw_red=1; fi
  if ((saw_red)); then pass "db: database stopped — /healthz red: $(curl -s "$HEALTH")"
  else fail "db: database stopped, /healthz still $(health_code)"; fi
  docker compose start db >/dev/null 2>&1
  if wait_health 200 120; then pass "db: /healthz green again"
  else fail "db: /healthz still red after 120 s"; return; fi
  if [[ $(docker inspect -f '{{.State.StartedAt}}' "$(container web)") == "$web_started" &&
        $(docker inspect -f '{{.State.StartedAt}}' "$(container worker)") == "$worker_started" ]]; then
    pass "db: web and worker reconnected without a restart"
  else
    pass "db: web or worker restarted by the restart policy and came back"
  fi
  if smoke; then pass "db: smoke suite passes after the restart"
  else fail "db: smoke suite failed (below)"; cat "$tmp/smoke.txt"; fi
  local items_after works_after
  items_after=$(sql "SELECT count(*) FROM content_items")
  works_after=$(sql "SELECT count(*) FROM work_operations")
  if ((items_after >= items && works_after >= works)); then
    pass "db: nothing lost — objects $items → $items_after, works $works → $works_after"
  else
    fail "db: rows lost — objects $items → $items_after, works $works → $works_after"
  fi
}

# --- restart: the whole stack down and up ---------------------------------------------
stream_rows() { sql "SELECT count(*) FROM work_operations WHERE stream_key IS NOT NULL"; }
check_restart() {
  log "restart: the whole stack stopped and started with ops/up.sh"
  local streams before after dup unfinished stale
  streams=$(sql "SELECT count(DISTINCT stream_key) FROM work_operations
                  WHERE stream_key IS NOT NULL AND created_at > now() - interval '1 day'")
  before=$(stream_rows)
  docker compose stop >/dev/null 2>&1
  pass "restart: stack stopped ($streams periodic streams, $before scheduled rows)"
  if ops/up.sh >"$tmp/up.txt" 2>&1; then pass "restart: ops/up.sh green"
  else fail "restart: ops/up.sh not green (below)"; tail -20 "$tmp/up.txt"; return; fi
  # The scheduler ticks every 10 s; three ticks after the start.
  sleep 35
  after=$(stream_rows)
  dup=$(sql "SELECT count(*) FROM (SELECT 1 FROM work_operations WHERE stream_key IS NOT NULL
               GROUP BY model_id, stream_key, work_key HAVING count(*) > 1) d")
  unfinished=$(sql "SELECT count(*) FROM (SELECT 1 FROM work_operations
                      WHERE stream_key IS NOT NULL AND state IN ('pending', 'running', 'retry_wait')
                      GROUP BY model_id, kind, stream_key HAVING count(*) > 1) d")
  if ((dup == 0 && unfinished == 0)); then
    pass "restart: one row per stream and interval — rows $before → $after, no duplicates"
  else
    fail "restart: $dup intervals with two rows, $unfinished streams with two unfinished rows"
  fi
  stale=$(sql "SELECT count(*) FROM work_operations WHERE state = 'running'
                AND lease_until < now() - interval '2 minutes'")
  if ((stale == 0)); then pass "restart: no work left running with a dead lease"
  else fail "restart: $stale works running with an expired lease"; fi
  if smoke --reads-only; then pass "restart: smoke reads pass"
  else fail "restart: smoke reads failed (below)"; cat "$tmp/smoke.txt"; fi
}

# --- mounts: the disk gate of ops/up.sh (local only) ----------------------------------
check_mounts() {
  log "mounts: DERIVED_ROOT unmounted, as disk E: would be"
  local root code running
  root=$(env_value DERIVED_ROOT)
  [[ -d $root ]] || { fail "mounts: DERIVED_ROOT $root is not a directory here"; return; }
  rm -f "$root/.contentops-volume"
  if REQUIRE_HOST_MOUNTS=$root ops/up.sh >"$tmp/up.txt" 2>&1; then
    fail "mounts: ops/up.sh went green without the disk"
  elif grep -q "NOT MOUNTED: $root" "$tmp/up.txt"; then
    pass "mounts: ops/up.sh says NOT MOUNTED and exits 1"
  else
    fail "mounts: ops/up.sh failed otherwise (below)"; tail -20 "$tmp/up.txt"
  fi
  running=" $(docker compose ps --status running --format '{{.Service}}' | tr '\n' ' ') "
  if [[ $running == *" web "* && $running == *" db "* && $running == *" proxy "* &&
        $running != *" worker "* && $running != *" worker-video "* && $running != *" worker-image "* ]]; then
    pass "mounts: db, web, proxy up; the workers stopped"
  else
    fail "mounts: running services:$running"
  fi
  code=$(health_code)
  if [[ $code == 503 ]] && curl -s "$HEALTH" | grep -q volumes; then
    pass "mounts: /healthz 503 — $(curl -s "$HEALTH")"
  else
    fail "mounts: /healthz $code"
  fi
  docker compose up -d --no-build --no-deps worker >/dev/null 2>&1
  sleep 8
  if docker compose logs --since 30s worker 2>&1 | grep -q 'storage is not mounted'; then
    pass "mounts: a worker started by hand waits and claims nothing"
  else
    fail "mounts: the worker did not say it waits for the storage"
  fi
  if ops/up.sh >"$tmp/up.txt" 2>&1 && [[ -e $root/.contentops-volume ]]; then
    pass "mounts: disk back — ops/up.sh marks it, starts the workers, /healthz green"
  else
    fail "mounts: ops/up.sh after the disk came back (below)"; tail -20 "$tmp/up.txt"
  fi
}

trap 'offline_restore; rm -rf "$tmp"' EXIT
for check in offline worker db restart mounts; do
  [[ " ${checks[*]} " == *" $check "* ]] || continue
  "check_$check"
done
offline_restore

printf '\nrecovery summary\n'
printf '%s\n' "${results[@]}"
for line in "${results[@]}"; do [[ $line == FAIL* ]] && exit 1; done
exit 0
