import { describe, expect, it } from 'vitest'
import { effectiveOrderItems, effectiveQuantity, hasFulfillmentAdjustment, isPartiallyFulfilled } from './fulfillment'
import type { OrderItem } from '../types'

const item = (quantity: number, fulfilledQuantity?: number): OrderItem => ({
  productId: 'product-1',
  productName: 'Prodotto test',
  packageLabel: 'Confezione test',
  quantity,
  fulfilledQuantity,
  unitPrice: 5,
  vatRate: 4,
})

describe('fulfillment', () => {
  it('mantiene distinta la quantità richiesta da quella effettiva', () => {
    expect(effectiveQuantity(item(10, 6))).toBe(6)
    expect(effectiveOrderItems([item(10, 6)])[0]).toMatchObject({
      quantity: 6,
      orderedQuantity: 10,
    })
  })

  it('rimuove dagli snapshot DDT le righe non consegnate', () => {
    expect(effectiveOrderItems([item(4, 0)])).toEqual([])
  })

  it('riconosce una rettifica e una consegna parziale', () => {
    expect(hasFulfillmentAdjustment({ items: [item(10, 10)] })).toBe(true)
    expect(isPartiallyFulfilled({ items: [item(10, 6)] })).toBe(true)
    expect(isPartiallyFulfilled({ items: [item(10, 10)] })).toBe(false)
  })
})
