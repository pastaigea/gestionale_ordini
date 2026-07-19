import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { parseCatalogCsv } from './catalogImport'

const header = 'sku;name;price;vat_rate;active;category;package_size;package_label;pricing_mode;description'

describe('parseCatalogCsv', () => {
  it('legge prezzi con virgola, confezioni a peso e campi CSV tra virgolette', () => {
    const products = parseCatalogCsv([
      header,
      'TEST-1;Prodotto prova;7,37;4;SI;PASTA;1,7;;per_kg;"Nota; con separatore"',
      'SERV-1;Servizio prova;2,73;22;true;SERVIZIO;;Singolo;per_unit;',
    ].join('\n'))

    expect(products).toHaveLength(2)
    expect(products[0]).toMatchObject({
      sku: 'TEST-1',
      price: 7.37,
      vatRate: 4,
      packageSize: 1.7,
      packageLabel: 'Confezione da 1,7 kg',
      pricingMode: 'per_kg',
      description: 'Nota; con separatore',
    })
    expect(products[1]).toMatchObject({
      category: 'Servizio',
      packageSize: undefined,
      pricingMode: 'per_unit',
    })
  })

  it('rifiuta SKU duplicati senza produrre un import parziale', () => {
    const csv = [
      header,
      'DUP-1;Primo;1;4;SI;PASTA;1;;per_kg;',
      'dup-1;Secondo;2;4;SI;PASTA;1;;per_kg;',
    ].join('\n')

    expect(() => parseCatalogCsv(csv)).toThrow(/duplicato/i)
  })

  it.each(['TRASP', 'TRASP2'])('rifiuta %s perché il trasporto è automatico', (sku) => {
    const csv = [
      header,
      `${sku};Trasporto;3,50;22;SI;SERVIZIO;;Servizio;per_unit;`,
    ].join('\n')

    expect(() => parseCatalogCsv(csv)).toThrow(/aggiunto automaticamente/i)
  })

  it('richiede il peso per i prodotti valorizzati al kg', () => {
    const csv = [header, 'TEST-2;Prodotto prova;8,23;4;SI;PASTA;;;per_kg;'].join('\n')

    expect(() => parseCatalogCsv(csv)).toThrow(/package_size/i)
  })

  it.each([
    ['prezzo', 'TEST-3;Prodotto prova;;4;SI;PASTA;1;;per_kg;'],
    ['IVA', 'TEST-4;Prodotto prova;8,23;;SI;PASTA;1;;per_kg;'],
  ])('rifiuta %s vuoto invece di convertirlo in zero', (_field, row) => {
    expect(() => parseCatalogCsv([header, row].join('\n'))).toThrow(/mancante/i)
  })

  it('rifiuta valori active ambigui', () => {
    const csv = [header, 'TEST-5;Prodotto prova;8,23;4;forse;PASTA;1;;per_kg;'].join('\n')

    expect(() => parseCatalogCsv(csv)).toThrow(/active/i)
  })

  it('rifiuta pesi negativi anche per le voci a prezzo unitario', () => {
    const csv = [header, 'SERV-2;Servizio prova;2,73;22;SI;SERVIZIO;-1;;per_unit;'].join('\n')

    expect(() => parseCatalogCsv(csv)).toThrow(/package_size/i)
  })

  it('rifiuta colonne extra invece di troncare una descrizione non quotata', () => {
    const csv = [header, 'TEST-6;Prodotto prova;8,23;4;SI;PASTA;1;;per_kg;Nota;troncata'].join('\n')

    expect(() => parseCatalogCsv(csv)).toThrow(/colonne/i)
  })

  it.runIf(existsSync('private/catalogo-prodotti.csv'))(
    'valida anche il catalogo privato quando è disponibile in locale',
    () => {
      const products = parseCatalogCsv(readFileSync('private/catalogo-prodotti.csv', 'utf8'))
      expect(products.length).toBeGreaterThan(0)
      expect(new Set(products.map((product) => product.sku)).size).toBe(products.length)
    },
  )
})
