import type { DiscountCode, OrderItem, Product } from '../types'

export const DEFAULT_DELIVERY_FEE_NET = 3.5
export const DEFAULT_DELIVERY_FEE_VAT_RATE = 22

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100

const normalizedSku = (value?: string) => value?.trim().toUpperCase() ?? ''
const normalizedName = (value?: string) => value?.trim().toLocaleLowerCase('it-IT') ?? ''

export const isDeliveryService = (
  item: Pick<Product, 'sku' | 'name' | 'category'> | Pick<OrderItem, 'sku' | 'productName'>,
) => {
  const sku = normalizedSku(item.sku)
  if (sku === 'TRASP' || sku === 'TRASP2') return true

  const name = normalizedName('name' in item ? item.name : item.productName)
  return name === 'trasporto' || name === 'trasporto doppio' || name === 'spese di trasporto'
}

export const validPromoPercent = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100

export const formatPromoPercent = (value: number) =>
  new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2 }).format(value)

export const productPromoLabel = (product: Product) =>
  product.promoted && validPromoPercent(product.promoPercentDiscount)
    ? `Sconto ${formatPromoPercent(product.promoPercentDiscount)}%`
    : ''

export const resolveProductUnitPrice = (product: Product, discount?: DiscountCode) => {
  const override = discount?.productPriceOverrides[product.id]
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) {
    return roundMoney(override)
  }

  const codePercent = discount?.productPercentDiscounts?.[product.id]
  const percent = validPromoPercent(codePercent)
    ? codePercent
    : product.promoted && validPromoPercent(product.promoPercentDiscount)
      ? product.promoPercentDiscount
      : undefined

  return percent === undefined
    ? product.price
    : roundMoney(Math.max(0, product.price * (1 - percent / 100)))
}

export const resolveDeliveryFeeNet = (baseFeeNet: number, discount?: DiscountCode) => {
  if (discount?.freeDelivery) return 0
  if (typeof discount?.deliveryFeeNet === 'number' && Number.isFinite(discount.deliveryFeeNet)) {
    return roundMoney(Math.max(0, discount.deliveryFeeNet))
  }
  return roundMoney(Math.max(0, baseFeeNet))
}

export const deliveryFeeAmounts = (net: number, vatRate = DEFAULT_DELIVERY_FEE_VAT_RATE) => {
  const safeNet = roundMoney(Math.max(0, net))
  const vat = roundMoney(safeNet * vatRate / 100)
  return { net: safeNet, vat, gross: roundMoney(safeNet + vat) }
}
