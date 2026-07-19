import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCatalogCsv } from './catalog-parser.mjs'
import { forbidden } from './public-bundle-rules.mjs'

const root = fileURLToPath(new URL('../dist/', import.meta.url))
const privateCatalogPath = fileURLToPath(new URL('../private/catalogo-prodotti.csv', import.meta.url))
const textExtensions = new Set(['.html', '.js', '.css', '.json', '.map', '.txt'])

const files = []

let privateSkuPatterns = []
try {
  const products = await readCatalogCsv(privateCatalogPath)
  privateSkuPatterns = products.map((product) => new RegExp(
    `(^|[^A-Z0-9_-])${product.sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^A-Z0-9_-])`,
  ))
} catch (error) {
  if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
}

const walk = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await walk(path)
    else if (textExtensions.has(extname(entry.name))) files.push(path)
  }
}

await walk(root)

const findings = []
for (const file of files) {
  const content = await readFile(file, 'utf8')
  for (const rule of forbidden) {
    if (rule.pattern.test(content)) findings.push(`${rule.label}: ${file}`)
  }
  if (privateSkuPatterns.some((pattern) => pattern.test(content))) {
    findings.push(`SKU del catalogo privato: ${file}`)
  }
}

if (findings.length > 0) {
  console.error('Controllo bundle fallito. Sono presenti dati non pubblicabili:')
  for (const finding of findings) console.error(`- ${finding}`)
  process.exit(1)
}

console.log(`Bundle verificato: ${files.length} file, nessun dato riservato noto.`)
