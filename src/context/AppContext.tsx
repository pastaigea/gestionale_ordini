import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsWithChildren } from 'react'
import type { User } from '@supabase/supabase-js'
import { createDemoDatabase, DEMO_ADMIN } from '../data/demo'
import { calculateOrderTotals, localIsoDate } from '../lib/format'
import { effectiveOrderItems, effectiveQuantity } from '../lib/fulfillment'
import {
  DEFAULT_DELIVERY_FEE_NET,
  DEFAULT_DELIVERY_FEE_VAT_RATE,
  isDeliveryService,
  resolveDeliveryFeeNet,
  validPromoPercent,
} from '../lib/commerce'
import {
  hasPasswordSetupToken,
  isSupabaseConfigured,
  isSupabaseMode,
  supabase,
} from '../lib/supabase'
import {
  BASE_PRICE_LIST_ID,
  customerPayload,
  emptyDatabase,
  loadSupabaseDatabase,
  loadCustomerCatalog,
  productPayload,
  supplierPayload,
} from '../lib/supabaseData'
import type {
  Customer,
  Database,
  DeliveryDocument,
  DiscountCode,
  Order,
  OrderItem,
  OrderStatus,
  PaymentMethod,
  Product,
  SessionUser,
  SupplierSettings,
} from '../types'

const DB_KEY = 'igea_demo_database_v6'
const SESSION_KEY = 'igea_demo_session_v3'

const uid = (prefix: string) =>
  `${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)}`

const sanitizeDemoDatabase = (database: Database): Database => ({
  ...database,
  products: database.products
    .filter((product) => !isDeliveryService(product))
    .map((product) => product.promoted && !validPromoPercent(product.promoPercentDiscount)
      ? { ...product, promoted: false, promoLabel: '' }
      : product),
  orders: database.orders.map((order) => {
    const customer = database.customers.find((item) => item.id === order.customerId)
    const discount = order.discountCode
      ? database.discounts.find((item) => item.code === order.discountCode)
      : undefined
    const baseFee = customer?.deliveryFeeMode === 'free' ? 0 : DEFAULT_DELIVERY_FEE_NET
    return {
      ...order,
      items: order.items.filter((item) => !isDeliveryService(item)),
      deliveryFeeNet: order.deliveryFeeNet ?? resolveDeliveryFeeNet(baseFee, discount),
      deliveryFeeVatRate: order.deliveryFeeVatRate ?? DEFAULT_DELIVERY_FEE_VAT_RATE,
    }
  }),
})

const readDemoDatabase = (): Database => {
  try {
    const saved = localStorage.getItem(DB_KEY)
    return sanitizeDemoDatabase(saved ? JSON.parse(saved) as Database : createDemoDatabase())
  } catch {
    return sanitizeDemoDatabase(createDemoDatabase())
  }
}

const readDemoSession = (): SessionUser | null => {
  try {
    const saved = sessionStorage.getItem(SESSION_KEY)
    if (!saved) return null
    const parsed = JSON.parse(saved) as SessionUser
    return parsed.source === 'demo' && ['admin', 'client'].includes(parsed.role) ? parsed : null
  } catch {
    return null
  }
}

type CustomerDraft = Omit<Customer, 'id' | 'createdAt' | 'authUserId'>
type OrderDraft = Pick<Order, 'requestedDeliveryDate' | 'notes'> & {
  items: OrderItem[]
  paymentMethod: PaymentMethod
  discountCode?: string
  idempotencyKey?: string
}

interface AppContextValue {
  db: Database
  session: SessionUser | null
  authLoading: boolean
  dataRefreshing: boolean
  dataError: string | null
  passwordSetup: boolean
  isSupabaseConfigured: boolean
  login: (identifier: string, password: string) => Promise<SessionUser>
  logout: () => Promise<void>
  refreshData: () => Promise<void>
  updateOwnPassword: (password: string) => Promise<void>
  resetDemo: () => void
  createOrder: (customerId: string, draft: OrderDraft) => Promise<Order>
  updateOrder: (orderId: string, draft: OrderDraft) => Promise<void>
  getCustomerCatalog: (customerId: string) => Promise<Product[]>
  adjustOrderFulfillment: (orderId: string, draft: {
    items: Array<{ productId: string; fulfilledQuantity: number }>
    reason: string
  }) => Promise<void>
  setOrderStatus: (orderId: string, status: OrderStatus) => Promise<void>
  confirmOrderPayment: (orderId: string) => Promise<void>
  issueDdt: (orderId: string) => Promise<DeliveryDocument>
  updateDeliveryFee: (documentId: string, feeNet: number) => Promise<void>
  saveCustomer: (customer: CustomerDraft, id?: string) => Promise<string>
  importCustomers: (customers: Array<Omit<CustomerDraft, 'paymentMethod'> & { id: string }>) => Promise<number>
  deleteCustomer: (id: string) => Promise<void>
  sendCustomerPasswordReset: (customerId: string) => Promise<void>
  setDemoCustomerPassword: (customerId: string, password: string) => void
  saveProduct: (product: Product) => Promise<void>
  addProduct: (product: Omit<Product, 'id'>) => Promise<void>
  importProducts: (products: Omit<Product, 'id'>[]) => Promise<number>
  deleteProduct: (id: string) => Promise<void>
  saveDiscount: (discount: DiscountCode) => Promise<void>
  deleteDiscount: (id: string) => Promise<void>
  saveSupplier: (supplier: SupplierSettings) => Promise<void>
}

const AppContext = createContext<AppContextValue | null>(null)

