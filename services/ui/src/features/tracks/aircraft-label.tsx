/**
 * "Neighbour's Mini 4 Pro" instead of `1581F3YTBJ9H003045J0`.
 *
 * An operator does not think about an airframe by its ANSI/CTA-2063-A serial,
 * and on a unit where fifteen of seventeen rows carry the same serial, the
 * serial is not even a discriminator. A label is how the aircraft gets a name;
 * the flag is how a known neighbour is told from one worth watching.
 *
 * **It is a note, and only a note.** Nothing reads the flag to change what the
 * sensors do, `ignore` does not stop a track being recorded, and none of it is
 * a threat score — ClassG is receive-only and this is the one feature that
 * could be mistaken for an action, so it is worth saying twice. See
 * services/ui/README.md, "Two things not to build".
 *
 * Gated on the operator role. The hiding is a courtesy, not the security: the
 * API refuses the PUT either way (features/auth/use-auth.ts).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { TagIcon } from 'lucide-react'
import { useState } from 'react'

import { StatusPill } from '@/components/ui/status-pill'
import type { StatusPillTone } from '@/components/ui/status-pill-variants'
import { Button } from '@/components/ui/button'
import { FormField, Input } from '@/components/ui/field'
import { Popover } from '@/components/ui/popover'
import { Select } from '@/components/ui/select'
import { useToast } from '@/components/ui/toast-primitives'
import { useHasRole } from '@/features/auth/use-auth'
import { log } from '@/features/logs/log-store'
import { api } from '@/lib/api/client'
import { queryKeys } from '@/lib/api/queries'
import type { AircraftFlag, AircraftLabel } from '@/lib/api/types'

import { useAircraftLabel } from './use-aircraft-label'

const FLAG_OPTIONS: { value: AircraftFlag; label: string }[] = [
  { value: '', label: 'No flag' },
  { value: 'known', label: 'Known' },
  { value: 'watch', label: 'Watch' },
  { value: 'ignore', label: 'Ignore' },
]

/**
 * Flags are badges, not colours on a scale.
 *
 * `watch` gets the warn tone because it is the one an operator asked to be
 * reminded about; `known` and `ignore` stay neutral. Nothing here is red:
 * "this is a drone I have not named" is not an alarm, and a red chip on an
 * aircraft would be the threat scoring this product does not do.
 */
const FLAG_TONE: Record<Exclude<AircraftFlag, ''>, StatusPillTone> = {
  known: 'info',
  watch: 'warn',
  ignore: 'muted',
}

export function AircraftFlagBadge({ flag }: { flag: AircraftFlag }) {
  if (flag === '') return null
  return <StatusPill tone={FLAG_TONE[flag]}>{flag}</StatusPill>
}

export function AircraftLabelControl({ serial }: { serial: string }) {
  const canEdit = useHasRole('operator')
  const stored = useAircraftLabel(serial)
  const [open, setOpen] = useState(false)

  if (!canEdit) {
    // A viewer still sees the label and the flag wherever they are rendered;
    // what they do not get is a control that opens and then fails on save.
    return null
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      aria-label="Label this aircraft"
      className="p-3"
      trigger={
        <Button variant="outline" size="sm">
          <TagIcon aria-hidden />
          {stored ? 'Edit label' : 'Label'}
        </Button>
      }
    >
      {/*
        A separate component, and that is the mechanism rather than tidiness:
        the popover's contents unmount when it closes, so the draft state below
        is seeded from the stored label every time it opens. The alternative —
        an effect syncing props into state — lets a background refetch of the
        label set overwrite half-typed text.
      */}
      <AircraftLabelForm
        serial={serial}
        stored={stored}
        onDone={() => {
          setOpen(false)
        }}
      />
    </Popover>
  )
}

function AircraftLabelForm({
  serial,
  stored,
  onDone,
}: {
  serial: string
  stored: AircraftLabel | null
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [text, setText] = useState(stored?.label ?? '')
  const [flag, setFlag] = useState<AircraftFlag>(stored?.flag ?? '')

  const save = useMutation({
    mutationFn: (body: { label: string; flag: AircraftFlag }) =>
      api.setAircraftLabel(serial, body),
    onSuccess: async (_result, body) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.aircraftLabels })
      const cleared = body.label === '' && body.flag === ''
      log.action(cleared ? 'Aircraft label cleared' : 'Aircraft label saved')
      toast.add({ title: cleared ? 'Label cleared' : 'Label saved', type: 'success' })
      onDone()
    },
    onError: (error: unknown) => {
      toast.add({
        title: 'Could not save the label',
        description: error instanceof Error ? error.message : String(error),
        type: 'error',
      })
    },
  })

  return (
    <div className="flex flex-col gap-3">
      <FormField
        label="Label"
        hint="A note for you. It replaces the serial wherever this aircraft is listed."
      >
        {(props) => (
          <Input
            {...props}
            value={text}
            maxLength={120}
            placeholder="Neighbour's Mini 4 Pro"
            onChange={(event) => {
              setText(event.target.value)
            }}
          />
        )}
      </FormField>

      <FormField label="Flag" hint="Nothing acts on this. It is how you sort your own list.">
        {(props) => (
          <Select
            id={props.id}
            aria-label="Flag"
            value={flag}
            onValueChange={setFlag}
            options={FLAG_OPTIONS}
            className="w-full"
          />
        )}
      </FormField>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={save.isPending}
          onClick={() => {
            save.mutate({ label: text.trim(), flag })
          }}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        {stored ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={save.isPending}
            onClick={() => {
              // An empty label with an empty flag is how the API deletes one.
              save.mutate({ label: '', flag: '' })
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  )
}
