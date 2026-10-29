#!/usr/bin/env python3
"""Слепой просмотр (compression.md §10.1 п. 6): нарезка пар и манифест.

Запуск на winpc в WSL из ~/bench-v2:
    python3 blind_pairs.py probe plan.json   # подбор CRF доставочного x264
    python3 blind_pairs.py build plan.json   # нарезка всех клипов + manifest.json + key.json

Идея: обе стороны пары (оригинал и AV1-энкод) режутся на один и тот же отрезок и
перекодируются одним и тем же x264 (8-бит, как источник), чтобы в браузере у
любого зрителя декодировался один кодек аппаратно. Что доставочный x264 не
искажает сравнение, проверяется числом: VMAF(оригинал, x264(AV1)) должен
совпадать с VMAF(оригинал, AV1) с точностью до порога из плана.
Имена файлов клипов — случайные токены; соответствие «токен → сцена/конфиг»
живёт только в key.json, который на сайт не выкладывается.
"""
import json, os, secrets, shutil, subprocess, sys, time
from pathlib import Path

BASE = Path.home() / "bench-v2"
FF = str(BASE.parent / "opt/ffmpeg-btbn/bin/ffmpeg")
FP = str(BASE.parent / "opt/ffmpeg-btbn/bin/ffprobe")
if not os.path.exists(FF):
    FF, FP = "ffmpeg", "ffprobe"
MODEL = BASE / "models/vmaf_4k_v0.6.1neg.json"
OUT = BASE / "blind"
X264_PARAMS = "psy=0"   # без psy-rd: доставка должна быть верной копией, а не «красивой»


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode:
        raise RuntimeError(f"{' '.join(map(str, cmd))}\n{r.stderr[-2000:]}")
    return r.stdout


def probe(path):
    j = json.loads(run([FP, "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height,nb_frames,avg_frame_rate,r_frame_rate:format=duration",
                        "-of", "json", str(path)]))
    s = j["streams"][0]
    num, den = map(int, s["avg_frame_rate"].split("/"))
    return {"w": s["width"], "h": s["height"], "frames": int(s.get("nb_frames") or 0),
            "fps": round(num / den, 3) if den else 0.0, "dur": float(j["format"]["duration"])}


def worst_second(scene, cfg):
    """Начало худшей секунды по VMAF NEG (как в harness.py)."""
    j = json.load(open(BASE / "logs" / f"{scene}__{cfg}.vmaf.json"))
    fr = j["frames"]
    key = "vmaf_neg" if "vmaf_neg" in fr[0]["metrics"] else "vmaf"
    s = [f["metrics"][key] for f in fr]
    fps = max(1, round(len(s) / 45))
    i = min(range(len(s) - fps + 1), key=lambda i: sum(s[i:i + fps]))
    return i / fps, sum(s[i:i + fps]) / fps


def src_path(scene, cfg):
    if cfg == "orig":
        m = list((BASE / "windows").glob(f"{scene}.*"))
        assert m, f"нет окна {scene}"
        return m[0]
    return BASE / "encodes" / f"{scene}__{cfg}.mp4"


def crop_filter(crop):
    if not crop:
        return ""
    w, h = map(int, crop.split(":"))
    return f"crop={w}:{h}:(iw-{w})/2:(ih-{h})/2,"


def cut(src, start, dur, crop, crf, preset, dst):
    run([FF, "-nostdin", "-v", "error", "-y", "-ss", f"{start:.3f}", "-i", str(src), "-t", f"{dur:.3f}",
         "-map", "0:v:0", "-an", "-vf", f"{crop_filter(crop)}format=yuv420p",
         "-fps_mode", "passthrough", "-avoid_negative_ts", "make_zero",
         "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p",
         "-profile:v", "high", "-x264-params", "log-level=error:" + X264_PARAMS,
         "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
         "-movflags", "+faststart", "-video_track_timescale", "600000", str(dst)])
    return probe(dst)


