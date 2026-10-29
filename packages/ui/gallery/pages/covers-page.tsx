import { Thumb } from '../../src/components/thumb'
import { GallerySection } from '../gallery-section'
import { sampleCovers } from '../sample-covers'

const families = [
  'bedroom',
  'lace',
  'party',
  'evening',
  'bath',
  'kitchen',
  'street',
  'office',
] as const

export function CoversPage() {
  return (
    <>
      <GallerySection
        title="40 обложек по ID"
        note="3:4, подписи длительности, числа фото и версии"
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-4">
          {sampleCovers.map((cover) => (
            <figure key={cover.id} className="flex flex-col gap-1.5">
              <Thumb
                seed={cover.id}
                kind={cover.kind}
                family={cover.id === 'PPV-073' ? 'party' : undefined}
                durationSeconds={cover.durationSeconds}
                countLabel={cover.countLabel}
                versionCount={cover.versionCount}
              />
              <figcaption className="truncate text-ink-3 text-sm">{cover.id}</figcaption>
            </figure>
          ))}
        </div>
      </GallerySection>
      <GallerySection
        title="Восемь семейств"
        note="по одному зерну в каждом семействе, все раскладки"
      >
        <div className="grid grid-cols-8 gap-3">
          {families.map((family) => (
            <div key={family} className="flex flex-col gap-2">
              {['a', 'b', 'c'].map((suffix) => (
                <Thumb key={suffix} seed={`${family}-${suffix}-7`} family={family} />
              ))}
              <p className="text-ink-3 text-sm">{family}</p>
            </div>
          ))}
        </div>
      </GallerySection>
      <GallerySection
        title="Пропорции и кадры мастера"
        note="9:16 вписано, 16:9 для YouTube, 1:1 в списке, кадры 5 × 2"
      >
        <div className="flex flex-wrap items-start gap-6">
          <Thumb
            seed="PPV-073"
            family="party"
            aspect="9:16"
            durationSeconds={804}
            versionCount={2}
            className="w-37"
          />
          <Thumb
            seed="PPV-073-teaser"
            family="party"
            aspect="9:16"
            durationSeconds={32}
            className="w-37"
          />
          <Thumb
            seed="PRM-017-yt"
            kind="promo"
            aspect="16:9"
            durationSeconds={95}
            className="w-60"
          />
          <Thumb seed="PRM-017-yt" kind="promo" aspect="9:16" mediaAspect="16:9" className="w-37" />
          <Thumb
            seed="SET-074"
            kind="set"
            aspect="1:1"
            showCaptions={false}
            className="w-10 rounded-md"
          />
          <div className="grid grid-cols-5 gap-2">
            {Array.from({ length: 10 }, (_, frame) => (
              <Thumb
                key={frame}
                seed="PPV-073"
                family="party"
                aspect="9:16"
                frame={frame + 1}
                showCaptions={false}
                className="w-20.5"
              />
            ))}
          </div>
        </div>
      </GallerySection>
    </>
  )
}
