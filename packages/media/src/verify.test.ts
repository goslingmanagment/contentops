import { describe, expect, it } from 'vitest'
import { encodeLogParser, errorLog, ptsDrift, truncated } from './verify.ts'

describe('ptsDrift (1 ms, as tools/ts_drift.py)', () => {
  const src = [0, 1 / 120, 2 / 120, 3 / 120, 0.05, 0.1]
  it('compares times relative to the first frame', () => {
    expect(
      ptsDrift(
        src,
        src.map((t) => t + 1.5),
        1,
      ),
    ).toEqual({ comparable: true, drifted: 0, maxDriftMs: 0 })
  })
  it('counts frames moved by more than the tolerance', () => {
    const moved = [...src]
    moved[2] = (moved[2] as number) + 0.002
    moved[3] = (moved[3] as number) + 0.0005
    const d = ptsDrift(src, moved, 1)
    expect(d.drifted).toBe(1)
    expect(d.maxDriftMs).toBe(2)
  })
  it('is not comparable with different counts or missing times', () => {
    expect(ptsDrift(src, src.slice(1), 1).comparable).toBe(false)
    expect(ptsDrift(src, [...src.slice(1), Number.NaN], 1).comparable).toBe(false)
    expect(ptsDrift([], [], 1).comparable).toBe(false)
  })
})

describe('encode log', () => {
  it('reads showinfo frames and splits source and encoder errors', () => {
    const frames: number[] = []
    const source = errorLog()
    const encoder = errorLog()
    const feed = encodeLogParser({ onFrame: (t) => frames.push(t), source, encoder })
    feed('[Parsed_showinfo_0 @ 0x1] [info] n:   0 pts:      0 pts_time:0       duration: 1')
    feed('[Parsed_showinfo_0 @ 0x1] [info] n:   1 pts:    512 pts_time:0.0333333 duration: 1')
    feed('[Parsed_showinfo_0 @ 0x1] [info]   side data - display matrix')
    feed('[h264 @ 0x2] [error] Invalid NAL unit size (1515853324 > 19542).')
    feed('[vist#0:0/h264 @ 0x3] [dec:h264 @ 0x4] [error] Decoding error: Invalid data')
    feed('Svt[error]: out of memory')
    feed('[out#0/mp4 @ 0x5] [error] Could not write header')
    // A VFR iPhone source in the check's null output (VM run 30.10.2026): ours, not the source's.
    feed(
      '[null @ 0x7455c94d1100] [error] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 1 >= 1',
    )
    feed('Svt[warn]: Failed to set thread priority')
    feed('[info] frame=   35 fps=0.0')
    expect(frames).toEqual([0, 0.0333333])
    expect(source.count).toBe(2)
    expect(encoder.count).toBe(3)
  })
  it('calls a source truncated below 95 % of promised frames', () => {
    expect(truncated(94, 100)).toBe(true)
    expect(truncated(95, 100)).toBe(false)
    expect(truncated(10, null)).toBe(false)
  })
})
