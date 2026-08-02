import { CalendarDays, ClipboardList, PackageCheck, Printer, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useApp } from '../context/AppContext'
import {
  buildDailyFulfillmentReport,
  type OpenFulfillmentStatus,
} from '../lib/dailyFulfillmentReport'
import { euro, formatDate, localIsoDate } from '../lib/format'
import { StatusBadge } from './StatusBadge'
import { Button, Card, EmptyState, Field, PageHeader } from './ui'

const quantity = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 3 })

const statusOptions: Array<{ value: '' | OpenFulfillmentStatus; label: string }> = [
  { value: '', label: 'Tutti gli ordini aperti' },
  { value: 'submitted', label: 'Da valutare' },
  { value: 'accepted', label: 'Da preparare / DDT da emettere' },
  { value: 'in_delivery', label: 'In consegna' },
]

/**
 * Pagina autonoma del report operativo. L'integrazione nel menu e nel router
 * amministrativo viene mantenuta separata per evitare dipendenze circolari.
 */
export const AdminOutstandingOrdersReport = () => {
  const { db } = useApp()
  const today = localIsoDate()
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [status, setStatus] = useState<'' | OpenFulfillmentStatus>('')

  const report = useMemo(() => {
    const orders = db.orders.filter((order) =>
      (!fromDate || order.requestedDeliveryDate >= fromDate)
      && (!toDate || order.requestedDeliveryDate <= toDate)
      && (!status || order.status === status),
    )
    return buildDailyFulfillmentReport({ customers: db.customers, orders }, today)
  }, [db.customers, db.orders, fromDate, status, toDate, today])

  const orderCount = report.reduce((sum, group) => sum + group.orderCount, 0)
  const overdueCount = report
    .filter((group) => group.overdue)
    .reduce((sum, group) => sum + group.orderCount, 0)
  const totalQuantity = report.reduce((sum, group) => sum + group.totalQuantity, 0)

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Pianificazione consegne"
        title="Ordini da evadere per giorno"
        description="Raggruppa gli ordini ancora aperti per data richiesta e riepiloga le quantità effettive da preparare."
        action={<Button icon={<Printer size={18} />} variant="secondary" onClick={() => window.print()}>Stampa report</Button>}
      />

      <Card className="table-card">
        <div className="table-card__toolbar">
          <div className="form-grid">
            <Field label="Dal" htmlFor="outstanding-orders-from">
              <input
                id="outstanding-orders-from"
                type="date"
                value={fromDate}
                max={toDate || undefined}
                onChange={(event) => setFromDate(event.target.value)}
              />
            </Field>
            <Field label="Al" htmlFor="outstanding-orders-to">
              <input
                id="outstanding-orders-to"
                type="date"
                value={toDate}
                min={fromDate || undefined}
                onChange={(event) => setToDate(event.target.value)}
              />
            </Field>
            <Field label="Stato" htmlFor="outstanding-orders-status">
              <select
                id="outstanding-orders-status"
                value={status}
                onChange={(event) => setStatus(event.target.value as '' | OpenFulfillmentStatus)}
              >
                {statusOptions.map((option) => (
                  <option value={option.value} key={option.value || 'all'}>{option.label}</option>
                ))}
              </select>
            </Field>
          </div>
          {(fromDate || toDate || status) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setFromDate('')
                setToDate('')
                setStatus('')
              }}
            >Azzera filtri</Button>
          )}
        </div>
      </Card>

      <div className="stat-grid stat-grid--four">
        <Card className="admin-stat">
          <span className="admin-stat__icon admin-stat__icon--blue"><CalendarDays /></span>
          <div><p>Giorni pianificati</p><strong>{report.length}</strong><small>Date con ordini aperti</small></div>
        </Card>
        <Card className="admin-stat">
          <span className="admin-stat__icon admin-stat__icon--yellow"><ClipboardList /></span>
          <div><p>Ordini aperti</p><strong>{orderCount}</strong><small>Da valutare o completare</small></div>
        </Card>
        <Card className="admin-stat">
          <span className="admin-stat__icon admin-stat__icon--yellow"><TriangleAlert /></span>
          <div><p>Ordini scaduti</p><strong>{overdueCount}</strong><small>Data richiesta superata</small></div>
        </Card>
        <Card className="admin-stat">
          <span className="admin-stat__icon admin-stat__icon--green"><PackageCheck /></span>
          <div><p>Unità da gestire</p><strong>{quantity.format(totalQuantity)}</strong><small>Quantità effettive confermate</small></div>
        </Card>
      </div>

      {!report.length && (
        <Card>
          <EmptyState
            icon={<ClipboardList size={29} />}
            title="Nessun ordine da evadere"
            description="Non risultano ordini aperti per i filtri selezionati."
          />
        </Card>
      )}

      {report.map((group) => (
        <Card className="table-card" key={group.date}>
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{group.overdue ? 'Data superata' : group.date === today ? 'Oggi' : 'Consegna programmata'}</p>
              <h2>{formatDate(group.date)}</h2>
              <p>{group.orderCount} {group.orderCount === 1 ? 'ordine' : 'ordini'} · {quantity.format(group.totalQuantity)} unità · prodotti {euro.format(group.totalGross)}</p>
            </div>
            {group.overdue && <span className="status-badge status-badge--danger"><span />Scaduto</span>}
          </div>

          <div className="table-wrap">
            <table className="data-table responsive-table">
              <thead>
                <tr>
                  <th>Ordine / Cliente</th>
                  <th>Stato</th>
                  <th>Prodotti da gestire</th>
                  <th>Note</th>
                  <th className="align-right">Totale prodotti</th>
                </tr>
              </thead>
              <tbody>
                {group.orders.map((order) => (
                  <tr key={order.id}>
                    <td data-label="Ordine / Cliente">
                      <strong>{order.number}</strong>
                      <small className="cell-subline">{order.customerName}</small>
                    </td>
                    <td data-label="Stato"><StatusBadge status={order.status} /></td>
                    <td data-label="Prodotti da gestire">
                      <div className="report-product-breakdown">
                        {order.items.length
                          ? order.items.map((item) => (
                            <small key={item.productId}>
                              {item.productName}: <strong>{quantity.format(item.effectiveQuantity)} conf.</strong>
                              {item.adjusted ? ` (richieste ${quantity.format(item.requestedQuantity)})` : ''}
                            </small>
                          ))
                          : <small>Nessuna riga prodotto effettiva</small>}
                      </div>
                    </td>
                    <td data-label="Note">{order.notes || '—'}</td>
                    <td data-label="Totale prodotti" className="align-right"><strong>{euro.format(order.totalGross)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="table-card__toolbar">
            <div>
              <strong>Riepilogo preparazione del giorno</strong>
              <div className="report-product-breakdown">
                {group.products.length
                  ? group.products.map((product) => (
                    <small key={product.productId}>
                      {product.productName}: {quantity.format(product.effectiveQuantity)} conf.
                      {product.kg > 0 ? ` · ${quantity.format(product.kg)} kg` : ''}
                      {` · ${product.orderCount} ${product.orderCount === 1 ? 'ordine' : 'ordini'}`}
                    </small>
                  ))
                  : <small>Nessun prodotto da preparare.</small>}
              </div>
            </div>
            <span className="result-count">Imponibile {euro.format(group.totalNet)}</span>
          </div>
        </Card>
      ))}
    </div>
  )
}
