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

import type { CardOrderStore } from './card-order-store'

export interface SortableCard<Id extends string> {
  id: Id
  /** Shown on the drag overlay, and as the handle's accessible name. */
  label: string
  icon: LucideIcon
  /** Only for an icon that keys back to something else on screen. Defaults to muted. */
  iconClassName?: string
  content: ReactNode
  className?: string
  contentClassName?: string
  /**
   * 'framed' (the default) wraps `content` in the grid's own Card, header,
   * icon and title -- required together in that mode, because a header
   * decorated on some cards and bare on others reads as a rendering fault
   * rather than a distinction.
   *
   * 'plain' is for a card that is already a complete `<Card>` with its own
   * header -- the deployment and watchdog panels, say, whose headers carry
   * live state (a "deploying" badge, a CI result) that a generic title
   * cannot express. The grid then contributes only the drag mechanics and a
   * floating handle, rather than a second header wrapped around the first.
   */
  variant?: 'framed' | 'plain'
  title?: ReactNode
  description?: ReactNode
  headerExtra?: ReactNode
}

/**
 * A grid of cards, draggable into whatever order the reader prefers, with
 * that order remembered per browser via `store`.
 *
 * Generic over the card id union so one implementation serves every
 * reorderable grid in the app — a track's detail cards, an admin category's
 * panels — rather than a fresh copy of the dnd-kit wiring per entity.
 */
export function SortableCardGrid<Id extends string>({
  cards,
  store,
  gridClassName,
}: {
  cards: SortableCard<Id>[]
  store: CardOrderStore<Id>
  gridClassName?: string
}) {
  const [order, setOrder] = useState<Id[]>(store.read)
  const [activeId, setActiveId] = useState<Id | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const byId = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards])
  const activeCard = activeId ? byId.get(activeId) : undefined

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as Id)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null)
    if (!event.over || event.active.id === event.over.id) return
    // Read out here, not inside the updater: the guard above proves `over` is
    // set, but that narrowing does not survive into the closure.
    const activeId = event.active.id as Id
    const overId = event.over.id as Id
    setOrder((current) => {
      const next = arrayMove(current, current.indexOf(activeId), current.indexOf(overId))
      store.persist(next)
      return next
    })
  }

  function resetOrder() {
    const next = [...store.defaultOrder]
    setOrder(next)
    store.persist(next)
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
          <div
            className={cn(
              'grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3',
              gridClassName,
            )}
          >
            {order.map((id) => {
              const card = byId.get(id)
              return card ? <SortableGridCard key={id} card={card} /> : null
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

function SortableGridCard<Id extends string>({ card }: { card: SortableCard<Id> }) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.id })

  const dragHandle = (
    <button
      ref={setActivatorNodeRef}
      type="button"
      className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring flex size-8 shrink-0 cursor-grab items-center justify-center rounded-md touch-none focus-visible:ring-2 focus-visible:outline-none active:cursor-grabbing"
      aria-label={`Move ${card.label} card`}
      title={`Move ${card.label} card`}
      {...attributes}
      {...listeners}
    >
      <GripVerticalIcon className="size-4" aria-hidden />
    </button>
  )

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('min-w-0', card.className, isDragging && 'relative z-10 opacity-35')}
    >
      {card.variant === 'plain' ? (
        <div className="relative min-w-0">
          {/* Floats over the panel's own header rather than adding a second
              one. The panel supplies its own Card and CardHeader in full. */}
          <div className="bg-card/70 absolute top-2 right-2 z-10 rounded-md backdrop-blur-sm">
            {dragHandle}
          </div>
          {card.content}
        </div>
      ) : (
        <Card className="h-full min-w-0 overflow-hidden">
          <CardHeader className="flex-row items-start justify-between gap-3 p-4 pb-3">
            <div className="min-w-0 flex-1">
              <CardTitle className="flex items-center gap-2">
                <card.icon
                  className={cn(
                    'size-4 shrink-0',
                    card.iconClassName ?? 'text-muted-foreground',
                  )}
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
            <div className="-mt-1 -mr-1">{dragHandle}</div>
          </CardHeader>
          <CardContent className={cn('min-w-0', card.contentClassName)}>
            {card.content}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
