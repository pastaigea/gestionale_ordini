import type { Product } from '../types'
import { isDeliveryService } from './commerce'

type ProductDraft = Omit<Product, 'id'>

const requiredHeaders = [
  'sku',
  'name',
  'price',
  'vat_rate',
  'category',
  'package_size',
  'pricing_mode',
] as const

const splitDelimitedLine = (line: string, delimiter: string): string[] => {
  const values: string[] = []
  let value = ''
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"'
        index += 1
      } else quoted = !quoted
    } else if (character === delimiter && !quoted) {
      values.push(value.trim())
      value = ''
    } else value += character
  }

  if (quoted) throw new Error('Virgolette non chiuse nel file CSV.')
  values.push(value.trim())
  return values
}

const normalizedHeader = (value: string) => value
  .replace(/^\uFEFF/, '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_|_$/g, '')

const decimal = (value: string, label: string, line: number): number => {
  let normalized = value.replace(/[€\s]/g, '')
  if (normalized.includes(',') && normalized.includes('.')) normalized = normalized.replace(/\./g, '')
  normalized = normalized.replace(',', '.')
  if (!normalized) throw new Error(`Riga ${line}: ${label} mancante.`)
  const result = Number(normalized)
  if (!Number.isFinite(result)) throw new Error(`Riga ${line}: ${label} non valido.`)
  return result
}

const category = (value: string, line: number): Product['category'] => {
  const normalized = value.trim().toLowerCase()
  const aliases: Record<string, Product['category']> = {
    pasta: 'Pasta',
    'pasta corta': 'Pasta',
    'pasta lunga': 'Pasta',
    ripieno: 'Ripieno',
    'pasta ripiena': 'Ripieno',
    speciale: 'Speciale',
    servizio: 'Servizio',
  }
  const result = aliases[normalized]
  if (!result) throw new Error(`Riga ${line}: categoria non riconosciuta.`)
  return result
}

const pricingMode = (value: string, line: number): NonNullable<Product['pricingMode']> => {
  const normalized = value.trim().toLowerCase().replace('-', '_')
  if (normalized === 'per_kg' || normalized === 'kg') return 'per_kg'
  if (normalized === 'per_unit' || normalized === 'unita' || normalized === 'unità') return 'per_unit'
  throw new Error(`Riga ${line}: pricing_mode deve essere per_kg oppure per_unit.`)
}

const active = (value: string, line: number) => {
  const normalized = value.trim().toLowerCase()
  if (['', 'si', 'sì', 'true', '1', 'attivo'].includes(normalized)) return true
  if (['no', 'false', '0', 'inattivo'].includes(normalized)) return false
  throw new Error(`Riga ${line}: active non valido.`)
}

const packageLabel = (value: string, size: number | undefined, mode: NonNullable<Product['pricingMode']>) => {
  if (value.trim()) return value.trim()
  if (mode === 'per_unit') return 'Unità di servizio'
  return `Confezione da ${String(size).replace('.', ',')} kg`
}

export const parseCatalogCsv = (contents: string): ProductDraft[] => {
  const lines = contents.replace(/\r\n?/g, '\n').split('\n').filter((line) => line.trim())
  if (lines.length < 2) throw new Error('Il CSV non contiene prodotti.')

  const delimiter = lines[0].includes('\t') ? '\t' : ';'
  const headers = splitDelimitedLine(lines[0], delimiter).map(normalizedHeader)
  const indexes = new Map(headers.map((header, index) => [header, index]))
  const missing = requiredHeaders.filter((header) => !indexes.has(header))
  if (missing.length) throw new Error(`Colonne CSV mancanti: ${missing.join(', ')}.`)

  const read = (values: string[], header: string) => values[indexes.get(header) ?? -1] ?? ''
  const seenSkus = new Set<string>()

  return lines.slice(1).map((lineText, offset) => {
    const line = offset + 2
    const values = splitDelimitedLine(lineText, delimiter)
    if (values.length !== headers.length) {
      throw new Error(`Riga ${line}: attese ${headers.length} colonne, trovate ${values.length}.`)
    }
    const sku = read(values, 'sku').trim().toUpperCase()
    const name = read(values, 'name').trim()
    if (!/^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(sku)) throw new Error(`Riga ${line}: SKU mancante o non valido.`)
    if (seenSkus.has(sku)) throw new Error(`Riga ${line}: SKU ${sku} duplicato.`)
    if (!name) throw new Error(`Riga ${line}: nome prodotto mancante.`)
    seenSkus.add(sku)

    const mode = pricingMode(read(values, 'pricing_mode'), line)
    const sizeValue = read(values, 'package_size')
    const size = sizeValue ? decimal(sizeValue, 'package_size', line) : undefined
    if (size !== undefined && size <= 0) {
      throw new Error(`Riga ${line}: package_size deve essere maggiore di zero.`)
    }
    if (mode === 'per_kg' && (!size || size <= 0)) {
      throw new Error(`Riga ${line}: package_size deve essere maggiore di zero per un prezzo al kg.`)
    }
    const price = decimal(read(values, 'price'), 'prezzo', line)
    const vatRate = decimal(read(values, 'vat_rate'), 'IVA', line)
    if (price < 0) throw new Error(`Riga ${line}: il prezzo non può essere negativo.`)
    if (vatRate < 0 || vatRate > 100) throw new Error(`Riga ${line}: IVA fuori intervallo.`)

    const product: ProductDraft = {
      sku,
      name,
      category: category(read(values, 'category'), line),
      packageLabel: packageLabel(read(values, 'package_label'), size, mode),
      packageSize: size,
      pricingMode: mode,
      price,
      vatRate,
      active: active(read(values, 'active'), line),
      description: read(values, 'description').trim(),
    }
    if (isDeliveryService(product)) {
      throw new Error(`Riga ${line}: ${sku} non è un prodotto. Il trasporto viene aggiunto automaticamente all'ordine.`)
    }
    return product
  })
}
