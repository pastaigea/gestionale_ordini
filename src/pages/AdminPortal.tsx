import {
  Activity,
  ArrowRight,
  Ban,
  Building2,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  ClipboardList,
  Download,
  Edit3,
  Eye,
  FileCheck2,
  FilePlus2,
  FileSpreadsheet,
  FileText,
  KeyRound,
  LayoutDashboard,
  Mail,
  MapPin,
  Package,
  PackageCheck,
  Pencil,
  Phone,
  Plus,
  Percent,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  Truck,
  Upload,
  UserRoundPlus,
  Users,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { AdminFulfillmentEditor } from '../components/AdminFulfillmentEditor'
import { OrderDetails } from '../components/OrderDetails'
import { OrderForm } from '../components/OrderForm'
import { StatusBadge } from '../components/StatusBadge'
import { Button, Card, DemoNotice, EmptyState, Field, Modal, PageHeader } from '../components/ui'
import { useApp } from '../context/AppContext'
import {
  addressLine,
  calculateOrderTotals,
  calculatePackageNet,
  euro,
  formatDate,
  formatDateTime,
  isPricedPerKg,
  statusMeta,
} from '../lib/format'
import type { PricingMode } from '../lib/format'
import { parseCatalogCsv } from '../lib/catalogImport'
import { parseCustomersTsv } from '../lib/customerImport'
import { buildFattureInCloudDraft, buildMonthlyReports } from '../lib/monthlyReport'
import { effectiveQuantity, isPartiallyFulfilled } from '../lib/fulfillment'
import {
  DEFAULT_DELIVERY_FEE_NET,
  formatPromoPercent,
  isDeliveryService,
  productPromoLabel,
  resolveProductUnitPrice,
  validPromoPercent,
} from '../lib/commerce'
import { downloadDdtPdf, previewDdtPdf } from '../lib/pdf'
import {
  isPaymentConfirmationDue,
  paymentMethodLabel,
  paymentStatusClass,
  paymentStatusLabel,
} from '../lib/payment'
import { isSupabaseMode } from '../lib/supabase'
import type { Customer, DeliveryDocument, DiscountCode, Order, OrderStatus, Product, SupplierSettings } from '../types'

const adminNav = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/admin/ordini', label: 'Gestione ordini', icon: ClipboardList },
  { to: '/admin/ddt', label: 'Documenti DDT', icon: FileText },
  { to: '/admin/report-fatture', label: 'Report fatture', icon: FileSpreadsheet },
  { to: '/admin/sconti', label: 'Sconti e promo', icon: Percent },
  { to: '/admin/clienti', label: 'Clienti', icon: Users },
  { to: '/admin/prodotti', label: 'Prodotti e prezzi', icon: Package },
  { to: '/admin/azienda', label: 'Dati aziendali', icon: Settings },
]

const operationError = (reason: unknown) =>
  reason instanceof Error ? reason.message : 'Operazione non riuscita. Riprova.'

type PricedProduct = Product & { packageSize?: number; pricingMode?: PricingMode }
type ProductDraft = Omit<Product, 'id'> & { packageSize?: number; pricingMode?: PricingMode }

const pricedProduct = (product: Product) => product as PricedProduct
const productPackageNet = (product: Pick<PricedProduct, 'price' | 'packageSize' | 'pricingMode'>) => calculatePackageNet({
  unitPrice: product.price,
  packageSize: product.packageSize,
  pricingMode: product.pricingMode,
})

export const AdminPortal = () => (
  <AppShell navItems={adminNav} areaLabel="Amministrazione">
    <Routes>
      <Route index element={<AdminDashboard />} />
      <Route path="ordini" element={<AdminOrders />} />
      <Route path="ordini/nuovo" element={<AdminNewOrder />} />
      <Route path="ddt" element={<AdminDocuments />} />
      <Route path="report-fatture" element={<AdminInvoiceReports />} />
      <Route path="sconti" element={<AdminDiscounts />} />
      <Route path="clienti" element={<AdminCustomers />} />
      <Route path="prodotti" element={<AdminProducts />} />
      <Route path="azienda" element={<AdminCompany />} />
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  </AppShell>
)

const AdminDashboard = () => {
  const { db } = useApp()
  const navigate = useNavigate()
  const pending = db.orders.filter((order) => order.status === 'submitted')
  const active = db.orders.filter((order) => ['accepted', 'in_delivery'].includes(order.status))
  const delivered = db.orders.filter((order) => order.status === 'delivered')
  const validOrders = db.orders.filter((order) => !['rejected', 'cancelled'].includes(order.status))
  const revenue = validOrders.reduce((sum, order) => sum + calculateOrderTotals(order).net, 0)
  const now = Date.now()
  const weekMs = 7 * 24 * 60 * 60 * 1000
  const weeklyCounts = Array.from({ length: 7 }, () => 0)
  validOrders.forEach((order) => {
    const createdAt = new Date(order.createdAt).getTime()
    const weeksAgo = Number.isFinite(createdAt) ? Math.floor((now - createdAt) / weekMs) : -1
    if (weeksAgo >= 0 && weeksAgo < 7) weeklyCounts[6 - weeksAgo] += 1
  })
  const highestWeeklyCount = Math.max(...weeklyCounts, 1)

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Centro di controllo"
        title="Dashboard amministratore"
        description="Ordini, consegne e clienti in un colpo d’occhio."
        action={<Button icon={<ClipboardList size={18} />} onClick={() => navigate('/admin/ordini')}>Gestisci ordini</Button>}
      />
      <DemoNotice><strong>Demo locale:</strong> credenziali, prezzi, aliquote, clienti e anagrafiche sono fittizi. Nessun dato operativo è incluso nella pagina pubblica.</DemoNotice>
      <div className="stat-grid stat-grid--four">
        <AdminStat icon={<Activity />} label="Da valutare" value={pending.length.toString()} change="Richiedono attenzione" tone="yellow" />
        <AdminStat icon={<Truck />} label="In lavorazione" value={active.length.toString()} change="Accettati o in consegna" tone="blue" />
        <AdminStat icon={<PackageCheck />} label="Consegnati" value={delivered.length.toString()} change={isSupabaseMode ? 'Totale ordini' : 'Totale demo'} tone="green" />
        <AdminStat icon={<CircleDollarSign />} label={isSupabaseMode ? 'Imponibile ordini' : 'Imponibile demo'} value={euro.format(revenue)} change="Esclusa IVA" tone="cyan" />
      </div>

      <div className="admin-dashboard-grid">
        <Card className="dashboard-panel admin-orders-widget">
          <div className="panel-heading"><div><h2>Ordini recenti</h2><p>Le attività che richiedono una verifica.</p></div><Button variant="ghost" size="sm" onClick={() => navigate('/admin/ordini')}>Vedi tutti <ArrowRight size={15} /></Button></div>
          <div className="recent-order-list">
            {db.orders.slice(0, 5).map((order) => {
              const customer = db.customers.find((item) => item.id === order.customerId)
              const total = calculateOrderTotals(order)
              return (
                <button type="button" key={order.id} onClick={() => navigate(`/admin/ordini?ordine=${order.id}`)}>
                  <span className="recent-order-list__avatar">{customer?.companyName.slice(0, 1)}</span>
                  <span className="recent-order-list__main"><strong>{customer?.companyName}</strong><small>{order.number} · {total.packages} confezioni</small></span>
                  <span className="recent-order-list__date"><strong>{euro.format(total.gross)}</strong><small>{formatDate(order.requestedDeliveryDate)}</small></span>
                  <StatusBadge status={order.status} />
                  <ChevronRight size={17} />
                </button>
              )
            })}
          </div>
        </Card>

        <Card className="dashboard-panel activity-chart">
          <div className="panel-heading"><div><h2>Andamento ordini</h2><p>{isSupabaseMode ? 'Ordini validi ricevuti nel periodo.' : 'Dati calcolati sugli ordini della demo.'}</p></div><span className="chart-legend"><span /> Ultime 7 settimane</span></div>
          <div className="bar-chart" role="img" aria-label={`Ordini validi nelle ultime sette settimane, dalla meno recente: ${weeklyCounts.join(', ')}`}>
            {weeklyCounts.map((count, index) => <span aria-hidden="true" key={index} style={{ height: `${Math.max(count / highestWeeklyCount, 0.04) * 100}%` }}><i>{count}</i></span>)}
          </div>
          <div className="bar-chart__labels" aria-hidden="true">{['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'].map((item) => <span key={item}>{item}</span>)}</div>
        </Card>
      </div>

      <div className="attention-grid">
        <Card className="attention-card attention-card--yellow">
          <span><Activity /></span><div><p>Ordini in attesa</p><strong>{pending.length}</strong><button onClick={() => navigate('/admin/ordini')}>Valuta ora <ArrowRight size={14} /></button></div>
        </Card>
        <Card className="attention-card attention-card--blue">
          <span><FilePlus2 /></span><div><p>DDT da emettere</p><strong>{db.orders.filter((order) => order.status === 'accepted' && !order.ddtId).length}</strong><button onClick={() => navigate('/admin/ddt')}>Apri documenti <ArrowRight size={14} /></button></div>
        </Card>
        <Card className="attention-card attention-card--yellow">
          <span><FileSpreadsheet /></span><div><p>Report mensile</p><strong>{new Date().toISOString().slice(0, 7)}</strong><button onClick={() => navigate('/admin/report-fatture')}>Apri report <ArrowRight size={14} /></button></div>
        </Card>
        <Card className="attention-card attention-card--neutral">
          <span><Users /></span><div><p>Clienti attivi</p><strong>{db.customers.filter((customer) => customer.active).length}</strong><button onClick={() => navigate('/admin/clienti')}>Gestisci clienti <ArrowRight size={14} /></button></div>
        </Card>
      </div>
    </div>
  )
}

const AdminStat = ({ icon, label, value, change, tone }: { icon: React.ReactNode; label: string; value: string; change: string; tone: string }) => (
  <Card className="admin-stat">
    <span className={`admin-stat__icon admin-stat__icon--${tone}`}>{icon}</span>
    <div><p>{label}</p><strong>{value}</strong><small>{change}</small></div>
  </Card>
)

