import { describe, expect, it } from 'vitest'
import { createDemoDatabase } from '../data/demo'
import { buildMonthlyReports } from './monthlyReport'

describe('buildMonthlyReports', () => {
  it('fattura lo snapshot del DDT valido e ignora ordine originale e DDT annullato', () => {
    const db = createDemoDatabase()
    const customer = db.customers[0]
    const order = {
      ...db.orders[0],
      id: 'order-report-test',
      customerId: customer.id,
      items: [{
        ...db.orders[0].items[0],
        quantity: 10,
        fulfilledQuantity: 6,
        packageSize: 1,
        pricingMode: 'per_kg' as const,
      }],
    }
    const deliveredItem = {
      ...order.items[0],
      quantity: 4,
      orderedQuantity: 10,
      fulfilledQuantity: undefined,
    }
    db.orders = [order]
    db.documents = [
      {
        id: 'ddt-ready-test',
        number: 'DDT-2026-000010',
        progressive: 10,
        year: 2026,
        orderId: order.id,
        customerId: customer.id,
        issueDate: '2026-07-20',
        transportReason: 'Vendita',
        carrier: 'Mittente',
        packages: 4,
        itemsSnapshot: [
          deliveredItem,
          {
            productId: 'legacy-transport',
            sku: 'TRASP',
            productName: 'Trasporto',
            packageLabel: 'Servizio',
            quantity: 1,
            unitPrice: 3.5,
            vatRate: 22,
            pricingMode: 'per_unit',
          },
        ],
        deliveryFeeNet: 3.5,
        deliveryFeeVatRate: 22,
        status: 'ready',
      },
      {
        id: 'ddt-void-test',
        number: 'DDT-2026-000009',
        progressive: 9,
        year: 2026,
        orderId: order.id,
        customerId: customer.id,
        issueDate: '2026-07-19',
        transportReason: 'Vendita',
        carrier: 'Mittente',
        packages: 10,
        itemsSnapshot: [{ ...deliveredItem, quantity: 10 }],
        status: 'void',
      },
    ]

    const reports = buildMonthlyReports(db, '2026-07')

    expect(reports).toHaveLength(1)
    expect(reports[0].deliveryCount).toBe(1)
    expect(reports[0].products).toHaveLength(1)
    expect(reports[0].products[0]).toMatchObject({ kg: 4, packages: 4 })
    expect(reports[0].deliveries[0].note).toContain('4 conf.')
    expect(reports[0].deliveries[0].note).not.toContain('Trasporto')
  })
})
