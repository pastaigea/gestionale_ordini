import {
  ArrowRight,
  Building2,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  ClipboardList,
  Download,
  Eye,
  FileText,
  LayoutDashboard,
  MapPin,
  Package,
  PackageCheck,
  Pencil,
  Plus,
  ShoppingBasket,
  UserRound,
} from 'lucide-react'
import { useState } from 'react'
import { Navigate, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { OrderDetails } from '../components/OrderDetails'
import { OrderForm } from '../components/OrderForm'
import { StatusBadge } from '../components/StatusBadge'
import { Button, Card, DemoNotice, EmptyState, PageHeader } from '../components/ui'
import { useApp } from '../context/AppContext'
import { addressLine, calculateOrderTotals, euro, formatDate, formatDateTime, localIsoDate } from '../lib/format'
import { effectiveQuantity, isPartiallyFulfilled } from '../lib/fulfillment'
import { DEFAULT_DELIVERY_FEE_NET } from '../lib/commerce'
import { downloadDdtPdf } from '../lib/pdf'
import { paymentMethodLabel, paymentStatusClass, paymentStatusLabel } from '../lib/payment'
import { isSupabaseMode } from '../lib/supabase'
import type { Order } from '../types'

const customerNav = [
  { to: '/cliente', label: 'Panoramica', icon: LayoutDashboard, end: true },
  { to: '/cliente/nuovo', label: 'Nuovo ordine', icon: Plus },
  { to: '/cliente/ordini', label: 'I miei ordini', icon: ClipboardList },
  { to: '/cliente/documenti', label: 'Documenti DDT', icon: FileText },
  { to: '/cliente/profilo', label: 'Dati aziendali', icon: Building2 },
]

export const CustomerPortal = () => {
  const { session, db } = useApp()
  const customer = db.customers.find((item) => item.id === session?.customerId)

  if (!customer) {
    return (
      <AppShell navItems={customerNav} areaLabel="Portale cliente">
        <Card className="configuration-card">
          <Building2 size={34} />
          <h1>Profilo cliente non disponibile</h1>
          <p>L’account autenticato non è ancora collegato a un’anagrafica cliente. Contatta l’amministratore Igea.</p>
        </Card>
      </AppShell>
    )
  }

  return (
    <AppShell navItems={customerNav} areaLabel="Portale cliente">
      <Routes>
        <Route index element={<CustomerDashboard customerId={customer.id} />} />
        <Route path="nuovo" element={<NewOrderPage customerId={customer.id} />} />
        <Route path="ordini" element={<CustomerOrders customerId={customer.id} />} />
        <Route path="documenti" element={<CustomerDocuments customerId={customer.id} />} />
        <Route path="profilo" element={<CustomerProfile customerId={customer.id} />} />
        <Route path="*" element={<Navigate to="/cliente" replace />} />
      </Routes>
    </AppShell>
  )
}

const CustomerDashboard = ({ customerId }: { customerId: string }) => {
  const { db } = useApp()
  const navigate = useNavigate()
  const customer = db.customers.find((item) => item.id === customerId)!
  const orders = db.orders.filter((order) => order.customerId === customerId)
  const openOrders = orders.filter((order) => !['delivered', 'rejected', 'cancelled'].includes(order.status))
  const recentOrder = [...orders].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
  const today = localIsoDate()
  const nextOrder = [...openOrders]
    .filter((order) => order.requestedDeliveryDate >= today)
    .sort((left, right) => left.requestedDeliveryDate.localeCompare(right.requestedDeliveryDate))[0]
  const documents = db.documents.filter((document) => document.customerId === customerId && document.status !== 'void')
  const spend = orders
    .filter((order) => !['rejected', 'cancelled'].includes(order.status))
    .reduce((sum, order) => sum + calculateOrderTotals(order).gross, 0)

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Panoramica cliente"
        title={`Buongiorno, ${customer.contactName.split(' ')[0]}`}
        description="Ecco cosa sta succedendo con i tuoi ordini."
        action={<Button icon={<Plus size={18} />} onClick={() => navigate('/cliente/nuovo')}>Nuovo ordine</Button>}
      />
      <DemoNotice><strong>Ambiente dimostrativo.</strong> Prodotti, prezzi, aliquote e dati fiscali mostrati sono fittizi e restano nel browser.</DemoNotice>
      <div className="stat-grid stat-grid--four">
        <StatCard icon={<Package size={20} />} label="Ordini attivi" value={openOrders.length.toString()} meta="Da completare" tone="blue" />
        <StatCard icon={<CalendarClock size={20} />} label="Prossima consegna" value={nextOrder ? formatDate(nextOrder.requestedDeliveryDate).replace(` ${new Date().getFullYear()}`, '') : '—'} meta={nextOrder?.number ?? 'Nessuna consegna pianificata'} tone="yellow" />
        <StatCard icon={<FileText size={20} />} label="Documenti DDT" value={documents.length.toString()} meta="Disponibili in PDF" tone="cyan" />
        <StatCard icon={<CircleDollarSign size={20} />} label={isSupabaseMode ? 'Totale ordini' : 'Totale ordini demo'} value={euro.format(spend)} meta="IVA inclusa" tone="green" />
      </div>

      <div className="dashboard-grid">
        <Card className="dashboard-panel dashboard-panel--wide">
          <div className="panel-heading"><div><h2>Ordine più recente</h2><p>Lo stato si aggiorna quando Igea prende in carico l’ordine.</p></div><Button variant="ghost" size="sm" onClick={() => navigate('/cliente/ordini')}>Vedi tutti <ArrowRight size={15} /></Button></div>
          {recentOrder ? <CurrentOrder order={recentOrder} onOpen={() => navigate(`/cliente/ordini?ordine=${recentOrder.id}`)} /> : (
            <EmptyState icon={<ShoppingBasket size={28} />} title="Nessun ordine" description="Crea il tuo primo ordine dal catalogo Igea." action={<Button onClick={() => navigate('/cliente/nuovo')}>Inizia ora</Button>} />
          )}
        </Card>
        <Card className="dashboard-panel quick-order-card">
          <span className="quick-order-card__icon"><PackageCheck size={26} /></span>
          <p className="eyebrow">Riordino rapido</p>
          <h2>La dispensa chiama?</h2>
          <p>Scegli i formati, indica le quantità e invia in pochi passaggi.</p>
          <Button onClick={() => navigate('/cliente/nuovo')} size="lg">Crea un ordine <ArrowRight size={17} /></Button>
          <small>Riceverai conferma dopo la verifica di Igea.</small>
        </Card>
      </div>
    </div>
  )
}

