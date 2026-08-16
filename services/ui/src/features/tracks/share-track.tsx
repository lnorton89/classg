/**
 * "Share" on a track: preview the infographic, choose whether it carries the
 * exact position, then take away a PNG.
 *
 * An inline panel rather than a modal, and not only because there is no dialog
 * primitive here. The card embeds a location, so the operator should be able to
 * see what they are about to hand over while the underlying record is still on
 * screen next to it — a modal that covers the page invites approving a card
 * without checking it against the track it came from.
 */
import { useId, useRef, useState } from 'react'
import { DownloadIcon, ImageIcon, Share2Icon, SmartphoneIcon, XIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/toast-primitives'
import { cn } from '@/lib/cn'
import type { Track } from '@/lib/api/types'

import type { RssiSample } from './rssi-samples'

import { CARD_HEIGHT, CARD_WIDTH, ShareCard } from './share-card'
import { buildShareCardModel } from './share-card-model'
import {
  canCopyImages,
  canShareFiles,
  cardFilename,
  downloadBlob,
  renderCardToPngBlob,
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
  const panelId = useId()
  const toggleId = useId()
  const toast = useToast()

  const model = buildShareCardModel(track, !includeLocation, rssiSamples)
  const hasPosition = Boolean(track.current)
  // Probed once per render: it depends on the origin being secure, not on state.
  const nativeShare = canShareFiles()

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
    <div className="min-w-0">
      <Button
        variant="outline"
        size="sm"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <XIcon aria-hidden /> : <Share2Icon aria-hidden />}
        {open ? 'Close share card' : 'Share'}
      </Button>

      {open ? (
        <section
          id={panelId}
          aria-label="Shareable track card"
          className="border-border bg-card mt-3 rounded-lg border p-3 sm:p-4"
        >
          <div className="border-border overflow-hidden rounded-md border">
            <ShareCard ref={svgRef} model={model} />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-3">
            <div className="flex items-center gap-2.5">
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

            <div className="ml-auto flex flex-wrap gap-2">
              {canCopyImages() ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleCopy()}
                  disabled={busy !== null}
                >
                  <ImageIcon aria-hidden />
                  {busy === 'copy' ? 'Copying…' : 'Copy image'}
                </Button>
              ) : null}
              {/* Sharing is the primary action where the OS offers it -- on a
                  phone a downloaded PNG means going to find it again. Download
                  stays visible as the secondary rather than disappearing,
                  because saving a copy and sending one are different intents. */}
              <Button
                variant={nativeShare ? 'outline' : 'default'}
                size="sm"
                onClick={() => void handleDownload()}
                disabled={busy !== null}
              >
                <DownloadIcon aria-hidden />
                {busy === 'png' ? 'Rendering…' : 'Download PNG'}
              </Button>
              {nativeShare ? (
                <Button size="sm" onClick={() => void handleShare()} disabled={busy !== null}>
                  <SmartphoneIcon aria-hidden />
                  {busy === 'share' ? 'Preparing…' : 'Share…'}
                </Button>
              ) : null}
            </div>
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
        </section>
      ) : null}
    </div>
  )
}
