import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { OrderForm } from './OrderForm'
import type { Product } from '../types'

const products: Product[] = [{
  id: 'test-product',
  name: 'Formato Test',
  category: 'Pasta',
  packageLabel: 'Confezione demo',
  packageSize: 1,
  pricingMode: 'per_kg',
  price: 10,
  vatRate: 22,
  active: true,
  description: 'Prodotto fittizio per test.',
}]

const fillDeliveryDate = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText('Data consegna'), '2026-08-01')
}

describe('OrderForm', () => {
  it('aggiunge una sola voce trasporto automatica in fondo al riepilogo', () => {
    const transportProduct: Product = {
      id: 'transport-product',
      sku: 'TRASP',
      name: 'Trasporto',
      category: 'Servizio',
      packageLabel: 'Servizio',
      pricingMode: 'per_unit',
      price: 3.5,
      vatRate: 22,
      active: true,
      description: 'Non deve essere ordinabile.',
    }
    render(<OrderForm products={[...products, transportProduct]} onSubmit={vi.fn()} />)

    expect(screen.queryByRole('button', { name: 'Aggiungi Trasporto' })).not.toBeInTheDocument()
    expect(screen.getAllByText('Spese di trasporto')).toHaveLength(1)
    const summary = within(screen.getByLabelText('Riepilogo ordine'))
    expect(summary.getByText(/Una consegna · IVA 22%/)).toBeInTheDocument()
    expect(summary.getByText(/Imponibile incl\. trasporto/).parentElement).toHaveTextContent('3,50')
    expect(summary.getByText('IVA').parentElement).toHaveTextContent('0,77')
    expect(summary.getByText('Totale IVA inclusa').parentElement).toHaveTextContent('4,27')
  })

  it('applica la percentuale promo al prezzo mostrato e allo snapshot ordine', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<OrderForm products={[{ ...products[0], promoted: true, promoPercentDiscount: 10 }]} onSubmit={onSubmit} />)

    expect(screen.getByText('Sconto 10%')).toBeInTheDocument()
    expect(screen.getAllByText(/9,00/).length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: 'Aggiungi Formato Test' }))
    await fillDeliveryDate(user)
    await user.click(screen.getByRole('button', { name: 'Invia ordine' }))

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({ unitPrice: 9 })],
    }))
  })

  it('aggiunge quantità e invia uno snapshot economico coerente', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<OrderForm products={products} onSubmit={onSubmit} />)

    await user.click(screen.getByRole('button', { name: 'Aggiungi Formato Test' }))
    await user.click(screen.getByRole('button', { name: 'Aggiungi Formato Test' }))
    await fillDeliveryDate(user)
    await user.click(screen.getByRole('button', { name: 'Invia ordine' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0].items).toEqual([expect.objectContaining({
      productId: 'test-product',
      quantity: 2,
      unitPrice: 10,
      vatRate: 22,
    })])
    expect(onSubmit.mock.calls[0][0].paymentMethod).toBe('end_of_month')
    expect(onSubmit.mock.calls[0][0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('permette al cliente di scegliere il pagamento alla consegna per l ordine', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<OrderForm products={products} onSubmit={onSubmit} />)

    await user.click(screen.getByRole('button', { name: 'Aggiungi Formato Test' }))
    await fillDeliveryDate(user)
    await user.click(screen.getByLabelText('Pagamento alla consegna'))
    await user.click(screen.getByRole('button', { name: 'Invia ordine' }))

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      paymentMethod: 'on_delivery',
    }))
  })

  it('mantiene nell’ordine in modifica un prodotto disattivato e il prezzo storico', () => {
    const archivedProduct = { ...products[0], active: false, price: 99 }
    render(
      <OrderForm
        products={[archivedProduct]}
        initialOrder={{
          id: 'order-1', number: 'ORD-DEMO', customerId: 'client-1', requestedDeliveryDate: '2026-08-01', notes: '', status: 'submitted', paymentMethod: 'end_of_month', createdAt: '2026-07-01T10:00:00Z', updatedAt: '2026-07-01T10:00:00Z',
          items: [{ productId: 'test-product', productName: 'Formato Test', packageLabel: 'Confezione demo', quantity: 2, unitPrice: 10, vatRate: 22, packageSize: 1, pricingMode: 'per_kg' }],
        }}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('Confezioni di Formato Test')).toHaveValue(2)
    expect(screen.getAllByText(/10,00/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Aggiungi Formato Test' })).toBeDisabled()
    expect(screen.getByText(/Non più disponibile/)).toBeInTheDocument()
  })

  it('calcola e salva un prodotto al kg usando il peso della confezione', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const productByWeight: Product = {
      ...products[0],
      id: 'weighted-product',
      name: 'Formato Peso Test',
      packageLabel: 'Confezione test da 1,5 kg',
      packageSize: 1.5,
      pricingMode: 'per_kg',
      price: 10,
    }
    render(<OrderForm products={[productByWeight]} onSubmit={onSubmit} />)

    await user.click(screen.getByRole('button', { name: 'Aggiungi Formato Peso Test' }))
    await user.click(screen.getByRole('button', { name: 'Aggiungi Formato Peso Test' }))
    await fillDeliveryDate(user)

    expect(screen.getAllByText(/15,00/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/30,00/).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: 'Invia ordine' }))

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({
        productId: 'weighted-product',
        quantity: 2,
        unitPrice: 10,
        packageSize: 1.5,
        pricingMode: 'per_kg',
      })],
    }))
  })
})
