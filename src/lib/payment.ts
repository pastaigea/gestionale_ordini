import type { Order, PaymentMethod } from '../types'
import { formatDateTime } from './format'

export const paymentMethodLabel = (method: PaymentMethod, compact = false) => {
  if (method === 'on_delivery') return compact ? 'Alla consegna' : 'Pagamento alla consegna'
  return compact ? 'Fine mese' : 'Fatturazione a fine mese'
}

export const isPaymentConfirmationDue = (order: Order) =>
  order.paymentMethod === 'on_delivery' &&
  !order.paymentConfirmedAt &&
  ['accepted', 'in_delivery', 'delivered'].includes(order.status)

export const paymentStatusLabel = (order: Order) => {
  if (order.paymentMethod !== 'on_delivery') return 'Fatturazione a fine mese'
  if (order.paymentConfirmedAt) return `Confermato il ${formatDateTime(order.paymentConfirmedAt)}`
  if (['rejected', 'cancelled'].includes(order.status)) return 'Pagamento non dovuto'
  if (isPaymentConfirmationDue(order)) return 'Da confermare dal venditore'
  return 'Previsto alla consegna dopo l’accettazione'
}

export const paymentStatusClass = (order: Order) => {
  if (isPaymentConfirmationDue(order)) return 'payment-cell--pending'
  if (order.paymentMethod !== 'on_delivery' || order.paymentConfirmedAt) return 'payment-cell--confirmed'
  return ''
}
