#!/usr/bin/env bash
# After a reboot of winpc or the VM (PLAN 6, SPEC §12.2): is the pilot back by itself?
# Read-only: nothing is started, stopped or written (the database is read in a read-only
# transaction). Run in the VM from the deploy checkout; the Windows half is
# ops/winpc/after-reboot-check.ps1. From the Mac:
#
#   ssh contentops-vm 'cd /opt/contentops && ops/vm/after-reboot-check.sh'
#
# Checks: boot time and the previous shutdown, the six storage mounts, swap, the read-only shares of
# Windows (/mnt/host with a fresh space.json, /mnt/ydisk mounted — nothing in it is read),
# Docker and every service of the stack, /healthz on loopback and on the tailnet address
# (`tailscale serve`), the workers' heartbeats and claims since the boot, works left running
# with a dead lease, the last Hub poll and the last Я.Диск/Dropbox scan. Exit 1 on a FAIL.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1
fails=0
row() { printf '%-4s  %-10s  %-26s  %s\n' "$1" "$2" "$3" "$4"; [[ $1 == FAIL ]] && fails=$((fails + 1)); return 0; }
env_value() { [[ -f .env ]] && sed -n "s/^$1=//p" .env | tail -n 1; }
sql() {
  docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' db \
    psql -U postgres -d contentops -XAtq -v ON_ERROR_STOP=1 -c "$1" 2>&1
}

# --- The VM itself --------------------------------------------------------------------
boot=$(uptime -s)
boot_epoch=$(date -d "$boot" +%s)
row ok vm "booted" "$boot (up $(uptime -p | sed 's/^up //'))"
previous=$(journalctl --list-boots --no-pager -q 2>/dev/null | tail -n 2 | head -n 1)
if [[ -n $previous ]]; then
  last=$(journalctl -b -1 -n 200 --no-pager -q -o cat 2>/dev/null |
    grep -E 'System is (rebooting|powering down)|Stopped target .*[Mm]ulti-[Uu]ser|Reached target .*(Power|Reboot|Shutdown)' |
    tail -n 1)
  if [[ -n $last ]]; then row ok vm "previous shutdown" "clean: $last"
  else row warn vm "previous shutdown" "no clean power-off/reboot line in the previous boot (power loss or a hard reset?)"; fi
else
  row warn vm "previous shutdown" "journal of the previous boot is not readable (sudo or group adm)"
fi

for path in /srv/vol/data /srv/vol/derived /srv/content /srv/db /srv/derived /srv/tmp; do
  if mountpoint -q "$path"; then row ok mounts "$path" "$(df -h --output=avail "$path" | tail -n 1 | tr -d ' ') free in the VM"
  else row FAIL mounts "$path" "NOT mounted: the workers stay stopped (ops/README.md «Диски ВМ»)"; fi
done
swap=$(swapon --show=NAME,SIZE --noheadings 2>/dev/null | awk '$1 == "/swapfile" {print $2}')
if [[ -n $swap ]]; then row ok vm "swap" "/swapfile $swap"
else row FAIL vm "swap" "/swapfile not active (ops/vm/setup-disks.sh swap)"; fi
# Automounted cifs shares: `stat -f` mounts them without reading any file of the copy.
for path in /mnt/host /mnt/ydisk; do
  type=$(timeout 15 stat -f -c %T "$path" 2>/dev/null)
  if [[ $type == smb2 || $type == cifs ]]; then row ok shares "$path" "$type, read-only"
  else row FAIL shares "$path" "not mounted (${type:-no answer})"; fi
done
space=/mnt/host/space.json
if [[ -f $space ]]; then
  age=$(($(date +%s) - $(stat -c %Y "$space")))
  if ((age < 900)); then row ok shares "space.json" "$((age / 60)) min old: ContentOps-Space runs"
  else row FAIL shares "space.json" "$((age / 60)) min old: ContentOps-Space on Windows has not written it"; fi
else
  row FAIL shares "space.json" "missing"
fi

# --- Docker and the stack -------------------------------------------------------------
if systemctl is-active --quiet docker; then row ok stack docker "active since $(systemctl show docker -p ActiveEnterTimestamp --value)"
else row FAIL stack docker "not active"; fi
while read -r service state status; do
  [[ -z $service ]] && continue
  if [[ $service == migrate ]]; then
    [[ $status == *"Exited (0)"* ]] && row ok stack "$service" "$status" || row FAIL stack "$service" "$status"
  elif [[ $state == running && $status != *unhealthy* ]]; then row ok stack "$service" "$status"
  else row FAIL stack "$service" "$state $status"; fi
done < <(docker compose ps -a --format '{{.Service}} {{.State}} {{.Status}}')
for service in db web proxy worker worker-video worker-image; do
  docker compose ps --status running --format '{{.Service}}' | grep -qx "$service" ||
    row FAIL stack "$service" "missing"
done