def vmaf(ref_src, start, dur, crop, dist, dist_start=None, log=None):
    """VMAF NEG (модель бенчмарка) отрезка dist против отрезка оригинала."""
    log = log or (OUT / "tmp_vmaf.json")
    dist_in = ["-i", str(dist)] if dist_start is None else ["-ss", f"{dist_start:.3f}", "-t", f"{dur:.3f}", "-i", str(dist)]
    run([FF, "-nostdin", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(ref_src), *dist_in,
         "-lavfi", f"[0:v]{crop_filter(crop)}format=yuv420p10le,setpts=PTS-STARTPTS[r];"
                   f"[1:v]{crop_filter(crop) if dist_start is not None else ''}format=yuv420p10le,setpts=PTS-STARTPTS[d];"
                   f"[d][r]libvmaf=model=path={MODEL}:n_threads=8:log_fmt=json:log_path={log}",
         "-f", "null", "-"])
    j = json.load(open(log))
    fr = j["frames"]
    key = "vmaf_neg" if "vmaf_neg" in fr[0]["metrics"] else "vmaf"
    s = [f["metrics"][key] for f in fr]
    return round(sum(s) / len(s), 2), len(s)


def segments(plan):
    seg = plan["seg_s"]
    out = {}
    for scene, sc in plan["scenes"].items():
        info = probe(src_path(scene, "orig"))
        if "start" in sc:
            start, note = float(sc["start"]), "из плана"
        else:
            ws, val = worst_second(scene, plan["anchor_cfg"])
            start, note = ws + 0.5 - seg / 2, f"худшая секунда {plan['anchor_cfg']} @{ws:.1f}s vmaf={val:.1f}"
        start = max(0.0, min(start, info["dur"] - seg))
        crop = sc.get("crop")
        if crop is None and max(info["w"], info["h"]) > 1920:   # 4K: центральный кроп 1:1, иначе на экране будет уменьшение
            crop = "1080:1920" if info["h"] > info["w"] else "1920:1080"
        out[scene] = {"start": round(start, 3), "note": note, "crop": crop, "src": info}
    return out


def cmd_probe(plan):
    """Подбор CRF доставочного x264. Критерий — VMAF между двумя доставленными
    клипами (оригинал↔AV1) совпадает с VMAF сырых файлов на том же отрезке:
    значит, клипы выровнены по кадрам и доставка не меняет измеряемую разницу.
    Сравнивать доставленный клип с сырым источником напрямую нельзя: у HEVC .mov
    с edit list -ss даёт другой первый кадр (проверено 04.09 на hel23)."""
    OUT.mkdir(exist_ok=True)
    segs = segments(plan)
    d = plan["delivery"]
    global X264_PARAMS
    X264_PARAMS = d.get("x264_params", X264_PARAMS)
    rows = []
    for scene in plan["probe_scenes"]:
        s = segs[scene]
        ref = src_path(scene, "orig")
        av1 = src_path(scene, plan["anchor_cfg"])
        base, n0 = vmaf(ref, s["start"], plan["seg_s"], s["crop"], av1, dist_start=s["start"])
        print(f"{scene} отрезок {s['start']:.1f}+{plan['seg_s']}s ({s['note']}): VMAF(orig, av1)={base} кадров={n0}", flush=True)
        for crf in d["probe_crfs"]:
            t0 = time.time()
            co, ca = OUT / f"probe_{scene}_orig_{crf}.mp4", OUT / f"probe_{scene}_av1_{crf}.mp4"
            po = cut(ref, s["start"], plan["seg_s"], s["crop"], crf, d["preset"], co)
            pa = cut(av1, s["start"], plan["seg_s"], s["crop"], crf, d["preset"], ca)
            enc_s = time.time() - t0
            cc, n1 = vmaf(co, 0, plan["seg_s"], None, ca)
            so, sa = os.path.getsize(co) / 1e6, os.path.getsize(ca) / 1e6
            rows.append({"scene": scene, "crf": crf, "vmaf_raw": base, "vmaf_clips": cc, "delta": round(cc - base, 2),
                         "mb_orig": round(so, 1), "mb_av1": round(sa, 1), "frames": [n0, n1, po["frames"], pa["frames"]], "enc_s": round(enc_s, 1)})
            print(f"  crf{crf}: VMAF(x264(orig), x264(av1)) = {cc} (Δ {cc - base:+.2f}); {so:.1f}+{sa:.1f} MB; "
                  f"кадры {n1}/{po['frames']}/{pa['frames']}; {enc_s:.0f}s", flush=True)
    json.dump(rows, open(OUT / "probe.json", "w"), indent=1)
    ok = [crf for crf in d["probe_crfs"]
          if all(abs(r["delta"]) <= d["max_delta"] and r["frames"][2] == r["frames"][3] for r in rows if r["crf"] == crf)]
    chosen = max(ok) if ok else min(d["probe_crfs"])
    print(f"проходят: {ok}; выбран CRF {chosen}" + ("" if ok else " (никто не прошёл — взят минимальный)"), flush=True)
    return chosen


