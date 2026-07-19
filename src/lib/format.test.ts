import { describe, expect, it } from 'vitest'
import { calculateLineNet, calculateOrderTotals, localIsoDate, statusMeta } from './format'

describe('calculateOrderTotals', () => {
  it('calcola imponibile, IVA, lordo e confezioni su aliquote diverse', () => {
    const totals = calculateOrderTotals({
      items: [
        { productId: 'a', productName: 'A', packageLabel: '1 kg', quantity: 2, unitPrice: 10, vatRate: 10, packageSize: 1, pricingMode: 'per_kg' },
        { productId: 'b', productName: 'B', packageLabel: '2 kg', quantity: 3, unitPrice: 4, vatRate: 22, packageSize: 2, pricingMode: 'per_kg' },
      ],
    })

    expect(totals.net).toBe(44)
    expect(totals.vat).toBeCloseTo(7.28)
    expect(totals.gross).toBeCloseTo(51.28)
    expect(totals.packages).toBe(5)
  })

  it('calcola le righe al kg usando peso confezione e quantità', () => {
    expect(calculateLineNet({
      quantity: 3,
      unitPrice: 8,
      packageSize: 1.5,
      pricingMode: 'per_kg',
    })).toBe(36)

    expect(calculateLineNet({
      quantity: 3,
      unitPrice: 8,
      packageSize: 1.5,
      pricingMode: 'per_unit',
    })).toBe(24)
  })

  it('arrotonda il totale al kg solo dopo la moltiplicazione completa', () => {
    expect(calculateLineNet({
      quantity: 2,
      unitPrice: 7.37,
      packageSize: 1.42,
      pricingMode: 'per_kg',
    })).toBe(20.93)
  })

  it('somma correttamente righe al kg e servizi a prezzo unitario', () => {
    const totals = calculateOrderTotals({
      items: [
        { productId: 'kg', productName: 'Prodotto al kg', packageLabel: '1,5 kg', quantity: 2, unitPrice: 10, vatRate: 10, packageSize: 1.5, pricingMode: 'per_kg' },
        { productId: 'service', productName: 'Servizio', packageLabel: 'Unità', quantity: 1, unitPrice: 5, vatRate: 22, pricingMode: 'per_unit' },
      ],
    })

    expect(totals.net).toBe(35)
    expect(totals.vat).toBe(4.1)
    expect(totals.gross).toBe(39.1)
    expect(totals.packages).toBe(2)
  })

  it('espone le etichette italiane degli stati applicativi', () => {
    expect(statusMeta.submitted.label).toBe('In ordine')
    expect(statusMeta.in_delivery.label).toBe('In consegna')
    expect(statusMeta.delivered.label).toBe('Consegnato')
  })

  it('preferisce i totali autorevoli calcolati dal database', () => {
    const totals = calculateOrderTotals({
      items: [{ productId: 'a', productName: 'A', packageLabel: '1 kg', quantity: 2, unitPrice: 10, vatRate: 10, packageSize: 1, pricingMode: 'per_kg' }],
      netTotal: 19.99,
      vatTotal: 2,
      grossTotal: 21.99,
    })

    expect(totals).toEqual({ net: 19.99, vat: 2, gross: 21.99, packages: 2 })
  })

  it('formatta la data usando il calendario locale, senza conversione UTC', () => {
    expect(localIsoDate(new Date(2026, 0, 9, 23, 55))).toBe('2026-01-09')
  })
})