const requireConfiguredClient = () => {
  if (!isSupabaseMode || !supabase) throw new Error('Backend Supabase non configurato.')
  return supabase
}

const resolveSessionUser = async (user: User): Promise<SessionUser> => {
  const client = requireConfiguredClient()
  const { data: profile, error: profileError } = await client
    .from('profiles')
    .select('user_id,display_name,role,active')
    .eq('user_id', user.id)
    .maybeSingle()

  if (profileError || !profile || !profile.active || !['admin', 'client'].includes(profile.role)) {
    throw new Error('Account non attivo o profilo non configurato. Contatta Igea.')
  }

  let customerId: string | undefined
  if (profile.role === 'client') {
    const { data: relation, error: relationError } = await client
      .from('customer_users')
      .select('customer_id')
      .eq('user_id', user.id)
      .maybeSingle()
    if (relationError || !relation?.customer_id) {
      throw new Error('Account non collegato a un cliente. Contatta Igea.')
    }
    customerId = String(relation.customer_id)
  }

  return {
    id: user.id,
    role: profile.role,
    customerId,
    email: user.email ?? '',
    name: String(profile.display_name || user.email || 'Utente'),
    source: 'supabase',
  }
}

const tomorrowIso = () => {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  return date.toISOString().slice(0, 10)
}

