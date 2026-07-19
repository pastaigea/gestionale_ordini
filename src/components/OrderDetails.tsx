import { CalendarDays, CircleDollarSign, FileText, MapPin, Package } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  addressLine,
  calculateLineNet,
  calculateOrderTotals,
  calculatePackageNet,
  euro,
  formatDate,
  formatDateTime,
  isPricedPerKg,
} from '../lib/format'
import { effectiveQuantity, isPartiallyFulfilled } from '../lib/fulfillment'
import {
  DEFAULT_DELIVERY_FEE_NET,
  DEFAULT_DELIVERY_FEE_VAT_RATE,
  isDeliveryService,
} from '../lib/commerce'
import type { PricingMode } from '../lib/format'
import { isPaymentConfirmationDue, paymentMethodLabel, paymentStatusLabel } from '../lib/payment'
import type { Customer, DeliveryDocument, Order, SupplierSettings } from '../types'
import { Modal } from './ui'
import { OrderProgress, StatusBadge } from './StatusBadge'

type PricedOrderItem = Order['items'][number] & { packageSize?: number; pricingMode?: PricingMode }

interface OrderDetailsProps {
  order: Order
  customer: Customer
  supplier?: SupplierSettings
  document?: DeliveryDocument
  onClose: () => void
  footer?: ReactNode
}

