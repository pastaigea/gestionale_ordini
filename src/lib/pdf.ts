import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import type { Customer, DeliveryDocument, Order, PaymentMethod, Product, SupplierSettings } from '../types'
import {
  addressLine,
  calculateLineNet,
  calculateOrderTotals,
  calculatePackageNet,
  euro,
  formatDate,
  formatDateTime,
  isPricedPerKg,
} from './format'
import type { PricingMode } from './format'
import { isSupabaseMode } from './supabase'
import {
  DEFAULT_DELIVERY_FEE_NET,
  DEFAULT_DELIVERY_FEE_VAT_RATE,
  isDeliveryService,
} from './commerce'

const imageToDataUrl = async (url: string): Promise<string | null> => {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const blob = await response.blob()
    if (!blob.size) return null
    return await new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

interface DdtPdfData {
  document: DeliveryDocument
  order: Order
  customer: Customer
  supplier: SupplierSettings
  products?: Array<Pick<Product, 'id' | 'sku'>>
}

type PdfOrderItem = Order['items'][number] & {
  sku?: string
  productSku?: string
  sku_snapshot?: string
  packageSize?: number
  pricingMode?: PricingMode
}

const wrappedLines = (pdf: jsPDF, value: unknown, width: number, maxLines = 2) => {
  const text = String(value || '—')
  const lines = pdf.splitTextToSize(text, width) as string[]
  if (lines.length <= maxLines) return lines
  const visible = lines.slice(0, maxLines)
  visible[maxLines - 1] = `${visible[maxLines - 1].replace(/[.…]+$/, '')}…`
  return visible
}

const itemCode = (item: PdfOrderItem, skuByProductId: Map<string, string>) => {
  const sku = item.sku ?? item.productSku ?? item.sku_snapshot ?? skuByProductId.get(item.productId)
  if (sku?.trim()) return sku.trim()
  return item.productName.slice(0, 14).toUpperCase()
}

const paymentText = (method: PaymentMethod) => {
  if (method === 'end_of_month') return 'Pagamento: fatturazione a fine mese'
  return 'Pagamento: alla consegna'
}

const drawFooter = (pdf: jsPDF, page: number, pages: number) => {
  const pageHeight = pdf.internal.pageSize.getHeight()
  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(7.5)
  pdf.setTextColor(92, 108, 125)
  pdf.text(
    `Documento generato dal Gestionale Ordini Pasta Igea${isSupabaseMode ? '' : ' · ambiente dimostrativo'}`,
    14,
    pageHeight - 8,
  )
  pdf.text(`Pagina ${page} di ${pages}`, 196, pageHeight - 8, { align: 'right' })
}

export const downloadDdtPdf = async ({ document, order, customer, supplier, products = [] }: DdtPdfData) => {
  const documentSupplier = document.supplierSnapshot ?? supplier
  const documentCustomer = document.customerSnapshot ?? customer
  const documentDestination = document.destinationSnapshot ?? documentCustomer.deliveryAddress
  const documentOrder = {
    ...order,
    items: (document.itemsSnapshot ?? order.items).filter((item) => !isDeliveryService(item)),
  }
  const paymentMethod = document.paymentMethod ?? order.paymentMethod ?? documentCustomer.paymentMethod ?? 'end_of_month'
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' })
  const logo = await imageToDataUrl(`${import.meta.env.BASE_URL}logo-igea.png`)
  const navy = [9, 62, 127] as [number, number, number]
  const pageHeight = pdf.internal.pageSize.getHeight()
  const skuByProductId = new Map(
    products.flatMap((product) => product.sku ? [[product.id, product.sku] as const] : []),
  )
  const deliveryFeeNet = document.deliveryFeeNet ?? DEFAULT_DELIVERY_FEE_NET
  const deliveryFeeVatRate = document.deliveryFeeVatRate ?? DEFAULT_DELIVERY_FEE_VAT_RATE
  const deliveryFeeVat = Math.round(deliveryFeeNet * deliveryFeeVatRate) / 100
  const productRows = documentOrder.items.map((rawItem) => {
    const item = rawItem as PdfOrderItem
    const perKg = isPricedPerKg(item)
    return [
      itemCode(item, skuByProductId),
      item.productName,
      item.packageLabel,
      item.quantity.toString(),
      perKg
        ? `${euro.format(item.unitPrice)}/kg\n${euro.format(calculatePackageNet(item))}/conf.`
        : `${euro.format(item.unitPrice)}/unita`,
      `${item.vatRate}%`,
      euro.format(calculateLineNet(item)),
    ]
  })

  pdf.setFillColor(...navy)
  pdf.rect(0, 0, 210, 34, 'F')
  if (logo) {
    pdf.setFillColor(255, 255, 255)
    pdf.roundedRect(13, 7, 38, 20, 2, 2, 'F')
    pdf.addImage(logo, 'PNG', 16, 11, 32, 12, undefined, 'FAST')
  }
  pdf.setTextColor(255, 255, 255)
  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(17)
  pdf.text('DOCUMENTO DI TRASPORTO', 196, 14, { align: 'right', maxWidth: 120 })
  pdf.setFontSize(10)
  pdf.setFont('helvetica', 'normal')
  pdf.text(`${document.number} · del ${formatDate(document.issueDate)}${(document.revision ?? 0) > 0 ? ` · REV. ${document.revision}` : ''}`, 196, 22, { align: 'right', maxWidth: 125 })

  pdf.setTextColor(30, 42, 56)
  pdf.setFontSize(8)
  pdf.setFont('helvetica', 'bold')
  pdf.text('MITTENTE', 14, 43)
  pdf.text('DESTINATARIO', 108, 43)
  pdf.setFontSize(9.5)
  pdf.text(wrappedLines(pdf, documentSupplier.businessName, 82), 14, 49)
  pdf.text(wrappedLines(pdf, documentCustomer.companyName, 87), 108, 49)
  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(8)
  pdf.text(wrappedLines(pdf, addressLine(documentSupplier.address), 82), 14, 59)
  pdf.text(wrappedLines(pdf, addressLine(documentDestination), 87), 108, 59)
  pdf.text(`P.IVA ${documentSupplier.vatNumber || '—'}`, 14, 69, { maxWidth: 82 })
  pdf.text(`P.IVA ${documentCustomer.vatNumber || '—'}`, 108, 69, { maxWidth: 87 })
  pdf.text(`Email ${documentSupplier.email || '—'}`, 14, 75, { maxWidth: 82 })
  pdf.text(`Rif. ${documentCustomer.contactName || '—'}`, 108, 75, { maxWidth: 87 })

  autoTable(pdf, {
    startY: 82,
    margin: { top: 16, right: 14, bottom: 18, left: 14 },
    head: [['Codice', 'Descrizione', 'Confezione', 'Q.tà', 'Prezzo', 'IVA', 'Totale netto']],
    body: [
      ...productRows,
      ['TRASPORTO', 'Spese di trasporto DDT', 'Servizio', '1', `${euro.format(deliveryFeeNet)}/servizio`, `${deliveryFeeVatRate}%`, euro.format(deliveryFeeNet)],
    ],
    theme: 'grid',
    showHead: 'everyPage',
    pageBreak: 'auto',
    rowPageBreak: 'avoid',
    headStyles: { fillColor: navy, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [242, 247, 252] },
    styles: { fontSize: 8, cellPadding: 2.7, overflow: 'linebreak', valign: 'middle' },
    columnStyles: {
      0: { cellWidth: 22 },
      1: { cellWidth: 31 },
      2: { cellWidth: 36 },
      3: { halign: 'right', cellWidth: 13 },
      4: { halign: 'right', cellWidth: 22 },
      5: { halign: 'right', cellWidth: 13 },
      6: { halign: 'right', cellWidth: 27 },
    },
  })

  const totals = calculateOrderTotals({ items: documentOrder.items })
  const totalWithDeliveryNet = totals.net + deliveryFeeNet
  const totalWithDeliveryVat = totals.vat + deliveryFeeVat
  const tableEnd = (pdf as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY
  let infoY = Math.max(tableEnd + 10, 125)
  const requiredHeight = 94
  if (infoY + requiredHeight > pageHeight - 12) {
    pdf.addPage()
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(9)
    pdf.setTextColor(...navy)
    pdf.text(`${document.number} · riepilogo trasporto`, 14, 14)
    infoY = 22
  }

  const reasonLines = wrappedLines(pdf, `Causale: ${document.transportReason}`, 78)
  const carrierLines = wrappedLines(pdf, `Trasporto: ${document.carrier}`, 78)
  pdf.setDrawColor(210, 220, 232)
  pdf.roundedRect(14, infoY, 182, 54, 2, 2, 'S')
  pdf.setTextColor(30, 42, 56)
  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(8)
  pdf.text('INFORMAZIONI SUL TRASPORTO', 19, infoY + 7)
  pdf.setFont('helvetica', 'normal')
  pdf.text(reasonLines, 19, infoY + 14)
  pdf.text(carrierLines, 19, infoY + 25)
  pdf.text(`Consegna richiesta: ${formatDate(order.requestedDeliveryDate)}`, 19, infoY + 40, { maxWidth: 78 })
  pdf.text(paymentText(paymentMethod), 19, infoY + 49, { maxWidth: 78 })
  pdf.text(`Colli: ${document.packages}`, 108, infoY + 14)
  pdf.text(`Ordine: ${order.number}`, 108, infoY + 24, { maxWidth: 82 })
  pdf.text(`Totale merce: ${euro.format(totals.net)} + IVA`, 108, infoY + 34, { maxWidth: 82 })
  pdf.text(`Trasporto: ${euro.format(deliveryFeeNet)} + IVA ${deliveryFeeVatRate}%`, 108, infoY + 40, { maxWidth: 82 })
  pdf.text(`Totale doc.: ${euro.format(totalWithDeliveryNet)} + IVA ${euro.format(totalWithDeliveryVat)}`, 108, infoY + 46, { maxWidth: 82 })
  pdf.text(`Inizio trasporto: ${document.transportStartedAt ? formatDateTime(document.transportStartedAt) : formatDate(document.issueDate)}`, 108, infoY + 52, { maxWidth: 82 })
  if ((document.revision ?? 0) > 0) {
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(154, 83, 16)
    pdf.text(`DDT sostitutivo · revisione ${document.revision}${document.revisionReason ? ` · ${document.revisionReason}` : ''}`, 19, infoY + 59, { maxWidth: 170 })
    pdf.setFont('helvetica', 'normal')
    pdf.setTextColor(30, 42, 56)
  }

  const signatureY = infoY + 66
  pdf.setDrawColor(160, 173, 189)
  pdf.line(14, signatureY + 12, 85, signatureY + 12)
  pdf.line(125, signatureY + 12, 196, signatureY + 12)
  pdf.setFontSize(8)
  pdf.text('Firma del conducente', 14, signatureY + 18)
  pdf.text('Firma del destinatario', 125, signatureY + 18)

  const pageCount = pdf.getNumberOfPages()
  for (let page = 1; page <= pageCount; page += 1) {
    pdf.setPage(page)
    drawFooter(pdf, page, pageCount)
  }

  const safeNumber = document.number.replace(/[^a-z0-9_-]+/gi, '-')
  pdf.save(`${safeNumber || 'DDT'}.pdf`)
}
