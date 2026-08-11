/**
 * A short synthesised chirp for "something new is in the sky".
 *
 * Synthesised rather than an audio file: it is a few hundred bytes of code
 * instead of an asset to ship, cache and get wrong, and the tone can be tuned
 * without a round trip through an editor.
 *
 * Deliberately two soft sine tones rather than an alarm. This is a passive
 * detector, not a warning system — the sound says "look at the screen", and a
 * klaxon would be claiming an authority the data does not support.
 */

let context: AudioContext | null = null

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  try {
    // Constructed lazily: an AudioContext created before any user interaction
    // starts suspended and stays that way in most browsers.
    context ??= new AudioContext()
    if (context.state === 'suspended') void context.resume()
    return context
  } catch {
    return null
  }
}

export type AlertKind = 'contact' | 'confirmed'

const TONES: Record<AlertKind, [number, number]> = {
  // Rising pair: a new contact.
  contact: [660, 880],
  // A third above, so a corroborated track is distinguishable without being
  // louder or more urgent-sounding.
  confirmed: [740, 1110],
}

export function playAlert(kind: AlertKind = 'contact'): void {
  const ctx = audioContext()
  if (!ctx) return

  const now = ctx.currentTime
  const gain = ctx.createGain()
  gain.connect(ctx.destination)
  // Peak well below full scale — this may be playing next to someone's ear on
  // a phone at 2am.
  gain.gain.setValueAtTime(0.0001, now)

  TONES[kind].forEach((frequency, index) => {
    const start = now + index * 0.11
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(frequency, start)
    osc.connect(gain)
    // Exponential ramps avoid the click a hard gate produces on a sine.
    gain.gain.exponentialRampToValueAtTime(0.14, start + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.1)
    osc.start(start)
    osc.stop(start + 0.11)
  })
}
