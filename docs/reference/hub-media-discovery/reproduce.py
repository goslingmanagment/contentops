#!/usr/bin/env python3
"""Reproduce the 2026-09-03 Vault candidate census from private, local exports.

No network or production writes. Output excludes filenames, captions and CDN URLs.
A unique candidate is a proposal within this corpus, not a verified media match.
"""
import argparse
import collections
import csv
import hashlib
import json
import pathlib
import re
import unicodedata


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def path_key(value):
    # The inspected Windows copy substitutes '-' for a Disk filename's ':'.
    return unicodedata.normalize("NFC", re.sub(r"[\\/]+", "/", value)).replace(":", "-")


def stem_key(value, lossy=False):
    value = unicodedata.normalize("NFC", pathlib.PurePosixPath(value).stem).casefold()
    value = value.replace(":", "_")
    return "".join(c if ord(c) < 128 else "?" for c in value) if lossy else value


def bucket(count):
    return "none" if count == 0 else "one" if count == 1 else "several"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", type=pathlib.Path, action="append", required=True,
                        help="Firefox Save Response As JSON; repeat for every nonempty page")
    parser.add_argument("--hub-vault", type=pathlib.Path, required=True)
    parser.add_argument("--disk", type=pathlib.Path, required=True,
                        help="ydisk find '' --type file --all --detail JSON")
    parser.add_argument("--census", type=pathlib.Path, required=True,
                        help="Original UTF-8 census2.tsv copied with scp, not cmd type")
    parser.add_argument("--tolerance-seconds", type=float, default=0.12,
                        help="Exploratory candidate tolerance; not a validated acceptance rule")
    args = parser.parse_args()
    if args.tolerance_seconds < 0:
        parser.error("tolerance must be nonnegative")

    members, media = [], []
    page_sizes = []
    for path in args.vault:
        body = read_json(path)
        if body.get("success") is not True:
            raise ValueError(f"Unsuccessful native response: {path.name}")
        response = body["response"]
        page_sizes.append(len(response["albumMedia"]))
        members.extend(response["albumMedia"])
        media.extend(response["media"])
    if len({m["id"] for m in members}) != len(members):
        raise ValueError("Repeated membership IDs: deduplicate or fix pagination first")
    if len({m["id"] for m in media}) != len(media):
        raise ValueError("Repeated raw media IDs in this cohort")
    hub_body = read_json(args.hub_vault)
    hub = [x["fields"] for x in hub_body["data"]["items"]]
    disk_body = read_json(args.disk)
    disk = disk_body["items"]
    if disk_body["shown"] != disk_body["total"]:
        raise ValueError("Disk export is truncated")
    disk_by_path = collections.defaultdict(list)
    for row in disk:
        disk_by_path[path_key(row["p"])].append(row)
    with args.census.open(encoding="utf-8-sig", newline="") as f:
        census = list(csv.DictReader(f, delimiter="\t"))
    measured = {}
    for row in census:
        candidates = [r for r in disk_by_path[path_key(row["path"])]
                      if r["mt"] == "video" and r["sz_b"] == int(row["bytes"])]
        if row["status"] == "ok" and len(candidates) == 1:
            measured[candidates[0]["p"]] = row

    member_by_media = {m["mediaId"]: m for m in members}
    rows = []
    for item in media:
        metadata = json.loads(item.get("metadata") or "{}")
        duration = metadata.get("duration")
        dims = sorted([metadata.get("originalWidth", item.get("width")) or 0,
                       metadata.get("originalHeight", item.get("height")) or 0])
        media_type = "video" if item["type"] == 2 else "photo"
        candidates = [r for r in disk if r["mt"] == media_type
                      and stem_key(r["n"], True) == stem_key(item["filename"], True)]

        def same_shape(row):
            return (duration is not None
                    and abs(float(row["dur_s"]) - duration) <= args.tolerance_seconds
                    and sorted([int(row["width"]), int(row["height"])]) == dims)

        combined = [r for r in candidates if r["p"] in measured and same_shape(measured[r["p"]])]
        if any(not re.fullmatch(r"[0-9a-fA-F]{64}", r.get("sha256") or "") for r in combined):
            raise ValueError("Candidate lacks source SHA-256; content deduplication is not justified")
        title = member_by_media[item["id"]].get("customFilename") or ""
        title_candidates = [r for r in disk if r["mt"] == media_type and title
                            and stem_key(r["n"]) == stem_key(title)]
        rows.append({
            "mediaRef": item["id"],
            "nameCandidates": len(candidates),
            "technicalCandidates": sum(same_shape(r) for r in measured.values()),
            "combinedPathCandidates": len(combined),
            "combinedContentCandidates": len({r["sha256"] for r in combined}),
            "titleCandidates": len(title_candidates),
        })
    dimensions = ("nameCandidates", "technicalCandidates", "combinedPathCandidates",
                  "combinedContentCandidates", "titleCandidates")
    totals = {key: dict(collections.Counter(bucket(r[key]) for r in rows)) for key in dimensions}
    native_ids = {r["mediaId"] for r in members}
    hub_ids = {r["mediaRef"] for r in hub}
    report = {
        "method": "candidate census; uniqueness within inspected corpus only",
        "toleranceSeconds": args.tolerance_seconds,
        "diskAsOf": disk_body["as_of"],
        "diskTimezone": disk_body["tz"],
        "diskFiles": len(disk), "censusRows": len(census), "measuredDiskVideos": len(measured),
        "nativePageSizes": page_sizes,
        "nativeMembers": len(members), "nativeRawMedia": len(media), "hubRows": len(hub),
        "rawIdSymmetricDifference": sorted(native_ids ^ hub_ids),
        "memberIdSymmetricDifference": sorted({r["id"] for r in members} ^ {r["memberRef"] for r in hub}),
        "hubBlockers": hub_body.get("blockers", []),
        "rawFilenameContainsQuestionMark": sum("?" in r["filename"] for r in media),
        "nativeCustomFilenamePresent": sum(bool(r.get("customFilename")) for r in members),
        "counts": totals, "rows": rows,
        "inputs": [{"file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                   for path in [*args.vault, args.hub_vault, args.disk, args.census]],
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
