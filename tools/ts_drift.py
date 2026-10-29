#!/usr/bin/env python3
"""Сколько кадров ушло по времени больше чем на 1 мс относительно источника.
Вход — два файла со списком pts_time декодированных кадров (по числу в строке):
источник (из showinfo при кодировании) и результат (из ffprobe -show_frames).
Печатает число уехавших кадров; -1, если число кадров не совпало."""
import sys

def load(p):
    with open(p) as f:
        return sorted(float(x) for x in f.read().split() if x.strip())

a, b = load(sys.argv[1]), load(sys.argv[2])
if len(a) != len(b) or not a:
    print(-1); sys.exit()
a = [x - a[0] for x in a]; b = [x - b[0] for x in b]
print(sum(1 for x, y in zip(a, b) if abs(x - y) > 0.001))
