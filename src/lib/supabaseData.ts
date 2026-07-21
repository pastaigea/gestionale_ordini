import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  Address,
  Customer,
  Database,
  DeliveryDocument,
  DiscountCode,
  Order,
  OrderItem,
  PaymentMethod,
  Product,
  SessionUser,
  SupplierSettings,
} from '../types'
import { localIsoDate } from './format'
import { isDeliveryService } from './commerce'

export const BASE_PRICE_LIST_ID = '00000000-0000-4000-8000-000000000001'

type Row = Record<string, unknown>

const asRow = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const text = (value: unknown) => typeof value === 'string' ? value : ''
const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0
const optionalText = (value: unknown) => text(value) || undefined

export const emptyAddress = (): Address => ({
  street: '',
  city: '',
  province: '',
  postalCode: '',
  country: 'Italia',
})

export const emptySupplier = (): SupplierSettings => ({
  businessName: '',
  ownerName: '',
  vatNumber: '',
  fiscalCode: '',
  address: emptyAddress(),
  email: '',
  phone: '',
  pec: '',
  sdiCode: '',
  bankName: '',
  iban: '',
})

export const emptyDatabase = (): Database => ({
  customers: [],
  products: [],
  orders: [],
  documents: [],
  discounts: [],
  supplier: emptySupplier(),
  demoCredentials: [],
  counters: { order: 0, ddtByYear: {} },
})

export const mapAddress = (value: unknown): Address => {
  const row = asRow(value)
  return {
    street: text(row.street ?? row.address ?? row.address_line),
    city: text(row.city),
    province: text(row.province),
    postalCode: text(row.postalCode ?? row.postal_code ?? row.zip),
    country: text(row.country) || 'Italia',
  }
}

const mapCustomerSnapshot = (value: unknown, fallbackId = ''): Customer => {
  const row = asRow(value)
  const email = text(row.email)
  return {
    id: text(row.id) || fallbackId,
    companyName: text(row.legalName ?? row.legal_name),
    contactName: text(row.contactName ?? row.contact_name),
    email,
    username: email,
    phone: text(row.phone),
    vatNumber: text(row.vatNumber ?? row.vat_number),
    fiscalCode: text(row.taxCode ?? row.tax_code),
    pec: text(row.pec),
    sdiCode: text(row.sdiCode ?? row.sdi_code),
    billingAddress: mapAddress(row.billingAddress ?? row.billing_address),
    deliveryAddress: mapAddress(row.shippingAddress ?? row.shipping_address),
    paymentMethod: normalizePaymentMethod(row.payment_method ?? row.paymentMethod),
    deliveryFeeMode: text(row.delivery_fee_mode ?? row.deliveryFeeMode) === 'free' ? 'free' : 'standard',
    active: row.active === undefined ? true : Boolean(row.active),
    createdAt: text(row.created_at) || new Date(0).toISOString(),
  }
}

export const mapCustomer = (value: unknown, authUserId?: string): Customer => {
  const row = asRow(value)
  return {
    ...mapCustomerSnapshot(row, text(row.id)),
    authUserId,
    priceListId: optionalText(row.price_list_id),
  }
}

const mapSupplierSnapshot = (value: unknown): SupplierSettings => {
  const row = asRow(value)
  return {
    businessName: text(row.legalName ?? row.legal_name),
    ownerName: text(row.ownerName ?? row.owner_name),
    vatNumber: text(row.vatNumber ?? row.vat_number),
    fiscalCode: text(row.taxCode ?? row.tax_code),
    address: mapAddress(row.registeredAddress ?? row.registered_address),
    email: text(row.email),
    phone: text(row.phone),
    pec: text(row.pec),
    sdiCode: text(row.sdiCode ?? row.sdi_code),
    bankName: text(row.bankName ?? row.bank_name),
    iban: text(row.iban),
  }
}

export const mapSupplier = mapSupplierSnapshot

const normalizeCategory = (value: unknown): Product['category'] => {
  const category = text(value).trim().toLowerCase()
  if (category === 'ripieno' || category === 'pasta ripiena') return 'Ripieno'
  if (category === 'speciale') return 'Speciale'
  if (category === 'servizio') return 'Servizio'
  return 'Pasta'
}

const normalizePricingMode = (value: unknown): NonNullable<Product['pricingMode']> =>
  text(value) === 'per_kg' ? 'per_kg' : 'per_unit'

const normalizePaymentMethod = (value: unknown): PaymentMethod =>
  text(value) === 'on_delivery' ? 'on_delivery' : 'end_of_month'

