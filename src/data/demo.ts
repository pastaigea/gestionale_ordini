import type { Database } from '../types'

const isoDate = (dayOffset: number) => {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() + dayOffset)
  return date.toISOString().slice(0, 10)
}

const isoTime = (dayOffset: number, hour = 9) => {
  const date = new Date()
  date.setDate(date.getDate() + dayOffset)
  date.setHours(hour, 20, 0, 0)
  return date.toISOString()
}

export const DEMO_ADMIN = {
  email: 'admin@demo.igea.local',
  password: 'DemoAdmin!2026',
} as const

export const DEMO_CUSTOMER = {
  email: 'cliente@demo.igea.local',
  password: 'DemoCliente!2026',
} as const

const customerAddress = {
  street: 'Via Dimostrazione 12',
  city: 'La Spezia',
  province: 'SP',
  postalCode: '19100',
  country: 'Italia',
}

export const createDemoDatabase = (): Database => ({
  customers: [
    {
      id: 'customer-demo-1',
      companyName: 'Trattoria del Porto (demo)',
      contactName: 'Giulia Rossi',
      email: DEMO_CUSTOMER.email,
      username: 'trattoria.demo',
      phone: '+39 000 000 0000',
      vatNumber: 'IT00000000000',
      fiscalCode: 'DEMO00000000000',
      pec: 'trattoria.demo@pec.example',
      sdiCode: 'DEMO000',
      billingAddress: customerAddress,
      deliveryAddress: { ...customerAddress, street: 'Molo Demo 4' },
      paymentMethod: 'end_of_month',
      deliveryFeeMode: 'standard',
      usualProductIds: ['prod-demo-pasta', 'prod-demo-ripieno'],
      active: true,
      createdAt: isoTime(-90),
    },
    {
      id: 'customer-demo-2',
      companyName: 'Osteria Levante (demo)',
      contactName: 'Luca Bianchi',
      email: 'levante@demo.igea.local',
      username: 'osteria.levante.demo',
      phone: '+39 000 000 0001',
      vatNumber: 'IT11111111111',
      fiscalCode: 'DEMO11111111111',
      pec: 'levante.demo@pec.example',
      sdiCode: 'DEMO111',
      billingAddress: { ...customerAddress, street: 'Piazza Esempio 8', city: 'Sarzana', postalCode: '19038' },
      deliveryAddress: { ...customerAddress, street: 'Piazza Esempio 8', city: 'Sarzana', postalCode: '19038' },
      paymentMethod: 'end_of_month',
      deliveryFeeMode: 'standard',
      usualProductIds: ['prod-demo-pasta'],
      active: true,
      createdAt: isoTime(-54),
    },
  ],
  products: [
    {
      id: 'prod-demo-pasta',
      sku: 'DEMO-PASTA',
      name: 'Formato demo',
      category: 'Pasta',
      packageLabel: 'Confezione demo da 1 kg',
      packageSize: 1,
      pricingMode: 'per_kg',
      price: 1,
      vatRate: 4,
      active: true,
      description: 'Segnaposto demo. Importa il catalogo reale da private/catalogo-prodotti.csv.',
    },
    {
      id: 'prod-demo-ripieno',
      sku: 'DEMO-RIPIENO',
      name: 'Ripieno demo',
      category: 'Ripieno',
      packageLabel: 'Confezione demo da 1 kg',
      packageSize: 1,
      pricingMode: 'per_kg',
      price: 1,
      vatRate: 10,
      active: true,
      description: 'Segnaposto demo. Importa il catalogo reale da private/catalogo-prodotti.csv.',
    },
  ],
  orders: [
    {
      id: 'order-demo-3',
      number: 'ORD-2026-0003',
      customerId: 'customer-demo-1',
      requestedDeliveryDate: isoDate(4),
      notes: 'Consegna preferibilmente entro le 11:00.',
      status: 'accepted',
      paymentMethod: 'end_of_month',
      deliveryFeeNet: 3.5,
      deliveryFeeVatRate: 22,
      items: [
        { productId: 'prod-demo-pasta', sku: 'DEMO-PASTA', productName: 'Formato demo', packageLabel: 'Confezione demo da 1 kg', quantity: 5, unitPrice: 1, vatRate: 4, packageSize: 1, pricingMode: 'per_kg' },
        { productId: 'prod-demo-ripieno', sku: 'DEMO-RIPIENO', productName: 'Ripieno demo', packageLabel: 'Confezione demo da 1 kg', quantity: 2, unitPrice: 1, vatRate: 10, packageSize: 1, pricingMode: 'per_kg' },
      ],
      createdAt: isoTime(-1),
      updatedAt: isoTime(0),
    },
    {
      id: 'order-demo-2',
      number: 'ORD-2026-0002',
      customerId: 'customer-demo-2',
      requestedDeliveryDate: isoDate(1),
      notes: '',
      status: 'in_delivery',
      paymentMethod: 'on_delivery',
      deliveryFeeNet: 3.5,
      deliveryFeeVatRate: 22,
      paymentConfirmedAt: isoTime(-1, 12),
      items: [
        { productId: 'prod-demo-pasta', sku: 'DEMO-PASTA', productName: 'Formato demo', packageLabel: 'Confezione demo da 1 kg', quantity: 8, unitPrice: 1, vatRate: 4, packageSize: 1, pricingMode: 'per_kg' },
      ],
      createdAt: isoTime(-3),
      updatedAt: isoTime(-1),
      ddtId: 'ddt-demo-2',
    },
    {
      id: 'order-demo-1',
      number: 'ORD-2026-0001',
      customerId: 'customer-demo-1',
      requestedDeliveryDate: isoDate(-5),
      notes: '',
      status: 'delivered',
      paymentMethod: 'end_of_month',
      deliveryFeeNet: 3.5,
      deliveryFeeVatRate: 22,
      items: [
        { productId: 'prod-demo-pasta', sku: 'DEMO-PASTA', productName: 'Formato demo', packageLabel: 'Confezione demo da 1 kg', quantity: 6, unitPrice: 1, vatRate: 4, packageSize: 1, pricingMode: 'per_kg' },
        { productId: 'prod-demo-ripieno', sku: 'DEMO-RIPIENO', productName: 'Ripieno demo', packageLabel: 'Confezione demo da 1 kg', quantity: 4, unitPrice: 1, vatRate: 10, packageSize: 1, pricingMode: 'per_kg' },
      ],
      createdAt: isoTime(-9),
      updatedAt: isoTime(-5),
      ddtId: 'ddt-demo-1',
    },
  ],
  documents: [
    {
      id: 'ddt-demo-2',
      number: 'DDT-2026-0002',
      progressive: 2,
      year: new Date().getFullYear(),
      orderId: 'order-demo-2',
      customerId: 'customer-demo-2',
      issueDate: isoDate(-1),
      transportReason: 'Vendita',
      carrier: 'Consegna a cura del mittente',
      packages: 8,
      deliveryFeeNet: 3.5,
      deliveryFeeVatRate: 22,
      paymentMethod: 'on_delivery',
    },
    {
      id: 'ddt-demo-1',
      number: 'DDT-2026-0001',
      progressive: 1,
      year: new Date().getFullYear(),
      orderId: 'order-demo-1',
      customerId: 'customer-demo-1',
      issueDate: isoDate(-6),
      transportReason: 'Vendita',
      carrier: 'Consegna a cura del mittente',
      packages: 10,
      deliveryFeeNet: 3.5,
      deliveryFeeVatRate: 22,
      paymentMethod: 'end_of_month',
    },
  ],
  discounts: [
    {
      id: 'discount-sconto1',
      code: 'SCONTO1',
      description: 'Trasporto gratuito e pasta base a 5 euro/kg.',
      active: true,
      productPriceOverrides: { 'prod-demo-pasta': 0.8 },
      freeDelivery: true,
    },
    {
      id: 'discount-sconto2',
      code: 'SCONTO2',
      description: 'Trasporto gratuito.',
      active: true,
      productPriceOverrides: {},
      freeDelivery: true,
    },
  ],
  supplier: {
    businessName: 'Pastificio Igea (dati demo fittizi)',
    ownerName: 'Titolare Demo',
    vatNumber: 'IT00000000000',
    fiscalCode: 'DEMO00000000000',
    address: {
      street: 'Via Esempio 26',
      city: 'La Spezia',
      province: 'SP',
      postalCode: '19100',
      country: 'Italia',
    },
    email: 'amministrazione@demo.igea.local',
    phone: '+39 000 000 0000',
    pec: 'igea.demo@pec.example',
    sdiCode: 'DEMO000',
    bankName: 'Banca Demo',
    iban: 'IT00 D000 0000 0000 0000 0000 000',
  },
  demoCredentials: [
    { customerId: 'customer-demo-1', password: DEMO_CUSTOMER.password },
    { customerId: 'customer-demo-2', password: 'DemoLevante!2026' },
  ],
  counters: {
    order: 3,
    ddtByYear: { [new Date().getFullYear().toString()]: 2 },
  },
})
