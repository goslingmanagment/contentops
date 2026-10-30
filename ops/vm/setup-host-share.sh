#!/usr/bin/env bash
# Host share of the pilot VM (SPEC §12.2): the free space of C: and E: as Windows sees it
# (the VM disks are growing VHDX files, `df` here says nothing about the host).
#
#   //10.77.0.1/contentops-host -> /mnt/host   cifs, read-only, systemd automount
#
# Windows side: ops/winpc/register-tasks.ps1 (task ContentOps-Space writes space.json every
# 5 min, share read-only for PC\contentops-ro only). Same account and credentials file as
# /mnt/ydisk; a separate share, nothing is written into the Yandex copy. The web container
# binds /mnt/host read-only with rslave propagation, so the automount reaches it.
#
# Run from the Mac: ssh contentops-vm 'sudo bash -s' < ops/vm/setup-host-share.sh
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "setup-host-share: run as root (sudo)" >&2; exit 1; }

MNT=/mnt/host
LINE="//10.77.0.1/contentops-host $MNT cifs ro,vers=3.1.1,credentials=/etc/contentops/ydisk.cred,uid=1000,gid=1000,file_mode=0444,dir_mode=0555,_netdev,nofail,x-systemd.automount 0 0"

[[ -f /etc/contentops/ydisk.cred ]] || { echo "setup-host-share: no /etc/contentops/ydisk.cred" >&2; exit 1; }
mkdir -p "$MNT"
if ! grep -qE "^[^#]+[[:space:]]$MNT[[:space:]]" /etc/fstab; then
  cp -p /etc/fstab "/etc/fstab.bak-$(date +%Y%m%d-%H%M%S)"
  printf '%s\n' "$LINE" >>/etc/fstab
  echo "fstab: added $MNT"
fi
systemctl daemon-reload
systemctl restart "$(systemd-escape -p --suffix=automount "$MNT")"
# The first access mounts it.
if [[ -s $MNT/space.json ]]; then
  echo "setup-host-share: ok — $(cat "$MNT/space.json")"
else
  echo "setup-host-share: $MNT/space.json is not there yet (task ContentOps-Space on winpc?)" >&2
  exit 1
fi