def cmd_build(plan, crf):
    OUT.mkdir(exist_ok=True)
    clips = OUT / "c"
    clips.mkdir(exist_ok=True)
    segs = segments(plan)
    d = plan["delivery"]
    global X264_PARAMS
    X264_PARAMS = d.get("x264_params", X264_PARAMS)
    made = {}   # (scene, cfg) -> token
    key = {"generated": time.strftime("%F %T"), "seg_s": plan["seg_s"], "delivery": {"codec": "libx264", "preset": d["preset"], "crf": crf, "x264_params": X264_PARAMS},
           "ffmpeg": run([FF, "-version"]).splitlines()[0], "segments": segs, "clips": {}, "trials": []}

    def clip(scene, cfg, copy_of=None):
        tok = secrets.token_hex(5)
        dst = clips / f"{tok}.mp4"
        if copy_of:
            shutil.copyfile(clips / f"{copy_of}.mp4", dst)
            info = probe(dst)
        else:
            s = segs[scene]
            info = cut(src_path(scene, cfg), s["start"], plan["seg_s"], s["crop"], crf, d["preset"], dst)
        key["clips"][tok] = {"scene": scene, "cfg": cfg, "bytes": os.path.getsize(dst), **info}
        print(f"  {scene} {cfg:>12} -> {tok}.mp4 {os.path.getsize(dst)/1e6:.1f} MB {info['w']}x{info['h']} {info['frames']} кадров {info['fps']} fps", flush=True)
        return tok

    trials = []
    for i, t in enumerate(plan["trials"], 1):
        scene, cfg, kind = t["scene"], t["test"], t["kind"]
        if (scene, "orig") not in made:
            made[(scene, "orig")] = clip(scene, "orig")
        ref = made[(scene, "orig")]
        if cfg == "orig":
            test = clip(scene, "orig", copy_of=ref)          # отрицательный контроль: копия под другим именем
        elif kind == "repeat":
            test = clip(scene, cfg, copy_of=made[(scene, cfg)]) # повтор: та же картинка, другое имя
        else:
            if (scene, cfg) not in made:
                made[(scene, cfg)] = clip(scene, cfg)
            test = made[(scene, cfg)]
        a, b = key["clips"][ref], key["clips"][test]
        assert a["frames"] == b["frames"] and a["w"] == b["w"], f"{scene} {cfg}: кадры/размер не совпали {a} {b}"
        tid = f"t{i:02d}"
        trials.append({"id": tid, "ref": f"c/{ref}.mp4", "test": f"c/{test}.mp4",
                       "w": a["w"], "h": a["h"], "fps": a["fps"], "frames": a["frames"]})
        key["trials"].append({"id": tid, "scene": scene, "cfg": cfg, "kind": kind, "ref": ref, "test": test})
    manifest = {"generated": key["generated"], "seg_s": plan["seg_s"], "trials": trials,
                "scale": plan.get("scale", {"незаметно": 0, "заметно, но не мешает": 1, "слегка мешает": 2, "мешает": 3})}
    json.dump(manifest, open(OUT / "manifest.json", "w"), ensure_ascii=False, indent=1)
    json.dump(key, open(OUT / "key.json", "w"), ensure_ascii=False, indent=1)
    total = sum(c["bytes"] for c in key["clips"].values()) / 1e6
    print(f"готово: {len(trials)} проб, {len(key['clips'])} клипов, {total:.0f} MB; manifest.json + key.json в {OUT}", flush=True)


if __name__ == "__main__":
    mode, plan = sys.argv[1], json.load(open(sys.argv[2]))
    if mode == "probe":
        cmd_probe(plan)
    elif mode == "build":
        crf = int(sys.argv[3]) if len(sys.argv) > 3 else cmd_probe(plan)
        cmd_build(plan, crf)
    else:
        sys.exit("режим: probe | build [crf]")
