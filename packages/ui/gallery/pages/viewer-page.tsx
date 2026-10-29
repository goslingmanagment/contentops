import { EllipsisIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../../src/components/button'
import { DownloadButton } from '../../src/components/download-button'
import { Viewer, type ViewerFile } from '../../src/components/viewer'
import { useHashRoute } from '../use-hash-route'
import { downloadOptions } from './sample-menus'

const photos: readonly ViewerFile[] = Array.from({ length: 21 }, (_, index) => ({
  seed: `SET-074/${String(index + 1).padStart(2, '0')}`,
  type: 'photo',
  aspect: '3:4',
  family: 'lace',
  label: `фото ${index + 1}`,
}))

const master: ViewerFile = {
  seed: 'PPV-073',
  type: 'video',
  aspect: '9:16',
  family: 'party',
  durationSeconds: 804,
}

/** Просмотр: `#/viewer` — фото с лентой, `?video` — видео, `?compare` и `?compare-video` — сравнение. */
export function ViewerPage() {
  const route = useHashRoute()
  const [index, setIndex] = useState(6)
  const [open, setOpen] = useState(true)
  const video = route.includes('video')
  const compare = route.includes('compare')
  const files = video ? [master] : photos
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Button onClick={() => setOpen(true)}>Открыть просмотр</Button>
      <Viewer
        open={open}
        onOpenChange={setOpen}
        title={video ? 'PPV-073 · мастер v2 · 13:24' : `SET-074 · фото ${index + 1} из 21`}
        files={files}
        index={video ? 0 : index}
        onIndexChange={setIndex}
        previewProgress={route.includes('pending') ? 40 : undefined}
        actions={
          <>
            <DownloadButton variant="bar" options={downloadOptions} onDownload={() => undefined} />
            <Button variant="bar" size="icon" aria-label="Ещё">
              <EllipsisIcon />
            </Button>
          </>
        }
        info={<p className="text-muted-foreground">Бандл на стену · 13:24 · 21 фото</p>}
        compare={
          compare
            ? video
              ? {
                  left: master,
                  right: { ...master, seed: 'PPV-073-v2' },
                  leftLabel: 'v1',
                  rightLabel: 'v2',
                }
              : {
                  left: photos[6] ?? master,
                  right: { seed: 'SET-074/07-ed', type: 'photo', aspect: '3:4', family: 'lace' },
                  leftLabel: 'исходный',
                  rightLabel: 'обр.',
                }
            : undefined
        }
      />
    </div>
  )
}
