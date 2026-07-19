import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Customer, Order } from '../types'
import { OrderDetails } from './OrderDetails'

const address = {
  street: 'Via Demo 1',
  city: 'Città Demo',
  province: 'SP',
  postalCode: '00000',
  country: 'Italia',
}

const customer: Customer = {
  id: 'customer-test',
  companyName: 'Cliente dimostrativo',
  contactName: 'Referente Demo',
  email: 'cliente@example.test',
  username: 'cliente-demo',
  phone: '',
  vatNumber: 'IT00000000000',
  fiscalCode: '',
  pec: '',
  sdiCode: '',
  billingAddress: address,
  deliveryAddress: address,
  paymentMethod: 'on_delivery',
  active: true,
  createdAt: '2026-07-01T10:00:00Z',
}

const order: Order = {
  id: 'order-test',
  number: 'ORD-TEST',
  customerId: customer.id,
  requestedDeliveryDate: '2026-08-01',
  notes: '',
  status: 'accepted',
  paymentMethod: 'on_delivery',
  items: [{
    productId: 'product-test',
    productName: 'Formato demo',
    packageLabel: 'Confezione demo',
    quantity: 1,
    unitPrice: 10,
    vatRate: 10,
    packageSize: 1,
    pricingMode: 'per_kg',
  }],
  createdAt: '2026-07-01T10:00:00Z',
  updatedAt: '2026-07-01T10:00:00Z',
}

describe('OrderDetails pagamento', () => {
  it('mostra il trasporto separato anche prima del DDT', () => {
    render(<OrderDetails order={order} customer={customer} onClose={vi.fn()} />)

    const deliveryRow = screen.getByText('Spese di trasporto').closest('tr')
    expect(deliveryRow).toHaveTextContent('1')
    expect(deliveryRow).toHaveTextContent('3,50')
    expect(screen.getByText('Imponibile incl. trasporto').parentElement).toHaveTextContent('13,50')
    expect(screen.getByText(/15,27/)).toBeInTheDocument()
  })

  it('mostra un pagamento alla consegna ancora da confermare', () => {
    render(<OrderDetails order={order} customer={customer} onClose={vi.fn()} />)

    expect(screen.getByText('Alla consegna')).toBeInTheDocument()
    expect(screen.getByText('Da confermare dal venditore')).toBeInTheDocument()
  })

  it('mostra quando il venditore ha confermato il pagamento', () => {
    render(<OrderDetails order={{ ...order, paymentConfirmedAt: '2026-07-19T12:00:00Z' }} customer={customer} onClose={vi.fn()} />)

    expect(screen.getByText(/Confermato il/)).toBeInTheDocument()
    expect(screen.queryByText('Da confermare dal venditore')).not.toBeInTheDocument()
  })

  it('distingue quantità richieste e quantità confermate dal venditore', () => {
    render(<OrderDetails
      order={{
        ...order,
        fulfillmentAdjustedAt: '2026-07-19T13:00:00Z',
        fulfillmentAdjustmentNote: 'Disponibilità insufficiente',
        items: [{ ...order.items[0], quantity: 10, fulfilledQuantity: 6 }],
      }}
      customer={customer}
      onClose={vi.fn()}
    />)

    expect(screen.getByText('Richieste')).toBeInTheDocument()
    expect(screen.getByText('Consegnate')).toBeInTheDocument()
    expect(screen.getByText('Disponibilità insufficiente')).toBeInTheDocument()
    expect(screen.getAllByText('6')).not.toHaveLength(0)
  })
})