const StatCard = ({ icon, label, value, meta, tone }: { icon: React.ReactNode; label: string; value: string; meta: string; tone: string }) => (
  <Card className="stat-card">
    <span className={`stat-card__icon stat-card__icon--${tone}`}>{icon}</span>
    <div><p>{label}</p><strong>{value}</strong><small>{meta}</small></div>
  </Card>
)

const CurrentOrder = ({ order, onOpen }: { order: Order; onOpen: () => void }) => {
  const totals = calculateOrderTotals(order)
  const partial = isPartiallyFulfilled(order)
  return (
    <article className="current-order">
      <div className="current-order__top">
        <div><span>{order.number}</span><small>inviato {formatDateTime(order.createdAt)}</small></div>
        <StatusBadge status={order.status} />
      </div>
      <div className="current-order__body">
        <div><Package /><span><small>Prodotti</small><strong>{totals.packages} confezioni{partial ? ' · parziale' : ''}</strong></span></div>
        <div><CalendarClock /><span><small>Data richiesta</small><strong>{formatDate(order.requestedDeliveryDate)}</strong></span></div>
        <div><CircleDollarSign /><span><small>Totale</small><strong>{euro.format(totals.gross)}</strong></span></div>
        <div><CircleDollarSign /><span><small>Pagamento</small><strong>{paymentStatusLabel(order)}</strong></span></div>
      </div>
      <button type="button" onClick={onOpen}>Apri dettagli <ArrowRight size={16} /></button>
    </article>
  )
}

const NewOrderPage = ({ customerId }: { customerId: string }) => {
  const { db, createOrder, updateOrder } = useApp()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const editId = searchParams.get('modifica')
  const initialOrder = db.orders.find((order) => order.id === editId && order.customerId === customerId && order.status === 'submitted')
  const customer = db.customers.find((item) => item.id === customerId)!

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={initialOrder ? initialOrder.number : 'Nuovo ordine'}
        title={initialOrder ? 'Modifica il tuo ordine' : 'Cosa prepariamo per te?'}
        description={initialOrder ? 'Puoi modificare quantità e consegna finché l’ordine è in attesa.' : 'Scegli i formati, indica le quantità e la data che preferisci.'}
      />
      <Card className="billing-summary">
        <div><small>Fornitore</small><strong>{db.supplier.businessName || 'Dati Igea da configurare'}</strong><span>{db.supplier.vatNumber ? `P.IVA ${db.supplier.vatNumber}` : 'Partita IVA da configurare'}</span>{db.supplier.address.street && <span>{addressLine(db.supplier.address)}</span>}</div>
        <div><small>Intestazione cliente</small><strong>{customer.companyName}</strong><span>P.IVA {customer.vatNumber || '—'}</span><span>{addressLine(customer.billingAddress)}</span></div>
        <div><small>Pagamento</small><strong>Scelta sull'ordine</strong><span>Puoi scegliere fattura a fine mese o pagamento alla consegna prima dell'invio.</span></div>
      </Card>
      <OrderForm
        key={initialOrder?.id ?? 'new'}
        products={db.products}
        initialOrder={initialOrder}
        defaultPaymentMethod="end_of_month"
        preferredProductIds={customer.usualProductIds ?? []}
        discounts={db.discounts}
        deliveryFeeNet={customer.deliveryFeeMode === 'free' ? 0 : DEFAULT_DELIVERY_FEE_NET}
        onSubmit={async (draft) => {
          if (initialOrder) {
            await updateOrder(initialOrder.id, draft)
            navigate(`/cliente/ordini?esito=modificato&ordine=${initialOrder.id}`)
            return
          }
          const created = await createOrder(customerId, draft)
          navigate(`/cliente/ordini?esito=creato&ordine=${created.id}`)
        }}
        onCancel={initialOrder ? () => navigate('/cliente/ordini') : undefined}
      />
    </div>
  )
}

