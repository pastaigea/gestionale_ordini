import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REQUIRED_COLUMNS = [
  'sku',
  'name',
  'price',
  'vat_rate',
  'active',
  'category',
  'package_size',
  'package_label',
  'pricing_mode',
  'description',
]

const parseLine = (line) => {
  const values = []
  let value = ''
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"' && line[index + 1] === '"' && quoted) {
      value += '"'
      index += 1
    } else if (character === '"') {
      quoted = !quoted
    } else if (character === ';' && !quoted) {
      values.push(value.trim())
      value = ''
    } else {
      value += character
    }
  }

  if (quoted) throw new Error('Virgolette non chiuse nel file catalogo.')
  values.push(value.trim())
  return values
}

const parseDecimal = (value) => {
  let normalized = value.replace(/[€\s]/g, '')
  if (normalized.includes(',') && normalized.includes('.')) normalized = normalized.replace(/\./g, '')
  normalized = normalized.replace(',', '.')
  return normalized ? Number(normalized) : Number.NaN
}

const parseActive = (value, rowNumber) => {
  const normalized = value.trim().toLowerCase()
  if (['', 'si', 'sì', 'true', '1', 'attivo'].includes(normalized)) return true
  if (['no', 'false', '0', 'inattivo'].includes(normalized)) return false
  throw new Error(`Riga ${rowNumber}: valore active non valido.`)
}

const parseCategory = (value, rowNumber) => {
  const categories = {
    pasta: 'Pasta',
    ripieno: 'Ripieno',
    speciale: 'Speciale',
    servizio: 'Servizio',
  }
  const result = categories[value.trim().toLowerCase()]
  if (!result) throw new Error(`Riga ${rowNumber}: categoria non valida.`)
  return result
}

const isDeliveryService = (product) => {
  const sku = product.sku.trim().toUpperCase()
  const name = product.name.trim().toLocaleLowerCase('it-IT')
  return sku === 'TRASP' || sku === 'TRASP2'
    || name === 'trasporto' || name === 'trasporto doppio' || name === 'spese di trasporto'
}

export const parseCatalogCsv = (source) => {
  const lines = source
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))

  if (lines.length < 2) throw new Error('Il catalogo non contiene prodotti.')

  const headers = parseLine(lines[0])
  const missing = REQUIRED_COLUMNS.filter((column) => !headers.includes(column))
  if (missing.length) throw new Error(`Colonne mancanti: ${missing.join(', ')}`)

  const products = lines.slice(1).map((line, rowIndex) => {
    const values = parseLine(line)
    if (values.length !== headers.length) {
      throw new Error(`Riga ${rowIndex + 2}: attese ${headers.length} colonne, trovate ${values.length}.`)
    }

    const raw = Object.fromEntries(headers.map((header, index) => [header, values[index]]))
    const packageSize = raw.package_size ? parseDecimal(raw.package_size) : undefined
    const product = {
      sku: raw.sku.toUpperCase(),
      name: raw.name,
      price: parseDecimal(raw.price),
      vatRate: parseDecimal(raw.vat_rate),
      active: parseActive(raw.active, rowIndex + 2),
      category: parseCategory(raw.category, rowIndex + 2),
      packageSize,
      packageLabel: raw.package_label,
      pricingMode: raw.pricing_mode.trim().toLowerCase(),
      description: raw.description,
    }

    if (!product.sku || !product.name) throw new Error(`Riga ${rowIndex + 2}: SKU e nome sono obbligatori.`)
    if (!Number.isFinite(product.price) || product.price < 0) throw new Error(`Riga ${rowIndex + 2}: prezzo non valido.`)
    if (!Number.isFinite(product.vatRate) || product.vatRate < 0 || product.vatRate > 100) throw new Error(`Riga ${rowIndex + 2}: IVA non valida.`)
    if (product.packageSize !== undefined && (!Number.isFinite(product.packageSize) || product.packageSize <= 0)) throw new Error(`Riga ${rowIndex + 2}: peso confezione non valido.`)
    if (!['per_kg', 'per_unit'].includes(product.pricingMode)) throw new Error(`Riga ${rowIndex + 2}: modalità prezzo non valida.`)
    if (product.pricingMode === 'per_kg' && product.packageSize === undefined) throw new Error(`Riga ${rowIndex + 2}: peso confezione obbligatorio per il prezzo al kg.`)
    if (isDeliveryService(product)) throw new Error(`Riga ${rowIndex + 2}: ${product.sku} non è un prodotto; il trasporto è aggiunto automaticamente all'ordine.`)

    return product
  })

  const duplicateSkus = products
    .map((product) => product.sku)
    .filter((sku, index, skus) => skus.indexOf(sku) !== index)
  if (duplicateSkus.length) throw new Error(`SKU duplicati: ${[...new Set(duplicateSkus)].join(', ')}`)

  return products
}

export const readCatalogCsv = async (filePath) => parseCatalogCsv(await readFile(filePath, 'utf8'))

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  const inputPath = process.argv[2]
  if (!inputPath) {
    throw new Error('Uso: node scripts/catalog-parser.mjs <percorso-catalogo.csv>')
  }
  const products = await readCatalogCsv(resolve(inputPath))
  const variants = products.filter((product) => /-(144|180|200)$/.test(product.sku)).length
  process.stdout.write(`Catalogo valido: ${products.length} prodotti, ${variants} varianti con suffisso.\n`)
}