const AdminNewOrder = () => {
  const { db, createOrder, getCustomerCatalog, resolveDiscountCode } = useApp()
  const navigate = useNavigate()
  const [customerId, setCustomerId] = useState('')
  const [catalog, setCatalog] = useState<Product[]>([])
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [error, setError] = useState('')
  const customer = db.customers.find((item) => item.id === customerId && item.active)
  const activeCustomers = db.customers.filter((item) => item.active)

  useEffect(() => {
    let active = true
    if (!customerId) {
      setCatalog([])
      setError('')
      return () => { active = false }
    }
    setLoadingCatalog(true)
    setError('')
    void getCustomerCatalog(customerId)
      .then((products) => {
        if (active) setCatalog(products)
      })
      .catch((reason) => {
        if (active) {
          setCatalog([])
          setError(operationError(reason))
        }
      })
      .finally(() => {
        if (active) setLoadingCatalog(false)
      })
    return () => { active = false }
  }, [customerId, getCustomerCatalog])

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Inserimento venditore"
        title="Nuovo ordine per un cliente"
        description="Scegli il cliente e registra l’ordine al suo posto. L’ordine sarà subito visibile nel suo account."
        action={<Button variant="ghost" onClick={() => navigate('/admin/ordini')}>Torna agli ordini</Button>}
      />
      <Card className="admin-customer-selector">
        <Field label="Cliente" htmlFor="admin-order-customer" hint="Sono disponibili solo i clienti attivi.">
          <select id="admin-order-customer" value={customerId} onChange={(event) => setCustomerId(event.target.value)} required>
            <option value="">Seleziona un cliente…</option>
            {activeCustomers.map((item) => <option value={item.id} key={item.id}>{item.companyName}</option>)}
          </select>
        </Field>
        {customer && (
          <div className="admin-customer-selector__summary">
            <span><small>Ragione sociale</small><strong>{customer.companyName}</strong></span>
            <span><small>P.IVA</small><strong>{customer.vatNumber || '—'}</strong></span>
            <span><small>Consegna</small><strong>{addressLine(customer.deliveryAddress)}</strong></span>
          </div>
        )}
      </Card>
      {error && <div className="form-alert form-alert--error" role="alert">{error}</div>}
      {loadingCatalog && <Card className="configuration-card"><Package size={30} /><h1>Caricamento listino cliente…</h1></Card>}
      {customer && !loadingCatalog && catalog.length > 0 && (
        <OrderForm
          key={customer.id}
          products={catalog}
          defaultPaymentMethod={customer.paymentMethod ?? 'end_of_month'}
          preferredProductIds={customer.usualProductIds ?? []}
          discounts={db.discounts}
          resolveDiscount={(code) => resolveDiscountCode(code, customer.id)}
          deliveryFeeNet={customer.deliveryFeeMode === 'free' ? 0 : DEFAULT_DELIVERY_FEE_NET}
          summaryTitle={`Ordine di ${customer.companyName}`}
          submitLabel="Registra ordine"
          legalText="L’ordine viene registrato dal venditore per conto del cliente e segue il normale flusso di accettazione e consegna."
          onCancel={() => navigate('/admin/ordini')}
          onSubmit={async (draft) => {
            const created = await createOrder(customer.id, draft)
            navigate(`/admin/ordini?ordine=${created.id}&esito=creato`)
          }}
        />
      )}
      {customer && !loadingCatalog && !catalog.length && !error && (
        <Card><EmptyState icon={<Package size={29} />} title="Listino cliente vuoto" description="Assegna al cliente un listino con almeno un prodotto attivo prima di inserire l’ordine." /></Card>
      )}
      {!activeCustomers.length && <Card><EmptyState icon={<Users size={29} />} title="Nessun cliente attivo" description="Aggiungi o riattiva un cliente prima di registrarne un ordine." /></Card>}
    </div>
  )
}

