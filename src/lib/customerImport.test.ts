import { describe, expect, it } from 'vitest'
import { parseCustomersTsv } from './customerImport'

const headers = [
  'ID Cliente',
  'Ragione Sociale',
  'Alias',
  'Indirizzo',
  'CAP',
  'Comune',
  'Provincia',
  'Paese',
  'Indirizzo Consegna',
  'Email',
  'Telefono',
  'P.IVA',
  'Codice Fiscale',
  'PEC',
  'SDI',
  'Trasporto Default',
  'Attivo',
]

const row = (overrides: Record<string, string> = {}) => headers.map((header) => ({
  'ID Cliente': '001',
  'Ragione Sociale': 'Cliente di prova',
  Alias: '',
  Indirizzo: 'Via Test 1',
  CAP: '00100',
  Comune: 'Roma',
  Provincia: 'rm',
  Paese: 'Italia',
  'Indirizzo Consegna': '',
  Email: '',
  Telefono: '',
  'P.IVA': '00000000000',
  'Codice Fiscale': '',
  PEC: '',
  SDI: '',
  'Trasporto Default': 'SI',
  Attivo: 'SI',
  ...overrides,
}[header] ?? '')).join('\t')

describe('parseCustomersTsv', () => {
  it('mantiene vuota una email assente senza inventare credenziali', () => {
    const [customer] = parseCustomersTsv(`${headers.join('\t')}\n${row()}`)

    expect(customer.email).toBe('')
    expect(customer.contactName).toBe('Cliente di prova')
  })

  it('mappa telefono, paese e indirizzo di consegna separato', () => {
    const [customer] = parseCustomersTsv(`${headers.join('\t')}\n${row({
      Paese: 'Italia',
      'Indirizzo Consegna': 'Via Magazzino 2',
      Email: 'ORDINI@EXAMPLE.INVALID',
      Telefono: '+39 000 000000',
    })}`)

    expect(customer.email).toBe('ordini@example.invalid')
    expect(customer.phone).toBe('+39 000 000000')
    expect(customer.billingAddress.street).toBe('Via Test 1')
    expect(customer.deliveryAddress).toMatchObject({
      street: 'Via Magazzino 2',
      postalCode: '00100',
      city: 'Roma',
      province: 'RM',
      country: 'Italia',
    })
  })
})