const mapCatalogProduct = (value: unknown): Product => {
  const row = asRow(value)
  return {
    id: text(row.id),
    sku: optionalText(row.sku),
    name: text(row.name),
    category: normalizeCategory(row.category),
    packageLabel: text(row.package_label ?? row.packageLabel),
    packageSize: number(row.package_size ?? row.packageSize) || undefined,
    pricingMode: normalizePricingMode(row.pricing_mode ?? row.pricingMode),
    price: number(row.unit_price_net ?? row.price),
    vatRate: number(row.vat_rate ?? row.vatRate),
    active: row.active === undefined ? true : Boolean(row.active),
    description: text(row.description),
    priceValidFrom: optionalText(row.valid_from),
    promoted: Boolean(row.promoted),
    promoPercentDiscount: row.promo_percent_discount === null || row.promo_percent_discount === undefined
      ? undefined
      : number(row.promo_percent_discount),
    promoLabel: optionalText(row.promo_label),
  }
}

const mapOrderItem = (value: unknown): OrderItem => {
  const row = asRow(value)
  return {
    productId: text(row.product_id ?? row.productId),
    sku: optionalText(row.sku_snapshot ?? row.sku ?? row.productSku),
    productName: text(row.name_snapshot ?? row.name ?? row.productName),
    packageLabel: text(row.package_label_snapshot ?? row.packageLabel),
    quantity: number(row.quantity),
    fulfilledQuantity: row.fulfilled_quantity === null || row.fulfilled_quantity === undefined
      ? undefined
      : number(row.fulfilled_quantity),
    orderedQuantity: row.ordered_quantity === null || row.ordered_quantity === undefined
      ? undefined
      : number(row.ordered_quantity),
    unitPrice: number(row.unit_price_net ?? row.unitPriceNet ?? row.unitPrice),
    vatRate: number(row.vat_rate ?? row.vatRate),
    packageSize: number(row.package_size_snapshot ?? row.packageSize) || undefined,
    pricingMode: normalizePricingMode(row.pricing_mode_snapshot ?? row.pricingMode),
  }
}

const orderDisplayNumber = (row: Row) => {
  const createdAt = text(row.created_at)
  const year = createdAt ? new Date(createdAt).getFullYear() : new Date().getFullYear()
  return `ORD-${year}-${String(row.order_number ?? '').padStart(6, '0')}`
}

const mapOrder = (value: unknown, items: OrderItem[], ddtId?: string): Order => {
  const row = asRow(value)
  const customerSnapshot = row.customer_snapshot
    ? mapCustomerSnapshot(row.customer_snapshot, text(row.customer_id))
    : undefined
  return {
    id: text(row.id),
    number: orderDisplayNumber(row),
    customerId: text(row.customer_id),
    requestedDeliveryDate: text(row.requested_delivery_date),
    notes: text(row.notes),
    status: text(row.status) as Order['status'],
    paymentMethod: normalizePaymentMethod(
      row.payment_method_snapshot ?? row.paymentMethod ?? customerSnapshot?.paymentMethod,
    ),
    discountCode: optionalText(row.discount_code ?? row.discountCode),
    deliveryFeeNet: row.delivery_fee_net === null || row.delivery_fee_net === undefined
      ? undefined
      : number(row.delivery_fee_net),
    deliveryFeeVatRate: row.delivery_fee_vat_rate === null || row.delivery_fee_vat_rate === undefined
      ? undefined
      : number(row.delivery_fee_vat_rate),
    paymentConfirmedAt: optionalText(row.payment_confirmed_at ?? row.paymentConfirmedAt),
    items,
    fulfillmentAdjustedAt: optionalText(row.fulfillment_adjusted_at),
    fulfillmentAdjustmentNote: optionalText(row.fulfillment_adjustment_note),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    ddtId,
    version: number(row.version),
    netTotal: number(row.net_total),
    vatTotal: number(row.vat_total),
    grossTotal: number(row.gross_total),
    customerSnapshot,
    supplierSnapshot: row.supplier_snapshot ? mapSupplierSnapshot(row.supplier_snapshot) : undefined,
  }
}

export const mapDiscount = (value: unknown): DiscountCode => {
  const row = asRow(value)
  return {
    id: text(row.id),
    code: text(row.code).trim().toUpperCase(),
    description: text(row.description),
    active: row.active === undefined ? true : Boolean(row.active),
    validUntil: optionalText(row.valid_until ?? row.validUntil),
    productPriceOverrides: asRow(row.product_price_overrides ?? row.productPriceOverrides) as Record<string, number>,
    productPercentDiscounts: asRow(row.product_percent_discounts ?? row.productPercentDiscounts) as Record<string, number>,
    freeDelivery: Boolean(row.free_delivery ?? row.freeDelivery),
    deliveryFeeNet: row.delivery_fee_net === null || row.delivery_fee_net === undefined
      ? undefined
      : number(row.delivery_fee_net),
  }
}

