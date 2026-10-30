import { describe, expect, it } from 'vitest'
import { masterCreationTime, masterEncodeArgs, planMaster } from './master.ts'
import { type FfprobeJson, type FfprobeStream, parseFfprobe } from './probe.ts'

function probeOf(video: Partial<FfprobeStream>, audio: Partial<FfprobeStream>[], mbps: number) {
  const json: FfprobeJson = {
    format: { duration: '10', tags: {} },
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'h264',
        width: 1920,
        height: 1080,
        avg_frame_rate: '30/1',
        r_frame_rate: '30/1',
        ...video,
      },
      ...audio.map((a, i) => ({
        index: i + 1,
        codec_type: 'audio',
        codec_name: 'aac',
        codec_tag_string: 'mp4a',
        ...a,
      })),
    ],
  }
  return parseFfprobe(json, (mbps * 1e6 * 10) / 8)
}

describe('planMaster (SPEC §9.2)', () => {
  it('keeps web uploads, HDR, AV1 and low bitrates as they are', () => {
    expect(planMaster(probeOf({}, [{}], 30), { webUpload: true }).decision).toBe('copy')
    expect(planMaster(probeOf({ color_transfer: 'smpte2084' }, [{}], 30)).decision).toBe(
      'skipped_hdr',
    )
    expect(planMaster(probeOf({ color_transfer: 'arib-std-b67' }, [{}], 30)).decision).toBe(
      'skipped_hdr',
    )
    expect(planMaster(probeOf({ codec_name: 'av1' }, [{}], 30)).decision).toBe('skipped_av1')
    // The benchmark's edge case: 7.954 Mbit/s is below 8, no rounding.
    expect(planMaster(probeOf({}, [{}], 7.954)).decision).toBe('skipped_lowrate')
    expect(planMaster(probeOf({}, [{}], 8)).decision).toBe('encode')
  })

  it('copies supported audio, drops apple_apac with a note, keeps other audio by not encoding', () => {
    const both = planMaster(
      probeOf({}, [{}, { codec_name: 'apple_apac', codec_tag_string: 'apac' }], 30),
    )
    expect(both.decision).toBe('encode')
    expect(both.keepAudio.map((a) => a.audioIndex)).toEqual([0])
    expect(both.dropAudio.map((a) => a.audioIndex)).toEqual([1])
    expect(both.notes.join()).toContain('apple_apac')
    expect(
      planMaster(probeOf({}, [{ codec_name: 'apple_apac', codec_tag_string: 'apac' }], 30))
        .decision,
    ).toBe('skipped_audio')
    expect(planMaster(probeOf({}, [{}, { codec_name: 'adpcm_ima_qt' }], 30)).decision).toBe(
      'skipped_audio',
    )
    expect(planMaster(probeOf({}, [], 30)).decision).toBe('encode')
  })
})

describe('master command', () => {
  it('is the benchmark profile with SVTAV1_LP as lp', () => {
    const plan = planMaster(probeOf({}, [{}, {}], 30))
    const args = masterEncodeArgs('in.mov', 'out.mp4', plan, {
      lp: 4,
      creationTime: '2024-01-02T03:04:05Z',
    })
    const joined = args.join(' ')
    for (const part of [
      '-map 0:v:0 -map 0:a:0 -map 0:a:1 -c:a copy -map_metadata 0',
      '-fps_mode passthrough -enc_time_base:v 1/1000000',
      '-c:v libsvtav1 -preset 6 -crf 24 -pix_fmt yuv420p10le -g 300',
      '-svtav1-params tune=1:lp=4:enable-qm=1:qm-min=0:qm-max=15',
      '-metadata creation_time=2024-01-02T03:04:05Z',
      '-video_track_timescale 600000 -movflags +faststart+use_metadata_tags',
    ]) {
      expect(joined).toContain(part)
    }
    expect(args.at(-1)).toBe('out.mp4')
    expect(masterEncodeArgs('a', 'b', plan, { lp: 6, creationTime: 'x' }).join(' ')).toContain(
      'tune=1:lp=6:',
    )
  })

  it('takes the creation date like compress-library.sh, else the mtime', () => {
    const mtime = new Date('2023-06-07T08:09:10.500Z')
    expect(masterCreationTime({ creation_time: '2024-01-02T03:04:05.000000Z' }, mtime)).toBe(
      '2024-01-02T03:04:05Z',
    )
    expect(masterCreationTime({ creation_time: '2024-01-02 03:04:05' }, mtime)).toBe(
      '2024-01-02T03:04:05Z',
    )
    expect(masterCreationTime({ creation_time: '2024-01-02T03:04:05 PMZ' }, mtime)).toBe(
      '2024-01-02T15:04:05Z',
    )
    expect(masterCreationTime({ creation_time: '2024-01-02T12:04:05 AMZ' }, mtime)).toBe(
      '2024-01-02T00:04:05Z',
    )
    expect(
      masterCreationTime({ creation_time: '2024-01-02T03:04:05Z;2024-01-03T03:04:05Z' }, mtime),
    ).toBe('2023-06-07T08:09:10Z')
    expect(masterCreationTime({}, mtime)).toBe('2023-06-07T08:09:10Z')
  })
})
