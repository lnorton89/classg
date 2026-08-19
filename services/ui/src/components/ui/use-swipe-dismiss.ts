import {
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

/** Past this drag distance, releasing dismisses rather than snapping back. */
const DEFAULT_THRESHOLD_PX = 88
/** How long the slide-away plays before `onDismiss` actually fires. */
const DEFAULT_ANIMATION_MS = 180
/**
 * Below this, a pointer down-then-up reads as a tap, not a swipe -- so a
 * wrapping `<a>`/`<button>` still gets a normal click. Above it, the release
 * is jitter from an aborted swipe rather than an intended tap, and the
 * synthesized click that follows is suppressed.
 */
const TAP_TOLERANCE_PX = 4

/**
 * Swipe-to-dismiss, extracted from `SkyStateBanner` once the notifications
 * drawer needed the identical gesture on every row: drag past a threshold and
 * release to commit, drag less and it snaps back, and either way a released
 * commit plays a short slide-and-fade before `onDismiss` actually fires so
 * the row reads as leaving rather than vanishing.
 *
 * Deliberately does NOT own an auto-dismiss timer -- `SkyStateBanner`'s 20s
 * "quiet sky becomes furniture" timeout is specific to that one banner, not a
 * property of swiping in general, and a notification row auto-clearing itself
 * while nobody was looking would lose history rather than declutter it.
 */
export function useSwipeDismiss({
  enabled,
  onDismiss,
  thresholdPx = DEFAULT_THRESHOLD_PX,
  animationMs = DEFAULT_ANIMATION_MS,
}: {
  enabled: boolean
  onDismiss: () => void
  thresholdPx?: number
  animationMs?: number
}) {
  const [closing, setClosing] = useState<1 | -1 | null>(null)
  const [dragX, setDragX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const dragStartX = useRef<number | null>(null)
  // Set on a release past tap tolerance; read and cleared by the click that
  // the browser synthesizes right after, so that click can be swallowed.
  const suppressClick = useRef(false)

  function commit(direction: 1 | -1 = 1) {
    if (closing !== null) return
    setClosing(direction)
    setTimeout(onDismiss, animationMs)
  }

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (!enabled || closing !== null) return
    dragStartX.current = event.clientX
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    if (dragStartX.current === null) return
    setDragX(event.clientX - dragStartX.current)
  }

  function onPointerUp() {
    if (dragStartX.current === null) return
    dragStartX.current = null
    setDragging(false)
    suppressClick.current = Math.abs(dragX) > TAP_TOLERANCE_PX
    if (Math.abs(dragX) > thresholdPx) {
      commit(dragX < 0 ? -1 : 1)
    } else {
      setDragX(0)
    }
  }

  function onClickCapture(event: ReactMouseEvent<HTMLElement>) {
    if (!suppressClick.current) return
    suppressClick.current = false
    event.preventDefault()
  }

  const exiting = closing !== null
  const style = exiting
    ? { transform: `translateX(${closing * 120}%)`, opacity: 0 }
    : dragging
      ? {
          transform: `translateX(${dragX}px)`,
          opacity: 1 - Math.min(0.85, Math.abs(dragX) / 260),
        }
      : undefined

  return {
    closing,
    dragging,
    style,
    commit,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onClickCapture,
    },
  }
}