const AdminOrders = () => {
  const { db, setOrderStatus, issueDdt, updateOrderPaymentMethod, confirmOrderPayment, adjustOrderFulfillment } = useApp()
  const navigate = useNavigate()
  const initialOrderId = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('ordine')
  const [selectedId, setSelectedId] = useState<string | null>(initialOrderId)
  const [editingFulfillmentId, setEditingFulfillmentId] = useState<string | null>(null)
  const [editingPaymentOrderId, setEditingPaymentOrderId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null)
  const [downloadingDdtId, setDownloadingDdtId] = useState<string | null>(null)
  const selected = db.orders.find((order) => order.id === selectedId)
  const visibleOrders = db.orders.filter((order) => {
    const customer = db.customers.find((item) => item.id === order.customerId)
    const matchesQuery = `${order.number} ${customer?.companyName}`.toLowerCase().includes(query.toLowerCase())
    return matchesQuery && (filter === 'all' || order.status === filter)
  })

  const changeStatus = async (order: Order, status: OrderStatus) => {
    const allowed =
      (order.status === 'submitted' && ['accepted', 'rejected'].includes(status)) ||
      (order.status === 'in_delivery' && status === 'delivered')
    if (!allowed) {
      setError('Transizione non consentita per lo stato corrente.')
      return
    }
    setBusyOrderId(order.id)
    setError('')
    try {
      await setOrderStatus(order.id, status)
      setNotice(`Stato aggiornato: ${statusMeta[status].label}.`)
    } catch (reason) {
      setError(operationError(reason))
    } finally {
      setBusyOrderId(null)
    }
  }

  const createDdt = async (order: Order) => {
    if (order.status !== 'accepted') {
      setError('Il DDT può essere emesso soltanto per un ordine accettato.')
      return
    }
    setBusyOrderId(order.id)
    setError('')
    try {
      const document = await issueDdt(order.id)
      setNotice(`${document.number} emesso correttamente.`)
    } catch (reason) {
      setError(operationError(reason))
    } finally {
      setBusyOrderId(null)
    }
  }

  const confirmPayment = async (order: Order) => {
    if (!isPaymentConfirmationDue(order)) {
      setError('Il pagamento può essere confermato solo per un ordine con pagamento alla consegna, già accettato e non ancora pagato.')
      return
    }
    const confirmed = window.confirm(
      `Confermare l’incasso dell’ordine ${order.number}? Verranno registrati data e operatore e la conferma non potrà essere annullata.`,
    )
    if (!confirmed) return
    setBusyOrderId(order.id)
    setError('')
    try {
      await confirmOrderPayment(order.id)
      setNotice(`Pagamento di ${order.number} confermato.`)
    } catch (reason) {
      setError(operationError(reason))
    } finally {
      setBusyOrderId(null)
    }
  }

  const downloadDdt = async (document: DeliveryDocument, order: Order, customer: Customer) => {
    setDownloadingDdtId(document.id)
    setError('')
    try {
      await downloadDdtPdf({ document, order, customer, supplier: db.supplier, products: db.products })
    } catch (reason) {
      setError(operationError(reason))
    } finally {
      setDownloadingDdtId(null)
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Operatività"
        title="Gestione ordini"
        description="Accetta, rifiuta, rettifica le quantità e accompagna ogni ordine fino alla consegna."
        action={<Button icon={<UserRoundPlus size={18} />} onClick={() => navigate('/admin/ordini/nuovo')}>Inserisci ordine per cliente</Button>}
      />
      {notice && <div className="success-banner" role="status"><CheckCircle2 size={20} /><div><strong>Operazione completata</strong><span>{notice}</span></div><button onClick={() => setNotice('')} aria-label="Chiudi"><X size={17} /></button></div>}
      {error && <div className="form-alert form-alert--error" role="alert">{error}</div>}
      <Card className="table-card">
        <div className="table-card__toolbar table-card__toolbar--search">
          <div className="search-input"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cerca ordine o cliente…" aria-label="Cerca ordini" /></div>
          <div className="filter-tabs" role="group" aria-label="Filtra ordini">
            {[['all', 'Tutti'], ['submitted', 'Da valutare'], ['accepted', 'Accettati'], ['in_delivery', 'In consegna'], ['delivered', 'Consegnati'], ['rejected', 'Rifiutati']].map(([value, label]) => (
              <button type="button" aria-pressed={filter === value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)} key={value}>{label}</button>
            ))}
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table responsive-table admin-order-table">
            <thead><tr><th>Ordine / Cliente</th><th>Consegna</th><th>Articoli</th><th>Totale</th><th>Pagamento</th><th>Stato</th><th><span className="sr-only">Azioni</span></th></tr></thead>
            <tbody>
              {visibleOrders.map((order) => {
                const customer = db.customers.find((item) => item.id === order.customerId)
                const totals = calculateOrderTotals(order)
                const fulfilledFormats = order.items.filter((item) => effectiveQuantity(item) > 0).length
                return (
                  <tr key={order.id}>
                    <td data-label="Ordine / Cliente"><button className="table-primary" onClick={() => setSelectedId(order.id)}>{order.number}<small>{customer?.companyName}</small></button></td>
                    <td data-label="Consegna"><strong>{formatDate(order.requestedDeliveryDate)}</strong><small className="cell-subline">Creato {formatDateTime(order.createdAt)}</small></td>
                    <td data-label="Articoli">{totals.packages} conf.<small className="cell-subline">{fulfilledFormats} formati{isPartiallyFulfilled(order) ? ' · consegna parziale' : ''}</small></td>
                    <td data-label="Totale"><strong>{euro.format(totals.gross)}</strong></td>
                    <td data-label="Pagamento"><span className="payment-cell"><strong>{paymentMethodLabel(order.paymentMethod, true)}</strong><small className={`cell-subline ${paymentStatusClass(order)}`}>{paymentStatusLabel(order)}</small></span></td>
                    <td data-label="Stato"><StatusBadge status={order.status} /></td>
                    <td className="table-actions">
                      {order.status === 'submitted' && <>
                        <button disabled={busyOrderId === order.id} className="action-accept" title="Accetta" aria-label={`Accetta ${order.number}`} onClick={() => void changeStatus(order, 'accepted')}><Check size={17} /></button>
                        <button disabled={busyOrderId === order.id} className="action-reject" title="Rifiuta" aria-label={`Rifiuta ${order.number}`} onClick={() => void changeStatus(order, 'rejected')}><Ban size={17} /></button>
                      </>}
                      {order.status === 'accepted' && !order.ddtId && <button disabled={busyOrderId === order.id} title="Emetti DDT" aria-label={`Emetti DDT per ${order.number}`} onClick={() => void createDdt(order)}><FilePlus2 size={17} /></button>}
                      {order.status === 'in_delivery' && <button disabled={busyOrderId === order.id} className="action-accept" title="Segna consegnato" aria-label={`Segna ${order.number} come consegnato`} onClick={() => void changeStatus(order, 'delivered')}><PackageCheck size={17} /></button>}
                      {isPaymentConfirmationDue(order) && <button disabled={busyOrderId === order.id} className="action-payment" title="Conferma pagamento" aria-label={`Conferma il pagamento di ${order.number}`} onClick={() => void confirmPayment(order)}><CircleDollarSign size={17} /></button>}
                      {['submitted', 'accepted', 'in_delivery', 'delivered'].includes(order.status) && !order.paymentConfirmedAt && <button title="Modifica quantità consegnate" aria-label={`Modifica quantità consegnate di ${order.number}`} onClick={() => setEditingFulfillmentId(order.id)}><Pencil size={17} /></button>}
                      <button title="Dettagli" aria-label={`Apri dettagli ${order.number}`} onClick={() => setSelectedId(order.id)}><Eye size={17} /></button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {!visibleOrders.length && <EmptyState icon={<ClipboardList size={28} />} title="Nessun ordine trovato" description="Prova a cambiare filtro o termine di ricerca." />}
        </div>
      </Card>
      {selected && (() => {
        const customer = db.customers.find((item) => item.id === selected.customerId)!
        const document = db.documents.find((item) => item.orderId === selected.id && item.status !== 'void')
        return (
          <OrderDetails
            order={selected}
            customer={customer}
            supplier={db.supplier}
            document={document}
            onClose={() => {
              setSelectedId(null)
              navigate('/admin/ordini', { replace: true })
            }}
            footer={<>
              {selected.status === 'submitted' && <><Button disabled={busyOrderId === selected.id} variant="danger" icon={<Ban size={16} />} onClick={() => void changeStatus(selected, 'rejected')}>Rifiuta</Button><Button disabled={busyOrderId === selected.id} variant="success" icon={<Check size={16} />} onClick={() => void changeStatus(selected, 'accepted')}>Accetta ordine</Button></>}
              {selected.status === 'accepted' && !document && <Button disabled={busyOrderId === selected.id} icon={<FilePlus2 size={16} />} onClick={() => void createDdt(selected)}>{busyOrderId === selected.id ? 'Emissione…' : 'Emetti DDT'}</Button>}
              {selected.status === 'in_delivery' && <Button disabled={busyOrderId === selected.id} variant="success" icon={<PackageCheck size={16} />} onClick={() => void changeStatus(selected, 'delivered')}>Segna consegnato</Button>}
              {isPaymentConfirmationDue(selected) && <Button disabled={busyOrderId === selected.id} variant="success" icon={<CircleDollarSign size={16} />} onClick={() => void confirmPayment(selected)}>{busyOrderId === selected.id ? 'Conferma…' : 'Conferma pagamento'}</Button>}
              {['submitted', 'accepted', 'in_delivery', 'delivered'].includes(selected.status) && !selected.paymentConfirmedAt && <Button variant="secondary" icon={<CircleDollarSign size={16} />} onClick={() => { setSelectedId(null); setEditingPaymentOrderId(selected.id) }}>Modifica pagamento</Button>}
              {['submitted', 'accepted', 'in_delivery', 'delivered'].includes(selected.status) && !selected.paymentConfirmedAt && <Button variant="secondary" icon={<Pencil size={16} />} onClick={() => { setSelectedId(null); setEditingFulfillmentId(selected.id) }}>Modifica quantità</Button>}
              {document && <Button disabled={downloadingDdtId === document.id} variant="secondary" icon={<Download size={16} />} onClick={() => void downloadDdt(document, selected, customer)}>{downloadingDdtId === document.id ? 'Preparazione…' : 'Scarica DDT'}</Button>}
            </>}
          />
        )
      })()}
      {editingPaymentOrderId && (() => {
        const order = db.orders.find((item) => item.id === editingPaymentOrderId)
        if (!order) return null
        return <OrderPaymentModal
          order={order}
          onClose={() => setEditingPaymentOrderId(null)}
          onSave={async (paymentMethod) => {
            await updateOrderPaymentMethod(order.id, paymentMethod)
            setEditingPaymentOrderId(null)
            setNotice(`Metodo di pagamento di ${order.number} aggiornato.`)
          }}
        />
      })()}
      {editingFulfillmentId && (() => {
        const order = db.orders.find((item) => item.id === editingFulfillmentId)
        if (!order) return null
        const document = db.documents.find((item) => item.orderId === order.id && item.status !== 'void')
        return (
          <AdminFulfillmentEditor
            order={order}
            document={document}
            onClose={() => setEditingFulfillmentId(null)}
            onSubmit={async (draft) => {
              await adjustOrderFulfillment(order.id, draft)
              setEditingFulfillmentId(null)
              setNotice(document
                ? `Quantità aggiornate. ${document.number} è stato sostituito con un nuovo DDT progressivo.`
                : `Quantità da consegnare aggiornate per ${order.number}.`)
            }}
          />
        )
      })()}
    </div>
  )
}

const AdminDocuments = () => {
  const { db, issueDdt, updateDeliveryFee, updateDdtMetadata } = useApp()
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [issuing, setIssuing] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState<string | null>(null)
  const [editingDocument, setEditingDocument] = useState<DeliveryDocument | null>(null)
  const eligibleOrders = db.orders.filter((order) => order.status === 'accepted' && !order.ddtId)
  const voidDocuments = db.documents.filter((document) => document.status === 'void').length

  const emit = async (order: Order) => {
    setIssuing(order.id)
    setError('')
    try {
      const document = await issueDdt(order.id)
      setNotice(`${document.number} emesso. Il progressivo è stato aggiornato.`)
    } catch (reason) {
      setError(operationError(reason))
    } finally {
      setIssuing(null)
    }
  }

  const download = async (document: DeliveryDocument) => {
    const order = db.orders.find((item) => item.id === document.orderId)!
    const customer = db.customers.find((item) => item.id === document.customerId)!
    setDownloading(document.id)
    setError('')
    try {
      await downloadDdtPdf({ document, order, customer, supplier: db.supplier, products: db.products })
    } catch (reason) {
      setError(operationError(reason))
    } finally {
      setDownloading(null)
    }
  }

  const preview = async (document: DeliveryDocument) => {
    const order = db.orders.find((item) => item.id === document.orderId)!
    const customer = db.customers.find((item) => item.id === document.customerId)!
    setPreviewing(document.id)
    setError('')
    try {
      await previewDdtPdf({ document, order, customer, supplier: db.supplier, products: db.products })
    } catch (reason) {
      setError(operationError(reason))
    } finally {
      setPreviewing(null)
    }
  }

  const saveDeliveryFee = async (document: DeliveryDocument, feeNet: number) => {
    setError('')
    try {
      await updateDeliveryFee(document.id, feeNet)
      setNotice(`Trasporto di ${document.number} aggiornato a ${euro.format(feeNet)} + IVA 22%.`)
    } catch (reason) {
      setError(operationError(reason))
      throw reason
    }
  }

  const currentYear = new Date().getFullYear()
  return (
    <div className="page-stack">
      <PageHeader eyebrow="Documenti" title="Documenti di trasporto" description="Emetti, controlla, modifica e visualizza i DDT prima di scaricarli." />
      <DemoNotice>Numerazione corrente demo: <strong>{currentYear}/{String(db.counters.ddtByYear[currentYear] ?? 0).padStart(4, '0')}</strong>. In produzione il progressivo deve essere assegnato in modo atomico dal database.</DemoNotice>
      {notice && <div className="success-banner" role="status"><CheckCircle2 size={20} /><div><strong>Documenti aggiornati</strong><span>{notice}</span></div><button onClick={() => setNotice('')} aria-label="Chiudi"><X size={17} /></button></div>}
      {error && <div className="form-alert form-alert--error" role="alert">{error}</div>}

      {eligibleOrders.length > 0 && (
        <Card className="ddt-queue">
          <div className="panel-heading"><div><h2>Da emettere</h2><p>Ordini accettati senza documento di trasporto.</p></div><span className="count-badge">{eligibleOrders.length}</span></div>
          <div className="ddt-queue__list">
            {eligibleOrders.map((order) => {
              const customer = db.customers.find((item) => item.id === order.customerId)!
              return (
                <div key={order.id}>
                  <span className="ddt-queue__icon"><FilePlus2 /></span>
                  <span><strong>{order.number}</strong><small>{customer.companyName} · consegna {formatDate(order.requestedDeliveryDate)}</small></span>
                  <Button size="sm" disabled={issuing === order.id} icon={<FileCheck2 size={16} />} onClick={() => void emit(order)}>{issuing === order.id ? 'Emissione…' : 'Emetti DDT'}</Button>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      <Card className="table-card">
        <div className="table-card__title"><div><h2>Archivio DDT</h2><p>{db.documents.length} documenti generati{voidDocuments ? ` · ${voidDocuments} annullati e sostituiti` : ''}</p></div></div>
        <div className="table-wrap">
          <table className="data-table responsive-table">
            <thead><tr><th>Documento</th><th>Cliente</th><th>Ordine</th><th>Data emissione</th><th>Colli</th><th>Totale</th><th>Stato</th><th>Trasporto</th><th><span className="sr-only">Azioni</span></th></tr></thead>
            <tbody>
              {db.documents.map((document) => {
                const customer = db.customers.find((item) => item.id === document.customerId)
                const order = db.orders.find((item) => item.id === document.orderId)
                const documentTotal = order ? calculateOrderTotals({
                  items: document.itemsSnapshot ?? order.items,
                  deliveryFeeNet: document.deliveryFeeNet ?? order.deliveryFeeNet ?? DEFAULT_DELIVERY_FEE_NET,
                  deliveryFeeVatRate: document.deliveryFeeVatRate ?? order.deliveryFeeVatRate ?? 22,
                }).gross : 0
                return (
                  <tr key={document.id}>
                    <td data-label="Documento"><strong className="document-number"><FileText size={17} />{document.number}</strong></td>
                    <td data-label="Cliente"><strong>{customer?.companyName}</strong></td>
                    <td data-label="Ordine">{order?.number}</td>
                    <td data-label="Data emissione">{formatDate(document.issueDate)}</td>
                    <td data-label="Colli">{document.packages}</td>
                    <td data-label="Totale"><strong>{euro.format(documentTotal)}</strong><small className="cell-subline">IVA inclusa</small></td>
                    <td data-label="Stato"><span className={document.status === 'void' ? 'active-pill' : 'active-pill active-pill--yes'}><span />{document.status === 'void' ? 'Annullato' : (document.revision ?? 0) > 0 ? `Sostitutivo rev. ${document.revision}` : 'Valido'}</span></td>
                    <td data-label="Trasporto">
                      <DeliveryFeeInput document={document} onSave={(feeNet) => saveDeliveryFee(document, feeNet)} />
                      <small className="cell-subline">+ IVA {document.deliveryFeeVatRate ?? 22}%</small>
                    </td>
                    <td className="table-actions document-table-actions">
                      <Button size="sm" variant="secondary" icon={<Eye size={16} />} disabled={document.status === 'void' || previewing === document.id} onClick={() => void preview(document)}>{previewing === document.id ? 'Apertura…' : 'Vedi'}</Button>
                      <Button size="sm" variant="secondary" icon={<Edit3 size={16} />} disabled={document.status === 'void'} onClick={() => setEditingDocument(document)}>Modifica</Button>
                      <Button size="sm" variant="secondary" icon={<Download size={16} />} disabled={document.status === 'void' || downloading === document.id} onClick={() => void download(document)}>{document.status === 'void' ? 'Sostituito' : downloading === document.id ? 'Attendi…' : 'PDF'}</Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {!db.documents.length && <EmptyState icon={<FileText size={29} />} title="Archivio vuoto" description="I documenti emessi compariranno qui." />}
        </div>
      </Card>
      {editingDocument && <DdtMetadataModal
        document={editingDocument}
        order={db.orders.find((item) => item.id === editingDocument.orderId)}
        onClose={() => setEditingDocument(null)}
        onSave={async (draft) => {
          await updateDdtMetadata(editingDocument.id, draft)
          setEditingDocument(null)
          setNotice(`Dati di ${draft.number} aggiornati.`)
        }}
      />}
    </div>
  )
}

const OrderPaymentModal = ({ order, onClose, onSave }: {
  order: Order
  onClose: () => void
  onSave: (paymentMethod: Order['paymentMethod']) => Promise<void>
}) => {
  const [paymentMethod, setPaymentMethod] = useState(order.paymentMethod)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  return <Modal title={`Pagamento ${order.number}`} description="La modifica si applica anche al DDT già emesso." onClose={onClose}>
    <form className="entity-form" onSubmit={async (event) => {
      event.preventDefault()
      setSaving(true)
      setError('')
      try {
        await onSave(paymentMethod)
      } catch (reason) {
        setError(operationError(reason))
      } finally {
        setSaving(false)
      }
    }}>
      <Field label="Metodo di pagamento">
        <select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value as Order['paymentMethod'])}>
          <option value="end_of_month">Fatturazione a fine mese</option>
          <option value="on_delivery">Pagamento alla consegna</option>
        </select>
      </Field>
      {error && <div className="form-alert form-alert--error" role="alert">{error}</div>}
      <footer className="entity-form__footer"><Button type="button" variant="ghost" disabled={saving} onClick={onClose}>Annulla</Button><Button type="submit" disabled={saving} icon={<Check size={17} />}>{saving ? 'Salvataggio…' : 'Salva pagamento'}</Button></footer>
    </form>
  </Modal>
}

const DdtMetadataModal = ({ document, order, onClose, onSave }: {
  document: DeliveryDocument
  order?: Order
  onClose: () => void
  onSave: (draft: { number: string; issueDate: string; paymentMethod: Order['paymentMethod'] }) => Promise<void>
}) => {
  const [number, setNumber] = useState(document.number)
  const [issueDate, setIssueDate] = useState(document.issueDate)
  const [paymentMethod, setPaymentMethod] = useState(document.paymentMethod ?? order?.paymentMethod ?? 'end_of_month')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  return <Modal title={`Modifica ${document.number}`} description="Puoi correggere numero, data e pagamento anche dopo l’emissione." onClose={onClose}>
    <form className="entity-form" onSubmit={async (event) => {
      event.preventDefault()
      setSaving(true)
      setError('')
      try {
        await onSave({ number: number.trim(), issueDate, paymentMethod })
      } catch (reason) {
        setError(operationError(reason))
      } finally {
        setSaving(false)
      }
    }}>
      <div className="form-grid">
        <Field label="Numero DDT"><input required maxLength={80} value={number} onChange={(event) => setNumber(event.target.value)} /></Field>
        <Field label="Data documento" hint="Può essere antecedente alla data odierna."><input required type="date" max={new Date().toISOString().slice(0, 10)} value={issueDate} onChange={(event) => setIssueDate(event.target.value)} /></Field>
        <Field label="Metodo di pagamento" className="field--span-2"><select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value as Order['paymentMethod'])}><option value="end_of_month">Fatturazione a fine mese</option><option value="on_delivery">Pagamento alla consegna</option></select></Field>
      </div>
      {error && <div className="form-alert form-alert--error" role="alert">{error}</div>}
      <footer className="entity-form__footer"><Button type="button" variant="ghost" disabled={saving} onClick={onClose}>Annulla</Button><Button type="submit" disabled={saving} icon={<Check size={17} />}>{saving ? 'Salvataggio…' : 'Salva modifiche'}</Button></footer>
    </form>
  </Modal>
}

const DeliveryFeeInput = ({ document, onSave }: {
  document: DeliveryDocument
  onSave: (feeNet: number) => Promise<void>
}) => {
  const currentFee = document.deliveryFeeNet ?? DEFAULT_DELIVERY_FEE_NET
  const [value, setValue] = useState(String(currentFee))
  const [saving, setSaving] = useState(false)

  useEffect(() => setValue(String(currentFee)), [currentFee])

  const commit = async () => {
    const feeNet = Number(value)
    if (!Number.isFinite(feeNet) || feeNet < 0) {
      setValue(String(currentFee))
      return
    }
    const normalized = Math.round(feeNet * 100) / 100
    if (normalized === currentFee) return
    setSaving(true)
    try {
      await onSave(normalized)
      setValue(String(normalized))
    } catch {
      setValue(String(currentFee))
    } finally {
      setSaving(false)
    }
  }

  return <input
    disabled={document.status === 'void' || saving}
    className="table-money-input"
    type="number"
    min="0"
    step="0.01"
    value={value}
    onChange={(event) => setValue(event.target.value)}
    onBlur={() => void commit()}
    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
    aria-label={`Trasporto netto ${document.number}`}
  />
}

const currentMonth = () => new Date().toISOString().slice(0, 7)

const AdminInvoiceReports = () => {
  const { db } = useApp()
  const [month, setMonth] = useState(currentMonth())
  const [discounts, setDiscounts] = useState<Record<string, number>>({})
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null)
  const reports = buildMonthlyReports(db, month)
  const selected = reports.find((report) => report.customer.id === selectedCustomerId) ?? reports[0]
  const draft = selected ? buildFattureInCloudDraft(selected, month, discounts[selected.customer.id] ?? 0) : null

  return (
    <div className="page-stack">
      <PageHeader eyebrow="Fine mese" title="Report mensile fatture" description="Riepilogo per cliente: kg per formato, consegne, pagamenti alla consegna e bozza fattura mensile." />
      <DemoNotice><strong>Dove si trova:</strong> Admin → Report fatture, oppure dashboard → Report mensile. Si popola con i DDT emessi nel mese selezionato; se non vedi righe, cambia mese o emetti almeno un DDT.</DemoNotice>
      <DemoNotice>Le fatture devono essere create da una Supabase Edge Function con token Fatture in Cloud nei secrets. Da GitHub Pages mostriamo solo anteprima e comando operativo.</DemoNotice>
      <Card className="table-card">
        <div className="table-card__toolbar table-card__toolbar--search">
          <Field label="Mese fatturazione"><input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></Field>
          <span className="result-count">{reports.length} clienti con DDT</span>
        </div>
        <div className="table-wrap">
          <table className="data-table responsive-table">
            <thead><tr><th>Cliente</th><th>Kg venduti per formato</th><th>Consegne</th><th>Pagato consegna</th><th>Totale imponibile</th><th>Sconto manuale</th></tr></thead>
            <tbody>
              {reports.map((report) => (
                <tr key={report.customer.id} className={selected?.customer.id === report.customer.id ? 'table-row--selected' : ''} onClick={() => setSelectedCustomerId(report.customer.id)}>
                  <td data-label="Cliente"><button className="table-primary" onClick={() => setSelectedCustomerId(report.customer.id)}>{report.customer.companyName}<small>{report.customer.vatNumber}</small></button></td>
                  <td data-label="Kg venduti per formato">
                    <div className="report-product-breakdown">
                      <strong>{report.products.reduce((sum, row) => sum + row.kg, 0).toFixed(2)} kg totali</strong>
                      {report.products.map((row) => <small key={row.sku ?? row.productName}>{row.productName}: {row.kg.toFixed(2)} kg</small>)}
                    </div>
                  </td>
                  <td data-label="Consegne">{report.deliveryCount}</td>
                  <td data-label="Pagato consegna">{euro.format(report.paidOnDeliveryNet)}</td>
                  <td data-label="Totale imponibile"><strong>{euro.format(report.totalNet - (discounts[report.customer.id] ?? 0))}</strong></td>
                  <td data-label="Sconto manuale"><input className="table-money-input" type="number" min="0" step="0.01" value={discounts[report.customer.id] ?? 0} onChange={(event) => setDiscounts((current) => ({ ...current, [report.customer.id]: Number(event.target.value) }))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!reports.length && <EmptyState icon={<FileSpreadsheet size={29} />} title="Nessun DDT nel mese" description="Il riepilogo si popola dai documenti di trasporto emessi." />}
        </div>
      </Card>
      {selected && (
        <div className="invoice-report-grid">
          <Card>
            <div className="panel-heading"><div><h2>{selected.customer.companyName}</h2><p>Dettaglio formati ordinati nel mese.</p></div></div>
            <div className="compact-list">
              {selected.products.map((row) => <div key={row.sku ?? row.productName}><span>{row.productName}</span><strong>{row.kg.toFixed(2)} kg · {euro.format(row.net)}</strong></div>)}
            </div>
          </Card>
          <Card>
            <div className="panel-heading"><div><h2>Consegne e note fattura</h2><p>Queste note entrano nella fattura complessiva.</p></div></div>
            <div className="compact-list">
              {selected.deliveries.map((delivery) => <div key={delivery.ddtNumber}><span>{delivery.ddtNumber} · {formatDate(delivery.date)}</span><strong>{delivery.paidOnDelivery ? 'gia pagato alla consegna' : paymentMethodLabel(delivery.paymentMethod)}</strong><small>{delivery.note}</small></div>)}
            </div>
          </Card>
          <Card className="json-preview-card">
            <div className="panel-heading"><div><h2>Bozza API Fatture in Cloud</h2><p>Payload da inviare dalla Edge Function server-side.</p></div></div>
            <pre>{JSON.stringify(draft, null, 2)}</pre>
          </Card>
        </div>
      )}
    </div>
  )
}

const AdminDiscounts = () => {
  const { db, saveDiscount, deleteDiscount, saveProduct } = useApp()
  const [editing, setEditing] = useState<DiscountCode | null>(null)
  const [promoProduct, setPromoProduct] = useState<Product | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  return (
    <div className="page-stack">
      <PageHeader eyebrow="Commerciale" title="Sconti e promo" description="Crea codici privati e imposta la percentuale di sconto dei prodotti in promo." action={<Button icon={<Plus size={18} />} onClick={() => setEditing({ id: `discount-${Date.now()}`, code: '', description: '', active: true, productPriceOverrides: {}, productPercentDiscounts: {}, freeDelivery: false })}>Nuovo sconto</Button>} />
      {notice && <div className="success-banner" role="status"><CheckCircle2 size={20} /><div><strong>Aggiornato</strong><span>{notice}</span></div><button onClick={() => setNotice('')} aria-label="Chiudi"><X size={17} /></button></div>}
      {error && <div className="form-alert form-alert--error" role="alert">{error}</div>}
      <div className="admin-dashboard-grid">
        <Card className="table-card">
          <div className="table-card__title"><div><h2>Codici sconto</h2><p>Il codice lo scegli tu e lo comunichi personalmente.</p></div></div>
          <div className="compact-list">
            {db.discounts.map((discount) => (
              <div key={discount.id}>
                <span><strong>{discount.code}</strong><small>{discount.description}</small></span>
                <strong>{discount.active ? 'Attivo' : 'Disattivo'}{discount.freeDelivery ? ' · no trasporto' : ''}</strong>
                <button onClick={() => setEditing(discount)} aria-label={`Modifica ${discount.code}`}><Edit3 size={16} /></button>
                <button onClick={() => void deleteDiscount(discount.id)} aria-label={`Elimina ${discount.code}`}><Trash2 size={16} /></button>
              </div>
            ))}
          </div>
        </Card>
        <Card className="table-card">
          <div className="table-card__title"><div><h2>Prodotti in promo</h2><p>Scegli la percentuale: prezzo e scritta vengono calcolati automaticamente.</p></div></div>
          <div className="compact-list">
            {db.products.filter((product) => product.active && !isDeliveryService(product)).slice(0, 80).map((product) => (
              <div key={product.id}>
                <span>
                  <strong>{product.name}</strong>
                  <small>{productPromoLabel(product) || 'Non in promo'} · listino {euro.format(product.price)}{product.pricingMode === 'per_kg' ? '/kg' : ''}</small>
                </span>
                <strong>{product.promoted && validPromoPercent(product.promoPercentDiscount)
                  ? euro.format(resolveProductUnitPrice(product))
                  : '—'}</strong>
                <button onClick={() => setPromoProduct(product)} aria-label={`Configura promo ${product.name}`}><Edit3 size={16} /></button>
              </div>
            ))}
          </div>
        </Card>
      </div>
      {editing && <DiscountModal discount={editing} products={db.products} onClose={() => setEditing(null)} onSaved={async (discount) => { await saveDiscount(discount); setEditing(null); setNotice(`${discount.code} salvato.`) }} />}
      {promoProduct && (
        <ProductPromotionModal
          product={promoProduct}
          onClose={() => setPromoProduct(null)}
          onSaved={async (product) => {
            try {
              await saveProduct(product)
              setPromoProduct(null)
              setError('')
              setNotice(product.promoted
                ? `${product.name}: promo ${productPromoLabel(product)} applicata.`
                : `${product.name} rimosso dalla promo.`)
            } catch (reason) {
              setError(operationError(reason))
              throw reason
            }
          }}
        />
      )}
    </div>
  )
}

const ProductPromotionModal = ({ product, onClose, onSaved }: {
  product: Product
  onClose: () => void
  onSaved: (product: Product) => Promise<void>
}) => {
  const [promoted, setPromoted] = useState(Boolean(product.promoted))
  const [percent, setPercent] = useState(String(product.promoPercentDiscount ?? 10))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const numericPercent = Number(percent)
  const previewProduct: Product = {
    ...product,
    promoted,
    promoPercentDiscount: numericPercent,
  }

  return (
    <Modal title={`Promo ${product.name}`} description="Scegli la percentuale: il prezzo promozionale viene calcolato automaticamente e il prodotto sale in cima al catalogo." onClose={onClose}>
      <form className="entity-form" onSubmit={async (event) => {
        event.preventDefault()
        if (promoted && !validPromoPercent(numericPercent)) {
          setError('Inserisci una percentuale maggiore di 0 e non superiore a 100.')
          return
        }
        setSaving(true)
        setError('')
        const promoPercentDiscount = validPromoPercent(numericPercent)
          ? numericPercent
          : product.promoPercentDiscount
        try {
          await onSaved({
            ...product,
            promoted,
            promoPercentDiscount,
            promoLabel: promoted && promoPercentDiscount
              ? `Sconto ${formatPromoPercent(promoPercentDiscount)}%`
              : '',
          })
        } catch (reason) {
          setError(operationError(reason))
        } finally {
          setSaving(false)
        }
      }}>
        <div className="form-grid">
          <label className="toggle-field field--span-2"><input type="checkbox" checked={promoted} onChange={(event) => setPromoted(event.target.checked)} /><span /><div><strong>Promo attiva</strong><small>Il prodotto viene mostrato in cima al catalogo.</small></div></label>
          <Field label="Percentuale di sconto" hint="Valore da 0,1% a 100%."><input aria-label="Percentuale di sconto promo" type="number" min="0.1" max="100" step="0.1" required={promoted} value={percent} onChange={(event) => setPercent(event.target.value)} /></Field>
          <div className="price-preview">
            <CircleDollarSign size={19} />
            <span><small>Prezzo promozionale netto</small><strong>{promoted && validPromoPercent(numericPercent) ? euro.format(resolveProductUnitPrice(previewProduct)) : 'Promo disattivata'}</strong></span>
          </div>
        </div>
        {error && <div className="form-alert form-alert--error" role="alert">{error}</div>}
        <footer className="entity-form__footer"><Button type="button" variant="ghost" disabled={saving} onClick={onClose}>Annulla</Button><Button type="submit" disabled={saving} icon={<Check size={17} />}>{saving ? 'Salvataggio…' : 'Salva promo'}</Button></footer>
      </form>
    </Modal>
  )
}

const DiscountModal = ({ discount, products, onClose, onSaved }: { discount: DiscountCode; products: Product[]; onClose: () => void; onSaved: (discount: DiscountCode) => Promise<void> }) => {
  const [form, setForm] = useState(discount)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const changeProductPrice = (productId: string, value: string) => setForm((current) => {
    const productPriceOverrides = { ...current.productPriceOverrides }
    if (value === '') delete productPriceOverrides[productId]
    else productPriceOverrides[productId] = Number(value)
    return { ...current, productPriceOverrides }
  })
  const changeProductPercent = (productId: string, value: string) => setForm((current) => {
    const productPercentDiscounts = { ...(current.productPercentDiscounts ?? {}) }
    if (value === '') delete productPercentDiscounts[productId]
    else productPercentDiscounts[productId] = Number(value)
    return { ...current, productPercentDiscounts }
  })
  return (
    <Modal title={discount.code ? `Sconto ${discount.code}` : 'Nuovo sconto'} description="Definisci prezzo prodotto e trasporto per il codice promo." onClose={onClose} size="lg">
      <form className="entity-form" noValidate onSubmit={async (event) => {
        event.preventDefault()
        setError('')
        const normalizedCode = form.code.trim().toUpperCase()
        if (normalizedCode.length < 2) {
          setError('Inserisci un codice sconto di almeno 2 caratteri.')
          return
        }
        const invalidPrice = Object.entries(form.productPriceOverrides ?? {}).find(([, value]) => !Number.isFinite(value) || value < 0)
        if (invalidPrice) {
          const product = products.find((item) => item.id === invalidPrice[0])
          setError(`Il prezzo impostato per ${product?.name ?? 'un prodotto'} non è valido.`)
          return
        }
        const invalidPercent = Object.entries(form.productPercentDiscounts ?? {}).find(([, value]) => !Number.isFinite(value) || value < 0 || value > 100)
        if (invalidPercent) {
          const product = products.find((item) => item.id === invalidPercent[0])
          setError(`La percentuale impostata per ${product?.name ?? 'un prodotto'} deve essere compresa tra 0 e 100.`)
          return
        }
        if (form.deliveryFeeNet !== undefined && (!Number.isFinite(form.deliveryFeeNet) || form.deliveryFeeNet < 0)) {
          setError('Il prezzo del trasporto non è valido.')
          return
        }
        setSaving(true)
        try {
          await onSaved({ ...form, code: normalizedCode })
        } catch (reason) {
          setError(operationError(reason))
        } finally {
          setSaving(false)
        }
      }}>
        {error && <div className="form-alert form-alert--error" role="alert" aria-live="assertive">{error}</div>}
        <div className="form-grid">
          <Field label="Codice"><input required value={form.code} onChange={(event) => setForm((current) => ({ ...current, code: event.target.value.toUpperCase() }))} /></Field>
          <Field label="Valido fino"><input type="date" value={form.validUntil ?? ''} onChange={(event) => setForm((current) => ({ ...current, validUntil: event.target.value || undefined }))} /></Field>
          <Field label="Descrizione" className="field--span-2"><input value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} /></Field>
          <label className="toggle-field"><input type="checkbox" checked={form.active} onChange={(event) => setForm((current) => ({ ...current, active: event.target.checked }))} /><span /><div><strong>Sconto attivo</strong><small>Puoi disattivarlo senza cancellarlo.</small></div></label>
          <label className="toggle-field"><input type="checkbox" checked={Boolean(form.freeDelivery)} onChange={(event) => setForm((current) => ({ ...current, freeDelivery: event.target.checked }))} /><span /><div><strong>Trasporto gratuito</strong><small>Il cliente non paga il trasporto.</small></div></label>
          <Field label="Prezzo trasporto personalizzato" hint="Lascia vuoto per usare 3,50 euro."><input type="number" min="0" step="any" value={form.deliveryFeeNet ?? ''} onChange={(event) => setForm((current) => ({ ...current, deliveryFeeNet: event.target.value ? Number(event.target.value) : undefined }))} /></Field>
        </div>
        <div className="discount-product-grid discount-product-grid--two-fields">
          {products.filter((product) => product.active && !isDeliveryService(product)).map((product) => (
            <div className="discount-product-row" key={product.id}>
              <strong>{product.name}</strong>
              <small>Listino {euro.format(product.price)}{product.pricingMode === 'per_kg' ? '/kg' : ''}</small>
              <label><span>% sconto</span><input type="number" min="0" max="100" step="any" value={form.productPercentDiscounts?.[product.id] ?? ''} onChange={(event) => changeProductPercent(product.id, event.target.value)} placeholder="10" /></label>
              <label><span>Prezzo nuovo</span><input type="number" min="0" step="any" value={form.productPriceOverrides[product.id] ?? ''} onChange={(event) => changeProductPrice(product.id, event.target.value)} placeholder="5,00" /></label>
            </div>
          ))}
        </div>
        <footer className="entity-form__footer"><Button type="button" variant="ghost" disabled={saving} onClick={onClose}>Annulla</Button><Button type="submit" disabled={saving} icon={<Check size={17} />}>{saving ? 'Salvataggio...' : 'Salva sconto'}</Button></footer>
      </form>
    </Modal>
  )
}

const AdminCustomers = () => {
  const { db, deleteCustomer, sendCustomerPasswordReset, importCustomers } = useApp()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Customer | 'new' | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busyCustomerId, setBusyCustomerId] = useState<string | null>(null)
  const customerInputRef = useRef<HTMLInputElement>(null)
  const customers = db.customers.filter((customer) => `${customer.companyName} ${customer.contactName} ${customer.email}`.toLowerCase().includes(query.toLowerCase()))

  const importCustomerFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError('')
    try {
      const parsed = parseCustomersTsv(await file.text())
      const count = await importCustomers(parsed)
      setNotice(`${count} clienti importati. Password demo fittizia: DemoCliente!2026.`)
    } catch (reason) {
      setError(operationError(reason))
    }
  }

  const removeCustomer = async (customer: Customer) => {
    const verb = isSupabaseMode ? (customer.active ? 'Disattivare' : 'Riattivare') : 'Eliminare'
    if (!window.confirm(`${verb} ${customer.companyName}?`)) return
    setBusyCustomerId(customer.id)
    setError('')
    try {
      await deleteCustomer(customer.id)
      setNotice(isSupabaseMode
        ? `${customer.companyName} è stato ${customer.active ? 'disattivato' : 'riattivato'}.`
        : `${customer.companyName} è stato eliminato dalla demo.`)
    } catch (reason) {
      setError(operationError(reason))
    } finally {
      setBusyCustomerId(null)
    }
  }

  const sendPasswordReset = async (customer: Customer) => {
    setBusyCustomerId(customer.id)
    setError('')
    try {
      await sendCustomerPasswordReset(customer.id)
      setNotice(`Email di reimpostazione inviata a ${customer.email}.`)
    } catch (reason) {
      setError(operationError(reason))
    } finally {
      setBusyCustomerId(null)
    }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="Anagrafiche" title="Clienti" description={isSupabaseMode ? 'Gestisci aziende, contatti, accessi e dati di fatturazione.' : 'Gestisci aziende, contatti, accessi demo e dati di fatturazione.'} action={<div className="page-header-actions"><input ref={customerInputRef} className="sr-only" type="file" accept=".txt,.tsv,text/tab-separated-values,text/plain" onChange={(event) => void importCustomerFile(event)} /><Button variant="secondary" icon={<Upload size={18} />} onClick={() => customerInputRef.current?.click()}>Importa clienti</Button><Button icon={<UserRoundPlus size={18} />} onClick={() => setEditing('new')}>Aggiungi cliente</Button></div>} />
      {notice && <div className="success-banner" role="status"><CheckCircle2 size={20} /><div><strong>Cliente aggiornato</strong><span>{notice}</span></div><button onClick={() => setNotice('')} aria-label="Chiudi"><X size={17} /></button></div>}
      {error && <div className="form-alert form-alert--error" role="alert">{error}</div>}
      <Card className="table-card">
        <div className="table-card__toolbar table-card__toolbar--search">
          <div className="search-input"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cerca azienda, referente o email…" aria-label="Cerca clienti" /></div>
          <span className="result-count">{customers.length} clienti</span>
        </div>
        <div className="table-wrap">
          <table className="data-table responsive-table">
            <thead><tr><th>Azienda</th><th>Contatto</th><th>Dati fiscali</th><th>Ordini</th><th>Accesso</th><th><span className="sr-only">Azioni</span></th></tr></thead>
            <tbody>
              {customers.map((customer) => {
                const customerOrders = db.orders.filter((order) => order.customerId === customer.id)
                return (
                  <tr key={customer.id}>
                    <td data-label="Azienda"><span className="customer-cell"><i>{customer.companyName.slice(0, 1)}</i><span><strong>{customer.companyName}</strong>{!isSupabaseMode && <small>{customer.username}</small>}</span></span></td>
                    <td data-label="Contatto"><strong>{customer.contactName}</strong><small className="cell-subline">{customer.email}</small></td>
                    <td data-label="Dati fiscali"><span>P.IVA {customer.vatNumber}</span><small className="cell-subline">SDI {customer.sdiCode}</small></td>
                    <td data-label="Ordini"><strong>{customerOrders.length}</strong><small className="cell-subline">{customerOrders.filter((order) => !['delivered', 'rejected'].includes(order.status)).length} attivi</small></td>
                    <td data-label="Accesso"><span className={`active-pill ${customer.active ? 'active-pill--yes' : ''}`}><span />{customer.active ? 'Attivo' : 'Disattivato'}</span></td>
                    <td className="table-actions">
                      {isSupabaseMode && <button disabled={busyCustomerId === customer.id || !customer.active} title={customer.active ? 'Invia reset password' : 'Accesso disattivato'} aria-label={`Invia reset password a ${customer.companyName}`} onClick={() => void sendPasswordReset(customer)}><KeyRound size={17} /></button>}
                      <button disabled={busyCustomerId === customer.id} title="Modifica" aria-label={`Modifica ${customer.companyName}`} onClick={() => setEditing(customer)}><Pencil size={17} /></button>
                      <button
                        title={!isSupabaseMode && customerOrders.length ? 'Impossibile eliminare: sono presenti ordini' : isSupabaseMode ? (customer.active ? 'Disattiva accesso' : 'Riattiva accesso') : 'Elimina'}
                        aria-label={`${isSupabaseMode ? (customer.active ? 'Disattiva accesso a' : 'Riattiva accesso a') : 'Elimina'} ${customer.companyName}`}
                        disabled={busyCustomerId === customer.id || (!isSupabaseMode && customerOrders.length > 0)}
                        onClick={() => void removeCustomer(customer)}
                      >{isSupabaseMode ? (customer.active ? <Ban size={17} /> : <CheckCircle2 size={17} />) : <Trash2 size={17} />}</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {editing && <CustomerModal customer={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={(message) => { setNotice(message); setEditing(null) }} />}
    </div>
  )
}

const blankAddress = { street: '', city: '', province: '', postalCode: '', country: 'Italia' }

const CustomerModal = ({ customer, onClose, onSaved }: { customer?: Customer; onClose: () => void; onSaved: (message: string) => void }) => {
  const { saveCustomer, setDemoCustomerPassword, db } = useApp()
  const [form, setForm] = useState<Omit<Customer, 'id' | 'createdAt' | 'authUserId'>>(customer ? {
    priceListId: customer.priceListId,
    companyName: customer.companyName,
    contactName: customer.contactName,
    email: customer.email,
    username: customer.username,
    phone: customer.phone,
    vatNumber: customer.vatNumber,
    fiscalCode: customer.fiscalCode,
    pec: customer.pec,
    sdiCode: customer.sdiCode,
    billingAddress: customer.billingAddress,
    deliveryAddress: customer.deliveryAddress,
    paymentMethod: customer.paymentMethod,
    deliveryFeeMode: customer.deliveryFeeMode ?? 'standard',
    usualProductIds: customer.usualProductIds ?? [],
    active: customer.active,
  } : {
    companyName: '', contactName: '', email: '', username: '', phone: '', vatNumber: '', fiscalCode: '', pec: '', sdiCode: '', billingAddress: { ...blankAddress }, deliveryAddress: { ...blankAddress }, paymentMethod: 'end_of_month', deliveryFeeMode: 'standard', usualProductIds: [], active: true,
  })
  const existingCredential = customer ? db.demoCredentials.find((item) => item.customerId === customer.id)?.password : undefined
  const [demoPassword, setDemoPassword] = useState(existingCredential ?? '')
  const [sameAddress, setSameAddress] = useState(!customer || JSON.stringify(customer.billingAddress) === JSON.stringify(customer.deliveryAddress))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const change = (key: keyof typeof form, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }))
  const changeAddress = (kind: 'billingAddress' | 'deliveryAddress', key: keyof typeof blankAddress, value: string) => setForm((current) => ({ ...current, [kind]: { ...current[kind], [key]: value } }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    const draft = {
      ...form,
      username: isSupabaseMode ? form.email : form.username,
      deliveryAddress: sameAddress ? form.billingAddress : form.deliveryAddress,
    }
    try {
      const customerId = await saveCustomer(draft, customer?.id)
      if (!isSupabaseMode) setDemoCustomerPassword(customerId, demoPassword)
      onSaved(customer
        ? `${customer.companyName} è stato aggiornato.`
        : isSupabaseMode
          ? 'Cliente creato e invito di accesso inviato.'
          : 'Nuova anagrafica demo e credenziale fittizia create.')
    } catch (reason) {
      setError(operationError(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={customer ? 'Modifica cliente' : 'Nuovo cliente'} description={isSupabaseMode ? 'Inserisci nome ed email del referente: l’email sarà l’utente per accedere al gestionale.' : 'Dati e credenziali sono esclusivamente fittizi nella demo.'} onClose={onClose} size="lg">
      <form className="entity-form" onSubmit={(event) => void submit(event)}>
        <fieldset><legend><Building2 size={17} /> Azienda</legend><div className="form-grid">
          <Field label="Ragione sociale" className="field--span-2"><input required value={form.companyName} onChange={(event) => change('companyName', event.target.value)} /></Field>
          <Field label="Partita IVA"><input required value={form.vatNumber} onChange={(event) => change('vatNumber', event.target.value)} /></Field>
          <Field label="Codice fiscale"><input value={form.fiscalCode} onChange={(event) => change('fiscalCode', event.target.value)} /></Field>
          <Field label="Codice SDI"><input value={form.sdiCode} onChange={(event) => change('sdiCode', event.target.value)} /></Field>
          <Field label="PEC"><input type="email" value={form.pec} onChange={(event) => change('pec', event.target.value)} /></Field>
        </div></fieldset>
        <fieldset className="customer-access-section"><legend><Mail size={17} /> Utente e accesso al gestionale</legend><div className="form-grid">
          {isSupabaseMode && <div className="access-user-note field--span-2"><UserRoundPlus size={20} /><span><strong>Crea l’utente del cliente</strong>Il nome identifica la persona; l’email sarà usata per entrare e ricevere l’invito a impostare la password.</span></div>}
          <Field label="Nome e cognome utente"><input required value={form.contactName} onChange={(event) => change('contactName', event.target.value)} /></Field>
          <Field label="Telefono"><input value={form.phone} onChange={(event) => change('phone', event.target.value)} /></Field>
          <Field label="Email di accesso" hint={isSupabaseMode ? 'Questa email diventa il nome utente del portale.' : undefined}><input type="email" required value={form.email} onChange={(event) => change('email', event.target.value)} /></Field>
          {!isSupabaseMode && <Field label="Nome utente"><input required value={form.username} onChange={(event) => change('username', event.target.value)} /></Field>}
          {!isSupabaseMode && <Field label="Password demo" hint="Solo locale; mai salvata in tabelle Supabase."><div className="input-with-icon"><KeyRound size={17} /><input type="text" minLength={8} required value={demoPassword} onChange={(event) => setDemoPassword(event.target.value)} /></div></Field>}
          {isSupabaseMode && <div className="secure-auth-note"><ShieldCheck size={19} /><span><strong>Password tramite invito</strong>Dopo il salvataggio, l’utente riceve il link per impostarla in sicurezza.</span></div>}
          <label className="toggle-field"><input type="checkbox" disabled={isSupabaseMode && !customer} checked={form.active} onChange={(event) => change('active', event.target.checked)} /><span /><div><strong>Accesso attivo</strong><small>{isSupabaseMode && !customer ? 'Il nuovo account viene invitato attivo; potrai disattivarlo in seguito.' : 'Il cliente può entrare nel portale.'}</small></div></label>
        </div></fieldset>
        <fieldset><legend><MapPin size={17} /> Indirizzo di fatturazione</legend><AddressFields value={form.billingAddress} onChange={(key, value) => changeAddress('billingAddress', key, value)} /></fieldset>
        <fieldset><legend><Truck size={17} /> Indirizzo di consegna</legend>
          <Field label="Trasporto default"><select value={form.deliveryFeeMode ?? 'standard'} onChange={(event) => change('deliveryFeeMode', event.target.value)}><option value="standard">Applica 3,50 + IVA per DDT</option><option value="free">Non applicare trasporto</option></select></Field>
          <label className="check-field"><input type="checkbox" checked={sameAddress} onChange={(event) => setSameAddress(event.target.checked)} /> Uguale all’indirizzo di fatturazione</label>
          {!sameAddress && <AddressFields value={form.deliveryAddress} onChange={(key, value) => changeAddress('deliveryAddress', key, value)} />}
        </fieldset>
        {error && <div className="form-alert form-alert--error" role="alert">{error}</div>}
        <footer className="entity-form__footer"><Button type="button" variant="ghost" disabled={saving} onClick={onClose}>Annulla</Button><Button type="submit" disabled={saving} icon={<Check size={17} />}>{saving ? 'Salvataggio…' : 'Salva cliente'}</Button></footer>
      </form>
    </Modal>
  )
}

const AddressFields = ({ value, onChange }: { value: Customer['billingAddress']; onChange: (key: keyof Customer['billingAddress'], value: string) => void }) => (
  <div className="form-grid form-grid--address">
    <Field label="Via e numero" className="field--span-2"><input required value={value.street} onChange={(event) => onChange('street', event.target.value)} /></Field>
    <Field label="CAP"><input required value={value.postalCode} onChange={(event) => onChange('postalCode', event.target.value)} /></Field>
    <Field label="Città"><input required value={value.city} onChange={(event) => onChange('city', event.target.value)} /></Field>
    <Field label="Provincia"><input required maxLength={2} value={value.province} onChange={(event) => onChange('province', event.target.value.toUpperCase())} /></Field>
    <Field label="Paese"><input required value={value.country} onChange={(event) => onChange('country', event.target.value)} /></Field>
  </div>
)

const AdminProducts = () => {
  const { db, saveProduct, deleteProduct, importProducts } = useApp()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Product | 'new' | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busyProductId, setBusyProductId] = useState<string | null>(null)
  const [importingCsv, setImportingCsv] = useState(false)
  const csvInputRef = useRef<HTMLInputElement>(null)
  const products = db.products.filter((product) =>
    !isDeliveryService(product) && product.name.toLowerCase().includes(query.toLowerCase()),
  )

  const importCatalog = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setImportingCsv(true)
    setNotice('')
    setError('')
    try {
      const parsedProducts = parseCatalogCsv(await file.text())
      if (!parsedProducts.length) throw new Error('Il CSV non contiene prodotti da importare.')
      const confirmed = window.confirm(
        `Importare ${parsedProducts.length} ${parsedProducts.length === 1 ? 'prodotto' : 'prodotti'} dal file “${file.name}”?\n\nIl file sostituirà il catalogo attivo: tutti i prodotti assenti verranno disattivati.`,
      )
      if (!confirmed) return
      const importedCount = await importProducts(parsedProducts)
      setNotice(`${importedCount} ${importedCount === 1 ? 'prodotto importato' : 'prodotti importati'} correttamente.`)
    } catch (reason) {
      setError(operationError(reason))
    } finally {
      setImportingCsv(false)
    }
  }

  const toggleProduct = async (product: Product, active: boolean) => {
    setBusyProductId(product.id)
    setError('')
    try {
      await saveProduct({ ...product, active })
      setNotice(`${product.name} ${active ? 'attivato' : 'nascosto'}.`)
    } catch (reason) {
      setError(operationError(reason))
    } finally {
      setBusyProductId(null)
    }
  }

  const removeProduct = async (product: Product) => {
    if (!window.confirm(`${isSupabaseMode ? 'Disattivare' : 'Eliminare'} ${product.name}?`)) return
    setBusyProductId(product.id)
    setError('')
    try {
      await deleteProduct(product.id)
      setNotice(`${product.name} ${isSupabaseMode ? 'disattivato' : 'eliminato dalla demo'}.`)
    } catch (reason) {
      setError(operationError(reason))
    } finally {
      setBusyProductId(null)
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Catalogo"
        title="Prodotti e prezzi"
        description="Gestisci formati, modalità di prezzo, peso confezione e aliquota di ciascun prodotto."
        action={<div className="page-header-actions">
          <input ref={csvInputRef} className="sr-only" type="file" accept=".csv,text/csv" onChange={(event) => void importCatalog(event)} />
          <Button variant="secondary" disabled={importingCsv} icon={<Upload size={18} />} onClick={() => csvInputRef.current?.click()}>{importingCsv ? 'Importazione…' : 'Importa CSV'}</Button>
          <Button icon={<Plus size={18} />} onClick={() => setEditing('new')}>Nuovo prodotto</Button>
        </div>}
      />
      <div className="catalog-import-note" role="note"><ShieldCheck size={17} /><span><strong>Importazione privata.</strong> Il file viene letto localmente e non viene pubblicato su GitHub; solo i prodotti confermati vengono salvati.</span></div>
      <DemoNotice>Tutti i valori economici mostrati sono <strong>fittizi</strong>. In produzione i listini sono protetti e vengono caricati solo dopo l’accesso.</DemoNotice>
      {notice && <div className="success-banner" role="status"><CheckCircle2 size={20} /><div><strong>Catalogo aggiornato</strong><span>{notice}</span></div><button onClick={() => setNotice('')} aria-label="Chiudi"><X size={17} /></button></div>}
      {error && <div className="form-alert form-alert--error" role="alert">{error}</div>}
      <Card className="table-card">
        <div className="table-card__toolbar table-card__toolbar--search"><div className="search-input"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cerca prodotto…" aria-label="Cerca prodotto" /></div><span className="result-count">{products.length} prodotti</span></div>
        <div className="product-admin-grid">
          {products.map((rawProduct) => {
            const product = pricedProduct(rawProduct)
            const perKg = isPricedPerKg(product)
            return (
            <article className="product-admin-card" key={product.id}>
              <div className="product-admin-card__visual"><span>{product.name.slice(0, 1)}</span><i className={product.active ? 'is-active' : ''}>{product.active ? 'Attivo' : 'Nascosto'}</i></div>
              <div className="product-admin-card__body">
                <span>{product.category}</span><h2>{product.name}</h2><p>{product.packageLabel}</p>
                <div className="product-admin-card__pricing">
                  <strong>{euro.format(product.price)}{perKg ? '/kg' : '/unità'}</strong>
                  <small>{perKg ? `${euro.format(productPackageNet(product))}/conf. · ` : ''}+ IVA {product.vatRate}%{isSupabaseMode ? '' : ' · demo'}</small>
                </div>
              </div>
              <footer>
                <label className="mini-toggle"><input type="checkbox" disabled={busyProductId === product.id} checked={product.active} onChange={(event) => void toggleProduct(product, event.target.checked)} aria-label={`${product.active ? 'Nascondi' : 'Attiva'} ${product.name}`} /><span /></label>
                <button disabled={busyProductId === product.id} onClick={() => setEditing(product)} aria-label={`Modifica ${product.name}`}><Edit3 size={17} /></button>
                <button disabled={busyProductId === product.id} onClick={() => void removeProduct(product)} aria-label={`${isSupabaseMode ? 'Disattiva' : 'Elimina'} ${product.name}`}><Trash2 size={17} /></button>
              </footer>
            </article>
            )
          })}
        </div>
      </Card>
      {editing && <ProductModal product={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={(message) => { setNotice(message); setEditing(null) }} />}
    </div>
  )
}

const ProductModal = ({ product, onClose, onSaved }: { product?: Product; onClose: () => void; onSaved: (message: string) => void }) => {
  const { saveProduct, addProduct } = useApp()
  const [form, setForm] = useState<ProductDraft>({
    sku: product?.sku ?? '',
    name: product?.name ?? '',
    category: product?.category ?? 'Pasta',
    packageLabel: product?.packageLabel ?? '',
    packageSize: product?.packageSize,
    pricingMode: product?.pricingMode ?? (product ? 'per_unit' : 'per_kg'),
    price: product?.price ?? 0,
    vatRate: product?.vatRate ?? 0,
    priceValidFrom: product?.priceValidFrom,
    promoLabel: product?.promoLabel ?? '',
    promoPercentDiscount: product?.promoPercentDiscount,
    promoted: product?.promoted ?? false,
    active: product?.active ?? true,
    description: product?.description ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const change = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [key]: value }))
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (form.pricingMode === 'per_kg' && !(typeof form.packageSize === 'number' && form.packageSize > 0)) {
      setError('Per i prodotti prezzati al kg devi indicare un peso confezione maggiore di zero.')
      return
    }
    if (form.promoted && !validPromoPercent(form.promoPercentDiscount)) {
      setError('Per attivare la promo devi indicare una percentuale maggiore di 0 e non superiore a 100.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const normalizedForm = {
        ...form,
        promoLabel: form.promoted && validPromoPercent(form.promoPercentDiscount)
          ? `Sconto ${formatPromoPercent(form.promoPercentDiscount)}%`
          : '',
      }
      if (product) await saveProduct({ ...normalizedForm, id: product.id })
      else await addProduct(normalizedForm)
      onSaved(`${form.name} è stato ${product ? 'aggiornato' : 'aggiunto'} al catalogo${isSupabaseMode ? '' : ' demo'}.`)
    } catch (reason) {
      setError(operationError(reason))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal title={product ? `Modifica ${product.name}` : 'Nuovo prodotto'} description="Configura il prezzo al kg per i prodotti pesati o il prezzo unitario per servizi e altre voci." onClose={onClose}>
      <form className="entity-form" onSubmit={(event) => void submit(event)}>
        <div className="form-grid">
          <Field label="Codice SKU" hint={product?.sku ? 'Codice stabile: non viene rigenerato.' : 'Assegna un codice univoco al prodotto.'}><input required readOnly={Boolean(product?.sku)} value={form.sku ?? ''} onChange={(event) => change('sku', event.target.value.toUpperCase())} /></Field>
          <Field label="Nome prodotto"><input required value={form.name} onChange={(event) => change('name', event.target.value)} /></Field>
          <Field label="Categoria"><select value={form.category} onChange={(event) => change('category', event.target.value as Product['category'])}><option>Pasta</option><option>Ripieno</option><option>Speciale</option><option>Servizio</option></select></Field>
          <Field label="Modalità prezzo"><select value={form.pricingMode ?? 'per_unit'} onChange={(event) => change('pricingMode', event.target.value as PricingMode)}><option value="per_kg">Al kg (€/kg)</option><option value="per_unit">Per unità o servizio</option></select></Field>
          <Field label="Confezione"><input required value={form.packageLabel} onChange={(event) => change('packageLabel', event.target.value)} placeholder="es. Confezione da 1 kg" /></Field>
          <Field
            label={form.pricingMode === 'per_kg' ? 'Peso confezione (kg)' : 'Dimensione confezione'}
            hint={form.pricingMode === 'per_kg' ? 'Obbligatorio: serve per calcolare il prezzo della confezione.' : 'Facoltativo per le voci a prezzo unitario.'}
          ><input type="number" min={form.pricingMode === 'per_kg' ? '0.001' : '0'} step="0.001" required={form.pricingMode === 'per_kg'} value={form.packageSize ?? ''} onChange={(event) => change('packageSize', event.target.value ? Number(event.target.value) : undefined)} /></Field>
          <Field label={`${form.pricingMode === 'per_kg' ? 'Prezzo netto al kg' : 'Prezzo netto unitario'}${isSupabaseMode ? '' : ' demo'} (€)`}><input type="number" min="0" step="0.01" required value={form.price} onChange={(event) => change('price', Number(event.target.value))} /></Field>
          <Field label={isSupabaseMode ? 'Aliquota IVA (%)' : 'Aliquota IVA demo (%)'}><input type="number" min="0" max="100" step="0.1" required value={form.vatRate} onChange={(event) => change('vatRate', Number(event.target.value))} /></Field>
          {form.pricingMode === 'per_kg' && typeof form.packageSize === 'number' && form.packageSize > 0 && (
            <div className="price-preview field--span-2"><CircleDollarSign size={19} /><span><small>Prezzo netto per confezione</small><strong>{euro.format(productPackageNet(form))}</strong></span></div>
          )}
          {isSupabaseMode && product?.priceValidFrom && <div className="secure-auth-note"><CircleDollarSign size={19} /><span><strong>Prezzo corrente dal {formatDate(product.priceValidFrom)}</strong>Un cambio prezzo crea automaticamente una nuova validità da oggi e conserva lo storico.</span></div>}
          <Field label="Descrizione" className="field--span-2"><textarea rows={3} value={form.description} onChange={(event) => change('description', event.target.value)} /></Field>
          <Field label="Percentuale sconto promo" hint="Il prezzo scontato e la scritta promo vengono calcolati automaticamente." className="field--span-2"><input type="number" min="0.1" max="100" step="0.1" required={Boolean(form.promoted)} value={form.promoPercentDiscount ?? ''} onChange={(event) => change('promoPercentDiscount', event.target.value ? Number(event.target.value) : undefined)} /></Field>
          <label className="toggle-field field--span-2"><input type="checkbox" checked={Boolean(form.promoted)} onChange={(event) => change('promoted', event.target.checked)} /><span /><div><strong>Metti in cima al catalogo</strong><small>Il cliente lo vedra prima dei prodotti abituali.</small></div></label>
          <label className="toggle-field field--span-2"><input type="checkbox" checked={form.active} onChange={(event) => change('active', event.target.checked)} /><span /><div><strong>Prodotto attivo</strong><small>Visibile nel catalogo clienti.</small></div></label>
        </div>
        {error && <div className="form-alert form-alert--error" role="alert">{error}</div>}
        <footer className="entity-form__footer"><Button type="button" variant="ghost" disabled={saving} onClick={onClose}>Annulla</Button><Button type="submit" disabled={saving} icon={<Check size={17} />}>{saving ? 'Salvataggio…' : 'Salva prodotto'}</Button></footer>
      </form>
    </Modal>
  )
}

const AdminCompany = () => {
  const { db, saveSupplier } = useApp()
  const [form, setForm] = useState<SupplierSettings>(db.supplier)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const change = (key: keyof SupplierSettings, value: string) => setForm((current) => ({ ...current, [key]: value }))
  const changeAddress = (key: keyof SupplierSettings['address'], value: string) => setForm((current) => ({ ...current, address: { ...current.address, [key]: value } }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await saveSupplier(form)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 3000)
    } catch (reason) {
      setError(operationError(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="Configurazione" title="Dati aziendali Igea" description="Queste informazioni vengono riportate nei documenti di trasporto." />
      <DemoNotice>L’anagrafica inclusa nel codice è interamente <strong>fittizia</strong>. In produzione i dati reali saranno letti da <code>supplier_settings</code> dopo l’autenticazione.</DemoNotice>
      {saved && <div className="success-banner" role="status"><CheckCircle2 size={20} /><div><strong>Modifiche salvate</strong><span>{isSupabaseMode ? 'I dati aziendali sono stati aggiornati.' : 'I dati demo sono stati aggiornati nel browser.'}</span></div></div>}
      {error && <div className="form-alert form-alert--error" role="alert">{error}</div>}
      <form className="company-form" onSubmit={(event) => void submit(event)}>
        <Card>
          <div className="settings-heading"><span><Building2 /></span><div><h2>Identità aziendale</h2><p>Ragione sociale e riferimenti fiscali.</p></div></div>
          <div className="form-grid">
            <Field label="Ragione sociale" className="field--span-2"><input required value={form.businessName} onChange={(event) => change('businessName', event.target.value)} /></Field>
            <Field label="Titolare / referente"><input value={form.ownerName} onChange={(event) => change('ownerName', event.target.value)} /></Field>
            <Field label="Partita IVA"><input required value={form.vatNumber} onChange={(event) => change('vatNumber', event.target.value)} /></Field>
            <Field label="Codice fiscale"><input value={form.fiscalCode} onChange={(event) => change('fiscalCode', event.target.value)} /></Field>
            <Field label="Codice SDI"><input value={form.sdiCode} onChange={(event) => change('sdiCode', event.target.value)} /></Field>
            <Field label="PEC" className="field--span-2"><input type="email" value={form.pec} onChange={(event) => change('pec', event.target.value)} /></Field>
          </div>
        </Card>
        <Card>
          <div className="settings-heading"><span><MapPin /></span><div><h2>Sede e contatti</h2><p>Dati mostrati su ordini e DDT.</p></div></div>
          <AddressFields value={form.address} onChange={changeAddress} />
          <div className="form-grid company-form__contacts">
            <Field label="Email"><div className="input-with-icon"><Mail size={17} /><input type="email" required value={form.email} onChange={(event) => change('email', event.target.value)} /></div></Field>
            <Field label="Telefono"><div className="input-with-icon"><Phone size={17} /><input value={form.phone} onChange={(event) => change('phone', event.target.value)} /></div></Field>
          </div>
        </Card>
        <Card>
          <div className="settings-heading"><span><CircleDollarSign /></span><div><h2>Coordinate di pagamento</h2><p>Informazioni facoltative per i documenti commerciali.</p></div></div>
          <div className="form-grid"><Field label="Banca"><input value={form.bankName} onChange={(event) => change('bankName', event.target.value)} /></Field><Field label="IBAN"><input value={form.iban} onChange={(event) => change('iban', event.target.value)} /></Field></div>
        </Card>
        <div className="company-form__save"><Button type="submit" size="lg" disabled={saving} icon={<Check size={18} />}>{saving ? 'Salvataggio…' : 'Salva configurazione'}</Button></div>
      </form>
    </div>
  )
}