export const OrderDetails = ({ order, customer, supplier, document, onClose, footer }: OrderDetailsProps) => {
  const orderItems = order.items.filter((item) => !isDeliveryService(item))
  const documentItems = document?.itemsSnapshot?.filter((item) => !isDeliveryService(item))
  const detailItems: PricedOrderItem[] = documentItems
    ? [
        ...orderItems.map((orderedItem) => {
          const deliveredItem = documentItems.find((item) => item.productId === orderedItem.productId)
          return {
            ...(deliveredItem ?? orderedItem),
            orderedQuantity: orderedItem.quantity,
            quantity: deliveredItem?.quantity ?? 0,
          } as PricedOrderItem
        }),
        ...documentItems.filter((item) => !orderItems.some((orderedItem) => orderedItem.productId === item.productId)) as PricedOrderItem[],
      ]
    : orderItems.map((item) => ({
        ...item,
        orderedQuantity: item.quantity,
        quantity: effectiveQuantity(item),
      }))
  const totals = calculateOrderTotals({ items: detailItems })
  const orderCustomer = order.customerSnapshot ?? customer
  const orderSupplier = order.supplierSnapshot ?? supplier
  const paymentMethod = order.paymentMethod ?? orderCustomer.paymentMethod ?? 'end_of_month'
  const paymentStatus = paymentStatusLabel(order)
  const deliveryFeeNet = document?.deliveryFeeNet ?? order.deliveryFeeNet ?? DEFAULT_DELIVERY_FEE_NET
  const deliveryFeeVatRate = document?.deliveryFeeVatRate ?? order.deliveryFeeVatRate ?? DEFAULT_DELIVERY_FEE_VAT_RATE
  const deliveryFeeVat = Math.round(deliveryFeeNet * deliveryFeeVatRate) / 100
  const totalNet = totals.net + deliveryFeeNet
  const totalVat = totals.vat + deliveryFeeVat
  const showFulfillment = isPartiallyFulfilled(order) || Boolean(order.fulfillmentAdjustedAt) || Boolean(document?.revision)
  return (
    <Modal title={order.number} description={`Creato il ${formatDateTime(order.createdAt)}`} onClose={onClose} size="lg">
      <div className="order-detail__status-row">
        <StatusBadge status={order.status} />
        <span><CalendarDays size={16} /> Consegna richiesta: <strong>{formatDate(order.requestedDeliveryDate)}</strong></span>
      </div>
      <OrderProgress status={order.status} />
      {order.status === 'rejected' && (
        <div className="form-alert form-alert--error">Questo ordine è stato rifiutato. Contatta Igea per maggiori informazioni.</div>
      )}
      {showFulfillment && (
        <div className="fulfillment-detail-note">
          <Package />
          <span><strong>Quantità rettificate dal venditore</strong><p>{order.fulfillmentAdjustmentNote || document?.revisionReason || 'La tabella distingue quanto richiesto da quanto effettivamente consegnato.'}</p></span>
        </div>
      )}
      {document && (document.revision ?? 0) > 0 && (
        <div className="fulfillment-detail-note fulfillment-detail-note--document">
          <FileText />
          <span><strong>DDT sostitutivo · revisione {document.revision}</strong><p>Il precedente DDT è stato annullato e sostituito mantenendo lo storico amministrativo.</p></span>
        </div>
      )}
      <div className="order-detail__facts">
        <div><MapPin /><span><small>Destinazione</small><strong>{orderCustomer.companyName}</strong><p>{orderCustomer.deliveryAddress.street}, {orderCustomer.deliveryAddress.city}</p></span></div>
        <div><Package /><span><small>Confezioni</small><strong>{totals.packages}</strong><p>{detailItems.filter((item) => item.quantity > 0).length} formati</p></span></div>
        <div><FileText /><span><small>Documento</small><strong>{document?.number ?? 'Da emettere'}</strong><p>{document ? `del ${formatDate(document.issueDate)}` : 'Disponibile con la consegna'}</p></span></div>
        <div className={isPaymentConfirmationDue(order) ? 'order-detail__payment--pending' : ''}><CircleDollarSign /><span><small>Pagamento</small><strong>{paymentMethodLabel(paymentMethod, true)}</strong><p>{paymentStatus}</p></span></div>
      </div>
      <div className="order-detail__parties">
        <section>
          <small>Fornitore</small>
          <strong>{orderSupplier?.businessName || 'Dati Igea da configurare'}</strong>
          <span>{orderSupplier?.vatNumber ? `P.IVA ${orderSupplier.vatNumber}` : 'Partita IVA da configurare'}</span>
          {orderSupplier?.address.street && <span>{addressLine(orderSupplier.address)}</span>}
        </section>
        <section>
          <small>Intestatario cliente</small>
          <strong>{orderCustomer.companyName}</strong>
          <span>P.IVA {orderCustomer.vatNumber || '—'}</span>
          <span>{addressLine(orderCustomer.billingAddress)}</span>
        </section>
      </div>
      <div className="table-wrap">
        <table className="data-table data-table--detail">
          <thead><tr><th>Prodotto</th><th>Confezione</th>{showFulfillment && <th className="align-right">Richieste</th>}<th className="align-right">{showFulfillment ? 'Consegnate' : 'Q.tà'}</th><th className="align-right">Prezzo</th><th className="align-right">Totale</th></tr></thead>
          <tbody>
            {detailItems.map((rawItem) => {
              const item = rawItem as PricedOrderItem
              const perKg = isPricedPerKg(item)
              const orderedQuantity = item.orderedQuantity ?? orderItems.find((orderedItem) => orderedItem.productId === item.productId)?.quantity ?? item.quantity
              return (
              <tr key={item.productId}>
                <td><strong>{item.productName}</strong></td>
                <td>{item.packageLabel}</td>
                {showFulfillment && <td className="align-right">{orderedQuantity}</td>}
                <td className="align-right">{item.quantity}</td>
                <td className="align-right">
                  <span className="price-breakdown">
                    <strong>{euro.format(item.unitPrice)}{perKg ? '/kg' : '/unità'}</strong>
                    {perKg && <small>{euro.format(calculatePackageNet(item))}/conf.</small>}
                  </span>
                </td>
                <td className="align-right"><strong>{euro.format(calculateLineNet(item))}</strong></td>
              </tr>
              )
            })}
            <tr>
                <td><strong>Spese di trasporto</strong></td>
                <td>Servizio</td>
                {showFulfillment && <td className="align-right">—</td>}
                <td className="align-right">1</td>
                <td className="align-right"><span className="price-breakdown"><strong>{euro.format(deliveryFeeNet)}/servizio</strong><small>IVA {deliveryFeeVatRate}%</small></span></td>
                <td className="align-right"><strong>{euro.format(deliveryFeeNet)}</strong></td>
              </tr>
          </tbody>
        </table>
      </div>
      <div className="order-detail__bottom">
        <div className="order-detail__notes">
          <small>Note ordine</small>
          <p>{order.notes || 'Nessuna nota inserita.'}</p>
        </div>
        <div className="order-detail__totals">
          <div><span>Imponibile incl. trasporto</span><strong>{euro.format(totalNet)}</strong></div>
          <div><span>IVA</span><strong>{euro.format(totalVat)}</strong></div>
          <div><span>Totale</span><strong>{euro.format(totalNet + totalVat)}</strong></div>
        </div>
      </div>
      {footer && <footer className="modal__footer">{footer}</footer>}
    </Modal>
  )
}
