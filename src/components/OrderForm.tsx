import { CalendarDays, Check, CircleDollarSign, Minus, Package, Plus, Search, Send, ShoppingBasket, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FormEvent } from 'react'
import {
  calculateLineNet,
  calculateOrderTotals,
  calculatePackageNet,
  euro,
  isPricedPerKg,
  minDeliveryDate,
} from '../lib/format'
import type { PricingMode } from '../lib/format'
import {
  DEFAULT_DELIVERY_FEE_NET,
  DEFAULT_DELIVERY_FEE_VAT_RATE,
  deliveryFeeAmounts,
  isDeliveryService,
  productPromoLabel,
  resolveDeliveryFeeNet,
  resolveProductUnitPrice,
} from '../lib/commerce'
import { isSupabaseMode } from '../lib/supabase'
import type { DiscountCode, Order, OrderItem, PaymentMethod, Product } from '../types'
import { Button, Card, Field } from './ui'

type PricedProduct = Product & { packageSize?: number; pricingMode?: PricingMode }
type PricedOrderItem = OrderItem & { packageSize?: number; pricingMode?: PricingMode }

const pricedProduct = (product: Product) => product as PricedProduct
const pricedItem = (item: OrderItem) => item as PricedOrderItem

interface OrderFormProps {
  products: Product[]
  initialOrder?: Order
  defaultPaymentMethod?: PaymentMethod
  preferredProductIds?: string[]
  discounts?: DiscountCode[]
  resolveDiscount?: (code: string) => Promise<DiscountCode | null>
  deliveryFeeNet?: number
  deliveryFeeVatRate?: number
  submitLabel?: string
  summaryTitle?: string
  legalText?: string
  onSubmit: (draft: { requestedDeliveryDate: string; notes: string; paymentMethod: PaymentMethod; discountCode?: string; items: OrderItem[]; idempotencyKey: string }) => Promise<void> | void
  onCancel?: () => void
}

