/**
 * "Share" on a track: preview the infographic, choose whether it carries the
 * exact position, then take away a PNG.
 *
 * A modal now, not an inline panel that used to push the rest of the page
 * down by a full portrait card's height. The location toggle sits directly
 * under the preview it affects, and the actions are pinned in a footer that
 * never scrolls out of reach on a phone -- the failure mode the inline version
 * had, where "Share" could be a full screen of scrolling below the fold.
 */
import { useId, useRef, useState } from 'react'
import { DownloadIcon, ImageIcon, Share2Icon, SmartphoneIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/toast-primitives'
import { cn } from '@/lib/cn'
import type { Track } from '@/lib/api/types'

import type { RssiSample } from '../rssi-samples'

import { CARD_HEIGHT, CARD_WIDTH, ShareCard } from './share-card'
import { buildShareCardModel } from './share-card-model'
import {
  canCopyImages,
  canShareFiles,
  cardFilename,
  downloadBlob,
  renderCardToPngBlob,
  shareBlockedByInsecureContext,
  ShareCardExportError,
  shareCardPng,
} from './share-card-export'

export function ShareTrack({
  track,
  rssiSamples = [],
}: {
  track: Track
  /** Drives the card's signal-strength plot. */
  rssiSamples?: RssiSample[]
}) {
  const [open, setOpen] = useState(false)
  const [includeLocation, setIncludeLocation] = useState(true)
  const [busy, setBusy] = useState<'png' | 'copy' | 'share' | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const toggleId = useId()
  const toast = useToast()

  const model = buildShareCardModel(track, !includeLocation, rssiSamples)
  const hasPosition = Boolean(track.current)
  // Probed once per render: it depends on the origin being secure, not on state.
  const nativeShare = canShareFiles()
  const insecureContext = !nativeShare && shareBlockedByInsecureContext()

  async function withCard<T>(run: (svg: SVGSVGElement) => Promise<T>): Promise<T | null> {
    const svg = svgRef.current
    if (!svg) return null
    try {
      return await run(svg)
    } catch (error) {
      toast.add({
        title: 'Could not create the image',
        description:
          error instanceof ShareCardExportError
            ? error.message
            : 'Rendering the card failed. The track itself is unaffected.',
        type: 'error',
      })
      return null
    } finally {
      setBusy(null)
    }
  }

  async function handleDownload() {
    setBusy('png')
    await withCard(async (svg) => {
      const blob = await renderCardToPngBlob(svg, {
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
      })
      downloadBlob(cardFilename(model.title, model.lastSeen), blob)
    })
  }

  /**
   * Hand the card to the OS share sheet — messages, mail, whatever the phone
   * has — instead of dropping a PNG into Downloads for the person to go and
   * find.
   *
   * The text deliberately carries no coordinates even when the card does. A
   * share sheet forwards this string into places the image does not always
   * follow (a subject line, a preview, a link unfurl), and a location that
   * leaks through a channel the redaction toggle never saw is worse than one
   * shown deliberately on the card.
   */
  async function handleShare() {
    setBusy('share')
    await withCard(async (svg) => {
      const blob = await renderCardToPngBlob(svg, {
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
      })
      const outcome = await shareCardPng(blob, cardFilename(model.title, model.lastSeen), {
        title: `ClassG detection — ${model.headline}`,
        text: `${model.headline} detected ${model.seenLabel} · ${String(
          model.detectionCount,
        )} detections · ${model.confidenceLabel} confidence.`,
      })
      // Falling back rather than failing: a browser that advertises sharing and
      // then refuses files should still get the person their image.
      if (outcome === 'unsupported') {
        downloadBlob(cardFilename(model.title, model.lastSeen), blob)
      }
    })
  }

  async function handleCopy() {
    setBusy('copy')
    await withCard(async (svg) => {
      const blob = await renderCardToPngBlob(svg, {
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
      })
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      toast.add({ title: 'Card copied to the clipboard', type: 'success' })
    })
  }

  return (
    <Dialog
      trigger={
        <Button variant="outline" size="sm">
          <Share2Icon aria-hidden />
          Share
        </Button>
      }
      title="Share this detection"
      description="A record of the detection, without the console around it."
      open={open}
      onOpenChange={setOpen}
      footer={
        <div className="flex flex-col gap-2">
          {nativeShare ? (
            <Button
              size="touch"
              className="w-full"
              onClick={() => void handleShare()}
              disabled={busy !== null}
            >
              <SmartphoneIcon aria-hidden />
              {busy === 'share' ? 'Preparing…' : 'Share…'}
            </Button>
          ) : null}

          <div className="flex gap-2">
            {canCopyImages() ? (
              <Button
                variant="outline"
                size={nativeShare ? 'sm' : 'touch'}
                className="flex-1"
                onClick={() => void handleCopy()}
                disabled={busy !== null}
              >
                <ImageIcon aria-hidden />
                {busy === 'copy' ? 'Copying…' : 'Copy'}
              </Button>
            ) : null}
            <Button
              variant={nativeShare ? 'outline' : 'default'}
              size={nativeShare ? 'sm' : 'touch'}
              className="flex-1"
              onClick={() => void handleDownload()}
              disabled={busy !== null}
            >
              <DownloadIcon aria-hidden />
              {busy === 'png' ? 'Rendering…' : 'Download PNG'}
            </Button>
          </div>

          {insecureContext ? (
            <p className="text-muted-foreground text-2xs leading-snug">
              Handing this straight to your phone's share sheet needs the console loaded over a
              secure (https) connection — downloading the PNG still works here.
            </p>
          ) : null}
        </div>
      }
    >
      <div className="p-3 sm:p-4">
        <div className="border-border mx-auto w-full max-w-72 overflow-hidden rounded-md border shadow-sm">
          <ShareCard ref={svgRef} model={model} />
        </div>

        <div className="mt-4 flex items-center gap-2.5">
          <Switch
            id={toggleId}
            checked={includeLocation}
            onCheckedChange={setIncludeLocation}
            disabled={!hasPosition}
          />
          <label htmlFor={toggleId} className="text-sm">
            Include exact location
          </label>
        </div>

        <p
          className={cn(
            'mt-2 text-xs',
            includeLocation && hasPosition ? 'text-warn' : 'text-muted-foreground',
          )}
        >
          {!hasPosition
            ? 'This track broadcast no position, so the card carries no coordinates.'
            : includeLocation
              ? 'This card shows the exact coordinates. For an aircraft on the ground that is effectively an address.'
              : 'Coordinates are removed. The signal trace and the ground-track summary stay — neither places the contact anywhere on earth.'}
        </p>
      </div>
    </Dialog>
  )
}