const CustomerOrders = ({ customerId }: { customerId: string }) => {
  const { db } = useApp()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [filter, setFilter] = useState('all')
  const orders = db.orders.filter((order) => order.customerId === customerId)
  const visible = filter === 'all' ? orders : orders.filter((order) => order.status === filter)
  const selected = orders.find((order) => order.id === searchParams.get('ordine'))
  const customer = db.customers.find((item) => item.id === customerId)!
  const outcome = searchParams.get('esito')

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Storico"
        title="I miei ordini"
        description="Controlla stato, date, importi e dettagli di ogni ordine."
        action={<Button icon={<Plus size={18} />} onClick={() => navigate('/cliente/nuovo')}>Nuovo ordine</Button>}
      />
      {outcome && <div className="success-banner success-banner--order" role="status"><CheckCircle2 size={24} /><div><strong>Ordine {outcome === 'creato' ? 'inviato correttamente' : 'aggiornato correttamente'}.</strong><span>{outcome === 'creato' ? 'Il riepilogo è aperto: Igea lo prenderà in carico al più presto.' : 'Il riepilogo aggiornato è aperto qui sotto.'}</span></div></div>}
      <Card className="table-card">
        <div className="table-card__toolbar">
          <div className="filter-tabs" role="group" aria-label="Filtra ordini">
            {[['all', 'Tutti'], ['submitted', 'In ordine'], ['accepted', 'Accettati'], ['in_delivery', 'In consegna'], ['delivered', 'Consegnati']].map(([value, label]) => (
              <button type="button" className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)} key={value}>{label}</button>
            ))}
          </div>
          <span className="result-count">{visible.length} risultati</span>
        </div>
        {visible.length ? (
          <div className="table-wrap">
            <table className="data-table responsive-table">
              <thead><tr><th>Ordine</th><th>Data richiesta</th><th>Prodotti</th><th>Totale</th><th>Pagamento</th><th>Stato</th><th><span className="sr-only">Azioni</span></th></tr></thead>
              <tbody>
                {visible.map((order) => {
                  const totals = calculateOrderTotals(order)
                  const fulfilledFormats = order.items.filter((item) => effectiveQuantity(item) > 0).length
                  return (
                    <tr key={order.id}>
                      <td data-label="Ordine"><button className="table-primary" onClick={() => setSearchParams({ ordine: order.id })}>{order.number}<small>{formatDateTime(order.createdAt)}</small></button></td>
                      <td data-label="Data richiesta"><strong>{formatDate(order.requestedDeliveryDate)}</strong></td>
                      <td data-label="Prodotti">{totals.packages} conf. · {fulfilledFormats} formati{isPartiallyFulfilled(order) ? ' · consegna parziale' : ''}</td>
                      <td data-label="Totale"><strong>{euro.format(totals.gross)}</strong></td>
                      <td data-label="Pagamento"><strong>{paymentMethodLabel(order.paymentMethod)}</strong><small className={`cell-subline ${paymentStatusClass(order)}`}>{paymentStatusLabel(order)}</small></td>
                      <td data-label="Stato"><StatusBadge status={order.status} /></td>
                      <td className="table-actions">
                        {order.status === 'submitted' && <button title="Modifica" aria-label={`Modifica ${order.number}`} onClick={() => navigate(`/cliente/nuovo?modifica=${order.id}`)}><Pencil size={17} /></button>}
                        <button title="Dettagli" aria-label={`Dettagli ${order.number}`} onClick={() => setSearchParams({ ordine: order.id })}><Eye size={17} /></button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : <EmptyState icon={<ClipboardList size={28} />} title="Nessun ordine in questa vista" description="Cambia filtro oppure crea un nuovo ordine." />}
      </Card>
      {selected && (
        <OrderDetails
          order={selected}
          customer={customer}
          supplier={db.supplier}
          document={db.documents.find((item) => item.orderId === selected.id && item.status !== 'void')}
          onClose={() => setSearchParams({})}
          footer={selected.status === 'submitted' && <Button icon={<Pencil size={16} />} onClick={() => navigate(`/cliente/nuovo?modifica=${selected.id}`)}>Modifica ordine</Button>}
        />
      )}
    </div>
  )
}

const CustomerDocuments = ({ customerId }: { customerId: string }) => {
  const { db } = useApp()
  const [downloading, setDownloading] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState('')
  const documents = db.documents.filter((document) =>
    document.customerId === customerId && (!document.status || document.status === 'ready'),
  )
  const customer = db.customers.find((item) => item.id === customerId)!

  const download = async (documentId: string) => {
    const document = db.documents.find((item) => item.id === documentId)!
    const order = db.orders.find((item) => item.id === document.orderId)!
    setDownloading(documentId)
    setDownloadError('')
    try {
      await downloadDdtPdf({ document, order, customer, supplier: db.supplier, products: db.products })
    } catch (reason) {
      setDownloadError(reason instanceof Error ? reason.message : 'Esportazione PDF non riuscita.')
    } finally {
      setDownloading(null)
    }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="Archivio" title="Documenti di trasporto" description="I DDT relativi esclusivamente ai tuoi ordini, pronti da esportare in PDF." />
      <DemoNotice>I PDF generati contengono esclusivamente <strong>dati fittizi dimostrativi</strong>. I progressivi reali saranno gestiti in modo atomico dal backend.</DemoNotice>
      {downloadError && <div className="form-alert form-alert--error" role="alert">{downloadError}</div>}
      <div className="document-grid">
        {documents.map((document) => {
          const order = db.orders.find((item) => item.id === document.orderId)!
          return (
            <Card className="document-card" key={document.id}>
              <div className="document-card__icon"><FileText size={24} /></div>
              <div className="document-card__content">
                <span>Documento di trasporto</span>
                <h2>{document.number}</h2>
                <p>Emesso il {formatDate(document.issueDate)}</p>
                <div><span>Ordine</span><strong>{order.number}</strong></div>
                <div><span>Colli</span><strong>{document.packages}</strong></div>
                <div><span>Destinazione</span><strong>{customer.deliveryAddress.city}</strong></div>
              </div>
              <Button variant="secondary" icon={<Download size={17} />} disabled={downloading === document.id} onClick={() => void download(document.id)}>
                {downloading === document.id ? 'Preparazione…' : 'Scarica PDF'}
              </Button>
            </Card>
          )
        })}
      </div>
      {!documents.length && <Card><EmptyState icon={<FileText size={29} />} title="Nessun DDT disponibile" description="I documenti compariranno qui quando Igea li avrà emessi." /></Card>}
    </div>
  )
}

const CustomerProfile = ({ customerId }: { customerId: string }) => {
  const { db } = useApp()
  const customer = db.customers.find((item) => item.id === customerId)!
  return (
    <div className="page-stack">
      <PageHeader eyebrow="Anagrafica" title="Dati aziendali" description="Verifica le informazioni associate al tuo account e usate nei documenti." />
      <div className="profile-grid">
        <Card className="profile-card">
          <div className="profile-card__heading"><span><Building2 /></span><div><h2>{customer.companyName}</h2><p>Cliente attivo</p></div></div>
          <dl className="details-list">
            <div><dt>Referente</dt><dd>{customer.contactName}</dd></div>
            <div><dt>Email</dt><dd>{customer.email}</dd></div>
            <div><dt>Telefono</dt><dd>{customer.phone}</dd></div>
            <div><dt>Partita IVA</dt><dd>{customer.vatNumber}</dd></div>
            <div><dt>Codice fiscale</dt><dd>{customer.fiscalCode}</dd></div>
            <div><dt>Codice SDI</dt><dd>{customer.sdiCode}</dd></div>
            <div><dt>PEC</dt><dd>{customer.pec}</dd></div>
          </dl>
        </Card>
        <div className="profile-side">
          <Card className="address-card"><span><MapPin /></span><div><small>Indirizzo di fatturazione</small><strong>{customer.billingAddress.street}</strong><p>{customer.billingAddress.postalCode} {customer.billingAddress.city} ({customer.billingAddress.province})</p></div></Card>
          <Card className="address-card"><span><Package /></span><div><small>Indirizzo di consegna</small><strong>{customer.deliveryAddress.street}</strong><p>{customer.deliveryAddress.postalCode} {customer.deliveryAddress.city} ({customer.deliveryAddress.province})</p></div></Card>
          <div className="profile-help"><UserRound size={21} /><div><strong>Qualcosa non è corretto?</strong><p>Per modificare i dati fiscali, contatta l’amministrazione Igea.</p></div></div>
        </div>
      </div>
    </div>
  )
}