export const OrderForm = ({
  products,
  initialOrder,
  defaultPaymentMethod = 'end_of_month',
  preferredProductIds = [],
  discounts = [],
  resolveDiscount,
  deliveryFeeNet = initialOrder?.deliveryFeeNet ?? DEFAULT_DELIVERY_FEE_NET,
  deliveryFeeVatRate = initialOrder?.deliveryFeeVatRate ?? DEFAULT_DELIVERY_FEE_VAT_RATE,
  submitLabel,
  summaryTitle = 'Il tuo ordine',
  legalText = 'L’invio non costituisce accettazione. Riceverai conferma da Igea.',
  onSubmit,
  onCancel,
}: OrderFormProps) => {
  const [date, setDate] = useState(initialOrder?.requestedDeliveryDate ?? '')
  const [notes, setNotes] = useState(initialOrder?.notes ?? '')
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(initialOrder?.paymentMethod ?? defaultPaymentMethod)
  const [discountCode, setDiscountCode] = useState(initialOrder?.discountCode ?? '')
  const [resolvedDiscount, setResolvedDiscount] = useState<DiscountCode | null>(null)
  const [discountValidation, setDiscountValidation] = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('Tutti')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const idempotencyKey = useRef(crypto.randomUUID())
  const checkoutRef = useRef<HTMLElement>(null)
  const [quantities, setQuantities] = useState<Record<string, number>>(() =>
    Object.fromEntries(initialOrder?.items.map((item) => [item.productId, item.quantity]) ?? []),
  )

  const initialItems = (initialOrder?.items ?? []).filter((item) => !isDeliveryService(item))
  const initialIds = new Set(initialItems.map((item) => item.productId))
  const catalogProducts: PricedProduct[] = [
    ...products
      .filter((product) => !isDeliveryService(product))
      .filter((product) => product.active || initialIds.has(product.id))
      .map((product) => {
        const snapshot = initialItems.find((item) => item.productId === product.id)
        const currentPricing = pricedProduct(product)
        const snapshotPricing = snapshot ? pricedItem(snapshot) : undefined
        return snapshot && !product.active
          ? {
              ...currentPricing,
              name: snapshot.productName,
              packageLabel: snapshot.packageLabel,
              packageSize: snapshotPricing?.packageSize,
              pricingMode: snapshotPricing?.pricingMode ?? 'per_unit',
              price: snapshot.unitPrice,
              vatRate: snapshot.vatRate,
            }
          : currentPricing
      }),
    ...initialItems
      .filter((item) => !isDeliveryService(item) && !products.some((product) => product.id === item.productId))
      .map((item): PricedProduct => ({
        id: item.productId,
        sku: item.sku,
        name: item.productName,
        packageLabel: item.packageLabel,
        packageSize: pricedItem(item).packageSize,
        pricingMode: pricedItem(item).pricingMode,
        price: item.unitPrice,
        vatRate: item.vatRate,
        category: 'Pasta',
        active: false,
        description: 'Prodotto non più presente nel catalogo.',
      })),
  ]
  const categories = ['Tutti', ...Array.from(new Set(catalogProducts.map((product) => product.category)))]
  const preferredRank = new Map(preferredProductIds.map((id, index) => [id, index]))
  const visibleProducts = catalogProducts
    .filter((product) =>
      (category === 'Tutti' || product.category === category) &&
      product.name.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .sort((left, right) =>
      Number(Boolean(right.promoted)) - Number(Boolean(left.promoted)) ||
      (preferredRank.get(left.id) ?? 9999) - (preferredRank.get(right.id) ?? 9999) ||
      left.name.localeCompare(right.name, 'it'),
    )

  const normalizedDiscountCode = discountCode.trim().toUpperCase()
  const localDiscount = discounts.find((discount) =>
    discount.active &&
    discount.code.toUpperCase() === normalizedDiscountCode &&
    (!discount.validUntil || discount.validUntil >= new Date().toISOString().slice(0, 10)),
  )
  const activeDiscount = localDiscount ?? (
    resolvedDiscount?.code.toUpperCase() === normalizedDiscountCode ? resolvedDiscount : undefined
  )

  const buildItems = (discount?: DiscountCode) => catalogProducts
    .filter((product) => (quantities[product.id] ?? 0) > 0)
    .map((product) => {
      const unitPrice = resolveProductUnitPrice(product, discount)
      return {
        productId: product.id,
        sku: product.sku,
        productName: product.name,
        packageLabel: product.packageLabel,
        quantity: quantities[product.id],
        unitPrice,
        vatRate: product.vatRate,
        packageSize: product.packageSize,
        pricingMode: product.pricingMode ?? 'per_unit',
      } as PricedOrderItem
    })

  const items = useMemo<OrderItem[]>(() => buildItems(activeDiscount), [activeDiscount, catalogProducts, quantities])

  const totals = calculateOrderTotals({ items })
  const effectiveDeliveryFeeNet = resolveDeliveryFeeNet(deliveryFeeNet, activeDiscount)
  const deliveryFee = deliveryFeeAmounts(effectiveDeliveryFeeNet, deliveryFeeVatRate)
  const orderNet = Math.round((totals.net + deliveryFee.net) * 100) / 100
  const orderVat = Math.round((totals.vat + deliveryFee.vat) * 100) / 100
  const orderGross = Math.round((orderNet + orderVat) * 100) / 100
  const containsUnavailableItems = items.some((item) =>
    !catalogProducts.find((product) => product.id === item.productId)?.active,
  )
  const pricesChanged = initialItems.some((snapshot) => {
    const current = products.find((product) => product.id === snapshot.productId && product.active)
    if (!current) return false
    const currentPricing = pricedProduct(current)
    const snapshotPricing = pricedItem(snapshot)
    return resolveProductUnitPrice(current, activeDiscount) !== snapshot.unitPrice ||
      current.vatRate !== snapshot.vatRate ||
      currentPricing.packageSize !== snapshotPricing.packageSize ||
      (currentPricing.pricingMode ?? 'per_unit') !== (snapshotPricing.pricingMode ?? 'per_unit')
  })
  const containsInvalidWeightItems = items.some((item) => {
    const pricing = pricedItem(item)
    return isPricedPerKg(pricing) && !(typeof pricing.packageSize === 'number' && pricing.packageSize > 0)
  })

  const setQuantity = (productId: string, value: number) => {
    const safe = Number.isFinite(value) ? Math.max(0, Math.min(999, Math.floor(value))) : 0
    setQuantities((current) => ({ ...current, [productId]: safe }))
    if (safe > 0) setError('')
  }

  useEffect(() => {
    if (!checkoutOpen) return
    const previousOverflow = document.body.style.overflow
    const previousFocus = document.activeElement as HTMLElement | null
    document.body.style.overflow = 'hidden'
    window.requestAnimationFrame(() => checkoutRef.current?.querySelector<HTMLElement>('button, input, textarea')?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCheckoutOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      previousFocus?.focus()
    }
  }, [checkoutOpen])

  const validateDiscount = async (): Promise<DiscountCode | null> => {
    const code = discountCode.trim().toUpperCase()
    if (!code) {
      setResolvedDiscount(null)
      setDiscountValidation('idle')
      return null
    }
    if (localDiscount) {
      setResolvedDiscount(localDiscount)
      setDiscountValidation('valid')
      return localDiscount
    }
    if (!resolveDiscount) {
      setResolvedDiscount(null)
      setDiscountValidation('invalid')
      return null
    }
    setDiscountValidation('checking')
    try {
      const discount = await resolveDiscount(code)
      setResolvedDiscount(discount)
      setDiscountValidation(discount ? 'valid' : 'invalid')
      return discount
    } catch (reason) {
      setResolvedDiscount(null)
      setDiscountValidation('invalid')
      setError(reason instanceof Error ? reason.message : 'Verifica del codice sconto non riuscita.')
      return null
    }
  }

  const discountHint = discountValidation === 'checking'
    ? 'Verifica del codice in corso…'
    : discountValidation === 'invalid' && normalizedDiscountCode
      ? 'Codice non valido, scaduto o non attivo.'
      : activeDiscount
        ? activeDiscount.description || 'Codice sconto applicato.'
        : 'Inseriscilo solo se comunicato dal venditore.'

  const submitDraft = async () => {
    const validatedDiscount = normalizedDiscountCode
      ? activeDiscount ?? await validateDiscount()
      : null
    if (normalizedDiscountCode && !validatedDiscount) {
      setError('Il codice sconto non è valido o non è più attivo.')
      return
    }
    const submittedItems = validatedDiscount === activeDiscount ? items : buildItems(validatedDiscount ?? undefined)
    if (!submittedItems.length) {
      setError('Seleziona almeno un prodotto e indica la quantità.')
      return
    }
    if (!date) {
      setError('Indica la data di consegna richiesta.')
      return
    }
    if (containsUnavailableItems) {
      setError('Uno o più prodotti non sono più disponibili. Portali a quantità zero prima di salvare.')
      return
    }
    if (containsInvalidWeightItems) {
      setError('Il peso della confezione non è configurato per uno o più prodotti al kg.')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await onSubmit({ requestedDeliveryDate: date, notes: notes.trim(), paymentMethod, discountCode: validatedDiscount?.code, items: submittedItems, idempotencyKey: idempotencyKey.current })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invio non riuscito. Riprova tra poco.')
    } finally {
      setSubmitting(false)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void submitDraft()
  }

  const openMobileCheckout = () => {
    if (!items.length) {
      setError('Aggiungi almeno un prodotto prima di continuare.')
      document.querySelector('.product-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    setError('')
    setCheckoutOpen(true)
  }

  return (
    <>
    <form className="order-form" onSubmit={submit}>
      <div className="order-form__main">
        <Card className="order-form__section order-form__section--catalog">
          <div className="section-heading">
            <span className="section-heading__number">1</span>
            <div><h2>Scegli i prodotti</h2><p>Indica il numero di confezioni che desideri ordinare.</p></div>
          </div>
          <div className="catalog-toolbar">
            <div className="search-input">
              <Search size={18} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cerca un formato…" aria-label="Cerca nel catalogo" />
            </div>
            <div className="category-tabs" role="group" aria-label="Filtra per categoria">
              {categories.map((item) => (
                <button className={category === item ? 'active' : ''} type="button" key={item} aria-pressed={category === item} onClick={() => setCategory(item)}>{item}</button>
              ))}
            </div>
          </div>
          <div className="product-grid">
            {visibleProducts.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                unitPrice={resolveProductUnitPrice(product, activeDiscount)}
                quantity={quantities[product.id] ?? 0}
                onChange={(value) => setQuantity(product.id, value)}
              />
            ))}
          </div>
          {visibleProducts.length === 0 && <p className="catalog-empty">Nessun prodotto corrisponde alla ricerca.</p>}
        </Card>

        <Card className="order-form__section order-form__section--delivery">
          <div className="section-heading">
            <span className="section-heading__number">2</span>
            <div><h2>Consegna</h2><p>Quando ti serve l'ordine?</p></div>
          </div>
          <div className="form-grid form-grid--delivery">
            <Field label="Data consegna" htmlFor="delivery-date" hint="Obbligatoria: verra confermata da Igea.">
              <div className="input-with-icon">
                <CalendarDays size={18} />
                <input
                  id="delivery-date"
                  aria-label="Data consegna"
                  type="date"
                  min={minDeliveryDate()}
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                  required
                />
              </div>
            </Field>
            <Field label="Note per la consegna" htmlFor="order-notes" hint={`${notes.length}/300 caratteri`}>
              <textarea
                id="order-notes"
                rows={3}
                maxLength={300}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Orario preferito, accesso, altre indicazioni…"
              />
            </Field>
            <Field label="Codice sconto" htmlFor="discount-code" hint={discountHint}>
              <input id="discount-code" value={discountCode} onChange={(event) => { setDiscountCode(event.target.value.toUpperCase()); setResolvedDiscount(null); setDiscountValidation('idle') }} onBlur={() => void validateDiscount()} placeholder="Es. SCONTO1" />
            </Field>
          </div>
        </Card>

        <Card className="order-form__section order-form__section--payment">
          <div className="section-heading">
            <span className="section-heading__number">3</span>
            <div><h2>Pagamento</h2><p>Scegli come vuoi pagare questo ordine.</p></div>
          </div>
          <div className="payment-choice" role="radiogroup" aria-label="Modalita di pagamento">
            <label className={paymentMethod === 'end_of_month' ? 'payment-choice__option active' : 'payment-choice__option'}>
              <input
                type="radio"
                name="payment-method"
                aria-label="Fattura a fine mese"
                value="end_of_month"
                checked={paymentMethod === 'end_of_month'}
                onChange={() => setPaymentMethod('end_of_month')}
              />
              <CircleDollarSign size={19} />
              <span><strong>Fattura a fine mese</strong><small>Pagamento raggruppato nella fatturazione periodica.</small></span>
            </label>
            <label className={paymentMethod === 'on_delivery' ? 'payment-choice__option active' : 'payment-choice__option'}>
              <input
                type="radio"
                name="payment-method"
                aria-label="Pagamento alla consegna"
                value="on_delivery"
                checked={paymentMethod === 'on_delivery'}
                onChange={() => setPaymentMethod('on_delivery')}
              />
              <CircleDollarSign size={19} />
              <span><strong>Pagamento alla consegna</strong><small>Il venditore confermera l'incasso sull'ordine.</small></span>
            </label>
          </div>
        </Card>
      </div>

      <aside className="order-summary" aria-label="Riepilogo ordine">
        <Card>
          <div className="order-summary__title">
            <span><ShoppingBasket size={19} /></span>
            <div><h2>{summaryTitle}</h2><p>{totals.packages} {totals.packages === 1 ? 'confezione' : 'confezioni'}</p></div>
          </div>
          {items.length ? (
            <div className="order-summary__lines">
              {items.map((item) => (
                <div className="order-summary__line" key={item.productId}>
                  <span>{item.quantity}× <strong>{item.productName}</strong><small>{item.packageLabel}{isPricedPerKg(pricedItem(item)) ? ` · ${euro.format(calculatePackageNet(pricedItem(item)))}/conf.` : ''}</small></span>
                  <b>{euro.format(calculateLineNet(pricedItem(item)))}</b>
                </div>
              ))}
              <div className="order-summary__line order-summary__line--delivery">
                <span>1× <strong>Spese di trasporto</strong><small>Una consegna · IVA {deliveryFeeVatRate}%</small></span>
                <b>{deliveryFee.net === 0 ? 'Gratuito' : euro.format(deliveryFee.net)}</b>
              </div>
            </div>
          ) : (
            <>
              <div className="order-summary__empty"><Package size={25} /><p>Il riepilogo si aggiornerà mentre scegli i prodotti.</p></div>
              <div className="order-summary__lines">
                <div className="order-summary__line order-summary__line--delivery">
                  <span>1× <strong>Spese di trasporto</strong><small>Una consegna · IVA {deliveryFeeVatRate}%</small></span>
                  <b>{deliveryFee.net === 0 ? 'Gratuito' : euro.format(deliveryFee.net)}</b>
                </div>
              </div>
            </>
          )}
          <div className="order-summary__totals">
            <div><span>Imponibile incl. trasporto</span><strong>{euro.format(orderNet)}</strong></div>
            <div><span>IVA</span><strong>{euro.format(orderVat)}</strong></div>
            <div className="order-summary__grand"><span>Totale IVA inclusa</span><strong>{euro.format(orderGross)}</strong></div>
          </div>
          {pricesChanged && <div className="order-summary__vat-note">Il listino è cambiato: il riepilogo usa i prezzi correnti, che saranno verificati dal server al salvataggio.</div>}
          {!isSupabaseMode && <div className="order-summary__vat-note">Prezzi e aliquote sono fittizi e servono solo per questa demo.</div>}
          {error && <div className="form-alert form-alert--error" role="alert">{error}</div>}
          <Button type="submit" size="lg" icon={<Check size={18} />} disabled={submitting}>
            {submitting ? 'Salvataggio…' : submitLabel ?? (initialOrder ? 'Salva modifiche' : 'Invia ordine')}
          </Button>
          {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Annulla</Button>}
          <p className="order-summary__legal">{legalText}</p>
        </Card>
      </aside>

      {items.length > 0 && (
        <div className="mobile-order-bar" aria-label="Riepilogo rapido ordine" aria-live="polite">
          <div>
            <strong>{euro.format(orderGross)}</strong>
            <span>{totals.packages} {totals.packages === 1 ? 'confezione' : 'confezioni'} selezionate</span>
          </div>
          <button type="button" onClick={openMobileCheckout}>
            Rivedi e invia
          </button>
        </div>
      )}
    </form>

    {checkoutOpen && createPortal(
      <div
        className="mobile-checkout__backdrop"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !submitting) setCheckoutOpen(false)
        }}
      >
        <section
          ref={checkoutRef}
          className="mobile-checkout"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mobile-checkout-title"
        >
          <header className="mobile-checkout__header">
            <div>
              <span>Ultimo controllo</span>
              <h2 id="mobile-checkout-title">Conferma il tuo ordine</h2>
            </div>
            <button type="button" onClick={() => setCheckoutOpen(false)} disabled={submitting} aria-label="Chiudi riepilogo">
              <X size={22} />
            </button>
          </header>

          <div className="mobile-checkout__body">
            <div className="mobile-checkout__summary">
              <div className="mobile-checkout__summary-heading">
                <strong>{totals.packages} {totals.packages === 1 ? 'confezione' : 'confezioni'}</strong>
                <span>{items.length} {items.length === 1 ? 'prodotto' : 'prodotti'}</span>
              </div>
              <div className="mobile-checkout__lines">
                {items.map((item) => (
                  <div key={item.productId}>
                    <span><b>{item.quantity}×</b> {item.productName}</span>
                    <strong>{euro.format(calculateLineNet(pricedItem(item)))}</strong>
                  </div>
                ))}
                <div className="mobile-checkout__delivery-line">
                  <span>Spese di trasporto</span>
                  <strong>{deliveryFee.net === 0 ? 'Gratuito' : euro.format(deliveryFee.net)}</strong>
                </div>
              </div>
            </div>

            <Field label="Data di consegna richiesta" htmlFor="mobile-delivery-date" error={!date && error ? 'Scegli una data per inviare l’ordine.' : undefined}>
              <div className="input-with-icon">
                <CalendarDays size={18} />
                <input
                  id="mobile-delivery-date"
                  type="date"
                  min={minDeliveryDate()}
                  value={date}
                  onChange={(event) => {
                    setDate(event.target.value)
                    if (event.target.value) setError('')
                  }}
                  required
                />
              </div>
            </Field>

            <div className="mobile-checkout__payment" role="radiogroup" aria-label="Pagamento ordine">
              <span>Pagamento</span>
              <label className={paymentMethod === 'end_of_month' ? 'active' : ''}>
                <input type="radio" name="mobile-payment-method" checked={paymentMethod === 'end_of_month'} onChange={() => setPaymentMethod('end_of_month')} />
                <span>Fattura a fine mese</span>
              </label>
              <label className={paymentMethod === 'on_delivery' ? 'active' : ''}>
                <input type="radio" name="mobile-payment-method" checked={paymentMethod === 'on_delivery'} onChange={() => setPaymentMethod('on_delivery')} />
                <span>Pagamento alla consegna</span>
              </label>
            </div>

            <Field label="Note per la consegna (facoltative)" htmlFor="mobile-order-notes" hint={`${notes.length}/300 caratteri`}>
              <textarea
                id="mobile-order-notes"
                rows={2}
                maxLength={300}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Orario preferito, accesso, altre indicazioni…"
              />
            </Field>

            <Field
              label="Codice sconto (facoltativo)"
              htmlFor="mobile-discount-code"
              hint={discountHint}
            >
              <input
                id="mobile-discount-code"
                value={discountCode}
                onChange={(event) => { setDiscountCode(event.target.value.toUpperCase()); setResolvedDiscount(null); setDiscountValidation('idle') }}
                onBlur={() => void validateDiscount()}
                placeholder="Es. SCONTO1"
              />
            </Field>

            <div className="mobile-checkout__total">
              <span>Totale IVA inclusa</span>
              <strong>{euro.format(orderGross)}</strong>
            </div>

            {error && <div className="form-alert form-alert--error" role="alert">{error}</div>}
            <p className="mobile-checkout__legal">{legalText}</p>
          </div>

          <footer className="mobile-checkout__footer">
            <button type="button" className="mobile-checkout__edit" onClick={() => setCheckoutOpen(false)} disabled={submitting}>
              Modifica ordine
            </button>
            <button type="button" className="mobile-checkout__confirm" onClick={() => void submitDraft()} disabled={submitting}>
              {submitting ? <><span className="mobile-checkout__spinner" /> Invio in corso…</> : <><Send size={18} /> Conferma e invia</>}
            </button>
          </footer>
        </section>
      </div>,
      document.body,
    )}
    </>
  )
}

