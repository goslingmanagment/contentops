import { Button } from '@contentops/ui/components/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@contentops/ui/components/tooltip'
import { UploadIcon } from 'lucide-react'
import { useUploads } from '../upload/upload-context'

/**
 * «Загрузить» (DESIGN §2.2): белая, 44, радиус 12, лёгкая тень, синий значок и слово
 * 15/600. Открывает окно загрузки; цель подставляется сама.
 */
export function UploadButton({ collapsed }: { collapsed: boolean }) {
  const { openUploadDialog } = useUploads()
  const button = (
    <Button
      variant="outline"
      size={collapsed ? 'icon-lg' : 'lg'}
      aria-label={collapsed ? 'Загрузить' : undefined}
      onClick={() => openUploadDialog()}
      className="w-full border-transparent shadow-xs hover:bg-background hover:shadow-md [&_svg]:text-primary"
    >
      <UploadIcon />
      {collapsed ? null : 'Загрузить'}
    </Button>
  )
  if (!collapsed) {
    return button
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">Загрузить</TooltipContent>
    </Tooltip>
  )
}
