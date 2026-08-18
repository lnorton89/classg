import { Badge } from '@/components/ui/badge'
import type { DeploymentArtefact } from '@/lib/api/types'

/**
 * What the agent made of the things this unit builds for itself, at whichever
 * check produced this list — the latest one on the deployment panel, or a
 * specific past run in deploy history.
 *
 * Worth a row of its own rather than leaving it to the log, because the log
 * only speaks when the agent acts: "pi-dash was checked and is current" and
 * "pi-dash was never checked" produce exactly the same silence, and pi-dash
 * spent days running an old build inside that ambiguity. An absent list is
 * therefore rendered as absent, never as everything being fine.
 *
 * Shared so the two call sites only agree on tone once: this used to be
 * reimplemented in both places, and they had drifted apart — a `rebuilt`
 * artefact read as `ok` in one and `muted` in the other for the same state.
 *
 * `behind` is warn rather than muted, and that distinction is the reason the
 * state exists. "current" on a submodule means current FOR ITS PIN, which a
 * unit can report truthfully while work pushed upstream days ago has never
 * reached it. Drawn the same grey as current, it would answer the question
 * nobody was asking.
 */
function artefactTone(state: DeploymentArtefact['state']): 'ok' | 'warn' | 'down' | 'muted' {
  if (state === 'failed') return 'down'
  if (state === 'behind') return 'warn'
  if (state === 'rebuilt') return 'ok'
  return 'muted'
}

export function ArtefactList({
  artefacts,
  label,
}: {
  artefacts: DeploymentArtefact[] | undefined
  /** Omitted in deploy history: the run it belongs to is already named by the
   *  row it sits under. */
  label?: string
}) {
  if (!artefacts || artefacts.length === 0) return null

  return (
    <div>
      {label ? <p className="label-caps mb-1">{label}</p> : null}
      <ul className="flex flex-wrap gap-2">
        {artefacts.map((artefact) => (
          <li key={artefact.name} className="flex items-center gap-1.5">
            <code className="font-mono text-2xs">{artefact.name}</code>
            <Badge variant={artefactTone(artefact.state)}>{artefact.state}</Badge>
          </li>
        ))}
      </ul>
    </div>
  )
}
