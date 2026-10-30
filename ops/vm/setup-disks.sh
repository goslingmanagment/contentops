#!/usr/bin/env bash
# Data disks and swap of the pilot VM `contentops` (SPEC §12.2). Safe to re-run.
#
#   data.vhdx    (C:, SCSI LUN 1, 1 TiB)   -> ext4 LABEL=co-data    -> /srv/vol/data
#     /srv/vol/data/content    -> bind /srv/content   blobs, inbox, encoder output next to blobs
#     /srv/vol/data/db         -> bind /srv/db        Postgres data
#   derived.vhdx (E:, SCSI LUN 2, 300 GiB) -> ext4 LABEL=co-derived -> /srv/vol/derived
#     /srv/vol/derived/derived -> bind /srv/derived   DERIVED_ROOT: previews, frames, thumbnails
#     /srv/vol/derived/tmp     -> bind /srv/tmp       prefetch, exports, scratch
#   /swapfile    (system disk, os.vhdx)    -> 8 GiB swap: a memory spike slows an encoder
#     instead of killing it. fallocate leaves the blocks unwritten, so os.vhdx grows only as
#     pages are swapped out. An existing swap file of another size stops the script.
#
# A disk whose label already exists is never touched. A blank disk is partitioned and
# formatted only if it has the expected size, no partition table, no signature and reads as
# zeros end to end (a fresh dynamic VHDX reads at ~6 GB/s: ~3 min for 1 TiB). Anything else
# stops the script. The empty mount points on the system disk are made immutable, so when a
# disk is missing nothing can be written there (nothing silently lands on C:).
#
# Keeping the VHDX thin (it allocates in 32 MB blocks): with ext4 defaults (flex_bg 16) the
# first mkfs wrote a bitmap every 2 GiB and grew data.vhdx to 17 GB and derived.vhdx to 5.4 GB
# empty. -G 4096 packs all metadata into one region; -i caps the inode tables (default 16 KiB
# per inode = 16 GiB of tables on 1 TiB that fill in as files spread): data 4M inodes, derived
# 4.9M. Zeros are proven, so mkfs skips zeroing inode tables and the journal.
#
# Run from the Mac: ssh contentops-vm 'sudo bash -s' < ops/vm/setup-disks.sh
# Swap only, nothing else touched (a running VM): ... 'sudo bash -s -- swap' < ...
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "setup-disks: run as root (sudo)" >&2; exit 1; }

APP_UID=1000
APP_GID=1000
MOUNT_OPTS=noatime,errors=remount-ro,nofail,x-systemd.device-timeout=10s
BIND_OPTS=bind,nofail,x-systemd.before=docker.service
SWAP_FILE=/swapfile
SWAP_BYTES=8589934592

# lun label size_bytes bytes_per_inode mountpoint
DISKS=(
  "1 co-data 1099511627776 262144 /srv/vol/data"
  "2 co-derived 322122547200 65536 /srv/vol/derived"
)
# source target mode
BINDS=(
  "/srv/vol/data/content /srv/content 0755"
  "/srv/vol/data/db /srv/db 0700"
  "/srv/vol/derived/derived /srv/derived 0755"
  "/srv/vol/derived/tmp /srv/tmp 0755"
)

die() { echo "setup-disks: $*" >&2; exit 1; }

# Empty directory on the system disk that a disk is mounted over; immutable while unmounted.
prepare_mountpoint() {
  local dir=$1
  mkdir -p "$dir"
  mountpoint -q "$dir" && return 0
  [[ -z $(ls -A "$dir") ]] || die "$dir is not empty on the system disk"
  chattr +i "$dir"
}

format_if_blank() {
  local lun=$1 label=$2 size=$3 ratio=$4 dev actual
  if [[ -e /dev/disk/by-label/$label ]]; then
    echo "$label: already formatted ($(readlink -f "/dev/disk/by-label/$label"))"
    return 0
  fi
  dev=/dev/disk/by-path/acpi-MSFT1000:00-scsi-0:0:0:$lun
  [[ -b $dev ]] || die "$label: no disk at SCSI LUN $lun"
  dev=$(readlink -f "$dev")
  actual=$(blockdev --getsize64 "$dev")
  [[ $actual == "$size" ]] || die "$label: $dev is $actual bytes, expected $size"
  [[ $(lsblk -nro NAME "$dev" | wc -l) -eq 1 ]] || die "$label: $dev has partitions"
  [[ -z $(wipefs -n "$dev") ]] || die "$label: $dev has a signature: $(wipefs -n "$dev")"
  echo "$label: $dev (WWN $(lsblk -dnro WWN "$dev")) — checking it is all zeros"
  cmp -s -n "$size" "$dev" /dev/zero || die "$label: $dev is not blank, not formatting"
  sgdisk --new=1:0:0 --typecode=1:8300 --change-name=1:"$label" "$dev" >/dev/null
  partprobe "$dev"
  udevadm settle
  mkfs.ext4 -q -L "$label" -m 0 -i "$ratio" -G 4096 \
    -E nodiscard,assume_storage_prezeroed=1 "${dev}1"
  udevadm settle
  [[ -e /dev/disk/by-label/$label ]] || die "$label: label not visible after mkfs"
  echo "$label: formatted ${dev}1"
}

