import { readdir, readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const db = new PGlite()

// PGlite does not bundle Supabase's auth, storage or pgcrypto schemas. These
// minimal test doubles let PostgreSQL parse the production migration; they are
// not used by a deployed Supabase project.
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create schema auth;
  create schema storage;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.role() returns text language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
  create table storage.buckets (
    id text primary key, name text unique, public boolean, file_size_limit bigint,
    allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(), bucket_id text not null, name text not null
  );
  create function storage.foldername(text) returns text[] language sql immutable as
    $$ select string_to_array($1, '/') $$;
`)

const migrationFiles = (await readdir('supabase/migrations'))
  .filter((file) => file.endsWith('.sql'))
  .sort()
for (const [index, file] of migrationFiles.entries()) {
  if (file === '20260802110000_ddt_bis_and_deletion.sql') {
    // Simula un contatore storico gia presente sul progetto prima del cut-over.
    await db.exec(`
      insert into public.document_counters(document_type, series, document_year, last_number)
      values ('DDT', 'A', extract(year from current_date)::integer, 41)
    `)
  }
  let migration = await readFile(`supabase/migrations/${file}`, 'utf8')
  if (index === 0) {
    migration = migration.replace(
      'create extension if not exists pgcrypto with schema extensions;',
      () => `create schema extensions;
       create function extensions.digest(text, text) returns bytea language sql immutable as
         $$ select decode(md5($1), 'hex') $$;`,
    )
  }
  await db.exec(migration)
}
await db.exec(await readFile('supabase/seed.sql', 'utf8'))

const expectFailure = async (operation, pattern, label) => {
  try {
    await operation()
  } catch (error) {
    if (pattern.test(String(error))) return true
    throw new Error(`${label} failed with an unexpected error: ${String(error)}`)
  }
  throw new Error(`${label} was expected to fail`)
}

const defaultCustomer = await db.query(`
  insert into public.customers (id, legal_name, price_list_id)
  values (
    '30000000-0000-4000-8000-000000000002',
    'Cliente default pagamento - SOLO TEST',
    '00000000-0000-4000-8000-000000000001'
  )
  returning payment_method, delivery_fee_mode
`)
if (defaultCustomer.rows[0].payment_method !== 'end_of_month' || defaultCustomer.rows[0].delivery_fee_mode !== 'standard') {
  throw new Error(`Incorrect customer payment default: ${JSON.stringify(defaultCustomer.rows[0])}`)
}

const catalog = [
  {
    sku: 'TEST-PER-KG',
    name: 'Prodotto test al kg',
    category: 'Pasta',
    description: 'Dato esclusivamente fittizio.',
    uom: 'confezione',
    package_label: 'Confezione test da 1,5 kg',
    package_size: 1.5,
    pricing_mode: 'per_kg',
    unit_price_net: 7.37,
    vat_rate: 10,
    active: true,
  },
  {
    sku: 'TEST-PER-UNIT',
    name: 'Servizio test unitario',
    category: 'Servizio',
    description: 'Dato esclusivamente fittizio.',
    uom: 'unità',
    package_label: 'Una unità test',
    package_size: null,
    pricing_mode: 'per_unit',
    unit_price_net: 2.73,
    vat_rate: 22,
    active: true,
  },
  {
    sku: 'TEST-INACTIVE',
    name: 'Prodotto test inattivo',
    category: 'Pasta',
    description: 'Dato esclusivamente fittizio.',
    uom: 'confezione',
    package_label: 'Confezione test da 1 kg',
    package_size: 1,
    pricing_mode: 'per_kg',
    unit_price_net: 1,
    vat_rate: 4,
    active: false,
  },
]

const adminId = '10000000-0000-4000-8000-000000000001'
await db.query('insert into auth.users(id, email) values ($1, $2)', [adminId, 'admin@example.invalid'])
await db.query(
  `insert into public.profiles(user_id, display_name, role, active)
   values ($1, 'Admin test', 'admin', true)`,
  [adminId],
)
await db.exec(`set request.jwt.claim.sub = '${adminId}'; set request.jwt.claim.role = 'authenticated';`)

const imported = await db.query(
  'select * from public.admin_import_catalog($1::jsonb, true)',
  [JSON.stringify(catalog)],
)
await expectFailure(
  () => db.query(
    'select * from public.admin_import_catalog($1::jsonb, false)',
    [JSON.stringify([{
      sku: 'TRASP',
      name: 'Trasporto',
      category: 'Servizio',
      description: 'Voce riservata test.',
      uom: 'servizio',
      package_label: 'Singolo',
      package_size: null,
      pricing_mode: 'per_unit',
      unit_price_net: 3.5,
      vat_rate: 22,
      active: true,
    }])],
  ),
  /delivery is added automatically/i,
  'Delivery service catalog import',
)
const counts = await db.query(`
  select count(*)::integer as total,
         count(*) filter (where active)::integer as active,
         count(*) filter (where active and pricing_mode = 'per_kg')::integer as per_kg,
         count(*) filter (where active and pricing_mode = 'per_unit')::integer as per_unit
  from public.products
`)

if (imported.rows[0].imported_count !== 3 || imported.rows[0].deactivated_count !== 3) {
  throw new Error(`Unexpected import result: ${JSON.stringify(imported.rows[0])}`)
}
if (counts.rows[0].total !== 6 || counts.rows[0].active !== 2 || counts.rows[0].per_kg !== 1 || counts.rows[0].per_unit !== 1) {
  throw new Error(`Unexpected catalog counts: ${JSON.stringify(counts.rows[0])}`)
}

const pricedItems = await db.query(`
  select id, sku from public.products where sku in ('TEST-PER-KG', 'TEST-PER-UNIT') order by sku
`)
const productIds = Object.fromEntries(pricedItems.rows.map(({ id, sku }) => [sku, id]))
const placed = await db.query(
  `select * from public.place_order(
     null, current_date + 1, 'Test calcolo server', $1::jsonb,
     'end_of_month'::public.payment_method, null,
     '30000000-0000-4000-8000-000000000001'::uuid,
     '40000000-0000-4000-8000-000000000001'::uuid
   )`,
  [JSON.stringify([
    { product_id: productIds['TEST-PER-KG'], quantity: 2 },
    { product_id: productIds['TEST-PER-UNIT'], quantity: 3 },
  ])],
)
const order = placed.rows[0]
if (Number(order.net_total) !== 33.8 || Number(order.vat_total) !== 4.78 || Number(order.gross_total) !== 38.58) {
  throw new Error(`Incorrect server totals: ${JSON.stringify(order)}`)
}
if (Number(order.delivery_fee_net) !== 3.5 || Number(order.delivery_fee_vat_rate) !== 22) {
  throw new Error(`Incorrect automatic delivery fee: ${JSON.stringify(order)}`)
}
if (
  order.payment_method_snapshot !== 'end_of_month'
  || order.payment_confirmed_at !== null
  || order.payment_confirmed_by !== null
  || order.customer_snapshot?.paymentMethod !== 'end_of_month'
) {
  throw new Error(`Incorrect default payment snapshot: ${JSON.stringify(order)}`)
}
const adminCreatedEvidence = await db.query(
  `select
     (select created_by from public.orders where id = $1) as created_by,
     (select actor_channel from public.order_status_history
      where order_id = $1 and to_status = 'draft' order by id limit 1) as draft_channel,
     (select actor_channel from public.order_status_history
      where order_id = $1 and to_status = 'submitted' order by id desc limit 1) as submit_channel`,
  [order.id],
)
if (
  adminCreatedEvidence.rows[0].created_by !== adminId
  || adminCreatedEvidence.rows[0].draft_channel !== 'admin'
  || adminCreatedEvidence.rows[0].submit_channel !== 'admin'
) {
  throw new Error(`Admin-created order evidence is incomplete: ${JSON.stringify(adminCreatedEvidence.rows[0])}`)
}

const snapshots = await db.query(
  `select sku_snapshot, package_size_snapshot, pricing_mode_snapshot, line_net
   from public.order_items where order_id = $1 order by sku_snapshot`,
  [order.id],
)
if (
  snapshots.rows[0].pricing_mode_snapshot !== 'per_kg'
  || Number(snapshots.rows[0].package_size_snapshot) !== 1.5
  || Number(snapshots.rows[0].line_net) !== 22.11
  || snapshots.rows[1].pricing_mode_snapshot !== 'per_unit'
  || snapshots.rows[1].package_size_snapshot !== null
  || Number(snapshots.rows[1].line_net) !== 8.19
) {
  throw new Error(`Incorrect order snapshots: ${JSON.stringify(snapshots.rows)}`)
}

await db.query(
  `update public.products
   set promoted = true, promo_percent_discount = 10, promo_label = 'Sconto 10%'
   where id = $1::uuid`,
  [productIds['TEST-PER-KG']],
)
const promotedCatalog = await db.query(
  `select unit_price_net, promoted, promo_percent_discount
   from public.get_catalog('30000000-0000-4000-8000-000000000001'::uuid)
   where id = $1::uuid`,
  [productIds['TEST-PER-KG']],
)
if (
  Number(promotedCatalog.rows[0]?.unit_price_net) !== 7.37
  || promotedCatalog.rows[0]?.promoted !== true
  || Number(promotedCatalog.rows[0]?.promo_percent_discount) !== 10
) {
  throw new Error(`Promoted catalog row is incorrect: ${JSON.stringify(promotedCatalog.rows)}`)
}
const promotedOrderResult = await db.query(
  `select * from public.place_order(
     null, current_date + 1, 'Test promo prodotto', $1::jsonb,
     'end_of_month'::public.payment_method, null,
     '30000000-0000-4000-8000-000000000001'::uuid,
     '40000000-0000-4000-8000-000000000005'::uuid
   )`,
  [JSON.stringify([{ product_id: productIds['TEST-PER-KG'], quantity: 1 }])],
)
const promotedOrder = promotedOrderResult.rows[0]
const promotedSnapshot = await db.query(
  'select unit_price_net from public.order_items where order_id = $1::uuid',
  [promotedOrder.id],
)
if (
  Number(promotedSnapshot.rows[0]?.unit_price_net) !== 6.63
  || Number(promotedOrder.net_total) !== 13.45
  || Number(promotedOrder.vat_total) !== 1.77
  || Number(promotedOrder.gross_total) !== 15.22
) {
  throw new Error(`Product promotion was not applied server-side: ${JSON.stringify({ promotedOrder, promotedSnapshot: promotedSnapshot.rows })}`)
}
await db.query(
  `update public.products
   set promoted = false, promo_percent_discount = null, promo_label = ''
   where id = $1::uuid`,
  [productIds['TEST-PER-KG']],
)

let fractionalQuantityRejected = false
try {
  await db.query(
    `select * from public.place_order(
       null, current_date + 1, 'Test quantità non valida', $1::jsonb,
       'end_of_month'::public.payment_method, null,
       '30000000-0000-4000-8000-000000000001'::uuid,
       '40000000-0000-4000-8000-000000000002'::uuid
     )`,
    [JSON.stringify([{ product_id: productIds['TEST-PER-KG'], quantity: 1.5 }])],
  )
} catch (error) {
  fractionalQuantityRejected = /whole number between 1 and 999/i.test(String(error))
}
if (!fractionalQuantityRejected) throw new Error('Fractional package quantities must be rejected by the server')

const defaultAcceptedResult = await db.query(
  `select * from public.admin_transition_order(
     $1::uuid, 'accepted'::public.order_status, $2::integer, 'Test pagamento mensile'
   )`,
  [order.id, order.version],
)
const defaultAccepted = defaultAcceptedResult.rows[0]
await expectFailure(
  () => db.query(
    'select * from public.admin_confirm_order_payment($1::uuid, $2::integer)',
    [defaultAccepted.id, defaultAccepted.version],
  ),
  /only on-delivery payments require confirmation/i,
  'Month-end payment confirmation',
)

await db.query(
  `update public.customers
   set payment_method = 'on_delivery'::public.payment_method
   where id = '30000000-0000-4000-8000-000000000001'::uuid`,
)

const onDeliveryPlaced = await db.query(
  `select * from public.place_order(
     null, current_date + 2, 'Test pagamento alla consegna', $1::jsonb,
     'on_delivery'::public.payment_method, null,
     '30000000-0000-4000-8000-000000000001'::uuid,
     '40000000-0000-4000-8000-000000000003'::uuid
   )`,
  [JSON.stringify([{ product_id: productIds['TEST-PER-KG'], quantity: 1 }])],
)
let onDeliveryOrder = onDeliveryPlaced.rows[0]
if (
  onDeliveryOrder.payment_method_snapshot !== 'on_delivery'
  || onDeliveryOrder.customer_snapshot?.paymentMethod !== 'on_delivery'
) {
  throw new Error(`Incorrect on-delivery payment snapshot: ${JSON.stringify(onDeliveryOrder)}`)
}

const withdrawnResult = await db.query(
  'select * from public.withdraw_order($1::uuid, $2::integer)',
  [onDeliveryOrder.id, onDeliveryOrder.version],
)
const resubmittedResult = await db.query(
  'select * from public.submit_order($1::uuid, $2::integer, $3::public.payment_method)',
  [onDeliveryOrder.id, withdrawnResult.rows[0].version, 'end_of_month'],
)
onDeliveryOrder = resubmittedResult.rows[0]
if (
  onDeliveryOrder.payment_method_snapshot !== 'end_of_month'
  || onDeliveryOrder.customer_snapshot?.paymentMethod !== 'end_of_month'
) {
  throw new Error(`Payment choice was not updated after withdrawal and resubmission: ${JSON.stringify(onDeliveryOrder)}`)
}

const submittedEvent = await db.query(
  `select payload from public.notification_outbox
   where aggregate_id = $1 and event_type = 'order.submitted'`,
  [onDeliveryOrder.id],
)
if (submittedEvent.rows.at(-1)?.payload?.payment_method !== 'end_of_month') {
  throw new Error(`Submitted outbox is missing payment snapshot: ${JSON.stringify(submittedEvent.rows)}`)
}

const deliveryChoiceWithdrawn = await db.query(
  'select * from public.withdraw_order($1::uuid, $2::integer)',
  [onDeliveryOrder.id, onDeliveryOrder.version],
)
const deliveryChoiceResubmitted = await db.query(
  'select * from public.submit_order($1::uuid, $2::integer, $3::public.payment_method)',
  [onDeliveryOrder.id, deliveryChoiceWithdrawn.rows[0].version, 'on_delivery'],
)
onDeliveryOrder = deliveryChoiceResubmitted.rows[0]
if (
  onDeliveryOrder.payment_method_snapshot !== 'on_delivery'
  || onDeliveryOrder.customer_snapshot?.paymentMethod !== 'on_delivery'
) {
  throw new Error(`Payment choice was not restored to on-delivery: ${JSON.stringify(onDeliveryOrder)}`)
}

await expectFailure(
  () => db.query(
    'select * from public.admin_confirm_order_payment($1::uuid, $2::integer)',
    [onDeliveryOrder.id, onDeliveryOrder.version],
  ),
  /only be confirmed for accepted or fulfilled orders/i,
  'Submitted order payment confirmation',
)

const acceptedResult = await db.query(
  `select * from public.admin_transition_order(
     $1::uuid, 'accepted'::public.order_status, $2::integer, 'Accettazione test'
   )`,
  [onDeliveryOrder.id, onDeliveryOrder.version],
)
const accepted = acceptedResult.rows[0]

await expectFailure(
  () => db.query(
    'select * from public.admin_confirm_order_payment($1::uuid, $2::integer)',
    [accepted.id, accepted.version - 1],
  ),
  /changed by another session/i,
  'Stale payment confirmation',
)

const clientId = '10000000-0000-4000-8000-000000000002'
await db.query('insert into auth.users(id, email) values ($1, $2)', [clientId, 'client@example.invalid'])
await db.query(
  `insert into public.profiles(user_id, display_name, role, active)
   values ($1, 'Cliente test', 'client', true)`,
  [clientId],
)
await db.query(
  `insert into public.customer_users(customer_id, user_id)
   values ('30000000-0000-4000-8000-000000000001', $1)`,
  [clientId],
)
const secondClientId = '10000000-0000-4000-8000-000000000003'
await db.query('insert into auth.users(id, email) values ($1, $2)', [secondClientId, 'client2@example.invalid'])
await expectFailure(
  () => db.query(
    `insert into public.customer_users(customer_id, user_id)
     values ('30000000-0000-4000-8000-000000000001', $1)`,
    [secondClientId],
  ),
  /duplicate key|unique constraint/i,
  'Second Auth account for the same customer',
)
await db.exec(`set request.jwt.claim.sub = '${clientId}'; set request.jwt.claim.role = 'authenticated';`)
await expectFailure(
  () => db.query(
    'select * from public.admin_confirm_order_payment($1::uuid, $2::integer)',
    [accepted.id, accepted.version],
  ),
  /administrator access required/i,
  'Non-admin payment confirmation',
)

await db.exec(`set request.jwt.claim.sub = '${adminId}'; set request.jwt.claim.role = 'authenticated';`)
const confirmedResult = await db.query(
  'select * from public.admin_confirm_order_payment($1::uuid, $2::integer)',
  [accepted.id, accepted.version],
)
const confirmed = confirmedResult.rows[0]
if (
  confirmed.payment_method_snapshot !== 'on_delivery'
  || confirmed.payment_confirmed_at === null
  || confirmed.payment_confirmed_by !== adminId
  || confirmed.version !== accepted.version + 1
) {
  throw new Error(`Incorrect payment confirmation: ${JSON.stringify(confirmed)}`)
}
await expectFailure(
  () => db.query(
    'select * from public.admin_adjust_order_fulfillment($1::uuid, $2::jsonb, $3::integer, $4::text)',
    [confirmed.id, JSON.stringify([
      { product_id: productIds['TEST-PER-KG'], fulfilled_quantity: 0 },
    ]), confirmed.version, 'Rettifica ordine già pagato'],
  ),
  /paid order requires a separate refund or integration workflow/i,
  'Fulfillment adjustment after payment confirmation',
)

const retriedResult = await db.query(
  'select * from public.admin_confirm_order_payment($1::uuid, $2::integer)',
  [accepted.id, accepted.version],
)
const retried = retriedResult.rows[0]
if (
  retried.version !== confirmed.version
  || String(retried.payment_confirmed_at) !== String(confirmed.payment_confirmed_at)
  || retried.payment_confirmed_by !== confirmed.payment_confirmed_by
) {
  throw new Error(`Payment confirmation retry was not idempotent: ${JSON.stringify(retried)}`)
}

await expectFailure(
  () => db.query(
    `select * from public.admin_transition_order(
       $1::uuid, 'cancelled'::public.order_status, $2::integer, 'Tentativo annullamento pagato'
     )`,
    [confirmed.id, confirmed.version],
  ),
  /paid order cannot be cancelled without a separate refund workflow/i,
  'Cancellation of paid order',
)

const confirmationEvidence = await db.query(
  `select
     (select count(*)::integer from public.admin_audit_log
      where action = 'order.payment_confirmed' and details ->> 'order_id' = $1::text) as audit_count,
     (select count(*)::integer from public.notification_outbox
      where event_type = 'order.payment_confirmed' and aggregate_id = $1::uuid) as outbox_count`,
  [confirmed.id],
)
if (
  confirmationEvidence.rows[0].audit_count !== 1
  || confirmationEvidence.rows[0].outbox_count !== 1
) {
  throw new Error(`Payment confirmation evidence is not unique: ${JSON.stringify(confirmationEvidence.rows[0])}`)
}

await db.query(
  `update public.customers
   set payment_method = 'end_of_month'::public.payment_method
   where id = '30000000-0000-4000-8000-000000000001'::uuid`,
)
const immutableSnapshot = await db.query(
  'select payment_method_snapshot from public.orders where id = $1',
  [confirmed.id],
)
if (immutableSnapshot.rows[0].payment_method_snapshot !== 'on_delivery') {
  throw new Error(`Order payment snapshot followed mutable customer data: ${JSON.stringify(immutableSnapshot.rows[0])}`)
}

const paymentMethodAudit = await db.query(
  `select
     count(*)::integer as change_count,
     bool_or(details ->> 'previous_payment_method' = 'end_of_month'
       and details ->> 'new_payment_method' = 'on_delivery') as recorded_to_delivery,
     bool_or(details ->> 'previous_payment_method' = 'on_delivery'
       and details ->> 'new_payment_method' = 'end_of_month') as recorded_to_month_end
   from public.admin_audit_log
   where action = 'customer.payment_method_changed'
     and customer_id = '30000000-0000-4000-8000-000000000001'::uuid`,
)
if (
  paymentMethodAudit.rows[0].change_count !== 2
  || paymentMethodAudit.rows[0].recorded_to_delivery !== true
  || paymentMethodAudit.rows[0].recorded_to_month_end !== true
) {
  throw new Error(`Customer payment method audit is incomplete: ${JSON.stringify(paymentMethodAudit.rows[0])}`)
}
await expectFailure(
  () => db.query(
    `update public.orders
     set payment_method_snapshot = 'end_of_month'::public.payment_method
     where id = $1`,
    [confirmed.id],
  ),
  /payment method snapshot is immutable/i,
  'Payment snapshot mutation',
)

const deliveryResult = await db.query(
  `select * from public.prepare_delivery_document(
     $1::uuid, $2::integer, 'TEST', current_date, now(), 'Vendita',
     '{}'::jsonb, null::jsonb, null::integer, 'DDT test pagamento'
   )`,
  [confirmed.id, confirmed.version],
)
const delivery = deliveryResult.rows[0]
const currentDocumentYear = Number((await db.query('select extract(year from current_date)::integer as year')).rows[0].year)
if (
  delivery.payment_method_snapshot !== 'on_delivery'
  || delivery.customer_snapshot?.paymentMethod !== 'on_delivery'
  || delivery.series !== 'BIS'
  || Number(delivery.sequence_number) !== 1
  || delivery.display_number !== `1bis/${currentDocumentYear}`
) {
  throw new Error(`First BIS DDT or payment snapshot is incorrect: ${JSON.stringify(delivery)}`)
}

const deliveryEvent = await db.query(
  `select payload from public.notification_outbox
   where aggregate_id = $1 and event_type = 'order.status_changed'
     and payload ->> 'to_status' = 'in_delivery'`,
  [confirmed.id],
)
if (
  deliveryEvent.rows[0]?.payload?.payment_method !== 'on_delivery'
  || deliveryEvent.rows[0]?.payload?.payment_confirmed_at === null
  || deliveryEvent.rows[0]?.payload?.payment_confirmed_at === undefined
) {
  throw new Error(`Delivery outbox is missing payment evidence: ${JSON.stringify(deliveryEvent.rows)}`)
}

await expectFailure(
  () => db.query('delete from auth.users where id = $1::uuid', [adminId]),
  /violates foreign key constraint/i,
  'Deletion of payment confirmation actor',
)

const fulfillmentPlaced = await db.query(
  `select * from public.place_order(
     null, current_date + 3, 'Test evasione parziale', $1::jsonb,
     'end_of_month'::public.payment_method, null,
     '30000000-0000-4000-8000-000000000001'::uuid,
     '40000000-0000-4000-8000-000000000004'::uuid
   )`,
  [JSON.stringify([
    { product_id: productIds['TEST-PER-KG'], quantity: 4 },
    { product_id: productIds['TEST-PER-UNIT'], quantity: 2 },
  ])],
)
let fulfillmentOrder = fulfillmentPlaced.rows[0]
const fulfillmentAccepted = await db.query(
  `select * from public.admin_transition_order(
     $1::uuid, 'accepted'::public.order_status, $2::integer, 'Accettazione evasione test'
   )`,
  [fulfillmentOrder.id, fulfillmentOrder.version],
)
fulfillmentOrder = fulfillmentAccepted.rows[0]

const firstAdjustment = await db.query(
  'select * from public.admin_adjust_order_fulfillment($1::uuid, $2::jsonb, $3::integer, $4::text)',
  [fulfillmentOrder.id, JSON.stringify([
    { product_id: productIds['TEST-PER-KG'], fulfilled_quantity: 3 },
    { product_id: productIds['TEST-PER-UNIT'], fulfilled_quantity: 1 },
  ]), fulfillmentOrder.version, 'Disponibilità parziale test'],
)
fulfillmentOrder = firstAdjustment.rows[0]
if (
  Number(fulfillmentOrder.net_total) !== 39.4
  || Number(fulfillmentOrder.vat_total) !== 4.69
  || Number(fulfillmentOrder.gross_total) !== 44.09
) {
  throw new Error(`Incorrect first fulfillment totals: ${JSON.stringify(fulfillmentOrder)}`)
}
const firstFulfilledItems = await db.query(
  `select sku_snapshot, quantity, fulfilled_quantity
   from public.order_items where order_id = $1 order by sku_snapshot`,
  [fulfillmentOrder.id],
)
if (
  Number(firstFulfilledItems.rows[0].quantity) !== 4
  || Number(firstFulfilledItems.rows[0].fulfilled_quantity) !== 3
  || Number(firstFulfilledItems.rows[1].quantity) !== 2
  || Number(firstFulfilledItems.rows[1].fulfilled_quantity) !== 1
) {
  throw new Error(`Ordered quantities were not preserved: ${JSON.stringify(firstFulfilledItems.rows)}`)
}

const firstPartialDdt = await db.query(
  `select * from public.prepare_delivery_document(
     $1::uuid, $2::integer, 'PART', current_date, now(), 'Vendita',
     '{}'::jsonb, null::jsonb, null::integer, 'DDT evasione parziale test'
   )`,
  [fulfillmentOrder.id, fulfillmentOrder.version],
)
const partialDdt = firstPartialDdt.rows[0]
const partialQuantities = partialDdt.items_snapshot.map((item) => Number(item.quantity)).sort((a, b) => a - b)
const orderedQuantities = partialDdt.items_snapshot.map((item) => Number(item.orderedQuantity)).sort((a, b) => a - b)
if (
  JSON.stringify(partialQuantities) !== JSON.stringify([1, 3])
  || JSON.stringify(orderedQuantities) !== JSON.stringify([2, 4])
  || Number(partialDdt.packages) !== 3
  || Number(partialDdt.delivery_fee_net) !== 3.5
  || Number(partialDdt.delivery_fee_vat_rate) !== 22
) {
  throw new Error(`DDT does not use fulfilled quantities: ${JSON.stringify(partialDdt)}`)
}

fulfillmentOrder = (await db.query('select * from public.orders where id = $1', [fulfillmentOrder.id])).rows[0]
await db.exec(`set request.jwt.claim.sub = '${clientId}'; set request.jwt.claim.role = 'authenticated';`)
await expectFailure(
  () => db.query(
    'select * from public.admin_adjust_order_fulfillment($1::uuid, $2::jsonb, $3::integer, $4::text)',
    [fulfillmentOrder.id, JSON.stringify([
      { product_id: productIds['TEST-PER-KG'], fulfilled_quantity: 2 },
      { product_id: productIds['TEST-PER-UNIT'], fulfilled_quantity: 1 },
    ]), fulfillmentOrder.version, 'Tentativo cliente'],
  ),
  /administrator access required/i,
  'Non-admin fulfillment adjustment',
)
await expectFailure(
  () => db.query(
    'select * from public.admin_update_delivery_fee($1::uuid, $2::numeric)',
    [partialDdt.id, 4.2],
  ),
  /administrator access required/i,
  'Non-admin delivery fee update',
)

await db.exec(`set request.jwt.claim.sub = '${adminId}'; set request.jwt.claim.role = 'authenticated';`)
const updatedFeeDocument = (await db.query(
  'select * from public.admin_update_delivery_fee($1::uuid, $2::numeric)',
  [partialDdt.id, 4.2],
)).rows[0]
if (Number(updatedFeeDocument.delivery_fee_net) !== 4.2 || Number(updatedFeeDocument.delivery_fee_vat_rate) !== 22) {
  throw new Error(`Delivery fee update failed: ${JSON.stringify(updatedFeeDocument)}`)
}
fulfillmentOrder = (await db.query('select * from public.orders where id = $1', [fulfillmentOrder.id])).rows[0]
const deliveredFulfillment = await db.query(
  `select * from public.admin_transition_order(
     $1::uuid, 'delivered'::public.order_status, $2::integer, 'Consegna parziale test'
   )`,
  [fulfillmentOrder.id, fulfillmentOrder.version],
)
fulfillmentOrder = deliveredFulfillment.rows[0]
const deliveredAdjustment = await db.query(
  'select * from public.admin_adjust_order_fulfillment($1::uuid, $2::jsonb, $3::integer, $4::text)',
  [fulfillmentOrder.id, JSON.stringify([
    { product_id: productIds['TEST-PER-KG'], fulfilled_quantity: 5 },
    { product_id: productIds['TEST-PER-UNIT'], fulfilled_quantity: 3 },
  ]), fulfillmentOrder.version, 'Aumento quantità dopo consegna test'],
)
fulfillmentOrder = deliveredAdjustment.rows[0]
if (
  fulfillmentOrder.status !== 'delivered'
  || Number(fulfillmentOrder.net_total) !== 67.67
  || Number(fulfillmentOrder.vat_total) !== 8.25
  || Number(fulfillmentOrder.gross_total) !== 75.92
) {
  throw new Error(`Delivered adjustment changed status or totals incorrectly: ${JSON.stringify(fulfillmentOrder)}`)
}

await expectFailure(
  () => db.query(
    'select * from public.admin_adjust_order_fulfillment($1::uuid, $2::jsonb, $3::integer, $4::text)',
    [fulfillmentOrder.id, JSON.stringify([
      { product_id: productIds['TEST-PER-KG'], fulfilled_quantity: 1000 },
      { product_id: productIds['TEST-PER-UNIT'], fulfilled_quantity: 3 },
    ]), fulfillmentOrder.version, 'Superamento limite test'],
  ),
  /between zero and 999/i,
  'Fulfillment quantity above 999',
)
const increasedFulfilledItems = await db.query(
  `select sku_snapshot, quantity, fulfilled_quantity
   from public.order_items where order_id = $1 order by sku_snapshot`,
  [fulfillmentOrder.id],
)
if (
  Number(increasedFulfilledItems.rows[0].quantity) !== 4
  || Number(increasedFulfilledItems.rows[0].fulfilled_quantity) !== 5
  || Number(increasedFulfilledItems.rows[1].quantity) !== 2
  || Number(increasedFulfilledItems.rows[1].fulfilled_quantity) !== 3
) {
  throw new Error(`Increased fulfillment did not preserve requested quantities: ${JSON.stringify(increasedFulfilledItems.rows)}`)
}

const replacementDocuments = await db.query(
  `select id, status, sequence_number, revision_number, replaces_document_id, items_snapshot, packages,
          delivery_fee_net, delivery_fee_vat_rate
   from public.delivery_documents where order_id = $1 order by sequence_number`,
  [fulfillmentOrder.id],
)
const voidDocument = replacementDocuments.rows.find((document) => document.status === 'void')
const readyReplacement = replacementDocuments.rows.find((document) => document.status === 'ready')
if (
  replacementDocuments.rows.length !== 2
  || !voidDocument
  || !readyReplacement
  || readyReplacement.replaces_document_id !== voidDocument.id
  || Number(readyReplacement.revision_number) !== 1
  || Number(readyReplacement.sequence_number) <= Number(voidDocument.sequence_number)
  || Number(readyReplacement.delivery_fee_net) !== 4.2
  || Number(readyReplacement.delivery_fee_vat_rate) !== 22
  || Number(readyReplacement.packages) !== 5
  || JSON.stringify(readyReplacement.items_snapshot.map((item) => Number(item.quantity)).sort((a, b) => a - b)) !== JSON.stringify([3, 5])
  || JSON.stringify(readyReplacement.items_snapshot.map((item) => Number(item.orderedQuantity)).sort((a, b) => a - b)) !== JSON.stringify([2, 4])
) {
  throw new Error(`Replacement DDT history is incorrect: ${JSON.stringify(replacementDocuments.rows)}`)
}

const fulfillmentAudit = await db.query(
  `select count(*)::integer as audit_count
   from public.admin_audit_log
   where action = 'order.fulfillment_adjusted'
     and details ->> 'order_id' = $1::text`,
  [fulfillmentOrder.id],
)
if (fulfillmentAudit.rows[0].audit_count !== 2) {
  throw new Error(`Fulfillment audit is incomplete: ${JSON.stringify(fulfillmentAudit.rows[0])}`)
}

const discountId = 'discount-backend-test'
await db.query(
  `insert into public.discount_codes (
     id, code, description, active, product_price_overrides,
     product_percent_discounts, free_delivery
   ) values ($1, 'TEST20', 'Sconto backend test', true, $2::jsonb, $3::jsonb, true)`,
  [
    discountId,
    JSON.stringify({ [productIds['TEST-PER-UNIT']]: 1.5 }),
    JSON.stringify({ [productIds['TEST-PER-KG']]: 20 }),
  ],
)
const resolvedDiscount = await db.query(
  `select * from public.resolve_discount_code(
     'test20', '30000000-0000-4000-8000-000000000001'::uuid
   )`,
)
if (resolvedDiscount.rows[0]?.code !== 'TEST20' || resolvedDiscount.rows[0]?.free_delivery !== true) {
  throw new Error(`Discount resolution failed: ${JSON.stringify(resolvedDiscount.rows)}`)
}

const discountedOrderResult = await db.query(
  `select * from public.place_order_with_discount(
     null, current_date + 1, 'Test codice sconto', $1::jsonb,
     'end_of_month'::public.payment_method, null,
     '30000000-0000-4000-8000-000000000001'::uuid,
     '40000000-0000-4000-8000-000000000099'::uuid,
     'TEST20'
   )`,
  [JSON.stringify([
    { product_id: productIds['TEST-PER-KG'], quantity: 1 },
    { product_id: productIds['TEST-PER-UNIT'], quantity: 1 },
  ])],
)
let discountedOrder = discountedOrderResult.rows[0]
const discountedSnapshots = await db.query(
  `select sku_snapshot, unit_price_net from public.order_items
   where order_id = $1 order by sku_snapshot`,
  [discountedOrder.id],
)
if (
  discountedOrder.discount_code !== 'TEST20'
  || Number(discountedOrder.delivery_fee_net) !== 0
  || Number(discountedOrder.net_total) !== 10.34
  || Number(discountedOrder.vat_total) !== 1.21
  || Number(discountedOrder.gross_total) !== 11.55
  || Number(discountedSnapshots.rows[0].unit_price_net) !== 5.896
  || Number(discountedSnapshots.rows[1].unit_price_net) !== 1.5
) {
  throw new Error(`Discounted order is incorrect: ${JSON.stringify({ discountedOrder, rows: discountedSnapshots.rows })}`)
}
const discountedRetry = (await db.query(
  `select * from public.place_order_with_discount(
     null, current_date + 1, 'Test codice sconto', $1::jsonb,
     'end_of_month'::public.payment_method, null,
     '30000000-0000-4000-8000-000000000001'::uuid,
     '40000000-0000-4000-8000-000000000099'::uuid,
     'TEST20'
   )`,
  [JSON.stringify([
    { product_id: productIds['TEST-PER-KG'], quantity: 1 },
    { product_id: productIds['TEST-PER-UNIT'], quantity: 1 },
  ])],
)).rows[0]
if (Number(discountedRetry.net_total) !== 10.34 || Number(discountedRetry.gross_total) !== 11.55) {
  throw new Error(`Idempotent discount retry compounded prices: ${JSON.stringify(discountedRetry)}`)
}

discountedOrder = (await db.query(
  `select * from public.admin_transition_order(
     $1::uuid, 'accepted'::public.order_status, $2::integer, 'Accettazione test modifica pagamento'
   )`,
  [discountedOrder.id, discountedOrder.version],
)).rows[0]
discountedOrder = (await db.query(
  `select * from public.admin_update_order_payment_method(
     $1::uuid, 'on_delivery'::public.payment_method
   )`,
  [discountedOrder.id],
)).rows[0]
if (discountedOrder.payment_method_snapshot !== 'on_delivery') {
  throw new Error(`Accepted order payment method was not updated: ${JSON.stringify(discountedOrder)}`)
}
const editableDdt = (await db.query(
  `select * from public.prepare_delivery_document(
     $1::uuid, $2::integer, 'EDIT', current_date, now(), 'Vendita',
     '{}'::jsonb, null::jsonb, null::integer, 'DDT editabile test'
   )`,
  [discountedOrder.id, discountedOrder.version],
)).rows[0]
await expectFailure(
  () => db.query(
    `select * from public.admin_update_delivery_document_metadata(
       $1::uuid, 'DDT-TEST-NON-CONSENTITO', current_date,
       'end_of_month'::public.payment_method
     )`,
    [editableDdt.id],
  ),
  /BIS delivery document number is immutable/i,
  'BIS document number mutation',
)
const editedDdt = (await db.query(
  `select * from public.admin_update_delivery_document_metadata(
     $1::uuid, $2::text,
     greatest(current_date - 5, date_trunc('year', current_date)::date),
     'end_of_month'::public.payment_method
   )`,
  [editableDdt.id, editableDdt.display_number],
)).rows[0]
const editedOrder = (await db.query('select * from public.orders where id = $1', [discountedOrder.id])).rows[0]
if (
  editedDdt.display_number !== editableDdt.display_number
  || String(editedDdt.issued_on) !== String((await db.query(
    "select greatest(current_date - 5, date_trunc('year', current_date)::date) as expected_date",
  )).rows[0].expected_date)
  || editedDdt.payment_method_snapshot !== 'end_of_month'
  || editedOrder.payment_method_snapshot !== 'end_of_month'
) {
  throw new Error(`DDT metadata update failed: ${JSON.stringify({ editedDdt, editedOrder })}`)
}

await expectFailure(
  () => db.query(
    'select * from public.admin_delete_delivery_document($1::uuid, $2::text, $3::text)',
    [delivery.id, delivery.display_number, 'Tentativo eliminazione DDT pagato'],
  ),
  /paid delivery document cannot be deleted/i,
  'Paid DDT deletion',
)
await expectFailure(
  () => db.query(
    'select * from public.admin_delete_delivery_document($1::uuid, $2::text, $3::text)',
    [editedDdt.id, 'numero errato', 'Conferma numero errata'],
  ),
  /number confirmation does not match/i,
  'DDT deletion confirmation',
)

await db.exec(`set request.jwt.claim.sub = '${clientId}'; set request.jwt.claim.role = 'authenticated';`)
await expectFailure(
  () => db.query(
    'select * from public.admin_delete_delivery_document($1::uuid, $2::text, $3::text)',
    [editedDdt.id, editedDdt.display_number, 'Tentativo cliente'],
  ),
  /administrator access required/i,
  'Non-admin DDT deletion',
)
await db.exec(`set request.jwt.claim.sub = '${adminId}'; set request.jwt.claim.role = 'authenticated';`)

const deletedDdt = (await db.query(
  'select * from public.admin_delete_delivery_document($1::uuid, $2::text, $3::text)',
  [editedDdt.id, editedDdt.display_number, 'Documento di prova da riemettere'],
)).rows[0]
const reopenedOrder = (await db.query(
  'select * from public.orders where id = $1::uuid',
  [editedDdt.order_id],
)).rows[0]
const deletionEvidence = (await db.query(
  `select count(*)::integer as audit_count
   from public.admin_audit_log
   where action = 'delivery_document.deleted'
     and details ->> 'delivery_document_id' = $1::text`,
  [editedDdt.id],
)).rows[0]
if (
  deletedDdt.status !== 'void'
  || reopenedOrder.status !== 'accepted'
  || reopenedOrder.version !== editedOrder.version + 1
  || deletionEvidence.audit_count !== 1
) {
  throw new Error(`DDT logical deletion failed: ${JSON.stringify({ deletedDdt, reopenedOrder, deletionEvidence })}`)
}
await db.query(
  'select * from public.admin_delete_delivery_document($1::uuid, $2::text, $3::text)',
  [editedDdt.id, editedDdt.display_number, 'Retry idempotente'],
)
const deletionAuditAfterRetry = (await db.query(
  `select count(*)::integer as audit_count
   from public.admin_audit_log
   where action = 'delivery_document.deleted'
     and details ->> 'delivery_document_id' = $1::text`,
  [editedDdt.id],
)).rows[0]
if (deletionAuditAfterRetry.audit_count !== 1) {
  throw new Error(`DDT deletion retry duplicated audit: ${JSON.stringify(deletionAuditAfterRetry)}`)
}
const reissuedDdt = (await db.query(
  `select * from public.prepare_delivery_document(
     $1::uuid, $2::integer, 'A', current_date, now(), 'Vendita',
     '{}'::jsonb, null::jsonb, null::integer, 'Riemissione dopo eliminazione test'
   )`,
  [reopenedOrder.id, reopenedOrder.version],
)).rows[0]
if (
  reissuedDdt.series !== 'BIS'
  || Number(reissuedDdt.sequence_number) <= Number(editedDdt.sequence_number)
  || reissuedDdt.display_number !== `${Number(reissuedDdt.sequence_number)}bis/${currentDocumentYear}`
) {
  throw new Error(`DDT reissue reused or misformatted a number: ${JSON.stringify(reissuedDdt)}`)
}

const customerBatch = [{
  legal_name: 'Cliente manuale senza account - SOLO TEST',
  contact_name: '',
  vat_number: '09999999999',
  tax_code: '',
  sdi_code: '',
  pec: '',
  email: '',
  phone: '',
  billing_address: {
    street: 'Via test 1', city: 'Roma', province: 'RM', postalCode: '00100', country: 'Italia',
  },
  shipping_address: {
    street: 'Via test 1', city: 'Roma', province: 'RM', postalCode: '00100', country: 'Italia',
  },
  payment_method: 'end_of_month',
  delivery_fee_mode: 'standard',
  active: true,
}]

// La normale scheda cliente usa INSERT/UPDATE diretto con il ruolo
// authenticated: anche l'indice normalizzato deve essere valutabile con gli
// stessi privilegi di un admin reale.
await db.exec('set role authenticated')
try {
  await db.query(
    `insert into public.customers (legal_name, vat_number, price_list_id)
     values ('Cliente inserimento RLS - SOLO TEST', '08888888888',
             '00000000-0000-4000-8000-000000000001'::uuid)`,
  )
} finally {
  await db.exec('reset role')
}

const importedCustomers = await db.query(
  'select * from public.admin_upsert_customers($1::jsonb)',
  [JSON.stringify(customerBatch)],
)
const manualCustomerId = importedCustomers.rows[0]?.customer_id
const importedCustomerEvidence = (await db.query(
  `select c.email,
          (select count(*)::integer from public.customer_users cu where cu.customer_id = c.id) as identity_count
   from public.customers c where c.id = $1::uuid`,
  [manualCustomerId],
)).rows[0]
if (
  importedCustomers.rows.length !== 1
  || importedCustomers.rows[0].outcome !== 'inserted'
  || importedCustomerEvidence.email !== ''
  || importedCustomerEvidence.identity_count !== 0
) {
  throw new Error(`Manual customer import created identity or changed blank email: ${JSON.stringify({ importedCustomers: importedCustomers.rows, importedCustomerEvidence })}`)
}
const repeatedCustomerImport = await db.query(
  'select * from public.admin_upsert_customers($1::jsonb)',
  [JSON.stringify(customerBatch)],
)
if (repeatedCustomerImport.rows[0]?.customer_id !== manualCustomerId || repeatedCustomerImport.rows[0]?.outcome !== 'unchanged') {
  throw new Error(`Customer batch upsert is not idempotent: ${JSON.stringify(repeatedCustomerImport.rows)}`)
}

await db.query(
  `update public.customers
   set payment_method = 'on_delivery', delivery_fee_mode = 'free',
       phone = '+39 000 000000', tax_code = 'TEST-PRESERVE'
   where id = $1::uuid`,
  [manualCustomerId],
)
const sparseReimport = await db.query(
  'select * from public.admin_upsert_customers($1::jsonb)',
  [JSON.stringify([{
    legal_name: 'Cliente manuale aggiornato - SOLO TEST',
    vat_number: '09999999999',
  }])],
)
const preservedCustomerSettings = (await db.query(
  `select payment_method, delivery_fee_mode, phone, tax_code
   from public.customers where id = $1::uuid`,
  [manualCustomerId],
)).rows[0]
if (
  sparseReimport.rows[0]?.outcome !== 'updated'
  || preservedCustomerSettings.payment_method !== 'on_delivery'
  || preservedCustomerSettings.delivery_fee_mode !== 'free'
  || preservedCustomerSettings.phone !== '+39 000 000000'
  || preservedCustomerSettings.tax_code !== 'TEST-PRESERVE'
) {
  throw new Error(`Sparse customer re-import reset existing values: ${JSON.stringify({
    sparseReimport: sparseReimport.rows,
    preservedCustomerSettings,
  })}`)
}

const manualCustomerOrder = (await db.query(
  `select * from public.place_order(
     null, current_date + 4, 'Ordine admin senza account cliente', $1::jsonb,
     'end_of_month'::public.payment_method, null, $2::uuid,
     '40000000-0000-4000-8000-000000000100'::uuid
   )`,
  [JSON.stringify([{ product_id: productIds['TEST-PER-UNIT'], quantity: 1 }]), manualCustomerId],
)).rows[0]
if (
  manualCustomerOrder.status !== 'submitted'
  || manualCustomerOrder.customer_id !== manualCustomerId
  || manualCustomerOrder.created_by !== adminId
  || manualCustomerOrder.customer_snapshot?.email !== ''
) {
  throw new Error(`Admin could not order for a customer without identity: ${JSON.stringify(manualCustomerOrder)}`)
}

await db.exec(`set request.jwt.claim.sub = '${clientId}'; set request.jwt.claim.role = 'authenticated';`)
await expectFailure(
  () => db.query('select * from public.admin_upsert_customers($1::jsonb)', [JSON.stringify(customerBatch)]),
  /active administrator required/i,
  'Non-admin customer batch import',
)
let clientDocumentVisibility
await db.exec('set role authenticated')
try {
  clientDocumentVisibility = (await db.query(`
    select
      count(*) filter (where status = 'ready')::integer as ready_count,
      count(*) filter (where status = 'void')::integer as void_count
    from public.delivery_documents
  `)).rows[0]
} finally {
  await db.exec('reset role')
}
if (clientDocumentVisibility.ready_count < 1 || clientDocumentVisibility.void_count !== 0) {
  throw new Error(`Client DDT visibility exposed void history: ${JSON.stringify(clientDocumentVisibility)}`)
}
await db.exec(`set request.jwt.claim.sub = '${adminId}'; set request.jwt.claim.role = 'authenticated';`)

const legacyCounterEvidence = (await db.query(`
  select last_number::integer
  from public.document_counters
  where document_type = 'DDT' and series = 'A'
`)).rows[0]
const obsoleteCounterEvidence = (await db.query(`
  select count(*)::integer as counter_count
  from public.document_counters
  where document_type = 'DDT' and series not in ('A', 'BIS')
`)).rows[0]
if (legacyCounterEvidence?.last_number !== 41 || obsoleteCounterEvidence.counter_count !== 0) {
  throw new Error(`BIS cut-over changed or consumed obsolete counters: ${JSON.stringify({
    legacyCounterEvidence,
    obsoleteCounterEvidence,
  })}`)
}

await db.exec(`update private.project_heartbeat set last_seen_at = now() - interval '2 hours'`)
let firstHeartbeat
let repeatedHeartbeat
await db.exec('set role anon')
try {
  await expectFailure(
    () => db.query('select * from private.project_heartbeat'),
    /permission denied/i,
    'Anonymous heartbeat table read',
  )
  firstHeartbeat = (await db.query('select public.keep_project_active() as seen_at')).rows[0].seen_at
  repeatedHeartbeat = (await db.query('select public.keep_project_active() as seen_at')).rows[0].seen_at
} finally {
  await db.exec('reset role')
}
if (
  !firstHeartbeat
  || String(firstHeartbeat) !== String(repeatedHeartbeat)
  || Date.now() - new Date(firstHeartbeat).getTime() > 60_000
) {
  throw new Error(`Heartbeat RPC is unavailable or not rate limited: ${JSON.stringify({ firstHeartbeat, repeatedHeartbeat })}`)
}

console.log(JSON.stringify({
  migration: 'ok',
  seedProducts: 3,
  imported: imported.rows[0],
  catalog: counts.rows[0],
  orderTotals: {
    net: Number(order.net_total),
    vat: Number(order.vat_total),
    gross: Number(order.gross_total),
  },
  fractionalQuantityRejected,
  payments: {
    customerDefault: defaultCustomer.rows[0].payment_method,
    monthEndSnapshot: order.payment_method_snapshot,
    onDeliverySnapshot: onDeliveryOrder.payment_method_snapshot,
    resubmittedSnapshot: onDeliveryOrder.customer_snapshot?.paymentMethod,
    confirmedVersion: confirmed.version,
    retryVersion: retried.version,
    auditCount: confirmationEvidence.rows[0].audit_count,
    outboxCount: confirmationEvidence.rows[0].outbox_count,
    customerMethodAuditCount: paymentMethodAudit.rows[0].change_count,
    ddtSnapshot: delivery.payment_method_snapshot,
  },
  discountsAndDocuments: {
    code: discountedOrder.discount_code,
    net: Number(discountedOrder.net_total),
    editedDdtNumber: editedDdt.display_number,
    editedDdtPayment: editedDdt.payment_method_snapshot,
  },
  fulfillment: {
    status: fulfillmentOrder.status,
    net: Number(fulfillmentOrder.net_total),
    auditCount: fulfillmentAudit.rows[0].audit_count,
    documentCount: replacementDocuments.rows.length,
    replacementRevision: Number(readyReplacement.revision_number),
  },
}, null, 2))

await db.close()