port=$(env_value PROXY_PORT)
public=$(env_value PUBLIC_URL)
for target in "loopback http://127.0.0.1:${port:-8080}/healthz" "tailnet ${public%/}/healthz"; do
  name=${target%% *} url=${target#* }
  [[ $url == /healthz ]] && continue
  body=$(curl -sS --max-time 10 "$url" 2>&1)
  if [[ $body == *'"ok":true'* ]]; then row ok access "healthz $name" "$url"
  else row FAIL access "healthz $name" "$url: ${body:-no answer}"; fi
done
if command -v tailscale >/dev/null; then
  self=$(tailscale status --self --peers=false 2>/dev/null | head -n 1)
  [[ $self == *offline* || -z $self ]] && row FAIL access tailscale "${self:-no status}" ||
    row ok access tailscale "$self"
  serve=$(tailscale serve status 2>/dev/null | grep -E 'https?://' | head -n 1)
  [[ -n $serve ]] && row ok access "tailscale serve" "$serve" ||
    row FAIL access "tailscale serve" "not configured (ops/README.md «Вход для людей»)"
fi

# --- Background work ------------------------------------------------------------------
probe=$(sql 'SELECT 1')
if [[ $probe != 1 ]]; then
  row FAIL work database "not readable: $probe"
else
  while IFS='|' read -r role claims beat; do
    [[ -z $role ]] && continue
    if ((claims > 0)); then row ok work "$role" "$claims works claimed since the boot, last heartbeat $beat"
    else row ok work "$role" "idle since the boot (nothing due), last heartbeat ${beat:-never}"; fi
  done < <(sql "
    WITH roles(role, kinds) AS (VALUES
      ('worker', ARRAY['scan','fetch','hash','unpack_archive','import_parse','register','propose',
                       'export','hub_sync','hub_history','hub_publish','annotate','verify_blobs','backup']),
      ('worker-video', ARRAY['derive_video','encode_master','verify_master','render','uniq_render',
                             'render_compat','extract_frame']),
      ('worker-image', ARRAY['derive_image']))
    SELECT r.role,
           count(w.id) FILTER (WHERE w.heartbeat_at >= to_timestamp($boot_epoch)),
           coalesce(to_char(max(w.heartbeat_at) AT TIME ZONE 'Europe/Moscow', 'DD.MM HH24:MI МСК'), '')
      FROM roles r LEFT JOIN work_operations w ON w.kind = ANY (r.kinds)
     GROUP BY r.role ORDER BY r.role")
  stale=$(sql "SELECT count(*) FROM work_operations WHERE state = 'running' AND lease_until < now() - interval '2 minutes'")
  ((stale == 0)) && row ok work "dead leases" "none" ||
    row FAIL work "dead leases" "$stale works running with a lease out for 2+ min: their worker is gone"
  queue=$(sql "SELECT coalesce(string_agg(kind || ' ' || n, ', '), 'empty') FROM (
                 SELECT kind, count(*) AS n FROM work_operations
                  WHERE state IN ('pending', 'retry_wait') AND paused_reason IS NULL
                  GROUP BY kind ORDER BY kind) q")
  row ok work queue "$queue"
  while IFS='|' read -r what last age failed; do
    [[ -z $what ]] && continue
    if [[ -z $last && -z $failed ]]; then row ok polls "$what" "never ran (off or not configured)"
    elif [[ -z $last ]]; then row warn polls "$what" "never succeeded; last failure $failed"
    elif ((age <= 2)); then row ok polls "$what" "last success $last${failed:+; last failure $failed}"
    else row warn polls "$what" "last success $last, $age h ago${failed:+; last failure $failed}"; fi
  done < <(sql "
    SELECT what,
           to_char(max(finished_at) FILTER (WHERE state = 'succeeded') AT TIME ZONE 'Europe/Moscow', 'DD.MM HH24:MI'),
           coalesce(floor(extract(epoch FROM now() - max(finished_at) FILTER (WHERE state = 'succeeded')) / 3600)::int, 0),
           (array_agg(coalesce(error_code, state) || ' ' || to_char(coalesce(finished_at, next_attempt_at) AT TIME ZONE 'Europe/Moscow', 'DD.MM HH24:MI')
              ORDER BY created_at DESC) FILTER (WHERE state IN ('failed', 'retry_wait')))[1]
      FROM (SELECT CASE WHEN kind = 'hub_sync' THEN 'Hub poll'
                        ELSE 'scan ' || coalesce((SELECT s.label FROM sources s WHERE s.id::text = w.scope), '?')
                   END AS what, *
              FROM work_operations w
             WHERE kind = 'hub_sync' OR (kind = 'scan' AND stream_key IS NOT NULL)) x
     GROUP BY what ORDER BY what")
fi

printf '%s\n' "$( ((fails)) && echo "FAILED: $fails" || echo PASSED)"
((fails == 0))
