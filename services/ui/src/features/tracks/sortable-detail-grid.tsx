import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVerticalIcon, RotateCcwIcon, type LucideIcon } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/cn'

import {
  DEFAULT_TRACK_DETAIL_ORDER,
  persistTrackDetailOrder,
  readStoredTrackDetailOrder,
  type TrackDetailCardId,
} from './track-detail-order'

export interface TrackDetailCard {
  id: TrackDetailCardId
  label: string
  /** Required, not optional: cards are reorderable, so a header that is
   *  decorated on some cards and bare on others looks like a rendering fault
   *  rather than a distinction. */
  icon: LucideIcon
  /** Only for an icon that keys back to the map. Defaults to muted. */
  iconClassName?: string
  title: ReactNode
  description?: ReactNode
  headerExtra?: ReactNode
  content: ReactNode
  className?: string
  contentClassName?: string
}

export function SortableTrackDetailGrid({ cards }: { cards: TrackDetailCard[] }) {
  const [order, setOrder] = useState<TrackDetailCardId[]>(readStoredTrackDetailOrder)
  const [activeId, setActiveId] = useState<TrackDetailCardId | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const byId = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards])
  const activeCard = activeId ? byId.get(activeId) : undefined

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as TrackDetailCardId)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null)
    if (!event.over || event.active.id === event.over.id) return
    // Read out here, not inside the updater: the guard above proves `over` is
    // set, but that narrowing does not survive into the closure.
    const activeId = event.active.id as TrackDetailCardId
    const overId = event.over.id as TrackDetailCardId
    setOrder((current) => {
      const next = arrayMove(current, current.indexOf(activeId), current.indexOf(overId))
      persistTrackDetailOrder(next)
      return next
    })
  }

  function resetOrder() {
    const next = [...DEFAULT_TRACK_DETAIL_ORDER]
    setOrder(next)
    persistTrackDetailOrder(next)
  }

  return (
    <div className="space-y-2">
      <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs">
        <p className="flex items-center gap-1.5">
          <GripVerticalIcon className="size-3.5" aria-hidden />
          Drag card handles to personalize this view. Focus a handle and press Space to reorder
          with the arrow keys.
        </p>
        <Button variant="ghost" size="sm" onClick={resetOrder} className="h-7 px-2 text-xs">
          <RotateCcwIcon aria-hidden /> Reset layout
        </Button>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragCancel={() => setActiveId(null)}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={order} strategy={rectSortingStrategy}>
          <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
            {order.map((id) => {
              const card = byId.get(id)
              return card ? <SortableDetailCard key={id} card={card} /> : null
            })}
          </div>
        </SortableContext>

        <DragOverlay>
          {activeCard ? (
            <Card className="border-primary/60 w-72 shadow-xl">
              <CardHeader className="flex-row items-center gap-2 p-3">
                <GripVerticalIcon className="text-primary size-4" aria-hidden />
                <activeCard.icon className="text-muted-foreground size-4" aria-hidden />
                <CardTitle>{activeCard.label}</CardTitle>
              </CardHeader>
            </Card>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}

function SortableDetailCard({ card }: { card: TrackDetailCard }) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.id })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('min-w-0', card.className, isDragging && 'relative z-10 opacity-35')}
    >
      <Card className="h-full min-w-0 overflow-hidden">
        <CardHeader className="flex-row items-start justify-between gap-3 p-4 pb-3">
          <div className="min-w-0 flex-1">
            <CardTitle className="flex items-center gap-2">
              <card.icon
                className={cn('size-4 shrink-0', card.iconClassName ?? 'text-muted-foreground')}
                aria-hidden
              />
              <span className="min-w-0">{card.title}</span>
            </CardTitle>
            {card.description ? (
              <CardDescription className="mt-1 leading-relaxed">
                {card.description}
              </CardDescription>
            ) : null}
            {card.headerExtra}
          </div>
          <button
            ref={setActivatorNodeRef}
            type="button"
            className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring -mt-1 -mr-1 flex size-8 shrink-0 cursor-grab items-center justify-center rounded-md touch-none focus-visible:ring-2 focus-visible:outline-none active:cursor-grabbing"
            aria-label={`Move ${card.label} card`}
            title={`Move ${card.label} card`}
            {...attributes}
            {...listeners}
          >
            <GripVerticalIcon className="size-4" aria-hidden />
          </button>
        </CardHeader>
        <CardContent className={cn('min-w-0', card.contentClassName)}>
          {card.content}
        </CardContent>
      </Card>
    </div>
  )
}
