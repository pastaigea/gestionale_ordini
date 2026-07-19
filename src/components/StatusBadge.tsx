import type { OrderStatus } from '../types'
import { statusMeta } from '../lib/format'

export const StatusBadge = ({ status }: { status: OrderStatus }) => {
  const meta = statusMeta[status]
  return <span className={`status-badge status-badge--${meta.tone}`}><span />{meta.label}</span>
}

export const OrderProgress = ({ status }: { status: OrderStatus }) => {
  if (status === 'rejected' || status === 'cancelled') return null
  const current = statusMeta[status].step
  const steps = ['In ordine', 'Accettato', 'In consegna', 'Consegnato']
  return (
    <div className="order-progress" aria-label={`Avanzamento ordine: ${statusMeta[status].label}`}>
      {steps.map((label, index) => {
        const step = index + 1
        const state = step < current ? 'done' : step === current ? 'current' : 'future'
        return (
          <div className={`order-progress__step order-progress__step--${state}`} key={label}>
            <span aria-hidden="true">{step < current ? '✓' : step}</span>
            <small>{label}</small>
          </div>
        )
      })}
    </div>
  )
}
