#!/usr/bin/env python3
"""Сводка слепого просмотра: key.json (сцена/конфиг/вид пробы) + ответы r/*.json.
    python3 blind_report.py key.json r/
Печатает markdown: надёжность каждого зрителя по контролям и повторам, распределение
оценок по конфигам и сценам, кадры, пропущенные при показе."""
import glob, json, os, sys
from collections import defaultdict

key = json.load(open(sys.argv[1]))
trials = {t["id"]: t for t in key["trials"]}
LAB = {1: "не вижу", 2: "не мешает", 3: "слегка мешает", 4: "мешает"}
sessions = []
for p in sorted(glob.glob(os.path.join(sys.argv[2], "*.json"))):
    try: sessions.append(json.load(open(p)))
    except Exception as e: print(f"<!-- {p}: {e} -->")

def dropped(r):
    return sum((r["dropped"].get(s) or [0, 0])[0] for s in ("ref", "test"))

print(f"# Слепой просмотр — {len(sessions)} сеансов, ключ от {key['generated']}\n")
print("## Зрители\n")
print("| Зритель | Проб | Контроль orig↔orig (ждём 1) | Контроль CRF 40 (ждём 3–4) | Повторы (|Δ|) | Пропущено кадров | Экран, 1:1 | Минут |")
print("|---|---:|---|---|---|---:|---|---:|")
good = {}
for s in sessions:
    R = {r["trial"]: r for r in s["responses"]}
    neg = [R[t]["rating"] for t in R if trials[t]["kind"] == "neg"]
    pos = [R[t]["rating"] for t in R if trials[t]["kind"] == "pos"]
    reps = []
    for t in R:
        if trials[t]["kind"] == "repeat":
            twin = next((u for u in R if u != t and trials[u]["scene"] == trials[t]["scene"] and trials[u]["cfg"] == trials[t]["cfg"] and trials[u]["kind"] == "test"), None)
            if twin: reps.append(abs(R[t]["rating"] - R[twin]["rating"]))
    drop = sum(dropped(r) for r in s["responses"])
    scale = min((r["scale"] for r in s["responses"]), default=0)
    mins = sum(r["seconds"] for r in s["responses"]) / 60
    # ненадёжен: «мешает» на одинаковых файлах, большинство CRF 40 не замечено, или повтор разошёлся на 2+ ступени
    ok = all(v <= 2 for v in neg) and (not pos or sum(v >= 3 for v in pos) * 2 >= len(pos)) and all(v <= 1 for v in reps)
    good[s["session"]] = ok
    d = s["device"]
    print(f"| {s['name']}{'' if ok else ' ⚠'} | {len(R)}/{len(s['order'])} | {neg} | {pos} | {reps} | {drop} | {d['screen'][0]}×{d['screen'][1]} @{d['dpr']}×, min {scale:.2f} | {mins:.0f} |")
print("\n⚠ — провалил контроль или повтор; ниже такие сеансы не учитываются.\n")
print("## Контроли по сценам (все сеансы)\n")
print("| Сцена | Вид | Оценки |")
print("|---|---|---|")
ctl = defaultdict(list)
for s in sessions:
    for r in s["responses"]:
        t = trials[r["trial"]]
        if t["kind"] in ("neg", "pos"): ctl[(t["scene"], t["cfg"])].append(f"{s['name']}:{r['rating']}")
for (scene, cfg), v in sorted(ctl.items()): print(f"| {scene} | {cfg} | {' '.join(v)} |")
print("\n## По зрителям и конфигам (все сеансы, только пробы и повторы)\n")
print("| Зритель | Конфиг | Оценки | Средняя |")
print("|---|---|---|---:|")
for s in sessions:
    per = defaultdict(list)
    for r in s["responses"]:
        t = trials[r["trial"]]
        if t["kind"] in ("test", "repeat"): per[t["cfg"]].append(r["rating"])
    for cfg, v in sorted(per.items()): print(f"| {s['name']} | {cfg} | {''.join(map(str, sorted(v)))} | {sum(v)/len(v):.2f} |")
print()

by_cfg = defaultdict(list); by_scene = defaultdict(lambda: defaultdict(list)); comments = defaultdict(list)
for s in sessions:
    if not good.get(s["session"]): continue
    for r in s["responses"]:
        t = trials[r["trial"]]
        if t["kind"] not in ("test", "repeat"): continue
        by_cfg[t["cfg"]].append(r["rating"]); by_scene[t["cfg"]][t["scene"]].append(r["rating"])
        if r["comment"]: comments[(t["cfg"], t["scene"])].append(f"{s['name']}: {r['comment']} ({LAB[r['rating']]})")
print("## По конфигам (надёжные сеансы)\n")
print("| Конфиг | Ответов | 1 не вижу | 2 не мешает | 3 слегка | 4 мешает | Средняя | Доля ≤ 2 |")
print("|---|---:|---:|---:|---:|---:|---:|---:|")
for cfg, v in sorted(by_cfg.items()):
    c = [v.count(i) for i in (1, 2, 3, 4)]
    print(f"| {cfg} | {len(v)} | {c[0]} | {c[1]} | {c[2]} | {c[3]} | {sum(v)/len(v):.2f} | {100*(c[0]+c[1])/len(v):.0f} % |")
print("\n## По сценам\n")
for cfg, sc in sorted(by_scene.items()):
    print(f"**{cfg}**\n")
    print("| Сцена | Оценки | Средняя | Отрезок | Что заметили |")
    print("|---|---|---:|---|---|")
    for scene, v in sorted(sc.items(), key=lambda kv: -sum(kv[1]) / len(kv[1])):
        seg = key["segments"][scene]
        print(f"| {scene} | {''.join(map(str, sorted(v)))} | {sum(v)/len(v):.2f} | {seg['start']:.1f}+{key['seg_s']}s{' кроп ' + seg['crop'] if seg.get('crop') else ''} | {'<br>'.join(comments.get((cfg, scene), []))} |")
    print()
