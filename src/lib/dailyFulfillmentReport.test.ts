import { describe, expect, it } from 'vitest'
import type { Customer, Order, OrderItem, OrderStatus } from '../types'
import {
  OPEN_FULFILLMENT_STATUSES,
  buildDailyFulfillmentReport,
  isOpenFulfillmentStatus,
} from './dailyFulfillmentReport'

const address = {
  street: 'Via Roma 1',
  city: 'Roma',
  province: 'RM',
  postalCode: '00100',
  country: 'Italia',
}

const customer = (id: string, companyName = `Cliente ${id}`): Customer => ({
  id,
  companyName,
  contactName: '',
  email: '',
  username: '',
  phone: '',
  vatNumber: '',
  fiscalCode: '',
  pec: '',
  sdiCode: '',
  billingAddress: { ...address },
  deliveryAddress: { ...address },
  paymentMethod: 'end_of_month',
  active: true,
  createdAt: '2026-07-01T08:00:00.000Z',
})

const product = (
  productId: string,
  productName: string,
  quantity = 1,
  overrides: Partial<OrderItem> = {},
): OrderItem => ({
  productId,
  sku: productId.toUpperCase(),
  productName,
  packageLabel: 'Confezione',
  quantity,
  unitPrice: 5,
  vatRate: 4,
  pricingMode: 'per_unit',
  ...overrides,
})

const order = (
  id: string,
  date: string,
  status: OrderStatus = 'submitted',
  overrides: Partial<Order> = {},
): Order => ({
  id,
  number: `ORD-${id}`,
  customerId: 'customer-1',
  requestedDeliveryDate: date,
  notes: '',
  status,
  paymentMethod: 'end_of_month',
  items: [product('pasta', 'Pasta fresca')],
  createdAt: '2026-07-01T09:00:00.000Z',
  updatedAt: '2026-07-01T09:00:00.000Z',
  ...overrides,
})

