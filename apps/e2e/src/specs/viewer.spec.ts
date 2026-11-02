import { expect, test } from '../fixtures.ts'

/**
 * The viewer plays the browser copy of a clip (DESIGN §3.5, SPEC §9.3): «Играть» starts the
 * `preview.mp4` of the master — its time goes on and new frames are presented — `Space` pauses
 * and the slider seeks. Before, the viewer drew a scene and «Играть» played nothing.
 */

// H.264 of `preview.mp4` needs Google Chrome: the Chromium build of Playwright lacks the codec on
// Linux. The runner image of CI has Chrome.
test.use({ channel: 'chrome' })

test('просмотр играет превью ролика: кадры идут, Space — пауза, ползунок перематывает', async ({
  km: page,
}) => {
  await page.goto('/lora/i/PPV-085?view=master')
  const video = page.getByRole('dialog').locator('video')
  // The preview comes with the thumbnails in the first pass; until then the card is re-read.
  await expect(video).toHaveCount(1, { timeout: 90_000 })
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
    .toBeGreaterThanOrEqual(2)
  expect(await video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toMatch(
    /\/api\/v1\/lora\/g\/[^/]+\/preview\.mp4$/,
  )

  const playback = () =>
    video.evaluate((element: HTMLVideoElement) => ({
      seconds: element.currentTime,
      frames: element.getVideoPlaybackQuality().totalVideoFrames,
      paused: element.paused,
    }))
  const start = await playback()
  await page.getByRole('button', { name: 'Играть' }).click()
  await expect(page.getByRole('button', { name: 'Пауза' })).toBeVisible()
  await expect.poll(async () => (await playback()).seconds).toBeGreaterThan(start.seconds + 1)
  await expect.poll(async () => (await playback()).frames).toBeGreaterThan(start.frames + 10)

  await page.keyboard.press('Space')
  await expect.poll(async () => (await playback()).paused).toBe(true)

  const slider = page.getByRole('slider', { name: 'Позиция' })
  await slider.evaluate((input: HTMLInputElement) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    set?.call(input, String(Number(input.max) * 0.75))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await expect.poll(async () => (await playback()).seconds).toBeCloseTo(9, 0)
  await expect(page.getByRole('dialog').getByText('0:09 / 0:12')).toBeVisible()
})
