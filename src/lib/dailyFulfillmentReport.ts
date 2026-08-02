import type { Customer, Database, Order, OrderItem, OrderStatus } from '../types'
import { isDeliveryService } from './commerce'
import { calculateLineNet, effectivePackageSize } from './format'
import { effectiveQuantity } from './fulfillment'

export const OPEN_FULFILLMENT_STATUSES = [
  'submitted',
  'accepted',
  'in_delivery',
] as const satisfies readonly OrderStatus[]

export type OpenFulfillmentStatus = (typeof OPEN_FULFILLMENT_STATUSES)[number]

export const isOpenFulfillmentStatus = (status: OrderStatus): status is OpenFulfillmentStatus =>
  (OPEN_FULFILLMENT_STATUSES as readonly OrderStatus[]).includes(status)

export interface DailyFulfillmentLine {
  productId: string
  sku?: string
  productName: string
  packageLabel: string
  requestedQuantity: number
  effectiveQuantity: number
  adjusted: boolean
  unitPrice: number
  vatRate: number
  packageSize?: number
  pricingMode?: OrderItem['pricingMode']
  kg: number
  net: number
  vat: number
  gross: number
}

export interface DailyFulfillmentOrder {
  id: string
  number: string
  customerId: string
  customer?: Customer
  customerName: string
  requestedDeliveryDate: string
  status: OpenFulfillmentStatus
  notes: string
  items: DailyFulfillmentLine[]
  totalQuantity: number
  totalKg: number
  totalNet: number
  totalVat: number
  totalGross: number
}

export interface DailyFulfillmentProductSummary {
  productId: string
  sku?: string
  productName: string
  packageLabel: string
  effectiveQuantity: number
  kg: number
  net: number
  vat: number
  gross: number
  orderCount: number
}

export interface DailyFulfillmentGroup {
  date: string
  overdue: boolean
  orders: DailyFulfillmentOrder[]
  products: DailyFulfillmentProductSummary[]
  orderCount: number
  totalQuantity: number
  totalKg: number
  totalNet: number
  totalVat: number
  totalGross: number
}

export type DailyFulfillmentReport = DailyFulfillmentGroup[]

type DailyFulfillmentSource = Pick<Database, 'customers' | 'orders'>

const UNKNOWN_CUSTOMER_NAME = 'Cliente non disponibile'
const collator = new Intl.Collator('it-IT', { numeric: true, sensitivity: 'base' })

const roundMoney = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100

const compareOrders = (left: Order, right: Order) =>
  collator.compare(left.number, right.number)
  || left.createdAt.localeCompare(right.createdAt)
  || left.id.localeCompare(right.id)

const compareProductSummaries = (
  left: DailyFulfillmentProductSummary,
  right: DailyFulfillmentProductSummary,
) => collator.compare(left.productName, right.productName)
  || collator.compare(left.packageLabel, right.packageLabel)
  || collator.compare(left.sku ?? '', right.sku ?? '')
  || left.productId.localeCompare(right.productId)

const toLine = (item: OrderItem): DailyFulfillmentLine => {
  const requestedQuantity = item.orderedQuantity ?? item.quantity
  const quantity = effectiveQuantity(item)
  const net = calculateLineNet({ ...item, quantity })
  const vat = roundMoney(net * item.vatRate / 100)
  const kg = item.pricingMode === 'per_kg'
    ? quantity * effectivePackageSize(item)
    : 0

  return {
    productId: item.productId,
    sku: item.sku,
    productName: item.productName,
    packageLabel: item.packageLabel,
    requestedQuantity,
    effectiveQuantity: quantity,
    adjusted: quantity !== requestedQuantity,
    unitPrice: item.unitPrice,
    vatRate: item.vatRate,
    packageSize: item.packageSize,
    pricingMode: item.pricingMode,
    kg,
    net,
    vat,
    gross: roundMoney(net + vat),
  }
}