describe('buildDailyFulfillmentReport', () => {
  it('raggruppa per data ISO, ordina giorni e ordini in modo deterministico', () => {
    const orders = [
      order('later', '2026-08-05', 'accepted', { number: 'ORD-10' }),
      order('second', '2026-08-03', 'submitted', { number: 'ORD-2' }),
      order('first', '2026-08-03', 'in_delivery', { number: 'ORD-1' }),
    ]

    const report = buildDailyFulfillmentReport({ customers: [customer('customer-1')], orders }, '2026-08-02')

    expect(report.map((group) => group.date)).toEqual(['2026-08-03', '2026-08-05'])
    expect(report[0].orders.map((item) => item.number)).toEqual(['ORD-1', 'ORD-2'])
    expect(report[0]).toMatchObject({ orderCount: 2, totalQuantity: 2, totalNet: 10 })
    expect(report[0].products[0]).toMatchObject({
      productId: 'pasta',
      effectiveQuantity: 2,
      orderCount: 2,
    })
  })

  it.each(['draft', 'rejected', 'cancelled', 'delivered'] as const)(
    'esclude gli ordini con stato %s',
    (status) => {
      const orders = [
        order(`closed-${status}`, '2026-08-03', status),
        order(`open-${status}`, '2026-08-03', 'submitted'),
      ]

      const report = buildDailyFulfillmentReport({ customers: [], orders }, '2026-08-02')

      expect(report).toHaveLength(1)
      expect(report[0].orders.map((item) => item.id)).toEqual([`open-${status}`])
    },
  )

  it('espone gli stati aperti e il relativo type guard', () => {
    expect(OPEN_FULFILLMENT_STATUSES).toEqual(['submitted', 'accepted', 'in_delivery'])
    expect(isOpenFulfillmentStatus('accepted')).toBe(true)
    expect(isOpenFulfillmentStatus('delivered')).toBe(false)
  })

  it('calcola overdue confrontando la data locale esplicita senza considerare oggi scaduto', () => {
    const orders = [
      order('past', '2026-08-01'),
      order('today', '2026-08-02'),
      order('future', '2026-08-03'),
    ]

    const report = buildDailyFulfillmentReport({ customers: [], orders }, '2026-08-02')

    expect(report.map(({ date, overdue }) => ({ date, overdue }))).toEqual([
      { date: '2026-08-01', overdue: true },
      { date: '2026-08-02', overdue: false },
      { date: '2026-08-03', overdue: false },
    ])
  })

  it('usa le quantità effettive e ignora il trasporto in righe, riepilogo e totali', () => {
    const adjustedOrder = order('adjusted', '2026-08-03', 'accepted', {
      items: [
        product('ravioli', 'Ravioli', 10, {
          fulfilledQuantity: 6,
          unitPrice: 8,
          vatRate: 10,
          packageSize: 0.5,
          pricingMode: 'per_kg',
        }),
        product('ravioli', 'Ravioli', 2, {
          fulfilledQuantity: 1,
          unitPrice: 8,
          vatRate: 10,
          packageSize: 0.5,
          pricingMode: 'per_kg',
        }),
        product('zero', 'Prodotto rimosso', 3, { fulfilledQuantity: 0 }),
        product('legacy-transport', 'Trasporto', 1, {
          sku: 'TRASP',
          unitPrice: 3.5,
          vatRate: 22,
        }),
      ],
    })

    const [day] = buildDailyFulfillmentReport({ customers: [], orders: [adjustedOrder] }, '2026-08-02')

    expect(day.orders[0].items).toHaveLength(3)
    expect(day.orders[0].items[0]).toMatchObject({
      requestedQuantity: 10,
      effectiveQuantity: 6,
      adjusted: true,
      kg: 3,
      net: 24,
      vat: 2.4,
      gross: 26.4,
    })
    expect(day.orders[0].items[2]).toMatchObject({
      requestedQuantity: 3,
      effectiveQuantity: 0,
      adjusted: true,
    })
    expect(day.products).toEqual([
      expect.objectContaining({
        productId: 'ravioli',
        effectiveQuantity: 7,
        kg: 3.5,
        net: 28,
        vat: 2.8,
        gross: 30.8,
        orderCount: 1,
      }),
    ])
    expect(day).toMatchObject({
      totalQuantity: 7,
      totalKg: 3.5,
      totalNet: 28,
      totalVat: 2.8,
      totalGross: 30.8,
    })
    expect(day.orders[0].items.some((item) => item.productId === 'legacy-transport')).toBe(false)
  })

  it('risolve il cliente corrente, usa lo snapshot come fallback e tollera un cliente assente', () => {
    const currentCustomer = customer('customer-1', 'Cliente corrente')
    const snapshotCustomer = customer('customer-snapshot', 'Cliente da snapshot')
    const orders = [
      order('known', '2026-08-03', 'submitted', { customerId: currentCustomer.id }),
      order('snapshot', '2026-08-03', 'submitted', {
        customerId: 'missing-from-registry',
        customerSnapshot: snapshotCustomer,
      }),
      order('missing', '2026-08-03', 'submitted', { customerId: 'missing-completely' }),
    ]

    const [day] = buildDailyFulfillmentReport({ customers: [currentCustomer], orders }, '2026-08-02')

    expect(day.orders.find((item) => item.id === 'known')).toMatchObject({
      customer: currentCustomer,
      customerName: 'Cliente corrente',
    })
    expect(day.orders.find((item) => item.id === 'snapshot')).toMatchObject({
      customer: snapshotCustomer,
      customerName: 'Cliente da snapshot',
    })
    expect(day.orders.find((item) => item.id === 'missing')).toMatchObject({
      customerName: 'Cliente non disponibile',
    })
    expect(day.orders.find((item) => item.id === 'missing')?.customer).toBeUndefined()
  })

  it('non muta né riordina i dati sorgente', () => {
    const customers = [customer('customer-1')]
    const orders = [
      order('z', '2026-08-04', 'accepted', { number: 'ORD-20' }),
      order('a', '2026-08-03', 'submitted', {
        number: 'ORD-1',
        items: [product('pasta', 'Pasta fresca', 4, { fulfilledQuantity: 2 })],
      }),
    ]
    const before = structuredClone({ customers, orders })

    buildDailyFulfillmentReport({ customers, orders }, '2026-08-02')

    expect({ customers, orders }).toEqual(before)
    expect(orders.map((item) => item.id)).toEqual(['z', 'a'])
  })
})
