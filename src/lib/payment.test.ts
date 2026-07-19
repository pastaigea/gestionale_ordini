import { describe, expect, it } from 'vitest'
import type { Order } from '../types'
import { isPaymentConfirmationDue, paymentStatusLabel } from './payment'

const order = (status: Order['status'], paymentConfirmedAt?: string): Order => ({
  id: 'order-payment-test',
  number: 'ORD-TEST',
  customerId: 'customer-test',
  requestedDeliveryDate: '2026-08-01',
  notes: '',
  status,
  paymentMethod: 'on_delivery',
  paymentConfirmedAt,
  items: [],
  createdAt: '2026-07-19T10:00:00Z',
  updatedAt: '2026-07-19T10:00:00Z',
})

describe('stato pagamento alla consegna', () => {
  it('non presenta un debito per ordini rifiutati o annullati', () => {
    expect(paymentStatusLabel(order('rejected'))).toBe('Pagamento non dovuto')
    expect(paymentStatusLabel(order('cancelled'))).toBe('Pagamento non dovuto')
  })

  it('distingue un ordine in attesa da un pagamento da confermare', () => {
    expect(paymentStatusLabel(order('submitted'))).toContain('dopo l’accettazione')
    expect(isPaymentConfirmationDue(order('submitted'))).toBe(false)
    expect(isPaymentConfirmationDue(order('accepted'))).toBe(true)
  })

  it('mostra la prova di conferma quando presente', () => {
    const paid = order('delivered', '2026-07-19T12:30:00Z')
    expect(paymentStatusLabel(paid)).toContain('Confermato il')
    expect(isPaymentConfirmationDue(paid)).toBe(false)
  })
})