interface ProductCardProps {
  product: PricedProduct
  unitPrice: number
  quantity: number
  onChange: (value: number) => void
}

const ProductCard = ({ product, unitPrice, quantity, onChange }: ProductCardProps) => {
  const perKg = isPricedPerKg(product)
  const packagePrice = calculatePackageNet({
    unitPrice,
    packageSize: product.packageSize,
    pricingMode: product.pricingMode,
  })
  return (
  <article className={`product-card ${quantity > 0 ? 'product-card--selected' : ''}`}>
    <div className="product-card__visual" aria-hidden="true">
      <span>{product.name.slice(0, 1)}</span>
      {quantity > 0 && <i><Check size={13} /></i>}
    </div>
    <div className="product-card__info">
      <span className="product-card__category">{product.category}</span>
      <h3>{product.name}</h3>
      {productPromoLabel(product) && <em className="product-card__promo">{productPromoLabel(product)}</em>}
      <p>{product.packageLabel}</p>
      {!product.active && <p className="product-card__unavailable">Non più disponibile: porta la quantità a zero.</p>}
      <div className="product-card__bottom">
        <strong className="product-card__price">
          {unitPrice !== product.price && <del>{euro.format(product.price)}</del>}
          <span>{euro.format(unitPrice)}{perKg ? '/kg' : '/unità'}</span>
          <small>{perKg ? `${euro.format(packagePrice)}/conf. · ` : ''}+ IVA{isSupabaseMode ? '' : ' demo'}</small>
        </strong>
        <div className="quantity-control" aria-label={`Quantità ${product.name}`}>
          <button type="button" onClick={() => onChange(quantity - 1)} disabled={quantity === 0} aria-label={`Riduci ${product.name}`}><Minus size={15} /></button>
          <input type="number" min="0" max={product.active ? 999 : quantity} value={quantity} onChange={(event) => onChange(Number(event.target.value))} aria-label={`Confezioni di ${product.name}`} />
          <button type="button" disabled={!product.active} onClick={() => onChange(quantity + 1)} aria-label={`Aggiungi ${product.name}`}><Plus size={15} /></button>
        </div>
      </div>
    </div>
  </article>
  )
}
