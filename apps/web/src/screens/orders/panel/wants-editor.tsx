import { Checkbox } from '@contentops/ui/components/checkbox'
import { Input } from '@contentops/ui/components/input'
import { Label } from '@contentops/ui/components/label'
import { type KeyboardEvent, useId, useState } from 'react'
import { EditorActions } from './field-editors'

interface WantsEditorProps {
  video: boolean
  photos: number
  pending: boolean
  onSave: (next: { wants_video: boolean; wants_photos: number }) => void
  onCancel: () => void
}

/** «Ждём видео и/или фото, число фото» (DESIGN §4.16, п. 2). */
export function WantsEditor({ video, photos, pending, onSave, onCancel }: WantsEditorProps) {
  const [wantsVideo, setWantsVideo] = useState(video)
  const [photoCount, setPhotoCount] = useState(String(photos))
  const videoId = useId()
  const photosId = useId()
  const save = () => {
    const count = Number.parseInt(photoCount, 10)
    onSave({
      wants_video: wantsVideo,
      wants_photos: Number.isFinite(count) ? Math.max(0, count) : 0,
    })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') save()
    if (event.key === 'Escape') onCancel()
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-5">
        <Label htmlFor={videoId}>
          <Checkbox
            id={videoId}
            checked={wantsVideo}
            onCheckedChange={(checked) => setWantsVideo(checked === true)}
          />
          видео
        </Label>
        <Label htmlFor={photosId}>
          фото
          <Input
            id={photosId}
            type="number"
            min={0}
            inputMode="numeric"
            value={photoCount}
            onChange={(event) => setPhotoCount(event.target.value)}
            onKeyDown={onKeyDown}
            className="w-18"
          />
        </Label>
      </div>
      <EditorActions pending={pending} onSave={save} onCancel={onCancel} />
    </div>
  )
}
