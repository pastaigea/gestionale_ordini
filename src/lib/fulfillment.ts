import type { Order, OrderItem } from '../types'

export const MAX_FULFILLMENT_QUANTITY = 999

export const effectiveQuantity = (
  item: Pick<OrderItem, 'quantity' | 'fulfilledQuantity'>,
) => item.fulfilledQuantity ?? item.quantity

export const effectiveOrderItems = (items: OrderItem[]): OrderItem[] =>
  items
    .map((item) => ({
      ...item,
      orderedQuantity: item.orderedQuantity ?? item.quantity,
      quantity: effectiveQuantity(item),
      fulfilledQuantity: undefined,
    }))
    .filter((item) => item.quantity > 0)

export const hasFulfillmentAdjustment = (order: Pick<Order, 'items'>) =>
  order.items.some((item) => typeof item.fulfilledQuantity === 'number')

export const isPartiallyFulfilled = (order: Pick<Order, 'items'>) =>
  order.items.some((item) =>
    typeof item.fulfilledQuantity === 'number' && item.fulfilledQuantity < item.quantity,
  )