const mapDocument = (value: unknown): DeliveryDocument => {
  const row = asRow(value)
  const customerSnapshot = mapCustomerSnapshot(row.customer_snapshot, text(row.customer_id))
  const itemSnapshots = asArray(row.items_snapshot).map(mapOrderItem)
  const carrier = asRow(row.carrier_snapshot)
  return {
    id: text(row.id),
    number: text(row.display_number),
    progressive: number(row.sequence_number),
    year: number(row.document_year),
    orderId: text(row.order_id),
    customerId: text(row.customer_id),
    issueDate: text(row.issued_on),
    transportStartedAt: optionalText(row.transport_started_at),
    transportReason: text(row.transport_reason),
    carrier: text(carrier.name ?? carrier.description ?? carrier.method) || 'Consegna a cura del mittente',
    packages: number(row.packages),
    deliveryFeeNet: row.delivery_fee_net === null || row.delivery_fee_net === undefined ? undefined : number(row.delivery_fee_net),
    deliveryFeeVatRate: row.delivery_fee_vat_rate === null || row.delivery_fee_vat_rate === undefined ? undefined : number(row.delivery_fee_vat_rate),
    paymentMethod: text(row.payment_method_snapshot)
      ? normalizePaymentMethod(row.payment_method_snapshot)
      : undefined,
    supplierSnapshot: mapSupplierSnapshot(row.supplier_snapshot),
    customerSnapshot,
    destinationSnapshot: mapAddress(row.destination_snapshot),
    itemsSnapshot: itemSnapshots,
    status: text(row.status) as DeliveryDocument['status'],
    revision: number(row.revision_number),
    revisionReason: optionalText(row.revision_reason),
    replacesDocumentId: optionalText(row.replaces_document_id),
  }
}

const ensure = (error: { message: string } | null, context: string) => {
  if (error) throw new Error(`${context}: ${error.message}`)
}

const PAGE_SIZE = 500

interface RowsPage {
  data: unknown[] | null
  error: { message: string } | null
}

const loadAllRows = async (
  fetchPage: (from: number, to: number) => PromiseLike<RowsPage>,
  context: string,
): Promise<Row[]> => {
  const rows: Row[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const result = await fetchPage(from, from + PAGE_SIZE - 1)
    ensure(result.error, context)
    const page = (result.data ?? []).map(asRow)
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
  }
}

export const loadCustomerCatalog = async (
  client: SupabaseClient,
  customerId: string,
): Promise<Product[]> => {
  const rows = await loadAllRows(
    (from, to) => client.rpc('get_catalog', { p_customer_id: customerId }).range(from, to),
    'Lettura listino cliente non riuscita',
  )
  return rows.map(mapCatalogProduct).filter((product) => !isDeliveryService(product))
}