export const AppProvider = ({ children }: PropsWithChildren) => {
  const [db, setDb] = useState<Database>(() => isSupabaseMode ? emptyDatabase() : readDemoDatabase())
  const [session, setSession] = useState<SessionUser | null>(() => isSupabaseMode ? null : readDemoSession())
  const [authLoading, setAuthLoading] = useState(isSupabaseMode)
  const [dataRefreshing, setDataRefreshing] = useState(false)
  const [dataError, setDataError] = useState<string | null>(null)
  const [passwordSetup, setPasswordSetup] = useState(hasPasswordSetupToken)
  const hydrationSequence = useRef(0)

  const hydrateUser = useCallback(async (user: User | null, showLoader = true) => {
    const sequence = ++hydrationSequence.current
    if (showLoader) setAuthLoading(true)
    if (!user) {
      setSession(null)
      setDb(emptyDatabase())
      setDataError(null)
      setAuthLoading(false)
      return null
    }

    try {
      const nextSession = await resolveSessionUser(user)
      const nextDb = await loadSupabaseDatabase(requireConfiguredClient(), nextSession)
      if (sequence !== hydrationSequence.current) return nextSession
      setSession(nextSession)
      setDb(nextDb)
      setDataError(null)
      setAuthLoading(false)
      return nextSession
    } catch (error) {
      if (sequence !== hydrationSequence.current) return null
      setSession(null)
      setDb(emptyDatabase())
      setDataError(error instanceof Error ? error.message : 'Caricamento account non riuscito.')
      setAuthLoading(false)
      throw error
    }
  }, [])

  useEffect(() => {
    if (isSupabaseMode) return
    localStorage.setItem(DB_KEY, JSON.stringify(db))
  }, [db])

  useEffect(() => {
    if (isSupabaseMode) {
      sessionStorage.removeItem(SESSION_KEY)
      return
    }
    if (session?.source === 'demo') sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))
    else sessionStorage.removeItem(SESSION_KEY)
  }, [session])

  useEffect(() => {
    if (!isSupabaseMode) {
      setAuthLoading(false)
      return
    }
    const client = supabase
    if (!client) {
      setDataError('Configurazione Supabase mancante.')
      setAuthLoading(false)
      return
    }

    let active = true
    void client.auth.getSession().then(({ data, error }) => {
      if (!active) return
      if (error) {
        setDataError('Sessione non valida. Effettua nuovamente l’accesso.')
        setAuthLoading(false)
        return
      }
      void hydrateUser(data.session?.user ?? null).catch(() => undefined)
    })

    const { data: listener } = client.auth.onAuthStateChange((event, nextAuthSession) => {
      if (event === 'PASSWORD_RECOVERY') setPasswordSetup(true)
      if (event === 'SIGNED_OUT') {
        setPasswordSetup(false)
        void hydrateUser(null, false)
        return
      }
      if ((event === 'SIGNED_IN' || event === 'PASSWORD_RECOVERY' || event === 'USER_UPDATED') && nextAuthSession?.user) {
        window.setTimeout(() => {
          if (active) void hydrateUser(nextAuthSession.user, false).catch(() => undefined)
        }, 0)
      }
    })

    return () => {
      active = false
      listener.subscription.unsubscribe()
    }
  }, [hydrateUser])

  const reloadDatabase = useCallback(async (): Promise<Database> => {
    if (!session || session.source !== 'supabase') return db
    setDataRefreshing(true)
    try {
      const nextDb = await loadSupabaseDatabase(requireConfiguredClient(), session)
      setDb(nextDb)
      setDataError(null)
      return nextDb
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Aggiornamento dati non riuscito.'
      setDataError(message)
      throw error
    } finally {
      setDataRefreshing(false)
    }
  }, [db, session])

  const refreshData = useCallback(async () => {
    await reloadDatabase()
  }, [reloadDatabase])

  useEffect(() => {
    if (!isSupabaseMode || !session) return

    const isCustomerEditingOrder = () => {
      const route = `${window.location.pathname}${window.location.hash}`
      return route.includes('/cliente/nuovo')
    }

    const refreshWhenVisible = () => {
      if (document.visibilityState !== 'visible' || isCustomerEditingOrder()) return
      void reloadDatabase().catch(() => undefined)
    }

    const interval = window.setInterval(refreshWhenVisible, 30_000)
    window.addEventListener('focus', refreshWhenVisible)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshWhenVisible)
    }
  }, [reloadDatabase, session])

  const login = useCallback(async (identifier: string, password: string): Promise<SessionUser> => {
    const normalized = identifier.trim().toLowerCase()
    if (!isSupabaseMode) {
      if (normalized === DEMO_ADMIN.email && password === DEMO_ADMIN.password) {
        const nextSession: SessionUser = {
          id: 'admin-demo',
          role: 'admin',
          name: 'Amministratore Igea (demo)',
          email: DEMO_ADMIN.email,
          source: 'demo',
        }
        setSession(nextSession)
        return nextSession
      }
      const customer = db.customers.find((item) =>
        item.active
        && (item.email.toLowerCase() === normalized || item.username.toLowerCase() === normalized)
        && db.demoCredentials.some((credential) =>
          credential.customerId === item.id && credential.password === password),
      )
      if (!customer) throw new Error('Credenziali non valide. Usa uno degli account demo indicati.')
      const nextSession: SessionUser = {
        id: `user-${customer.id}`,
        role: 'client',
        customerId: customer.id,
        name: customer.contactName,
        email: customer.email,
        source: 'demo',
      }
      setSession(nextSession)
      return nextSession
    }

    const client = requireConfiguredClient()
    const { data, error } = await client.auth.signInWithPassword({ email: normalized, password })
    if (error || !data.user) throw new Error('Credenziali non valide o account non abilitato.')
    try {
      const nextSession = await hydrateUser(data.user)
      if (!nextSession) throw new Error('Profilo non disponibile.')
      return nextSession
    } catch (error) {
      await client.auth.signOut()
      throw error
    }
  }, [db.customers, db.demoCredentials, hydrateUser])

  const logout = useCallback(async () => {
    if (isSupabaseMode && supabase) await supabase.auth.signOut()
    setPasswordSetup(false)
    setSession(null)
    if (isSupabaseMode) setDb(emptyDatabase())
  }, [])

  const updateOwnPassword = useCallback(async (password: string) => {
    if (password.length < 12) throw new Error('La password deve contenere almeno 12 caratteri.')
    const client = requireConfiguredClient()
    const { error } = await client.auth.updateUser({ password })
    if (error) throw new Error(error.message)
    setPasswordSetup(false)
  }, [])

  const resetDemo = useCallback(() => {
    if (isSupabaseMode) return
    setDb(createDemoDatabase())
  }, [])

  const createOrder = useCallback(async (customerId: string, draft: OrderDraft): Promise<Order> => {
    if (!session) throw new Error('Sessione non disponibile.')
    if (session.role === 'client' && session.customerId !== customerId) {
      throw new Error('Non puoi inserire ordini per un altro cliente.')
    }
    if (draft.items.some((item) => isDeliveryService(item))) {
      throw new Error('Il trasporto viene aggiunto automaticamente e non può essere inserito come prodotto.')
    }
    if (isSupabaseMode) {
      if (draft.discountCode) throw new Error('I codici sconto in produzione richiedono le tabelle promo Supabase.')
      const client = requireConfiguredClient()
      const { data, error } = await client.rpc('place_order', {
        p_order_id: null,
        p_requested_delivery_date: draft.requestedDeliveryDate,
        p_notes: draft.notes,
        p_items: draft.items.map((item) => ({ product_id: item.productId, quantity: item.quantity })),
        p_payment_method: draft.paymentMethod,
        p_expected_version: null,
        p_customer_id: session?.role === 'admin' ? customerId : null,
        p_idempotency_key: draft.idempotencyKey ?? null,
      })
      if (error || !data) throw new Error(error?.message ?? 'Creazione ordine non riuscita.')
      const nextDb = await reloadDatabase()
      const created = nextDb.orders.find((order) => order.id === String(data.id))
      if (!created) throw new Error('Ordine creato, ma il riepilogo non è ancora disponibile.')
      return created
    }

    const customer = db.customers.find((item) => item.id === customerId)
    if (!customer) throw new Error('Cliente non trovato.')
    const discount = draft.discountCode
      ? db.discounts.find((item) =>
          item.active && item.code === draft.discountCode &&
          (!item.validUntil || item.validUntil >= localIsoDate()),
        )
      : undefined
    const deliveryFeeNet = resolveDeliveryFeeNet(
      customer.deliveryFeeMode === 'free' ? 0 : DEFAULT_DELIVERY_FEE_NET,
      discount,
    )
    const counter = db.counters.order + 1
    const year = new Date().getFullYear()
    const created: Order = {
      id: uid('order'),
      number: `ORD-${year}-${counter.toString().padStart(4, '0')}`,
      customerId,
      requestedDeliveryDate: draft.requestedDeliveryDate,
      notes: draft.notes,
      items: draft.items,
      status: 'submitted',
      paymentMethod: draft.paymentMethod,
      discountCode: draft.discountCode,
      deliveryFeeNet,
      deliveryFeeVatRate: DEFAULT_DELIVERY_FEE_VAT_RATE,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      customerSnapshot: structuredClone(customer),
      supplierSnapshot: structuredClone(db.supplier),
    }
    setDb((current) => ({
      ...current,
      orders: [created, ...current.orders],
      counters: { ...current.counters, order: Math.max(counter, current.counters.order + 1) },
    }))
    return created
  }, [db.counters.order, db.customers, db.supplier, reloadDatabase, session])

  const updateOrder = useCallback(async (orderId: string, draft: OrderDraft) => {
    if (draft.items.some((item) => isDeliveryService(item))) {
      throw new Error('Il trasporto viene aggiunto automaticamente e non può essere inserito come prodotto.')
    }
    if (isSupabaseMode) {
      if (draft.discountCode) throw new Error('I codici sconto in produzione richiedono le tabelle promo Supabase.')
      const existing = db.orders.find((order) => order.id === orderId)
      if (!existing?.version) throw new Error('Versione ordine non disponibile. Aggiorna la pagina.')
      const client = requireConfiguredClient()
      const { error } = await client.rpc('place_order', {
        p_order_id: orderId,
        p_requested_delivery_date: draft.requestedDeliveryDate,
        p_notes: draft.notes,
        p_items: draft.items.map((item) => ({ product_id: item.productId, quantity: item.quantity })),
        p_payment_method: draft.paymentMethod,
        p_expected_version: existing.version,
        p_customer_id: null,
        p_idempotency_key: null,
      })
      if (error) throw new Error(error.message)
      await reloadDatabase()
      return
    }
    setDb((current) => ({
      ...current,
      orders: current.orders.map((order) => {
        if (order.id !== orderId || order.status !== 'submitted') return order
        const customer = current.customers.find((item) => item.id === order.customerId)
        const discount = draft.discountCode
          ? current.discounts.find((item) =>
              item.active && item.code === draft.discountCode &&
              (!item.validUntil || item.validUntil >= localIsoDate()),
            )
          : undefined
        const deliveryFeeNet = resolveDeliveryFeeNet(
          customer?.deliveryFeeMode === 'free' ? 0 : DEFAULT_DELIVERY_FEE_NET,
          discount,
        )
        return {
          ...order,
          ...draft,
          deliveryFeeNet,
          deliveryFeeVatRate: DEFAULT_DELIVERY_FEE_VAT_RATE,
          updatedAt: new Date().toISOString(),
          version: (order.version ?? 0) + 1,
        }
      }),
    }))
  }, [db.orders, reloadDatabase])

  const getCustomerCatalog = useCallback(async (customerId: string): Promise<Product[]> => {
    if (session?.role !== 'admin') throw new Error('Solo l\'amministratore può caricare il listino di un altro cliente.')
    const customer = db.customers.find((item) => item.id === customerId && item.active)
    if (!customer) throw new Error('Cliente attivo non trovato.')
    if (!isSupabaseMode) return db.products.filter((product) => product.active && !isDeliveryService(product))
    return (await loadCustomerCatalog(requireConfiguredClient(), customerId))
      .filter((product) => !isDeliveryService(product))
  }, [db.customers, db.products, session?.role])

  const adjustOrderFulfillment = useCallback(async (
    orderId: string,
    draft: { items: Array<{ productId: string; fulfilledQuantity: number }>; reason: string },
  ) => {
    if (session?.role !== 'admin') throw new Error('Solo l\'amministratore può modificare le quantità consegnate.')
    const order = db.orders.find((item) => item.id === orderId)
    if (!order) throw new Error('Ordine non trovato.')
    if (!['submitted', 'accepted', 'in_delivery', 'delivered'].includes(order.status)) {
      throw new Error('Le quantità non possono essere modificate nello stato corrente.')
    }
    if (order.paymentConfirmedAt) {
      throw new Error('Il pagamento alla consegna è già stato confermato: prima serve una procedura separata di rimborso o integrazione.')
    }
    if (draft.reason.trim().length < 3) throw new Error('Il motivo della modifica è obbligatorio.')

    const quantities = new Map<string, number>()
    for (const item of draft.items) {
      if (quantities.has(item.productId)) throw new Error('Lo stesso prodotto è presente più volte.')
      quantities.set(item.productId, item.fulfilledQuantity)
    }
    if (quantities.size !== order.items.length || order.items.some((item) => !quantities.has(item.productId))) {
      throw new Error('Devi specificare la quantità effettiva di tutte le righe dell\'ordine.')
    }
    for (const item of order.items) {
      const quantity = quantities.get(item.productId)!
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > item.quantity) {
        throw new Error(`Quantità non valida per ${item.productName}: deve essere compresa tra 0 e ${item.quantity}.`)
      }
    }
    if (![...quantities.values()].some((quantity) => quantity > 0)) {
      throw new Error('Deve rimanere almeno una confezione da consegnare.')
    }
    if (order.items.every((item) => effectiveQuantity(item) === quantities.get(item.productId))) {
      throw new Error('Nessuna quantità è stata modificata.')
    }

    if (isSupabaseMode) {
      if (!order.version) throw new Error('Versione ordine non disponibile. Aggiorna la pagina.')
      const client = requireConfiguredClient()
      const { error } = await client.rpc('admin_adjust_order_fulfillment', {
        p_order_id: orderId,
        p_items: draft.items.map((item) => ({
          product_id: item.productId,
          fulfilled_quantity: item.fulfilledQuantity,
        })),
        p_expected_version: order.version,
        p_reason: draft.reason.trim(),
      })
      if (error) throw new Error(error.message)
      await reloadDatabase()
      return
    }

    const adjustedAt = new Date().toISOString()
    const adjustedItems = order.items.map((item) => ({
      ...item,
      fulfilledQuantity: quantities.get(item.productId)!,
    }))
    const totals = calculateOrderTotals({
      items: adjustedItems,
      deliveryFeeNet: order.deliveryFeeNet ?? DEFAULT_DELIVERY_FEE_NET,
      deliveryFeeVatRate: order.deliveryFeeVatRate ?? DEFAULT_DELIVERY_FEE_VAT_RATE,
    })
    const currentDocument = db.documents.find((item) => item.orderId === order.id && item.status !== 'void')
    let replacement: DeliveryDocument | undefined
    let nextCounters = db.counters
    if (currentDocument) {
      const year = new Date().getFullYear()
      const progressive = (db.counters.ddtByYear[year] ?? 0) + 1
      replacement = {
        ...structuredClone(currentDocument),
        id: uid('ddt'),
        number: `DDT-${year}-${progressive.toString().padStart(6, '0')}`,
        progressive,
        year,
        issueDate: localIsoDate(),
        itemsSnapshot: effectiveOrderItems(adjustedItems),
        packages: totals.packages,
        status: 'ready',
        revision: (currentDocument.revision ?? 0) + 1,
        revisionReason: draft.reason.trim(),
        replacesDocumentId: currentDocument.id,
      }
      nextCounters = {
        ...db.counters,
        ddtByYear: { ...db.counters.ddtByYear, [year]: progressive },
      }
    }
    const replacementId = replacement?.id
    setDb((current) => ({
      ...current,
      orders: current.orders.map((item) => item.id === orderId
        ? {
            ...item,
            items: adjustedItems,
            netTotal: totals.net,
            vatTotal: totals.vat,
            grossTotal: totals.gross,
            ddtId: replacementId ?? item.ddtId,
            fulfillmentAdjustedAt: adjustedAt,
            fulfillmentAdjustmentNote: draft.reason.trim(),
            updatedAt: adjustedAt,
            version: (item.version ?? 0) + 1,
          }
        : item),
      documents: replacement && currentDocument
        ? [replacement, ...current.documents.map((item) => item.id === currentDocument.id ? { ...item, status: 'void' as const } : item)]
        : current.documents,
      counters: nextCounters,
    }))
  }, [db, reloadDatabase, session?.role])

  const setOrderStatus = useCallback(async (orderId: string, status: OrderStatus) => {
    const selectedOrder = db.orders.find((item) => item.id === orderId)
    if (status === 'cancelled' && selectedOrder?.paymentConfirmedAt) {
      throw new Error('Un ordine già pagato richiede una procedura separata di rimborso e non può essere annullato.')
    }
    if (isSupabaseMode) {
      const order = selectedOrder
      if (!order?.version) throw new Error('Versione ordine non disponibile. Aggiorna la pagina.')
      if (status === 'in_delivery') {
        await issueDdtInternal(orderId, order.version, reloadDatabase)
        return
      }
      const client = requireConfiguredClient()
      const { error } = await client.rpc('admin_transition_order', {
        p_order_id: orderId,
        p_new_status: status,
        p_expected_version: order.version,
        p_note: null,
      })
      if (error) throw new Error(error.message)
      await reloadDatabase()
      return
    }
    setDb((current) => ({
      ...current,
      orders: current.orders.map((order) =>
        order.id === orderId
          ? { ...order, status, updatedAt: new Date().toISOString(), version: (order.version ?? 0) + 1 }
          : order),
    }))
  }, [db.orders, reloadDatabase])

  const confirmOrderPayment = useCallback(async (orderId: string) => {
    if (session?.role !== 'admin') throw new Error('Solo l’amministratore può confermare un pagamento.')
    const order = db.orders.find((item) => item.id === orderId)
    if (!order) throw new Error('Ordine non trovato.')
    if (order.paymentMethod !== 'on_delivery') {
      throw new Error('Questo ordine non richiede la conferma del pagamento alla consegna.')
    }
    if (!['accepted', 'in_delivery', 'delivered'].includes(order.status)) {
      throw new Error('Il pagamento può essere confermato solo dopo l’accettazione dell’ordine.')
    }
    if (order.paymentConfirmedAt) return

    if (isSupabaseMode) {
      if (!order.version) throw new Error('Versione ordine non disponibile. Aggiorna la pagina.')
      const client = requireConfiguredClient()
      const { error } = await client.rpc('admin_confirm_order_payment', {
        p_order_id: orderId,
        p_expected_version: order.version,
      })
      if (error) throw new Error(error.message)
      await reloadDatabase()
      return
    }

    const confirmedAt = new Date().toISOString()
    setDb((current) => ({
      ...current,
      orders: current.orders.map((item) => item.id === orderId && !item.paymentConfirmedAt
        ? {
            ...item,
            paymentConfirmedAt: confirmedAt,
            updatedAt: confirmedAt,
            version: (item.version ?? 0) + 1,
          }
        : item),
    }))
  }, [db.orders, reloadDatabase, session?.role])

  const issueDdt = useCallback(async (orderId: string): Promise<DeliveryDocument> => {
    if (isSupabaseMode) {
      const order = db.orders.find((item) => item.id === orderId)
      if (!order?.version) throw new Error('Versione ordine non disponibile. Aggiorna la pagina.')
      return issueDdtInternal(orderId, order.version, reloadDatabase)
    }
    const order = db.orders.find((item) => item.id === orderId)
    if (!order) throw new Error('Ordine non trovato.')
    const existing = db.documents.find((item) => item.orderId === orderId && item.status !== 'void')
    if (existing) return existing
    const year = new Date().getFullYear()
    const progressive = (db.counters.ddtByYear[year] ?? 0) + 1
    const customer = db.customers.find((item) => item.id === order.customerId)
    const discount = order.discountCode ? db.discounts.find((item) => item.active && item.code === order.discountCode) : undefined
    if (!customer) throw new Error('Cliente non trovato.')
    const created: DeliveryDocument = {
      id: uid('ddt'),
      number: `DDT-${year}-${progressive.toString().padStart(6, '0')}`,
      progressive,
      year,
      orderId,
      customerId: order.customerId,
      issueDate: localIsoDate(),
      transportStartedAt: new Date().toISOString(),
      transportReason: 'Vendita',
      carrier: 'Consegna a cura del mittente',
      packages: calculateOrderTotals(order).packages,
      deliveryFeeNet: order.deliveryFeeNet ?? resolveDeliveryFeeNet(
        customer.deliveryFeeMode === 'free' ? 0 : DEFAULT_DELIVERY_FEE_NET,
        discount,
      ),
      deliveryFeeVatRate: order.deliveryFeeVatRate ?? DEFAULT_DELIVERY_FEE_VAT_RATE,
      paymentMethod: order.paymentMethod,
      supplierSnapshot: structuredClone(db.supplier),
      customerSnapshot: structuredClone(customer),
      destinationSnapshot: structuredClone(customer.deliveryAddress),
      itemsSnapshot: effectiveOrderItems(order.items),
      status: 'ready',
    }
    setDb((current) => {
      if (current.documents.some((item) => item.orderId === orderId)) return current
      return {
        ...current,
        documents: [created, ...current.documents],
        orders: current.orders.map((item) => item.id === orderId
          ? { ...item, ddtId: created.id, status: 'in_delivery', updatedAt: new Date().toISOString(), version: (item.version ?? 0) + 1 }
          : item),
        counters: {
          ...current.counters,
          ddtByYear: { ...current.counters.ddtByYear, [year]: progressive },
        },
      }
    })
    return created
  }, [db, reloadDatabase])

  const updateDeliveryFee = useCallback(async (documentId: string, feeNet: number) => {
    if (feeNet < 0 || !Number.isFinite(feeNet)) throw new Error('Prezzo trasporto non valido.')
    if (isSupabaseMode) {
      const client = requireConfiguredClient()
      const { error } = await client.rpc('admin_update_delivery_fee', {
        p_document_id: documentId,
        p_delivery_fee_net: Math.round(feeNet * 100) / 100,
      })
      if (error) throw new Error(error.message)
      await reloadDatabase()
      return
    }
    const normalizedFee = Math.round(feeNet * 100) / 100
    setDb((current) => {
      const selectedDocument = current.documents.find((document) => document.id === documentId)
      if (!selectedDocument) return current
      const deliveryFeeVatRate = selectedDocument.deliveryFeeVatRate ?? DEFAULT_DELIVERY_FEE_VAT_RATE
      return {
        ...current,
        documents: current.documents.map((document) => document.id === documentId
          ? { ...document, deliveryFeeNet: normalizedFee, deliveryFeeVatRate }
          : document),
        orders: current.orders.map((order) => {
          if (order.id !== selectedDocument.orderId) return order
          const totals = calculateOrderTotals({
            items: order.items,
            deliveryFeeNet: normalizedFee,
            deliveryFeeVatRate,
          })
          return {
            ...order,
            deliveryFeeNet: normalizedFee,
            deliveryFeeVatRate,
            netTotal: totals.net,
            vatTotal: totals.vat,
            grossTotal: totals.gross,
          }
        }),
      }
    })
  }, [reloadDatabase])

  const saveCustomer = useCallback(async (draft: CustomerDraft, id?: string): Promise<string> => {
    if (isSupabaseMode) {
      const client = requireConfiguredClient()
      if (id) {
        const current = db.customers.find((customer) => customer.id === id)
        if (current?.authUserId && current.email.trim().toLowerCase() !== draft.email.trim().toLowerCase()) {
          const { error: emailError } = await client.functions.invoke('admin-users', {
            body: { action: 'update_email', user_id: current.authUserId, email: draft.email },
          })
          if (emailError) throw new Error(emailError.message)
        }
        if (current?.authUserId && current.active !== draft.active) {
          const { error: accessError } = await client.functions.invoke('admin-users', {
            body: { action: draft.active ? 'enable' : 'disable', user_id: current.authUserId },
          })
          if (accessError) throw new Error(accessError.message)
        }
        const { error } = await client.from('customers').update(customerPayload(draft)).eq('id', id)
        if (error) throw new Error(error.message)
        await reloadDatabase()
        return id
      }
      const redirectTo = `${window.location.origin}${import.meta.env.BASE_URL}#/imposta-password`
      const { data, error } = await client.functions.invoke('admin-users', {
        body: {
          action: 'invite',
          email: draft.email,
          display_name: draft.contactName || draft.companyName,
          customer: customerPayload({ ...draft, priceListId: draft.priceListId ?? BASE_PRICE_LIST_ID }),
          redirect_to: redirectTo,
        },
      })
      if (error) throw new Error(error.message)
      const createdCustomerId = String(data.customer_id)
      const { error: customerError } = await client
        .from('customers')
        .update(customerPayload({ ...draft, priceListId: draft.priceListId ?? BASE_PRICE_LIST_ID }))
        .eq('id', createdCustomerId)
      if (customerError) throw new Error(customerError.message)
      await reloadDatabase()
      return createdCustomerId
    }
    const targetId = id ?? uid('customer')
    setDb((current) => ({
      ...current,
      customers: id
        ? current.customers.map((customer) => customer.id === id ? { ...customer, ...draft } : customer)
        : [{ ...draft, id: targetId, createdAt: new Date().toISOString() }, ...current.customers],
    }))
    return targetId
  }, [db.customers, reloadDatabase])

  const importCustomers = useCallback(async (customers: Array<Omit<CustomerDraft, 'paymentMethod'> & { id: string }>) => {
    if (!customers.length) throw new Error('Il file clienti non contiene anagrafiche.')
    if (isSupabaseMode) throw new Error('Import clienti in produzione: usare una Edge Function/RPC admin per creare anche gli accessi.')
    setDb((current) => {
      const imported = customers.map((customer) => ({
        ...customer,
        paymentMethod: 'end_of_month' as const,
        createdAt: new Date().toISOString(),
      }))
      const importedIds = new Set(imported.map((customer) => customer.id))
      return {
        ...current,
        customers: [...imported, ...current.customers.filter((customer) => !importedIds.has(customer.id))],
        demoCredentials: [
          ...current.demoCredentials.filter((credential) => !importedIds.has(credential.customerId)),
          ...imported.map((customer) => ({ customerId: customer.id, password: 'DemoCliente!2026' })),
        ],
      }
    })
    return customers.length
  }, [])

  const deleteCustomer = useCallback(async (id: string) => {
    if (isSupabaseMode) {
      const customer = db.customers.find((item) => item.id === id)
      if (!customer) throw new Error('Cliente non trovato.')
      const nextActive = !customer.active
      const client = requireConfiguredClient()
      if (customer?.authUserId) {
        const { error } = await client.functions.invoke('admin-users', {
          body: { action: nextActive ? 'enable' : 'disable', user_id: customer.authUserId },
        })
        if (error) throw new Error(error.message)
      }
      const { error } = await client.from('customers').update({ active: nextActive }).eq('id', id)
      if (error) throw new Error(error.message)
      await reloadDatabase()
      return
    }
    setDb((current) => ({
      ...current,
      customers: current.customers.filter((customer) => customer.id !== id),
      demoCredentials: current.demoCredentials.filter((credential) => credential.customerId !== id),
    }))
  }, [db.customers, reloadDatabase])

  const sendCustomerPasswordReset = useCallback(async (customerId: string) => {
    const customer = db.customers.find((item) => item.id === customerId)
    if (!customer) throw new Error('Cliente non trovato.')
    if (!isSupabaseMode) return
    const client = requireConfiguredClient()
    const { error } = await client.functions.invoke('admin-users', {
      body: {
        action: 'send_reset',
        email: customer.email,
        redirect_to: `${window.location.origin}${import.meta.env.BASE_URL}#/imposta-password`,
      },
    })
    if (error) throw new Error(error.message)
  }, [db.customers])

  const setDemoCustomerPassword = useCallback((customerId: string, password: string) => {
    if (isSupabaseMode) throw new Error('Le password Supabase si gestiscono tramite invito o reset sicuro.')
    setDb((current) => ({
      ...current,
      demoCredentials: [
        ...current.demoCredentials.filter((credential) => credential.customerId !== customerId),
        { customerId, password },
      ],
    }))
  }, [])

  const saveProduct = useCallback(async (product: Product) => {
    if (isDeliveryService(product)) {
      throw new Error('Il trasporto è una voce automatica dell’ordine e non può essere salvato come prodotto.')
    }
    if (isSupabaseMode) {
      const client = requireConfiguredClient()
      const current = db.products.find((item) => item.id === product.id)
      const priceChanged = !current || current.price !== product.price || current.vatRate !== product.vatRate
      const isActivating = Boolean(current && !current.active && product.active)
      if (priceChanged || isActivating) await upsertProductWithPrice(client, product, product.id)
      else {
        const { error } = await client.from('products').update(productPayload(product)).eq('id', product.id)
        if (error) throw new Error(error.message)
      }
      await reloadDatabase()
      return
    }
    setDb((current) => ({
      ...current,
      products: current.products.map((item) => item.id === product.id ? product : item),
    }))
  }, [db.products, reloadDatabase])

  const addProduct = useCallback(async (product: Omit<Product, 'id'>) => {
    if (isDeliveryService(product)) {
      throw new Error('Il trasporto è una voce automatica dell’ordine e non può essere salvato come prodotto.')
    }
    if (isSupabaseMode) {
      const client = requireConfiguredClient()
      await upsertProductWithPrice(client, product)
      await reloadDatabase()
      return
    }
    setDb((current) => ({
      ...current,
      products: [...current.products, { ...product, id: uid('prod') }],
    }))
  }, [reloadDatabase])

  const importProducts = useCallback(async (products: Omit<Product, 'id'>[]): Promise<number> => {
    if (!products.length) throw new Error('Il catalogo non contiene prodotti da importare.')
    if (products.length > 500) throw new Error('Il catalogo può contenere al massimo 500 prodotti.')
    if (products.some((product) => isDeliveryService(product))) {
      throw new Error('TRASP e TRASP2 non sono prodotti: il trasporto viene aggiunto automaticamente una sola volta per ordine.')
    }

    if (isSupabaseMode) {
      const client = requireConfiguredClient()
      const payload = products.map((product) => ({
        ...productPayload(product),
        unit_price_net: product.price,
        vat_rate: product.vatRate,
      }))
      const { data, error } = await client.rpc('admin_import_catalog', {
        p_products: payload,
        p_replace: true,
      })
      if (error) throw new Error(error.message)
      await reloadDatabase()
      const result = Array.isArray(data) ? data[0] : data
      return Number(result?.imported_count ?? products.length)
    }

    setDb((current) => {
      const importedSkus = new Set(products.map((product) => product.sku))
      const imported = products.map((product) => ({
        ...product,
        id: current.products.find((item) => item.sku === product.sku)?.id ?? uid('prod'),
      }))
      const deactivated = current.products
        .filter((product) => !importedSkus.has(product.sku))
        .map((product) => ({ ...product, active: false }))
      return { ...current, products: [...imported, ...deactivated] }
    })
    return products.length
  }, [reloadDatabase])

  const deleteProduct = useCallback(async (id: string) => {
    if (isSupabaseMode) {
      const client = requireConfiguredClient()
      const { error } = await client.from('products').update({ active: false }).eq('id', id)
      if (error) throw new Error(error.message)
      await reloadDatabase()
      return
    }
    setDb((current) => ({
      ...current,
      products: current.products.filter((product) => product.id !== id),
    }))
  }, [reloadDatabase])

  const saveDiscount = useCallback(async (discount: DiscountCode) => {
    if (isSupabaseMode) throw new Error('Gli sconti in produzione richiedono le tabelle promo Supabase.')
    setDb((current) => ({
      ...current,
      discounts: current.discounts.some((item) => item.id === discount.id)
        ? current.discounts.map((item) => item.id === discount.id ? discount : item)
        : [{ ...discount, id: discount.id || uid('discount') }, ...current.discounts],
    }))
  }, [])

  const deleteDiscount = useCallback(async (id: string) => {
    if (isSupabaseMode) throw new Error('Gli sconti in produzione richiedono le tabelle promo Supabase.')
    setDb((current) => ({ ...current, discounts: current.discounts.filter((discount) => discount.id !== id) }))
  }, [])

  const saveSupplier = useCallback(async (supplier: SupplierSettings) => {
    if (isSupabaseMode) {
      const client = requireConfiguredClient()
      const { error } = await client.from('supplier_settings').update(supplierPayload(supplier)).eq('id', 1)
      if (error) throw new Error(error.message)
      await reloadDatabase()
      return
    }
    setDb((current) => ({ ...current, supplier }))
  }, [reloadDatabase])

  const value = useMemo<AppContextValue>(() => ({
    db,
    session,
    authLoading,
    dataRefreshing,
    dataError,
    passwordSetup,
    isSupabaseConfigured,
    login,
    logout,
    refreshData,
    updateOwnPassword,
    resetDemo,
    createOrder,
    updateOrder,
    getCustomerCatalog,
    adjustOrderFulfillment,
    setOrderStatus,
    confirmOrderPayment,
    issueDdt,
    updateDeliveryFee,
    saveCustomer,
    importCustomers,
    deleteCustomer,
    sendCustomerPasswordReset,
    setDemoCustomerPassword,
    saveProduct,
    addProduct,
    importProducts,
    deleteProduct,
    saveDiscount,
    deleteDiscount,
    saveSupplier,
  }), [
    db,
    session,
    authLoading,
    dataRefreshing,
    dataError,
    passwordSetup,
    login,
    logout,
    refreshData,
    updateOwnPassword,
    resetDemo,
    createOrder,
    updateOrder,
    getCustomerCatalog,
    adjustOrderFulfillment,
    setOrderStatus,
    confirmOrderPayment,
    issueDdt,
    updateDeliveryFee,
    saveCustomer,
    importCustomers,
    deleteCustomer,
    sendCustomerPasswordReset,
    setDemoCustomerPassword,
    saveProduct,
    addProduct,
    importProducts,
    deleteProduct,
    saveDiscount,
    deleteDiscount,
    saveSupplier,
  ])

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

