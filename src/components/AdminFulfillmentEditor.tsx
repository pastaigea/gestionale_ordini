import { AlertTriangle, Check, PackageCheck } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { effectiveQuantity } from '../lib/fulfillment'
import { calculateLineNet, calculateOrderTotals, euro } from '../lib/format'
import { DEFAULT_DELIVERY_FEE_NET, DEFAULT_DELIVERY_FEE_VAT_RATE } from '../lib/commerce'
import type { DeliveryDocument, Order } from '../types'
import { Button, Field, Modal } from './ui'

interface AdminFulfillmentEditorProps {
  order: Order
  document?: DeliveryDocument
  onSubmit: (values: {
    items: Array<{ productId: string; fulfilledQuantity: number }>
    reason: string
  }) => Promise<void>
  onClose: () => void
}

export const AdminFulfillmentEditor = ({ order, document, onSubmit, onClose }: AdminFulfillmentEditorProps) => {
  const [quantities, setQuantities] = useState<Record<string, number>>(() =>
    Object.fromEntries(order.items.map((item) => [item.productId, effectiveQuantity(item)])),
  )
  const [reason, setReason] = useState(order.fulfillmentAdjustmentNote ?? '')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const effectiveItems = useMemo(() => order.items.map((item) => ({
    ...item,
    fulfilledQuantity: quantities[item.productId] ?? item.quantity,
  })), [order.items, quantities])
  const deliveryFeeNet = document?.deliveryFeeNet ?? order.deliveryFeeNet ?? DEFAULT_DELIVERY_FEE_NET
  const deliveryFeeVatRate = document?.deliveryFeeVatRate ?? order.deliveryFeeVatRate ?? DEFAULT_DELIVERY_FEE_VAT_RATE
  const totals = calculateOrderTotals({ items: effectiveItems, deliveryFeeNet, deliveryFeeVatRate })
  const isPartial = effectiveItems.some((item) => effectiveQuantity(item) < item.quantity)

  const changeQuantity = (productId: string, orderedQuantity: number, value: number) => {
    const safe = Number.isFinite(value)
      ? Math.max(0, Math.min(orderedQuantity, Math.floor(value)))
      : 0
    setQuantities((current) => ({ ...current, [productId]: safe }))
    setError('')
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!effectiveItems.some((item) => effectiveQuantity(item) > 0)) {
      setError('Deve rimanere almeno una confezione da consegnare. Per azzerare tutto, rifiuta o annulla l\'ordine.')
      return
    }
    if (reason.trim().length < 3) {
      setError('Indica il motivo della modifica, ad esempio "disponibilità insufficiente".')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await onSubmit({
        items: order.items.map((item) => ({
          productId: item.productId,
          fulfilledQuantity: quantities[item.productId] ?? item.quantity,
        })),
        reason: reason.trim(),
      })
    } catch (reasonCaught) {
      setError(reasonCaught instanceof Error ? reasonCaught.message : 'Modifica non riuscita.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title={`Quantità consegnate · ${order.number}`}
      description="La richiesta originale del cliente resta memorizzata e visibile."
      onClose={onClose}
      size="lg"
    >
      <form className="fulfillment-editor" onSubmit={(event) => void submit(event)}>
        {document && (
          <div className="fulfillment-editor__warning" role="note">
            <AlertTriangle size={20} />
            <span>
              <strong>Esiste già il DDT {document.number}.</strong>
              Verrà annullato e sostituito con un nuovo DDT progressivo che riporta le quantità corrette.
            </span>
          </div>
        )}

        <div className="table-wrap">
          <table className="data-table fulfillment-table">
            <thead>
              <tr><th>Prodotto</th><th>Confezione</th><th className="align-right">Richieste</th><th className="align-right">Da consegnare</th><th className="align-right">Totale netto</th></tr>
            </thead>
            <tbody>
              {order.items.map((item) => {
                const fulfilled = quantities[item.productId] ?? item.quantity
                return (
                  <tr className={fulfilled < item.quantity ? 'fulfillment-table__partial' : ''} key={item.productId}>
                    <td><strong>{item.productName}</strong>{fulfilled < item.quantity && <small>Consegna parziale</small>}</td>
                    <td>{item.packageLabel}</td>
                    <td className="align-right"><strong>{item.quantity}</strong></td>
                    <td className="align-right">
                      <input
                        aria-label={`Quantità da consegnare di ${item.productName}`}
                        type="number"
                        min="0"
                        max={item.quantity}
                        step="1"
                        value={fulfilled}
                        onChange={(event) => changeQuantity(item.productId, item.quantity, Number(event.target.value))}
                      />
                    </td>
                    <td className="align-right"><strong>{euro.format(calculateLineNet({ ...item, quantity: fulfilled }))}</strong></td>
                  </tr>
                )
              })}
              <tr>
                <td><strong>Spese di trasporto</strong></td>
                <td>Una consegna · IVA {deliveryFeeVatRate}%</td>
                <td className="align-right">1</td>
                <td className="align-right">1</td>
                <td className="align-right"><strong>{euro.format(deliveryFeeNet)}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="fulfillment-editor__summary">
          <span><PackageCheck size={18} /><strong>{isPartial ? 'Consegna parziale' : 'Ordine completo'}</strong></span>
          <span>Confezioni: <strong>{totals.packages}</strong></span>
          <span>Imponibile: <strong>{euro.format(totals.net)}</strong></span>
          <span>Totale: <strong>{euro.format(totals.gross)}</strong></span>
        </div>

        <Field label="Motivo della modifica" htmlFor="fulfillment-reason" hint="Obbligatorio; resta nello storico amministrativo.">
          <textarea
            id="fulfillment-reason"
            rows={3}
            maxLength={300}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Es. disponibilità insufficiente del formato richiesto"
            required
          />
        </Field>

        {error && <div className="form-alert form-alert--error" role="alert">{error}</div>}
        <footer className="fulfillment-editor__footer">
          <Button type="button" variant="ghost" onClick={onClose}>Annulla</Button>
          <Button type="submit" disabled={submitting} icon={<Check size={17} />}>
            {submitting ? 'Salvataggio…' : document ? 'Rettifica e genera nuovo DDT' : 'Salva quantità da consegnare'}
          </Button>
        </footer>
      </form>
    </Modal>
  )
}