export const loadSupabaseDatabase = async (
  client: SupabaseClient,
  session: SessionUser,
): Promise<Database> => {
  const today = localIsoDate()
  const [customerRows, relationRows, orderRows, itemRows, documentRows, discountRows, supplierResult] = await Promise.all([
    loadAllRows(
      (from, to) => client.from('customers').select('*').order('legal_name').order('id').range(from, to),
      'Lettura clienti non riuscita',
    ),
    loadAllRows(
      (from, to) => client.from('customer_users').select('customer_id,user_id').order('customer_id').range(from, to),
      'Lettura account cliente non riuscita',
    ),
    loadAllRows(
      (from, to) => client.from('orders').select('*').order('created_at', { ascending: false }).order('id').range(from, to),
      'Lettura ordini non riuscita',
    ),
    loadAllRows(
      (from, to) => client.from('order_items').select('*').order('created_at').order('id').range(from, to),
      'Lettura righe ordine non riuscita',
    ),
    loadAllRows(
      (from, to) => {
        let query = client.from('delivery_documents').select('*')
        if (session.role !== 'admin') query = query.eq('status', 'ready')
        return query.order('issued_on', { ascending: false }).order('id').range(from, to)
      },
      'Lettura DDT non riuscita',
    ),
    session.role === 'admin'
      ? loadAllRows(
          (from, to) => client.from('discount_codes').select('*').order('code').range(from, to),
          'Lettura codici sconto non riuscita',
        )
      : Promise.resolve([]),
    client.from('supplier_settings').select('*').eq('id', 1).maybeSingle(),
  ])

  ensure(supplierResult.error, 'Lettura dati fornitore non riuscita')

  const relationByCustomer = new Map(
    relationRows.map((relation) => [String(relation.customer_id), String(relation.user_id)]),
  )
  const customers = customerRows.map((customer) =>
    mapCustomer(customer, relationByCustomer.get(String(customer.id))),
  )

  let products: Product[]
  if (session.role === 'admin') {
    const [productRows, priceRows] = await Promise.all([
      loadAllRows(
        (from, to) => client.from('products').select('*').order('name').order('id').range(from, to),
        'Lettura prodotti non riuscita',
      ),
      loadAllRows(
        (from, to) => client
          .from('price_list_items')
          .select('*')
          .eq('price_list_id', BASE_PRICE_LIST_ID)
          .lte('valid_from', today)
          .or(`valid_to.is.null,valid_to.gte.${today}`)
          .order('valid_from', { ascending: false })
          .order('product_id')
          .range(from, to),
        'Lettura prezzi non riuscita',
      ),
    ])
    const latestPriceByProduct = new Map<string, Row>()
    for (const price of priceRows) {
      const productId = String(price.product_id)
      if (!latestPriceByProduct.has(productId)) latestPriceByProduct.set(productId, asRow(price))
    }
    products = productRows.map((product) => {
      const price = latestPriceByProduct.get(String(product.id)) ?? {}
      return mapCatalogProduct({ ...product, ...price })
    }).filter((product) => !isDeliveryService(product))
  } else {
    const catalogRows = await loadAllRows(
      (from, to) => client.rpc('get_catalog').range(from, to),
      'Lettura catalogo non riuscita',
    )
    products = catalogRows.map(mapCatalogProduct).filter((product) => !isDeliveryService(product))
  }

  const documents = documentRows.map(mapDocument)
  const documentByOrder = new Map(
    documents
      .filter((document) => document.status !== 'void')
      .map((document) => [document.orderId, document.id]),
  )
  const itemsByOrder = new Map<string, OrderItem[]>()
  for (const row of itemRows) {
    const orderId = String(row.order_id)
    itemsByOrder.set(orderId, [...(itemsByOrder.get(orderId) ?? []), mapOrderItem(row)])
  }
  const orders = orderRows.map((order) =>
    mapOrder(order, itemsByOrder.get(String(order.id)) ?? [], documentByOrder.get(String(order.id))),
  )

  const counters = documents.reduce<Record<string, number>>((result, document) => ({
    ...result,
    [document.year]: Math.max(result[document.year] ?? 0, document.progressive),
  }), {})

  return {
    customers,
    products,
    orders,
    documents,
    discounts: discountRows.map(mapDiscount),
    supplier: supplierResult.data ? mapSupplier(supplierResult.data) : emptySupplier(),
    demoCredentials: [],
    counters: {
      order: Math.max(0, ...orders.map((order) => Number(order.number.split('-').at(-1) ?? 0))),
      ddtByYear: counters,
    },
  }
}

export const customerPayload = (customer: Omit<Customer, 'id' | 'createdAt'>) => ({
  legal_name: customer.companyName.trim(),
  contact_name: customer.contactName.trim(),
  vat_number: customer.vatNumber.trim(),
  tax_code: customer.fiscalCode.trim(),
  sdi_code: customer.sdiCode.trim(),
  pec: customer.pec.trim(),
  email: customer.email.trim().toLowerCase(),
  phone: customer.phone.trim(),
  billing_address: customer.billingAddress,
  shipping_address: customer.deliveryAddress,
  price_list_id: customer.priceListId ?? BASE_PRICE_LIST_ID,
  payment_method: customer.paymentMethod ?? 'end_of_month',
  delivery_fee_mode: customer.deliveryFeeMode ?? 'standard',
  active: customer.active,
})

export const supplierPayload = (supplier: SupplierSettings) => ({
  legal_name: supplier.businessName.trim(),
  owner_name: supplier.ownerName.trim(),
  vat_number: supplier.vatNumber.trim(),
  tax_code: supplier.fiscalCode.trim(),
  registered_address: supplier.address,
  shipping_origin: supplier.address,
  email: supplier.email.trim().toLowerCase(),
  phone: supplier.phone.trim(),
  pec: supplier.pec.trim(),
  sdi_code: supplier.sdiCode.trim(),
  bank_name: supplier.bankName.trim(),
  iban: supplier.iban.trim(),
})

export const productPayload = (product: Omit<Product, 'id'> | Product) => ({
  sku: product.sku || `IGEA-${product.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toUpperCase()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
  name: product.name.trim(),
  category: product.category,
  description: product.description.trim(),
  uom: product.pricingMode === 'per_kg' ? 'kg' : 'unità',
  package_label: product.packageLabel.trim(),
  package_size: product.packageSize ?? null,
  pricing_mode: product.pricingMode ?? 'per_unit',
  promoted: Boolean(product.promoted),
  promo_percent_discount: product.promoPercentDiscount ?? null,
  promo_label: product.promoLabel?.trim() ?? '',
  active: product.active,
})
