export type UserRole = 'admin' | 'client'

export type PricingMode = 'per_kg' | 'per_unit'

export type PaymentMethod = 'end_of_month' | 'on_delivery'

export type OrderStatus =
  | 'draft'
  | 'submitted'
  | 'accepted'
  | 'rejected'
  | 'in_delivery'
  | 'delivered'
  | 'cancelled'

export interface Address {
  street: string
  city: string
  province: string
  postalCode: string
  country: string
}

export interface Customer {
  id: string
  authUserId?: string
  priceListId?: string
  companyName: string
  contactName: string
  email: string
  username: string
  phone: string
  vatNumber: string
  fiscalCode: string
  pec: string
  sdiCode: string
  billingAddress: Address
  deliveryAddress: Address
  paymentMethod: PaymentMethod
  deliveryFeeMode?: 'standard' | 'free'
  usualProductIds?: string[]
  active: boolean
  createdAt: string
}

/** Credenziale esclusivamente fittizia per la modalità demo locale. Non viene mai inviata a Supabase. */
export interface DemoCredential {
  customerId: string
  password: string
}

export interface Product {
  id: string
  sku?: string
  name: string
  category: 'Pasta' | 'Ripieno' | 'Speciale' | 'Servizio'
  packageLabel: string
  price: number
  pricingMode?: PricingMode
  vatRate: number
  active: boolean
  description: string
  packageSize?: number
  priceValidFrom?: string
  promoLabel?: string
  /** Percentuale applicata automaticamente quando il prodotto e in promo. */
  promoPercentDiscount?: number
  promoted?: boolean
}

export interface DiscountCode {
  id: string
  code: string
  description: string
  active: boolean
  validUntil?: string
  productPriceOverrides: Record<string, number>
  productPercentDiscounts?: Record<string, number>
  freeDelivery?: boolean
  deliveryFeeNet?: number
}

export interface OrderItem {
  productId: string
  sku?: string
  productName: string
  packageLabel: string
  quantity: number
  /** Quantità effettivamente confermata/consegnata dall'amministratore. */
  fulfilledQuantity?: number
  /** Quantità richiesta, riportata nello snapshot di un DDT rettificato. */
  orderedQuantity?: number
  unitPrice: number
  vatRate: number
  packageSize?: number
  pricingMode?: PricingMode
}

export interface Order {
  id: string
  number: string
  customerId: string
  requestedDeliveryDate: string
  notes: string
  status: OrderStatus
  paymentMethod: PaymentMethod
  discountCode?: string
  /** Voce separata dai prodotti: una sola consegna per ordine. */
  deliveryFeeNet?: number
  deliveryFeeVatRate?: number
  paymentConfirmedAt?: string
  items: OrderItem[]
  fulfillmentAdjustedAt?: string
  fulfillmentAdjustmentNote?: string
  createdAt: string
  updatedAt: string
  ddtId?: string
  version?: number
  netTotal?: number
  vatTotal?: number
  grossTotal?: number
  customerSnapshot?: Customer
  supplierSnapshot?: SupplierSettings
}

export interface DeliveryDocument {
  id: string
  number: string
  progressive: number
  year: number
  orderId: string
  customerId: string
  issueDate: string
  transportReason: string
  carrier: string
  packages: number
  deliveryFeeNet?: number
  deliveryFeeVatRate?: number
  paymentMethod?: PaymentMethod
  supplierSnapshot?: SupplierSettings
  customerSnapshot?: Customer
  destinationSnapshot?: Address
  itemsSnapshot?: OrderItem[]
  status?: 'generating' | 'ready' | 'void'
  transportStartedAt?: string
  revision?: number
  revisionReason?: string
  replacesDocumentId?: string
}

export interface SupplierSettings {
  businessName: string
  ownerName: string
  vatNumber: string
  fiscalCode: string
  address: Address
  email: string
  phone: string
  pec: string
  sdiCode: string
  bankName: string
  iban: string
}

export interface Database {
  customers: Customer[]
  products: Product[]
  orders: Order[]
  documents: DeliveryDocument[]
  discounts: DiscountCode[]
  supplier: SupplierSettings
  demoCredentials: DemoCredential[]
  counters: {
    order: number
    ddtByYear: Record<string, number>
  }
}

export interface SessionUser {
  id: string
  role: UserRole
  name: string
  email: string
  customerId?: string
  source: 'demo' | 'supabase'
}

export interface OrderTotals {
  net: number
  vat: number
  gross: number
  packages: number
}