write_fstab() {
  local begin='# contentops data disks (ops/vm/setup-disks.sh)' end='# end contentops data disks'
  local block lun label size ratio mnt src dst mode
  block="$begin"$'\n'
  for d in "${DISKS[@]}"; do
    read -r lun label size ratio mnt <<<"$d"
    block+="LABEL=$label $mnt ext4 $MOUNT_OPTS 0 2"$'\n'
  done
  for b in "${BINDS[@]}"; do
    read -r src dst mode <<<"$b"
    block+="$src $dst none $BIND_OPTS,x-systemd.requires-mounts-for=${src%/*} 0 0"$'\n'
  done
  block+="$end"
  # Replace our block, keep everything else (system disks, /mnt/ydisk).
  awk -v b="$begin" -v e="$end" '$0==b{skip=1} !skip{print} $0==e{skip=0}' /etc/fstab >/etc/fstab.new
  printf '%s\n' "$block" >>/etc/fstab.new
  if ! cmp -s /etc/fstab /etc/fstab.new; then
    cp -p /etc/fstab "/etc/fstab.bak-$(date +%Y%m%d-%H%M%S)"
    mv /etc/fstab.new /etc/fstab
    echo "fstab: updated"
  else
    rm /etc/fstab.new
  fi
  systemctl daemon-reload
}

setup_swap() {
  if [[ ! -e $SWAP_FILE ]]; then
    (umask 077 && fallocate -l "$SWAP_BYTES" "$SWAP_FILE")
    mkswap "$SWAP_FILE" >/dev/null
    echo "swap: created $SWAP_FILE"
  fi
  [[ $(stat -c %s "$SWAP_FILE") == "$SWAP_BYTES" ]] || die "swap: $SWAP_FILE is not $SWAP_BYTES bytes"
  if ! grep -qE "^${SWAP_FILE}[[:space:]]" /etc/fstab; then
    cp -p /etc/fstab "/etc/fstab.bak-$(date +%Y%m%d-%H%M%S)"
    printf '%s none swap sw 0 0\n' "$SWAP_FILE" >>/etc/fstab
    echo "fstab: added $SWAP_FILE"
  fi
  swapon --show=NAME --noheadings | grep -qx "$SWAP_FILE" || swapon "$SWAP_FILE"
  swapon --show
}

if [[ ${1:-} == swap ]]; then
  setup_swap
  echo "setup-disks: swap ok"
  exit 0
fi

for d in "${DISKS[@]}"; do
  read -r lun label size ratio mnt <<<"$d"
  format_if_blank "$lun" "$label" "$size" "$ratio"
  prepare_mountpoint "$mnt"
done
for b in "${BINDS[@]}"; do
  read -r src dst mode <<<"$b"
  prepare_mountpoint "$dst"
done

write_fstab

for d in "${DISKS[@]}"; do
  read -r lun label size ratio mnt <<<"$d"
  mountpoint -q "$mnt" || mount "$mnt"
done
for b in "${BINDS[@]}"; do
  read -r src dst mode <<<"$b"
  # Created once; later the app (e.g. Postgres) may own it differently — do not reset.
  [[ -d $src ]] || install -d -o "$APP_UID" -g "$APP_GID" -m "$mode" "$src"
  mountpoint -q "$dst" || mount "$dst"
done

for p in /srv/vol/data /srv/vol/derived /srv/content /srv/db /srv/derived /srv/tmp; do
  mountpoint -q "$p" || die "$p is not mounted"
  findmnt -no TARGET,SOURCE,FSTYPE --mountpoint "$p"
done
df -h --output=target,size,used,avail /srv/vol/data /srv/vol/derived
setup_swap
echo "setup-disks: ok"
