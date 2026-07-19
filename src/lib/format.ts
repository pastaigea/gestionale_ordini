import type { Order, OrderStatus, OrderTotals } from '../types'
import { effectiveQuantity } from './fulfillment'
import {
  DEFAULT_DELIVERY_FEE_NET,
  DEFAULT_DELIVERY_FEE_VAT_RATE,
  deliveryFeeAmounts,
} from './commerce'

export const euro = new Intl.NumberFormat('it-IT', {
  style: 'currency',
  currency: 'EUR',
})

export const integer = new Intl.NumberFormat('it-IT')

export const formatDate = (value: string) =>
  new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${value.slice(0, 10)}T12:00:00`))

export const formatDateTime = (value: string) =>
  new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100

export type PricingMode = 'per_kg' | 'per_unit'

export interface PricedLine {
  quantity: number
  unitPrice: number
  packageSize?: number
  pricingMode?: PricingMode
}

export const isPricedPerKg = (line: Pick<PricedLine, 'pricingMode'>) =>
  line.pricingMode === 'per_kg'

export const effectivePackageSize = (line: Pick<PricedLine, 'packageSize' | 'pricingMode'>) =>
  isPricedPerKg(line) && typeof line.packageSize === 'number' && line.packageSize > 0
    ? line.packageSize
    : 1

/** Prezzo netto della singola confezione/servizio. */
export const calculatePackageNet = (line: Pick<PricedLine, 'unitPrice' | 'packageSize' | 'pricingMode'>) =>
  roundMoney(line.unitPrice * effectivePackageSize(line))

/** Totale netto della riga: confezioni × kg/confezione × €/kg, oppure unità × €/unità. */
export const calculateLineNet = (line: PricedLine) =>
  roundMoney(line.quantity * line.unitPrice * effectivePackageSize(line))

export const calculateOrderTotals = (
  order: Pick<Order, 'items'> & Partial<Pick<Order,
    'netTotal' | 'vatTotal' | 'grossTotal' | 'deliveryFeeNet' | 'deliveryFeeVatRate'
  >>,
): OrderTotals => {
  const result = order.items.reduce(
    (totals, item) => {
      const quantity = effectiveQuantity(item)
      const effectiveItem = { ...item, quantity } as typeof item & PricedLine
      const net = calculateLineNet(effectiveItem)
      const vat = roundMoney(net * (item.vatRate / 100))
      return {
        net: roundMoney(totals.net + net),
        vat: roundMoney(totals.vat + vat),
        packages: totals.packages + (item.pricingMode === 'per_kg' ? quantity : 0),
      }
    },
    { net: 0, vat: 0, packages: 0 },
  )

  const hasAuthoritativeTotals = [order.netTotal, order.vatTotal, order.grossTotal]
    .every((value) => typeof value === 'number' && Number.isFinite(value))

  if (hasAuthoritativeTotals) {
    return {
      net: order.netTotal!,
      vat: order.vatTotal!,
      gross: order.grossTotal!,
      packages: result.packages,
    }
  }

  const includesDelivery = Object.prototype.hasOwnProperty.call(order, 'deliveryFeeNet')
  const delivery = includesDelivery
    ? deliveryFeeAmounts(
        order.deliveryFeeNet ?? DEFAULT_DELIVERY_FEE_NET,
        order.deliveryFeeVatRate ?? DEFAULT_DELIVERY_FEE_VAT_RATE,
      )
    : { net: 0, vat: 0, gross: 0 }

  const net = roundMoney(result.net + delivery.net)
  const vat = roundMoney(result.vat + delivery.vat)
  return {
    net,
    vat,
    gross: roundMoney(net + vat),
    packages: result.packages,
  }
}

export const statusMeta: Record<
  OrderStatus,
  { label: string; tone: 'neutral' | 'info' | 'success' | 'danger' | 'warning'; step: number }
> = {
  draft: { label: 'Bozza', tone: 'neutral', step: 0 },
  submitted: { label: 'In ordine', tone: 'warning', step: 1 },
  accepted: { label: 'Accettato', tone: 'info', step: 2 },
  rejected: { label: 'Rifiutato', tone: 'danger', step: 1 },
  in_delivery: { label: 'In consegna', tone: 'info', step: 3 },
  delivered: { label: 'Consegnato', tone: 'success', step: 4 },
  cancelled: { label: 'Annullato', tone: 'neutral', step: 1 },
}

export const orderStatusOptions: OrderStatus[] = [
  'submitted',
  'accepted',
  'rejected',
  'in_delivery',
  'delivered',
]

export const addressLine = (address: {
  street: string
  postalCode: string
  city: string
  province: string
}) => `${address.street}, ${address.postalCode} ${address.city} (${address.province})`

export const minDeliveryDate = () => {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  return localIsoDate(date)
}

export const localIsoDate = (date = new Date()) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
