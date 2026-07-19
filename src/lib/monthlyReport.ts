import type { Customer, Database, DeliveryDocument, Order, OrderItem } from '../types'
import { calculateLineNet, effectivePackageSize } from './format'
import { effectiveOrderItems } from './fulfillment'
import {
  DEFAULT_DELIVERY_FEE_NET,
  DEFAULT_DELIVERY_FEE_VAT_RATE,
  isDeliveryService,
} from './commerce'

export interface MonthlyReportRow {
  productName: string
  sku?: string
  kg: number
  packages: number
  net: number
}

export interface MonthlyDeliveryRow {
  date: string
  orderNumber: string
  ddtNumber: string
  paymentMethod: Order['paymentMethod']
  paidOnDelivery: boolean
  deliveryFeeNet: number
  deliveryFeeVatRate: number
  note: string
}

export interface MonthlyCustomerReport {
  customer: Customer
  orders: Order[]
  documents: DeliveryDocument[]
  products: MonthlyReportRow[]
  deliveries: MonthlyDeliveryRow[]
  deliveryCount: number
  paidOnDeliveryNet: number
  goodsNet: number
  deliveryNet: number
  totalNet: number
}

const monthBounds = (month: string) => {
  const [year, monthIndex] = month.split('-').map(Number)
  const start = `${year}-${String(monthIndex).padStart(2, '0')}-01`
  const endDate = new Date(year, monthIndex, 0)
  const end = `${year}-${String(monthIndex).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`
  return { start, end }
}

const lineKg = (item: OrderItem) =>
  item.pricingMode === 'per_kg' ? item.quantity * effectivePackageSize(item) : 0

export const buildMonthlyReports = (db: Database, month: string): MonthlyCustomerReport[] => {
  const { start, end } = monthBounds(month)
  const documents = db.documents.filter((document) =>
    document.status !== 'void' && document.issueDate >= start && document.issueDate <= end,
  )
  const orderById = new Map(db.orders.map((order) => [order.id, order]))
  const docsByCustomer = new Map<string, DeliveryDocument[]>()
  for (const document of documents) {
    docsByCustomer.set(document.customerId, [...(docsByCustomer.get(document.customerId) ?? []), document])
  }

  return db.customers
    .map((customer) => {
      const customerDocuments = docsByCustomer.get(customer.id) ?? []
      const orders = customerDocuments
        .map((document) => orderById.get(document.orderId))
        .filter((order): order is Order => Boolean(order))
      const productRows = new Map<string, MonthlyReportRow>()
      for (const document of customerDocuments) {
        const order = orderById.get(document.orderId)
        if (!order) continue
        const deliveredItems = (document.itemsSnapshot?.length
          ? document.itemsSnapshot
          : effectiveOrderItems(order.items)).filter((item) => !isDeliveryService(item))
        for (const item of deliveredItems) {
          const key = item.sku ?? item.productId
          const current = productRows.get(key) ?? {
            productName: item.productName,
            sku: item.sku,
            kg: 0,
            packages: 0,
            net: 0,
          }
          current.kg += lineKg(item)
          current.packages += item.quantity
          current.net += calculateLineNet(item)
          productRows.set(key, current)
        }
      }
      const deliveryRows = customerDocuments.map((document) => {
        const order = orderById.get(document.orderId)!
        const deliveredItems = (document.itemsSnapshot?.length
          ? document.itemsSnapshot
          : effectiveOrderItems(order.items)).filter((item) => !isDeliveryService(item))
        const productNote = deliveredItems.map((item) => `${item.productName} ${item.quantity} conf.`).join('; ')
        return {
          date: document.issueDate,
          orderNumber: order.number,
          ddtNumber: document.number,
          paymentMethod: order.paymentMethod,
          paidOnDelivery: order.paymentMethod === 'on_delivery' && Boolean(order.paymentConfirmedAt),
          deliveryFeeNet: document.deliveryFeeNet ?? DEFAULT_DELIVERY_FEE_NET,
          deliveryFeeVatRate: document.deliveryFeeVatRate ?? DEFAULT_DELIVERY_FEE_VAT_RATE,
          note: `${document.issueDate} - DDT ${document.number}: ${productNote}`,
        }
      })
      const goodsNet = [...productRows.values()].reduce((sum, row) => sum + row.net, 0)
      const deliveryNet = deliveryRows.reduce((sum, row) => sum + row.deliveryFeeNet, 0)
      const paidOnDeliveryNet = customerDocuments.reduce((sum, document) => {
        const order = orderById.get(document.orderId)
        if (!order || order.paymentMethod !== 'on_delivery' || !order.paymentConfirmedAt) return sum
        const deliveredItems = (document.itemsSnapshot?.length
          ? document.itemsSnapshot
          : effectiveOrderItems(order.items)).filter((item) => !isDeliveryService(item))
        const goods = deliveredItems.reduce((total, item) => total + calculateLineNet(item), 0)
        return sum + goods + (document.deliveryFeeNet ?? DEFAULT_DELIVERY_FEE_NET)
      }, 0)

      return {
        customer,
        orders,
        documents: customerDocuments,
        products: [...productRows.values()].sort((left, right) => left.productName.localeCompare(right.productName, 'it')),
        deliveries: deliveryRows,
        deliveryCount: customerDocuments.length,
        paidOnDeliveryNet,
        goodsNet,
        deliveryNet,
        totalNet: goodsNet + deliveryNet,
      }
    })
    .filter((report) => report.deliveryCount > 0)
    .sort((left, right) => left.customer.companyName.localeCompare(right.customer.companyName, 'it'))
}

export const buildFattureInCloudDraft = (report: MonthlyCustomerReport, month: string, extraDiscountNet = 0) => ({
  type: 'invoice',
  entity: {
    name: report.customer.companyName,
    vat_number: report.customer.vatNumber,
    tax_code: report.customer.fiscalCode,
    address_street: report.customer.billingAddress.street,
    address_postal_code: report.customer.billingAddress.postalCode,
    address_city: report.customer.billingAddress.city,
    address_province: report.customer.billingAddress.province,
    country: report.customer.billingAddress.country,
    certified_email: report.customer.pec || undefined,
    ei_code: report.customer.sdiCode || undefined,
  },
  subject: `Riepilogo acquisti Igea ${month}`,
  visible_subject: `Riepilogo acquisti Igea ${month}`,
  items_list: [
    ...report.products.map((row) => ({
      name: row.productName,
      qty: Number(row.kg.toFixed(3)),
      measure: 'kg',
      net_price: Number((row.net / Math.max(row.kg, 1)).toFixed(2)),
      category: row.sku,
    })),
    ...report.deliveries
      .filter((delivery) => delivery.deliveryFeeNet > 0)
      .map((delivery) => ({
        name: `Trasporto DDT ${delivery.ddtNumber}`,
        qty: 1,
        measure: 'servizio',
        net_price: delivery.deliveryFeeNet,
        vat: { value: delivery.deliveryFeeVatRate },
      })),
    ...(extraDiscountNet > 0 ? [{
      name: 'Sconto manuale riepilogo mensile',
      qty: 1,
      measure: 'sconto',
      net_price: -Math.abs(extraDiscountNet),
    }] : []),
  ],
  notes: [
    `Riepilogo mese ${month}.`,
    `Consegne: ${report.deliveryCount}.`,
    report.deliveries.map((delivery) => delivery.note).join('\n'),
    report.paidOnDeliveryNet > 0 ? `Pagamenti gia effettuati alla consegna: imponibile merce ${report.paidOnDeliveryNet.toFixed(2)} EUR.` : '',
  ].filter(Boolean).join('\n'),
})
