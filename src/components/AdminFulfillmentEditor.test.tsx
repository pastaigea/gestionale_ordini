import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Order } from '../types'
import { AdminFulfillmentEditor } from './AdminFulfillmentEditor'

const order: Order = {
  id: 'order-test',
  number: 'ORD-TEST',
  customerId: 'customer-test',
  requestedDeliveryDate: '2026-08-05',
  notes: '',
  status: 'accepted',
  paymentMethod: 'end_of_month',
  createdAt: '2026-08-01T10:00:00Z',
  updatedAt: '2026-08-01T10:00:00Z',
  items: [{
    productId: 'product-test',
    productName: 'Prodotto test',
    packageLabel: 'Confezione test',
    quantity: 4,
    unitPrice: 10,
    vatRate: 22,
    packageSize: 1,
    pricingMode: 'per_kg',
  }],
}

describe('AdminFulfillmentEditor', () => {
  it('permette di consegnare più confezioni di quelle ordinate', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<AdminFulfillmentEditor order={order} onSubmit={onSubmit} onClose={vi.fn()} />)

    const quantityInput = screen.getByLabelText('Quantità da consegnare di Prodotto test')
    fireEvent.change(quantityInput, { target: { value: '6' } })
    expect(quantityInput).toHaveValue(6)
    expect(screen.getByText("Aumento rispetto all'ordine")).toBeInTheDocument()
    expect(screen.getByText('Quantità aumentate')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Quantità consegnata superiore' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salva quantità da consegnare' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      items: [{ productId: 'product-test', fulfilledQuantity: 6 }],
      reason: 'Quantità consegnata superiore',
    }))
  })

  it('limita la quantità massima a 999', () => {
    render(<AdminFulfillmentEditor order={order} onSubmit={vi.fn()} onClose={vi.fn()} />)

    const quantityInput = screen.getByLabelText('Quantità da consegnare di Prodotto test')
    expect(quantityInput).toHaveAttribute('max', '999')
    fireEvent.change(quantityInput, { target: { value: '1000' } })

    expect(quantityInput).toHaveValue(999)
  })
})
