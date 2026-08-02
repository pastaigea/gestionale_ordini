import type { Customer } from '../types'

const splitLine = (line: string) => line.split('\t')

const slug = (value: string) =>
  value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '')

export const parseCustomersTsv = (text: string): Omit<Customer, 'createdAt' | 'authUserId' | 'paymentMethod'>[] => {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim())
  if (lines.length < 2) throw new Error('Il file clienti non contiene righe.')
  const header = splitLine(lines[0]).map((item) => item.trim())
  const idx = (name: string) => header.findIndex((item) => item.toLowerCase() === name.toLowerCase())
  const required = ['Ragione Sociale', 'Indirizzo', 'CAP', 'Comune', 'Provincia']
  for (const field of required) if (idx(field) < 0) throw new Error(`Colonna mancante: ${field}`)

  return lines.slice(1).map((line, index) => {
    const cols = splitLine(line)
    const get = (name: string) => cols[idx(name)]?.trim() ?? ''
    const rawId = get('ID Cliente') || `AUTO${String(index + 1).padStart(3, '0')}`
    const companyName = get('Ragione Sociale')
    if (!companyName) throw new Error(`Riga ${index + 2}: ragione sociale mancante.`)
    const email = get('Email').toLowerCase()
    const address = {
      street: get('Indirizzo'),
      postalCode: get('CAP'),
      city: get('Comune'),
      province: get('Provincia').toUpperCase(),
      country: get('Paese') || 'Italia',
    }
    const deliveryAddress = get('Indirizzo Consegna')
      ? { ...address, street: get('Indirizzo Consegna') }
      : address
    return {
      id: `customer-${rawId.toLowerCase()}`,
      companyName,
      contactName: get('Alias').split('|')[0] || companyName,
      email,
      username: slug(get('Alias').split('|')[0] || companyName || rawId),
      phone: get('Telefono'),
      vatNumber: get('P.IVA'),
      fiscalCode: get('Codice Fiscale'),
      pec: get('PEC'),
      sdiCode: get('SDI'),
      billingAddress: address,
      deliveryAddress,
      deliveryFeeMode: get('Trasporto Default').toUpperCase() === 'NO' ? 'free' : 'standard',
      active: get('Attivo').toUpperCase() !== 'NO',
      priceListId: undefined,
      usualProductIds: [],
    }
  })
}