const sumOrder = (
  order: Order,
  customerById: ReadonlyMap<string, Customer>,
): DailyFulfillmentOrder => {
  const customer = customerById.get(order.customerId) ?? order.customerSnapshot
  const items = order.items
    .filter((item) => !isDeliveryService(item))
    .map(toLine)

  const totals = items.reduce(
    (result, item) => ({
      quantity: result.quantity + item.effectiveQuantity,
      kg: result.kg + item.kg,
      net: result.net + item.net,
      vat: result.vat + item.vat,
      gross: result.gross + item.gross,
    }),
    { quantity: 0, kg: 0, net: 0, vat: 0, gross: 0 },
  )

  return {
    id: order.id,
    number: order.number,
    customerId: order.customerId,
    customer,
    customerName: customer?.companyName.trim() || UNKNOWN_CUSTOMER_NAME,
    requestedDeliveryDate: order.requestedDeliveryDate,
    status: order.status as OpenFulfillmentStatus,
    notes: order.notes,
    items,
    totalQuantity: totals.quantity,
    totalKg: totals.kg,
    totalNet: roundMoney(totals.net),
    totalVat: roundMoney(totals.vat),
    totalGross: roundMoney(totals.gross),
  }
}

interface MutableProductSummary extends DailyFulfillmentProductSummary {
  orderIds: Set<string>
}

const buildProductSummaries = (
  orders: readonly DailyFulfillmentOrder[],
): DailyFulfillmentProductSummary[] => {
  const summaries = new Map<string, MutableProductSummary>()

  for (const order of orders) {
    for (const item of order.items) {
      if (item.effectiveQuantity <= 0) continue

      const current = summaries.get(item.productId) ?? {
        productId: item.productId,
        sku: item.sku,
        productName: item.productName,
        packageLabel: item.packageLabel,
        effectiveQuantity: 0,
        kg: 0,
        net: 0,
        vat: 0,
        gross: 0,
        orderCount: 0,
        orderIds: new Set<string>(),
      }
      current.effectiveQuantity += item.effectiveQuantity
      current.kg += item.kg
      current.net += item.net
      current.vat += item.vat
      current.gross += item.gross
      current.orderIds.add(order.id)
      summaries.set(item.productId, current)
    }
  }

  return [...summaries.values()]
    .map(({ orderIds, ...summary }) => ({
      ...summary,
      kg: summary.kg,
      net: roundMoney(summary.net),
      vat: roundMoney(summary.vat),
      gross: roundMoney(summary.gross),
      orderCount: orderIds.size,
    }))
    .sort(compareProductSummaries)
}

/**
 * Costruisce la vista operativa degli ordini ancora da evadere. `today` deve
 * essere una data locale ISO (YYYY-MM-DD): il confronto non usa il fuso UTC.
 */
export const buildDailyFulfillmentReport = (
  source: DailyFulfillmentSource,
  today: string,
): DailyFulfillmentReport => {
  const customerById = new Map(source.customers.map((customer) => [customer.id, customer]))
  const ordersByDate = new Map<string, Order[]>()

  for (const order of source.orders) {
    if (!isOpenFulfillmentStatus(order.status)) continue
    const orders = ordersByDate.get(order.requestedDeliveryDate) ?? []
    orders.push(order)
    ordersByDate.set(order.requestedDeliveryDate, orders)
  }

  return [...ordersByDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, sourceOrders]) => {
      const orders = [...sourceOrders]
        .sort(compareOrders)
        .map((order) => sumOrder(order, customerById))
      const products = buildProductSummaries(orders)

      return {
        date,
        overdue: date < today,
        orders,
        products,
        orderCount: orders.length,
        totalQuantity: orders.reduce((sum, order) => sum + order.totalQuantity, 0),
        totalKg: orders.reduce((sum, order) => sum + order.totalKg, 0),
        totalNet: roundMoney(orders.reduce((sum, order) => sum + order.totalNet, 0)),
        totalVat: roundMoney(orders.reduce((sum, order) => sum + order.totalVat, 0)),
        totalGross: roundMoney(orders.reduce((sum, order) => sum + order.totalGross, 0)),
      }
    })
}
