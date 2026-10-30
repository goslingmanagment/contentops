import { describe, expect, it } from 'vitest'
import { type FfprobeJson, parseFfprobe, parseZoned, UnreadableMediaError } from './probe.ts'

/** Shape of an iPhone HDR portrait clip with spatial audio, as ffprobe prints it. */
export const IPHONE_LIKE: FfprobeJson = {
  format: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: '10.000000',
    tags: {
      creation_time: '2024-01-02T03:04:05.000000Z',
      'com.apple.quicktime.creationdate': '2024-01-02T06:04:05+0300',
      'com.apple.quicktime.make': 'Maker',
      'com.apple.quicktime.model': 'Phone',
      'com.apple.quicktime.software': '18.0',
    },
  },
  streams: [
    {
      index: 0,
      codec_type: 'video',
      codec_name: 'hevc',
      codec_tag_string: 'hvc1',
      width: 3840,
      height: 2160,
      pix_fmt: 'yuv420p10le',
      avg_frame_rate: '60/1',
      r_frame_rate: '60/1',
      nb_frames: '600',
      color_transfer: 'arib-std-b67',
      color_primaries: 'bt2020',
      side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }],
    },
    {
      index: 1,
      codec_type: 'audio',
      codec_name: 'aac',
      codec_tag_string: 'mp4a',
      channels: 2,
      sample_rate: '48000',
    },
    {
      index: 2,
      codec_type: 'audio',
      codec_name: 'apple_apac',
      codec_tag_string: 'apac',
      channels: 4,
    },
    { index: 3, codec_type: 'data', codec_tag_string: 'mebx' },
  ],
}

describe('parseFfprobe', () => {
  it('reads rotation, display size, HDR, audio and the zoned shooting time', () => {
    const p = parseFfprobe(IPHONE_LIKE, 125_000_000)
    expect(p.durationMs).toBe(10_000)
    expect(p.bitRate).toBe(100_000_000)
    expect(p.video).toMatchObject({
      codec: 'hevc',
      rotation: 90,
      displayWidth: 2160,
      displayHeight: 3840,
      bitDepth: 10,
      isHdr: true,
      isVfr: false,
      nbFrames: 600,
      fpsNum: 60,
      fpsDen: 1,
    })
    expect(p.audio.map((a) => [a.audioIndex, a.codec, a.applePositional])).toEqual([
      [0, 'aac', false],
      [1, 'apple_apac', true],
    ])
    expect(p.otherStreams).toBe(1)
    expect(p).toMatchObject({
      shotAt: '2024-01-02T03:04:05.000Z',
      shotAtLocal: '2024-01-02T06:04:05',
      shotTz: '+03:00',
      camera: { make: 'Maker', model: 'Phone', software: '18.0' },
    })
  })

  it('flags VFR, PQ and Dolby Vision, and an apac tag without a codec', () => {
    const streams = IPHONE_LIKE.streams ?? []
    const json: FfprobeJson = {
      format: { duration: '2', tags: { creation_time: '2024-01-02T03:04:05Z' } },
      streams: [
        {
          ...streams[0],
          index: 0,
          avg_frame_rate: '3200/100',
          r_frame_rate: '120/1',
          color_transfer: 'bt709',
          side_data_list: [{ side_data_type: 'DOVI configuration record' }],
        },
        { index: 1, codec_type: 'audio', codec_name: undefined, codec_tag_string: 'apac' },
      ],
    }
    const p = parseFfprobe(json, 1000)
    expect(p.video.isVfr).toBe(true)
    expect(p.video.dolbyVision).toBe(true)
    expect(p.video.isHdr).toBe(true)
    expect(p.audio[0]?.applePositional).toBe(true)
    expect(p.shotAt).toBe('2024-01-02T03:04:05.000Z')
    expect(p.shotTz).toBeNull()
  })

  it('throws Unreadable without a video stream or a duration', () => {
    expect(() => parseFfprobe({ format: { duration: '1' }, streams: [] }, 10)).toThrow(
      UnreadableMediaError,
    )
    expect(() => parseFfprobe({ format: {}, streams: IPHONE_LIKE.streams }, 10)).toThrow(
      UnreadableMediaError,
    )
  })

  it('parses QuickTime zoned dates in both offset forms', () => {
    expect(parseZoned('2024-01-02T06:04:05-0130')).toEqual({
      shotAt: '2024-01-02T07:34:05.000Z',
      shotAtLocal: '2024-01-02T06:04:05',
      shotTz: '-01:30',
    })
    expect(parseZoned('2024-01-02T06:04:05+03:00')?.shotTz).toBe('+03:00')
    expect(parseZoned('garbage')).toBeNull()
  })
})