const issueDdtInternal = async (
  orderId: string,
  version: number,
  reload: () => Promise<Database>,
): Promise<DeliveryDocument> => {
  const client = requireConfiguredClient()
  const { data, error } = await client.rpc('prepare_delivery_document', {
    p_order_id: orderId,
    p_expected_version: version,
  })
  if (error || !data) throw new Error(error?.message ?? 'Emissione DDT non riuscita.')
  const nextDb = await reload()
  const document = nextDb.documents.find((item) => item.id === String(data.id))
  if (!document) throw new Error('DDT emesso, ma il documento non è ancora disponibile.')
  return document
}

const upsertProductWithPrice = async (
  client: ReturnType<typeof requireConfiguredClient>,
  product: Omit<Product, 'id'> | Product,
  productId?: string,
) => {
  const payload = productPayload(product)
  const { data, error } = await client.rpc('admin_upsert_product_with_price', {
    p_sku: payload.sku,
    p_name: payload.name,
    p_category: payload.category,
    p_description: payload.description,
    p_uom: payload.uom,
    p_package_label: payload.package_label,
    p_package_size: payload.package_size,
    p_pricing_mode: payload.pricing_mode,
    p_active: product.active,
    p_price_list_id: BASE_PRICE_LIST_ID,
    p_unit_price_net: product.price,
    p_vat_rate: product.vatRate,
    p_effective_on: null,
    p_product_id: productId ?? null,
  })
  if (error) throw new Error(error.message)
  const result = Array.isArray(data) ? data[0] : data
  const savedProductId = productId ?? (result && typeof result === 'object' && 'product_id' in result
    ? String(result.product_id)
    : '')
  if (!savedProductId) throw new Error('Prodotto salvato, ma identificativo non disponibile.')
  const { error: promoError } = await client
    .from('products')
    .update({
      promoted: Boolean(product.promoted),
      promo_percent_discount: product.promoPercentDiscount ?? null,
      promo_label: product.promoLabel?.trim() ?? '',
    })
    .eq('id', savedProductId)
  if (promoError) throw new Error(promoError.message)
}

export const useApp = () => {
  const context = useContext(AppContext)
  if (!context) throw new Error('useApp deve essere usato dentro AppProvider')
  return context
}

export const demoTomorrow = tomorrowIso
