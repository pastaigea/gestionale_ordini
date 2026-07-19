-- IGEA order management: initial database, authorization and workflow.
-- No production customer or supplier data belongs in this migration.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;

create type public.app_role as enum ('client', 'admin');
create type public.order_status as enum (
  'draft',
  'submitted',
  'accepted',
  'rejected',
  'in_delivery',
  'delivered',
  'cancelled'
);
create type public.document_status as enum ('generating', 'ready', 'void');
create type public.order_actor_channel as enum ('client', 'admin', 'telegram', 'system');
create type public.outbox_status as enum ('pending', 'processing', 'delivered', 'failed');
create type public.product_pricing_mode as enum ('per_kg', 'per_unit');
create type public.payment_method as enum ('end_of_month', 'on_delivery');

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 1 and 160),
  role public.app_role not null default 'client',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.supplier_settings (
  id smallint primary key default 1 check (id = 1),
  legal_name text not null default '',
  owner_name text not null default '',
  vat_number text not null default '',
  tax_code text not null default '',
  email text not null default '',
  phone text not null default '',
  pec text not null default '',
  sdi_code text not null default '',
  registered_address jsonb not null default '{}'::jsonb check (jsonb_typeof(registered_address) = 'object'),
  shipping_origin jsonb not null default '{}'::jsonb check (jsonb_typeof(shipping_origin) = 'object'),
  bank_name text not null default '',
  iban text not null default '',
  updated_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique check (length(btrim(sku)) between 1 and 64),
  name text not null check (length(btrim(name)) between 1 and 160),
  category text not null default '',
  description text not null default '',
  uom text not null default 'confezione',
  package_label text not null default '',
  package_size numeric(12,3) check (package_size is null or package_size > 0),
  pricing_mode public.product_pricing_mode not null default 'per_kg',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (pricing_mode = 'per_unit' or package_size is not null)
);

create table public.price_lists (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(btrim(name)) between 1 and 160),
  currency char(3) not null default 'EUR' check (currency = upper(currency)),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null check (length(btrim(legal_name)) between 1 and 200),
  contact_name text not null default '',
  vat_number text not null default '',
  tax_code text not null default '',
  sdi_code text not null default '',
  pec text not null default '',
  email text not null default '',
  phone text not null default '',
  billing_address jsonb not null default '{}'::jsonb check (jsonb_typeof(billing_address) = 'object'),
  shipping_address jsonb not null default '{}'::jsonb check (jsonb_typeof(shipping_address) = 'object'),
  price_list_id uuid references public.price_lists(id) on delete restrict,
  payment_method public.payment_method not null default 'end_of_month',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.customer_users (
  customer_id uuid not null references public.customers(id) on delete restrict,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (customer_id, user_id)
);

create table public.price_list_items (
  price_list_id uuid not null references public.price_lists(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  valid_from date not null default current_date,
  valid_to date,
  unit_price_net numeric(12,4) not null check (unit_price_net >= 0),
  vat_rate numeric(5,2) not null check (vat_rate between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (price_list_id, product_id, valid_from),
  check (valid_to is null or valid_to >= valid_from)
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint generated always as identity unique,
  customer_id uuid not null references public.customers(id) on delete restrict,
  client_request_id uuid,
  status public.order_status not null default 'draft',
  requested_delivery_date date not null,
  notes text not null default '',
  customer_snapshot jsonb,
  supplier_snapshot jsonb,
  payment_method_snapshot public.payment_method,
  payment_confirmed_at timestamptz,
  payment_confirmed_by uuid references auth.users(id) on delete restrict,
  net_total numeric(14,2) not null default 0 check (net_total >= 0),
  vat_total numeric(14,2) not null default 0 check (vat_total >= 0),
  gross_total numeric(14,2) not null default 0 check (gross_total >= 0),
  version integer not null default 1 check (version > 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  accepted_at timestamptz,
  rejected_at timestamptz,
  delivered_at timestamptz,
  unique (customer_id, client_request_id),
  check (status in ('draft', 'cancelled') or payment_method_snapshot is not null),
  check (
    (payment_confirmed_at is null and payment_confirmed_by is null)
    or (payment_confirmed_at is not null and payment_confirmed_by is not null)
  ),
  check (payment_confirmed_at is null or payment_method_snapshot = 'on_delivery')
);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  sku_snapshot text not null,
  name_snapshot text not null,
  category_snapshot text not null default '',
  uom_snapshot text not null,
  package_label_snapshot text not null default '',
  package_size_snapshot numeric(12,3) check (package_size_snapshot is null or package_size_snapshot > 0),
  pricing_mode_snapshot public.product_pricing_mode not null,
  quantity numeric(12,3) not null check (quantity > 0 and quantity <= 999 and quantity = trunc(quantity)),
  unit_price_net numeric(12,4) not null check (unit_price_net >= 0),
  vat_rate numeric(5,2) not null check (vat_rate between 0 and 100),
  line_net numeric(14,2) not null check (line_net >= 0),
  line_vat numeric(14,2) not null check (line_vat >= 0),
  line_gross numeric(14,2) not null check (line_gross >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, product_id),
  check (pricing_mode_snapshot = 'per_unit' or package_size_snapshot is not null)
);

create table public.order_status_history (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  from_status public.order_status,
  to_status public.order_status not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_external_id text,
  actor_channel public.order_actor_channel not null,
  note text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create table public.document_counters (
  document_type text not null,
  series text not null,
  document_year integer not null check (document_year between 2000 and 9999),
  last_number bigint not null check (last_number > 0),
  updated_at timestamptz not null default now(),
  primary key (document_type, series, document_year)
);

create table public.delivery_documents (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  series text not null default 'A',
  document_year integer not null check (document_year between 2000 and 9999),
  sequence_number bigint not null check (sequence_number > 0),
  display_number text not null unique,
  issued_on date not null,
  transport_started_at timestamptz,
  transport_reason text not null default 'Vendita',
  carrier_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(carrier_snapshot) = 'object'),
  destination_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(destination_snapshot) = 'object'),
  supplier_snapshot jsonb not null check (jsonb_typeof(supplier_snapshot) = 'object'),
  customer_snapshot jsonb not null check (jsonb_typeof(customer_snapshot) = 'object'),
  payment_method_snapshot public.payment_method not null,
  items_snapshot jsonb not null check (jsonb_typeof(items_snapshot) = 'array'),
  packages integer check (packages is null or packages > 0),
  notes text not null default '',
  status public.document_status not null default 'generating',
  pdf_object_path text,
  pdf_sha256 text check (pdf_sha256 is null or pdf_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (series, document_year, sequence_number),
  check (
    (pdf_object_path is null and pdf_sha256 is null)
    or (pdf_object_path is not null and pdf_sha256 is not null)
  )
);

create table public.notification_outbox (
  id bigint generated always as identity primary key,
  event_type text not null,
  aggregate_id uuid not null,
  dedupe_key text not null unique,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  status public.outbox_status not null default 'pending',
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  processed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.telegram_action_tokens (
  id uuid primary key default gen_random_uuid(),
  outbox_id bigint not null unique references public.notification_outbox(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  order_version integer not null check (order_version > 0),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_action public.order_status check (used_action in ('accepted', 'rejected')),
  chat_id bigint not null,
  message_id bigint,
  created_at timestamptz not null default now(),
  check (used_action is null or used_at is not null)
);

create table public.telegram_updates (
  update_id bigint primary key,
  processed_at timestamptz not null default now()
);

create table public.admin_audit_log (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_user_id uuid references auth.users(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now()
);

create index customer_users_user_id_idx on public.customer_users(user_id);
create index customers_price_list_id_idx on public.customers(price_list_id);
create index price_list_items_product_id_idx on public.price_list_items(product_id);
create index orders_customer_id_created_at_idx on public.orders(customer_id, created_at desc);
create index orders_status_requested_date_idx on public.orders(status, requested_delivery_date);
create index orders_unpaid_on_delivery_idx
on public.orders(status, requested_delivery_date)
where payment_method_snapshot = 'on_delivery' and payment_confirmed_at is null;
create index order_items_order_id_idx on public.order_items(order_id);
create index order_status_history_order_id_idx on public.order_status_history(order_id, created_at desc);
create index delivery_documents_customer_id_idx on public.delivery_documents(customer_id, issued_on desc);
create index notification_outbox_pending_idx on public.notification_outbox(status, available_at, id);
create index telegram_action_tokens_order_id_idx on public.telegram_action_tokens(order_id);

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles
for each row execute function private.set_updated_at();
create trigger supplier_settings_set_updated_at before update on public.supplier_settings
for each row execute function private.set_updated_at();
create trigger products_set_updated_at before update on public.products
for each row execute function private.set_updated_at();
create trigger price_lists_set_updated_at before update on public.price_lists
for each row execute function private.set_updated_at();
create trigger customers_set_updated_at before update on public.customers
for each row execute function private.set_updated_at();
create trigger price_list_items_set_updated_at before update on public.price_list_items
for each row execute function private.set_updated_at();
create trigger orders_set_updated_at before update on public.orders
for each row execute function private.set_updated_at();
create trigger order_items_set_updated_at before update on public.order_items
for each row execute function private.set_updated_at();
create trigger delivery_documents_set_updated_at before update on public.delivery_documents
for each row execute function private.set_updated_at();
create trigger notification_outbox_set_updated_at before update on public.notification_outbox
for each row execute function private.set_updated_at();

create or replace function private.audit_customer_payment_method()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.payment_method is distinct from old.payment_method then
    insert into public.admin_audit_log (
      actor_user_id, action, customer_id, details
    ) values (
      auth.uid(),
      'customer.payment_method_changed',
      new.id,
      jsonb_build_object(
        'previous_payment_method', old.payment_method,
        'new_payment_method', new.payment_method
      )
    );
  end if;
  return new;
end;
$$;

create trigger customers_audit_payment_method
after update of payment_method on public.customers
for each row execute function private.audit_customer_payment_method();

create or replace function private.protect_order_payment_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.payment_method_snapshot is not null
     and new.payment_method_snapshot is distinct from old.payment_method_snapshot
     and (
       old.status not in ('draft', 'submitted')
       or new.status not in ('draft', 'submitted')
       or old.payment_confirmed_at is not null
     ) then
    raise exception using errcode = 'P0001', message = 'Order payment method snapshot is immutable';
  end if;

  if old.payment_confirmed_at is not null
     and (
       new.payment_confirmed_at is distinct from old.payment_confirmed_at
       or new.payment_confirmed_by is distinct from old.payment_confirmed_by
     ) then
    raise exception using errcode = 'P0001', message = 'Order payment confirmation is immutable';
  end if;

  return new;
end;
$$;

create trigger orders_protect_payment_evidence
before update on public.orders
for each row execute function private.protect_order_payment_evidence();

create or replace function private.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.user_id = (select auth.uid())
      and p.active
  );
$$;

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.user_id = (select auth.uid())
      and p.role = 'admin'::public.app_role
      and p.active
  );
$$;

create or replace function private.can_access_customer(p_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_admin() or exists (
    select 1
    from public.customer_users cu
    join public.customers c on c.id = cu.customer_id and c.active
    join public.profiles p on p.user_id = cu.user_id and p.active
    where cu.user_id = (select auth.uid())
      and cu.customer_id = p_customer_id
  );
$$;

create or replace function private.current_customer_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select cu.customer_id
  from public.customer_users cu
  join public.customers c on c.id = cu.customer_id and c.active
  join public.profiles p on p.user_id = cu.user_id and p.active
  where cu.user_id = (select auth.uid())
  limit 1;
$$;

create or replace function private.customer_snapshot(p_customer_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', c.id,
    'legalName', c.legal_name,
    'contactName', c.contact_name,
    'vatNumber', c.vat_number,
    'taxCode', c.tax_code,
    'sdiCode', c.sdi_code,
    'pec', c.pec,
    'email', c.email,
    'phone', c.phone,
    'billingAddress', c.billing_address,
    'shippingAddress', c.shipping_address,
    'paymentMethod', c.payment_method
  )
  from public.customers c
  where c.id = p_customer_id;
$$;

create or replace function private.supplier_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'legalName', s.legal_name,
    'ownerName', s.owner_name,
    'vatNumber', s.vat_number,
    'taxCode', s.tax_code,
    'email', s.email,
    'phone', s.phone,
    'pec', s.pec,
    'sdiCode', s.sdi_code,
    'registeredAddress', s.registered_address,
    'shippingOrigin', s.shipping_origin,
    'bankName', s.bank_name,
    'iban', s.iban
  )
  from public.supplier_settings s
  where s.id = 1;
$$;

create or replace function private.effective_price(
  p_customer_id uuid,
  p_product_id uuid,
  p_on_date date default current_date
)
returns table (unit_price_net numeric, vat_rate numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select pli.unit_price_net, pli.vat_rate
  from public.customers c
  join public.price_lists pl on pl.id = c.price_list_id and pl.active
  join public.price_list_items pli on pli.price_list_id = pl.id
  join public.products p on p.id = pli.product_id and p.active
  where c.id = p_customer_id
    and c.active
    and pli.product_id = p_product_id
    and pli.valid_from <= p_on_date
    and (pli.valid_to is null or pli.valid_to >= p_on_date)
  order by pli.valid_from desc
  limit 1;
$$;

create or replace function private.recalculate_order_totals(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_net numeric(14,2);
  v_vat numeric(14,2);
  v_gross numeric(14,2);
begin
  select
    coalesce(sum(oi.line_net), 0),
    coalesce(sum(oi.line_vat), 0),
    coalesce(sum(oi.line_gross), 0)
  into v_net, v_vat, v_gross
  from public.order_items oi
  where oi.order_id = p_order_id;

  update public.orders
  set net_total = v_net,
      vat_total = v_vat,
      gross_total = v_gross
  where id = p_order_id;
end;
$$;

create or replace function public.create_order(
  p_requested_delivery_date date,
  p_notes text default null,
  p_customer_id uuid default null
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_customer_id uuid;
  v_order public.orders;
  v_channel public.order_actor_channel;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  if private.is_admin() then
    v_customer_id := p_customer_id;
    v_channel := 'admin';
  else
    v_customer_id := private.current_customer_id();
    v_channel := 'client';
    if p_customer_id is not null and p_customer_id <> v_customer_id then
      raise exception using errcode = '42501', message = 'Customer access denied';
    end if;
  end if;

  if v_customer_id is null
     or not private.can_access_customer(v_customer_id)
     or not exists (
       select 1 from public.customers c where c.id = v_customer_id and c.active
     ) then
    raise exception using errcode = '42501', message = 'An active customer is required';
  end if;

  if p_requested_delivery_date is null
     or p_requested_delivery_date < (now() at time zone 'Europe/Rome')::date then
    raise exception using errcode = '22023', message = 'Requested delivery date cannot be in the past';
  end if;

  insert into public.orders (
    customer_id,
    requested_delivery_date,
    notes,
    created_by
  )
  values (
    v_customer_id,
    p_requested_delivery_date,
    coalesce(p_notes, ''),
    v_user_id
  )
  returning * into v_order;

  insert into public.order_status_history (
    order_id,
    from_status,
    to_status,
    actor_user_id,
    actor_channel
  )
  values (v_order.id, null, 'draft', v_user_id, v_channel);

  return v_order;
end;
$$;

create or replace function public.update_order(
  p_order_id uuid,
  p_requested_delivery_date date,
  p_notes text,
  p_expected_version integer
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Order not found';
  end if;
  if not private.can_access_customer(v_order.customer_id) then
    raise exception using errcode = '42501', message = 'Order access denied';
  end if;
  if v_order.status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'Only draft orders can be changed';
  end if;
  if v_order.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'Order was changed by another session';
  end if;
  if p_requested_delivery_date is null
     or p_requested_delivery_date < (now() at time zone 'Europe/Rome')::date then
    raise exception using errcode = '22023', message = 'Requested delivery date cannot be in the past';
  end if;

  update public.orders
  set requested_delivery_date = p_requested_delivery_date,
      notes = coalesce(p_notes, ''),
      version = version + 1
  where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$$;

create or replace function public.set_order_item(
  p_order_id uuid,
  p_product_id uuid,
  p_quantity numeric,
  p_expected_version integer
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_product record;
  v_line_net numeric(14,2);
  v_line_vat numeric(14,2);
begin
  if p_quantity is null
     or p_quantity::text in ('NaN', 'Infinity', '-Infinity')
     or p_quantity <= 0
     or p_quantity > 999
     or p_quantity <> trunc(p_quantity) then
    raise exception using errcode = '22023', message = 'Quantity must be a whole number between 1 and 999';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Order not found';
  end if;
  if not private.can_access_customer(v_order.customer_id) then
    raise exception using errcode = '42501', message = 'Order access denied';
  end if;
  if v_order.status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'Only draft orders can be changed';
  end if;
  if v_order.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'Order was changed by another session';
  end if;

  select
    p.sku,
    p.name,
    p.category,
    p.uom,
    p.package_label,
    p.package_size,
    p.pricing_mode,
    ep.unit_price_net,
    ep.vat_rate
  into v_product
  from public.products p
  join lateral private.effective_price(
    v_order.customer_id,
    p.id,
    (now() at time zone 'Europe/Rome')::date
  ) ep on true
  where p.id = p_product_id
    and p.active;

  if not found then
    raise exception using errcode = 'P0002', message = 'Product is unavailable or has no valid price';
  end if;

  -- quantity is the number of packages. A per-kg price is multiplied by the
  -- immutable package weight; services and other unit-priced products are not.
  v_line_net := round(
    p_quantity
      * case when v_product.pricing_mode = 'per_kg' then v_product.package_size else 1 end
      * v_product.unit_price_net,
    2
  );
  v_line_vat := round(v_line_net * v_product.vat_rate / 100, 2);

  insert into public.order_items (
    order_id,
    product_id,
    sku_snapshot,
    name_snapshot,
    category_snapshot,
    uom_snapshot,
    package_label_snapshot,
    package_size_snapshot,
    pricing_mode_snapshot,
    quantity,
    unit_price_net,
    vat_rate,
    line_net,
    line_vat,
    line_gross
  )
  values (
    p_order_id,
    p_product_id,
    v_product.sku,
    v_product.name,
    v_product.category,
    v_product.uom,
    v_product.package_label,
    v_product.package_size,
    v_product.pricing_mode,
    p_quantity,
    v_product.unit_price_net,
    v_product.vat_rate,
    v_line_net,
    v_line_vat,
    v_line_net + v_line_vat
  )
  on conflict (order_id, product_id) do update
  set sku_snapshot = excluded.sku_snapshot,
      name_snapshot = excluded.name_snapshot,
      category_snapshot = excluded.category_snapshot,
      uom_snapshot = excluded.uom_snapshot,
      package_label_snapshot = excluded.package_label_snapshot,
      package_size_snapshot = excluded.package_size_snapshot,
      pricing_mode_snapshot = excluded.pricing_mode_snapshot,
      quantity = excluded.quantity,
      unit_price_net = excluded.unit_price_net,
      vat_rate = excluded.vat_rate,
      line_net = excluded.line_net,
      line_vat = excluded.line_vat,
      line_gross = excluded.line_gross;

  perform private.recalculate_order_totals(p_order_id);
  update public.orders
  set version = version + 1
  where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$$;

create or replace function public.remove_order_item(
  p_order_id uuid,
  p_product_id uuid,
  p_expected_version integer
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Order not found';
  end if;
  if not private.can_access_customer(v_order.customer_id) then
    raise exception using errcode = '42501', message = 'Order access denied';
  end if;
  if v_order.status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'Only draft orders can be changed';
  end if;
  if v_order.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'Order was changed by another session';
  end if;

  delete from public.order_items
  where order_id = p_order_id
    and product_id = p_product_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Order item not found';
  end if;

  perform private.recalculate_order_totals(p_order_id);
  update public.orders
  set version = version + 1
  where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$$;

create or replace function public.submit_order(
  p_order_id uuid,
  p_expected_version integer,
  p_payment_method public.payment_method default 'end_of_month'
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_item record;
  v_product record;
  v_line_net numeric(14,2);
  v_line_vat numeric(14,2);
  v_customer_snapshot jsonb;
  v_supplier_snapshot jsonb;
  v_effective_payment_method public.payment_method;
begin
  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Order not found';
  end if;
  if not private.can_access_customer(v_order.customer_id) then
    raise exception using errcode = '42501', message = 'Order access denied';
  end if;
  if v_order.status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'Only draft orders can be submitted';
  end if;
  if v_order.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'Order was changed by another session';
  end if;
  if v_order.requested_delivery_date < (now() at time zone 'Europe/Rome')::date then
    raise exception using errcode = '22023', message = 'Requested delivery date cannot be in the past';
  end if;
  if not exists (select 1 from public.order_items oi where oi.order_id = p_order_id) then
    raise exception using errcode = '22023', message = 'At least one order item is required';
  end if;

  -- Re-resolve every price at submission time. The client never chooses prices.
  for v_item in
    select oi.id, oi.product_id, oi.quantity
    from public.order_items oi
    where oi.order_id = p_order_id
    order by oi.id
  loop
    select
      p.sku,
      p.name,
      p.category,
      p.uom,
      p.package_label,
      p.package_size,
      p.pricing_mode,
      ep.unit_price_net,
      ep.vat_rate
    into v_product
    from public.products p
    join lateral private.effective_price(
      v_order.customer_id,
      p.id,
      (now() at time zone 'Europe/Rome')::date
    ) ep on true
    where p.id = v_item.product_id
      and p.active;

    if not found then
      raise exception using errcode = 'P0002', message = 'An order product is unavailable or has no valid price';
    end if;

    v_line_net := round(
      v_item.quantity
        * case when v_product.pricing_mode = 'per_kg' then v_product.package_size else 1 end
        * v_product.unit_price_net,
      2
    );
    v_line_vat := round(v_line_net * v_product.vat_rate / 100, 2);

    update public.order_items
    set sku_snapshot = v_product.sku,
        name_snapshot = v_product.name,
        category_snapshot = v_product.category,
        uom_snapshot = v_product.uom,
        package_label_snapshot = v_product.package_label,
        package_size_snapshot = v_product.package_size,
        pricing_mode_snapshot = v_product.pricing_mode,
        unit_price_net = v_product.unit_price_net,
        vat_rate = v_product.vat_rate,
        line_net = v_line_net,
        line_vat = v_line_vat,
        line_gross = v_line_net + v_line_vat
    where id = v_item.id;
  end loop;

  perform private.recalculate_order_totals(p_order_id);
  v_customer_snapshot := private.customer_snapshot(v_order.customer_id);
  v_supplier_snapshot := private.supplier_snapshot();
  if v_customer_snapshot is null then
    raise exception using errcode = 'P0002', message = 'Customer data is unavailable';
  end if;
  if v_supplier_snapshot is null
     or nullif(btrim(v_supplier_snapshot ->> 'legalName'), '') is null then
    raise exception using errcode = '22023', message = 'Supplier settings must be completed before accepting orders';
  end if;
  if p_payment_method is null then
    raise exception using errcode = '22023', message = 'Payment method is required';
  end if;

  -- The customer chooses the payment method for this order. It is stored on the
  -- order so later customer profile changes cannot rewrite accepted documents.
  v_effective_payment_method := p_payment_method;
  v_customer_snapshot := jsonb_set(
    v_customer_snapshot,
    '{paymentMethod}',
    to_jsonb(v_effective_payment_method),
    true
  );

  update public.orders
  set status = 'submitted',
      customer_snapshot = v_customer_snapshot,
      supplier_snapshot = v_supplier_snapshot,
      payment_method_snapshot = v_effective_payment_method,
      submitted_at = now(),
      accepted_at = null,
      rejected_at = null,
      version = version + 1
  where id = p_order_id
  returning * into v_order;

  insert into public.order_status_history (
    order_id, from_status, to_status, actor_user_id, actor_channel
  ) values (
    v_order.id, 'draft', 'submitted', auth.uid(),
    case when private.is_admin() then 'admin'::public.order_actor_channel else 'client'::public.order_actor_channel end
  );

  insert into public.notification_outbox (
    event_type, aggregate_id, dedupe_key, payload
  ) values (
    'order.submitted',
    v_order.id,
    'order.submitted:' || v_order.id::text || ':' || v_order.version::text,
    jsonb_build_object(
      'order_id', v_order.id,
      'order_version', v_order.version,
      'payment_method', v_order.payment_method_snapshot,
      'payment_confirmed_at', v_order.payment_confirmed_at
    )
  ) on conflict (dedupe_key) do nothing;

  return v_order;
end;
$$;

create or replace function public.withdraw_order(
  p_order_id uuid,
  p_expected_version integer
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Order not found';
  end if;
  if not private.can_access_customer(v_order.customer_id) then
    raise exception using errcode = '42501', message = 'Order access denied';
  end if;
  if v_order.status <> 'submitted' then
    raise exception using errcode = 'P0001', message = 'Only submitted orders can be withdrawn';
  end if;
  if v_order.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'Order was changed by another session';
  end if;

  update public.orders
  set status = 'draft',
      submitted_at = null,
      version = version + 1
  where id = p_order_id
  returning * into v_order;

  update public.telegram_action_tokens
  set expires_at = least(expires_at, now())
  where order_id = p_order_id
    and used_at is null;

  insert into public.order_status_history (
    order_id, from_status, to_status, actor_user_id, actor_channel, note
  ) values (
    v_order.id,
    'submitted',
    'draft',
    auth.uid(),
    case when private.is_admin() then 'admin'::public.order_actor_channel else 'client'::public.order_actor_channel end,
    'Ordine ritirato per modifica'
  );

  return v_order;
end;
$$;

create or replace function public.place_order(
  p_order_id uuid default null,
  p_requested_delivery_date date default null,
  p_notes text default null,
  p_items jsonb default '[]'::jsonb,
  p_payment_method public.payment_method default 'end_of_month',
  p_expected_version integer default null,
  p_customer_id uuid default null,
  p_idempotency_key uuid default null
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_item jsonb;
  v_product_id_text text;
  v_product_id uuid;
  v_quantity numeric;
  v_has_duplicates boolean;
  v_idempotency_customer_id uuid;
begin
  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'Items must be a non-empty JSON array';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception using errcode = '22023', message = 'Every item must be a JSON object';
    end if;
    v_product_id_text := coalesce(v_item ->> 'product_id', v_item ->> 'productId');
    if v_product_id_text is null
       or v_product_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception using errcode = '22023', message = 'Every item requires a valid product_id';
    end if;
    begin
      v_quantity := (v_item ->> 'quantity')::numeric;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Every item requires a numeric quantity';
    end;
    if v_quantity is null
       or v_quantity::text in ('NaN', 'Infinity', '-Infinity')
       or v_quantity <= 0
       or v_quantity > 999
       or v_quantity <> trunc(v_quantity) then
      raise exception using errcode = '22023', message = 'Every item quantity must be a whole number between 1 and 999';
    end if;
  end loop;

  select count(*) <> count(distinct lower(coalesce(value ->> 'product_id', value ->> 'productId')))
  into v_has_duplicates
  from jsonb_array_elements(p_items);
  if v_has_duplicates then
    raise exception using errcode = '22023', message = 'Duplicate products are not allowed';
  end if;

  if p_order_id is null then
    if p_idempotency_key is not null then
      if private.is_admin() then
        v_idempotency_customer_id := p_customer_id;
      else
        v_idempotency_customer_id := private.current_customer_id();
      end if;
      if v_idempotency_customer_id is null
         or not private.can_access_customer(v_idempotency_customer_id) then
        raise exception using errcode = '42501', message = 'Customer access denied';
      end if;

      -- Serializes retries carrying the same customer/key pair. A concurrent
      -- retry waits for the first transaction and then receives its order.
      perform pg_advisory_xact_lock(hashtextextended(
        v_idempotency_customer_id::text || ':' || p_idempotency_key::text,
        0
      ));
      select * into v_order
      from public.orders
      where customer_id = v_idempotency_customer_id
        and client_request_id = p_idempotency_key;
      if found then
        return v_order;
      end if;
    end if;

    v_order := public.create_order(
      p_requested_delivery_date,
      p_notes,
      p_customer_id
    );
    if p_idempotency_key is not null then
      update public.orders
      set client_request_id = p_idempotency_key
      where id = v_order.id
      returning * into v_order;
    end if;
  else
    if p_expected_version is null then
      raise exception using errcode = '22023', message = 'expected_version is required when editing an order';
    end if;

    select * into v_order
    from public.orders
    where id = p_order_id
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'Order not found';
    end if;
    if not private.can_access_customer(v_order.customer_id) then
      raise exception using errcode = '42501', message = 'Order access denied';
    end if;
    if v_order.version <> p_expected_version then
      raise exception using errcode = '40001', message = 'Order was changed by another session';
    end if;

    if v_order.status = 'submitted' then
      v_order := public.withdraw_order(v_order.id, v_order.version);
    elsif v_order.status <> 'draft' then
      raise exception using errcode = 'P0001', message = 'Only draft or submitted orders can be replaced';
    end if;

    v_order := public.update_order(
      v_order.id,
      p_requested_delivery_date,
      p_notes,
      v_order.version
    );

    delete from public.order_items where order_id = v_order.id;
    perform private.recalculate_order_totals(v_order.id);
    update public.orders
    set version = version + 1
    where id = v_order.id
    returning * into v_order;
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_product_id := coalesce(v_item ->> 'product_id', v_item ->> 'productId')::uuid;
    v_quantity := (v_item ->> 'quantity')::numeric;
    v_order := public.set_order_item(
      v_order.id,
      v_product_id,
      v_quantity,
      v_order.version
    );
  end loop;

  v_order := public.submit_order(v_order.id, v_order.version, p_payment_method);
  return v_order;
end;
$$;

create or replace function public.admin_transition_order(
  p_order_id uuid,
  p_new_status public.order_status,
  p_expected_version integer,
  p_note text default null
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_previous_status public.order_status;
begin
  if not private.is_admin() then
    raise exception using errcode = '42501', message = 'Administrator access required';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Order not found';
  end if;
  if v_order.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'Order was changed by another session';
  end if;

  v_previous_status := v_order.status;
  if not (
    (v_previous_status = 'submitted' and p_new_status in ('accepted', 'rejected'))
    or (v_previous_status in ('draft', 'submitted', 'accepted') and p_new_status = 'cancelled')
    or (v_previous_status = 'in_delivery' and p_new_status = 'delivered')
  ) then
    raise exception using errcode = '22023',
      message = 'Invalid order status transition; use prepare_delivery_document for in_delivery';
  end if;

  if p_new_status = 'cancelled' and v_order.payment_confirmed_at is not null then
    raise exception using errcode = '22023',
      message = 'A paid order cannot be cancelled without a separate refund workflow';
  end if;

  if p_new_status = 'delivered'
     and not exists (
       select 1
       from public.delivery_documents d
       where d.order_id = p_order_id
         and d.status = 'ready'
     ) then
    raise exception using errcode = '22023', message = 'A ready delivery document is required';
  end if;

  update public.orders
  set status = p_new_status,
      accepted_at = case when p_new_status = 'accepted' then now() else accepted_at end,
      rejected_at = case when p_new_status = 'rejected' then now() else rejected_at end,
      delivered_at = case when p_new_status = 'delivered' then now() else delivered_at end,
      version = version + 1
  where id = p_order_id
  returning * into v_order;

  if p_new_status in ('accepted', 'rejected', 'cancelled') then
    update public.telegram_action_tokens
    set expires_at = least(expires_at, now())
    where order_id = p_order_id
      and used_at is null;
  end if;

  insert into public.order_status_history (
    order_id, from_status, to_status, actor_user_id, actor_channel, note
  ) values (
    v_order.id, v_previous_status, p_new_status, auth.uid(), 'admin', nullif(btrim(p_note), '')
  );

  insert into public.notification_outbox (
    event_type, aggregate_id, dedupe_key, payload
  ) values (
    'order.status_changed',
    v_order.id,
    'order.status_changed:' || v_order.id::text || ':' || v_order.version::text,
    jsonb_build_object(
      'order_id', v_order.id,
      'order_version', v_order.version,
      'from_status', v_previous_status,
      'to_status', p_new_status,
      'payment_method', v_order.payment_method_snapshot,
      'payment_confirmed_at', v_order.payment_confirmed_at
    )
  ) on conflict (dedupe_key) do nothing;

  return v_order;
end;
$$;

create or replace function public.admin_confirm_order_payment(
  p_order_id uuid,
  p_expected_version integer
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  if not private.is_admin() then
    raise exception using errcode = '42501', message = 'Administrator access required';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Order not found';
  end if;
  if v_order.payment_method_snapshot <> 'on_delivery' then
    raise exception using errcode = '22023', message = 'Only on-delivery payments require confirmation';
  end if;

  -- A retry with the previous version returns the original evidence without
  -- changing its timestamp, actor or version a second time. Check this before
  -- the current status so legacy rows remain safely retryable.
  if v_order.payment_confirmed_at is not null then
    return v_order;
  end if;

  if v_order.status not in ('accepted', 'in_delivery', 'delivered') then
    raise exception using errcode = '22023', message = 'Payment can only be confirmed for accepted or fulfilled orders';
  end if;

  if v_order.version is distinct from p_expected_version then
    raise exception using errcode = '40001', message = 'Order was changed by another session';
  end if;

  update public.orders
  set payment_confirmed_at = now(),
      payment_confirmed_by = auth.uid(),
      version = version + 1
  where id = p_order_id
  returning * into v_order;

  insert into public.admin_audit_log(
    actor_user_id, action, customer_id, details
  ) values (
    auth.uid(),
    'order.payment_confirmed',
    v_order.customer_id,
    jsonb_build_object(
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'order_version', v_order.version,
      'payment_method', v_order.payment_method_snapshot,
      'payment_confirmed_at', v_order.payment_confirmed_at
    )
  );

  insert into public.notification_outbox (
    event_type, aggregate_id, dedupe_key, payload
  ) values (
    'order.payment_confirmed',
    v_order.id,
    'order.payment_confirmed:' || v_order.id::text,
    jsonb_build_object(
      'order_id', v_order.id,
      'order_version', v_order.version,
      'payment_method', v_order.payment_method_snapshot,
      'payment_confirmed_at', v_order.payment_confirmed_at,
      'payment_confirmed_by', v_order.payment_confirmed_by
    )
  ) on conflict (dedupe_key) do nothing;

  return v_order;
end;
$$;

create or replace function public.prepare_delivery_document(
  p_order_id uuid,
  p_expected_version integer,
  p_series text default 'A',
  p_issued_on date default null,
  p_transport_started_at timestamptz default null,
  p_transport_reason text default 'Vendita',
  p_carrier jsonb default '{}'::jsonb,
  p_destination jsonb default null,
  p_packages integer default null,
  p_notes text default null
)
returns public.delivery_documents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_document public.delivery_documents;
  v_issued_on date := coalesce(p_issued_on, (now() at time zone 'Europe/Rome')::date);
  v_year integer;
  v_sequence bigint;
  v_display_number text;
  v_items jsonb;
  v_packages integer;
begin
  if not private.is_admin() then
    raise exception using errcode = '42501', message = 'Administrator access required';
  end if;
  if nullif(btrim(p_series), '') is null or length(btrim(p_series)) > 12 then
    raise exception using errcode = '22023', message = 'Invalid document series';
  end if;
  if jsonb_typeof(coalesce(p_carrier, '{}'::jsonb)) <> 'object'
     or (p_destination is not null and jsonb_typeof(p_destination) <> 'object') then
    raise exception using errcode = '22023', message = 'Carrier and destination must be JSON objects';
  end if;

  -- Idempotent retry: if this order already has a DDT, never allocate a new number.
  select * into v_document
  from public.delivery_documents
  where order_id = p_order_id
    and status <> 'void'
  order by created_at desc
  limit 1;
  if found then
    return v_document;
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Order not found';
  end if;

  select * into v_document
  from public.delivery_documents
  where order_id = p_order_id
    and status <> 'void'
  order by created_at desc
  limit 1;
  if found then
    return v_document;
  end if;

  if v_order.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'Order was changed by another session';
  end if;
  if v_order.status <> 'accepted' then
    raise exception using errcode = 'P0001', message = 'Only accepted orders can enter delivery';
  end if;
  if v_order.customer_snapshot is null or v_order.supplier_snapshot is null then
    raise exception using errcode = '22023', message = 'Order snapshots are missing';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'productId', oi.product_id,
      'sku', oi.sku_snapshot,
      'name', oi.name_snapshot,
      'category', oi.category_snapshot,
      'uom', oi.uom_snapshot,
      'packageLabel', oi.package_label_snapshot,
      'packageSize', oi.package_size_snapshot,
      'pricingMode', oi.pricing_mode_snapshot,
      'quantity', oi.quantity,
      'unitPriceNet', oi.unit_price_net,
      'vatRate', oi.vat_rate,
      'lineNet', oi.line_net,
      'lineVat', oi.line_vat,
      'lineGross', oi.line_gross
    ) order by oi.id
  )
  into v_items
  from public.order_items oi
  where oi.order_id = p_order_id;

  if v_items is null then
    raise exception using errcode = '22023', message = 'Cannot create a delivery document without items';
  end if;

  if p_packages is not null and p_packages <= 0 then
    raise exception using errcode = '22023', message = 'Packages must be greater than zero';
  end if;
  select coalesce(
    p_packages,
    nullif(ceil(sum(oi.quantity) filter (where oi.pricing_mode_snapshot = 'per_kg'))::integer, 0)
  )
  into v_packages
  from public.order_items oi
  where oi.order_id = p_order_id;

  v_year := extract(year from v_issued_on)::integer;
  insert into public.document_counters (
    document_type, series, document_year, last_number
  ) values (
    'DDT', upper(btrim(p_series)), v_year, 1
  )
  on conflict (document_type, series, document_year) do update
  set last_number = public.document_counters.last_number + 1,
      updated_at = now()
  returning last_number into v_sequence;

  v_display_number := case
    when upper(btrim(p_series)) = 'A'
      then 'DDT-' || v_year::text || '-' || lpad(v_sequence::text, 6, '0')
    else 'DDT-' || upper(btrim(p_series)) || '-' || v_year::text || '-' || lpad(v_sequence::text, 6, '0')
  end;

  insert into public.delivery_documents (
    order_id,
    customer_id,
    series,
    document_year,
    sequence_number,
    display_number,
    issued_on,
    transport_started_at,
    transport_reason,
    carrier_snapshot,
    destination_snapshot,
    supplier_snapshot,
    customer_snapshot,
    payment_method_snapshot,
    items_snapshot,
    packages,
    notes,
    status,
    created_by
  ) values (
    v_order.id,
    v_order.customer_id,
    upper(btrim(p_series)),
    v_year,
    v_sequence,
    v_display_number,
    v_issued_on,
    coalesce(p_transport_started_at, now()),
    coalesce(nullif(btrim(p_transport_reason), ''), 'Vendita'),
    coalesce(p_carrier, '{}'::jsonb),
    coalesce(p_destination, v_order.customer_snapshot -> 'shippingAddress', '{}'::jsonb),
    v_order.supplier_snapshot,
    v_order.customer_snapshot,
    v_order.payment_method_snapshot,
    v_items,
    v_packages,
    coalesce(p_notes, ''),
    'ready',
    auth.uid()
  )
  returning * into v_document;

  update public.orders
  set status = 'in_delivery',
      version = version + 1
  where id = p_order_id
  returning * into v_order;

  insert into public.order_status_history (
    order_id, from_status, to_status, actor_user_id, actor_channel, note, metadata
  ) values (
    v_order.id,
    'accepted',
    'in_delivery',
    auth.uid(),
    'admin',
    'DDT ' || v_document.display_number || ' generato',
    jsonb_build_object('delivery_document_id', v_document.id, 'display_number', v_document.display_number)
  );

  insert into public.notification_outbox (
    event_type, aggregate_id, dedupe_key, payload
  ) values (
    'order.status_changed',
    v_order.id,
    'order.status_changed:' || v_order.id::text || ':' || v_order.version::text,
    jsonb_build_object(
      'order_id', v_order.id,
      'order_version', v_order.version,
      'from_status', 'accepted',
      'to_status', 'in_delivery',
      'delivery_document_id', v_document.id,
      'payment_method', v_order.payment_method_snapshot,
      'payment_confirmed_at', v_order.payment_confirmed_at
    )
  ) on conflict (dedupe_key) do nothing;

  return v_document;
end;
$$;

create or replace function public.mark_delivery_document_ready(
  p_document_id uuid,
  p_pdf_object_path text,
  p_pdf_sha256 text
)
returns public.delivery_documents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_document public.delivery_documents;
begin
  if not private.is_admin() then
    raise exception using errcode = '42501', message = 'Administrator access required';
  end if;

  select * into v_document
  from public.delivery_documents
  where id = p_document_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Delivery document not found';
  end if;
  if v_document.status = 'void' then
    raise exception using errcode = 'P0001', message = 'A void document cannot be completed';
  end if;
  if nullif(btrim(p_pdf_object_path), '') is null
     or p_pdf_object_path not like v_document.customer_id::text || '/%' then
    raise exception using errcode = '22023', message = 'PDF path must be scoped to the document customer';
  end if;
  if lower(coalesce(p_pdf_sha256, '')) !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Invalid PDF SHA-256';
  end if;

  update public.delivery_documents
  set status = 'ready',
      pdf_object_path = p_pdf_object_path,
      pdf_sha256 = lower(p_pdf_sha256)
  where id = p_document_id
  returning * into v_document;

  return v_document;
end;
$$;

create or replace function public.apply_telegram_order_action(
  p_update_id bigint,
  p_token text,
  p_action public.order_status,
  p_telegram_user_id bigint
)
returns table (
  applied boolean,
  result_message text,
  result_order_id uuid,
  result_status public.order_status,
  result_order_number bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
  v_token public.telegram_action_tokens;
  v_order public.orders;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'Service role required';
  end if;
  if p_action not in ('accepted', 'rejected') then
    raise exception using errcode = '22023', message = 'Telegram action must be accepted or rejected';
  end if;

  insert into public.telegram_updates(update_id)
  values (p_update_id)
  on conflict do nothing;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    return query select false, 'Aggiornamento già elaborato', null::uuid, null::public.order_status, null::bigint;
    return;
  end if;

  select * into v_token
  from public.telegram_action_tokens tat
  where tat.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
  for update;

  if not found or v_token.used_at is not null or v_token.expires_at <= now() then
    return query select false, 'Pulsante scaduto o già utilizzato', null::uuid, null::public.order_status, null::bigint;
    return;
  end if;

  select * into v_order
  from public.orders o
  where o.id = v_token.order_id
  for update;

  if not found then
    return query select false, 'Ordine non trovato', null::uuid, null::public.order_status, null::bigint;
    return;
  end if;
  if v_order.status <> 'submitted' or v_order.version <> v_token.order_version then
    update public.telegram_action_tokens
    set expires_at = least(expires_at, now())
    where order_id = v_order.id and used_at is null;
    return query select false, 'Ordine già modificato o gestito', v_order.id, v_order.status, v_order.order_number;
    return;
  end if;

  update public.orders
  set status = p_action,
      accepted_at = case when p_action = 'accepted' then now() else accepted_at end,
      rejected_at = case when p_action = 'rejected' then now() else rejected_at end,
      version = version + 1
  where id = v_order.id
  returning * into v_order;

  update public.telegram_action_tokens
  set used_at = now(),
      used_action = p_action,
      expires_at = least(expires_at, now())
  where order_id = v_order.id
    and used_at is null;

  insert into public.order_status_history (
    order_id,
    from_status,
    to_status,
    actor_external_id,
    actor_channel,
    note,
    metadata
  ) values (
    v_order.id,
    'submitted',
    p_action,
    p_telegram_user_id::text,
    'telegram',
    'Decisione ricevuta tramite Telegram',
    jsonb_build_object('telegram_update_id', p_update_id)
  );

  insert into public.notification_outbox (
    event_type, aggregate_id, dedupe_key, payload
  ) values (
    'order.status_changed',
    v_order.id,
    'order.status_changed:' || v_order.id::text || ':' || v_order.version::text,
    jsonb_build_object(
      'order_id', v_order.id,
      'order_version', v_order.version,
      'from_status', 'submitted',
      'to_status', p_action,
      'source', 'telegram',
      'payment_method', v_order.payment_method_snapshot,
      'payment_confirmed_at', v_order.payment_confirmed_at
    )
  ) on conflict (dedupe_key) do nothing;

  return query select true, 'Ordine aggiornato', v_order.id, v_order.status, v_order.order_number;
end;
$$;

create or replace function public.get_catalog(p_customer_id uuid default null)
returns table (
  id uuid,
  sku text,
  name text,
  category text,
  description text,
  uom text,
  package_label text,
  package_size numeric,
  pricing_mode public.product_pricing_mode,
  unit_price_net numeric,
  vat_rate numeric,
  currency char(3)
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  if private.is_admin() then
    v_customer_id := p_customer_id;
    if v_customer_id is null then
      raise exception using errcode = '22023', message = 'Administrator must select a customer';
    end if;
  else
    v_customer_id := private.current_customer_id();
    if p_customer_id is not null and p_customer_id <> v_customer_id then
      raise exception using errcode = '42501', message = 'Customer access denied';
    end if;
  end if;

  if v_customer_id is null or not private.can_access_customer(v_customer_id) then
    raise exception using errcode = '42501', message = 'Customer access denied';
  end if;

  return query
  select
    p.id,
    p.sku,
    p.name,
    p.category,
    p.description,
    p.uom,
    p.package_label,
    p.package_size,
    p.pricing_mode,
    ep.unit_price_net,
    ep.vat_rate,
    pl.currency
  from public.customers c
  join public.price_lists pl on pl.id = c.price_list_id and pl.active
  join public.products p on p.active
  join lateral private.effective_price(
    c.id,
    p.id,
    (now() at time zone 'Europe/Rome')::date
  ) ep on true
  where c.id = v_customer_id
    and c.active
  order by p.category, p.name, p.id;
end;
$$;

create or replace function public.admin_set_current_price(
  p_price_list_id uuid,
  p_product_id uuid,
  p_unit_price_net numeric,
  p_vat_rate numeric,
  p_effective_on date default null
)
returns public.price_list_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_effective_on date := coalesce(p_effective_on, (now() at time zone 'Europe/Rome')::date);
  v_today date := (now() at time zone 'Europe/Rome')::date;
  v_current public.price_list_items;
  v_result public.price_list_items;
  v_next_date date;
  v_overlap_count integer;
begin
  if not private.is_admin() then
    raise exception using errcode = '42501', message = 'Administrator access required';
  end if;
  if p_unit_price_net is null
     or p_unit_price_net::text in ('NaN', 'Infinity', '-Infinity')
     or p_unit_price_net < 0 then
    raise exception using errcode = '22023', message = 'Net price must be zero or greater';
  end if;
  if p_vat_rate is null
     or p_vat_rate::text in ('NaN', 'Infinity', '-Infinity')
     or p_vat_rate < 0
     or p_vat_rate > 100 then
    raise exception using errcode = '22023', message = 'VAT rate must be between zero and one hundred';
  end if;
  if v_effective_on < v_today then
    raise exception using errcode = '22023', message = 'A current price cannot start in the past';
  end if;

  -- Serializes changes for this price list and verifies active references.
  perform 1
  from public.price_lists pl
  where pl.id = p_price_list_id and pl.active
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Active price list not found';
  end if;
  if not exists (select 1 from public.products p where p.id = p_product_id and p.active) then
    raise exception using errcode = 'P0002', message = 'Active product not found';
  end if;

  select count(*) into v_overlap_count
  from public.price_list_items pli
  where pli.price_list_id = p_price_list_id
    and pli.product_id = p_product_id
    and pli.valid_from <= v_effective_on
    and (pli.valid_to is null or pli.valid_to >= v_effective_on);
  if v_overlap_count > 1 then
    raise exception using errcode = '23000', message = 'Overlapping price history must be repaired first';
  end if;

  select * into v_current
  from public.price_list_items pli
  where pli.price_list_id = p_price_list_id
    and pli.product_id = p_product_id
    and pli.valid_from <= v_effective_on
    and (pli.valid_to is null or pli.valid_to >= v_effective_on)
  order by pli.valid_from desc
  limit 1
  for update;

  select min(pli.valid_from) into v_next_date
  from public.price_list_items pli
  where pli.price_list_id = p_price_list_id
    and pli.product_id = p_product_id
    and pli.valid_from > v_effective_on;

  if v_current.valid_from = v_effective_on then
    update public.price_list_items
    set unit_price_net = p_unit_price_net,
        vat_rate = p_vat_rate
    where price_list_id = p_price_list_id
      and product_id = p_product_id
      and valid_from = v_effective_on
    returning * into v_result;
  else
    if v_current.valid_from is not null then
      update public.price_list_items
      set valid_to = v_effective_on - 1
      where price_list_id = p_price_list_id
        and product_id = p_product_id
        and valid_from = v_current.valid_from;
    end if;

    insert into public.price_list_items (
      price_list_id,
      product_id,
      valid_from,
      valid_to,
      unit_price_net,
      vat_rate
    ) values (
      p_price_list_id,
      p_product_id,
      v_effective_on,
      case when v_next_date is null then null else v_next_date - 1 end,
      p_unit_price_net,
      p_vat_rate
    ) returning * into v_result;
  end if;

  insert into public.admin_audit_log(actor_user_id, action, details)
  values (
    auth.uid(),
    'catalog.price_changed',
    jsonb_build_object(
      'price_list_id', p_price_list_id,
      'product_id', p_product_id,
      'effective_on', v_effective_on,
      'previous_unit_price_net', v_current.unit_price_net,
      'previous_vat_rate', v_current.vat_rate,
      'unit_price_net', p_unit_price_net,
      'vat_rate', p_vat_rate
    )
  );

  return v_result;
end;
$$;

create or replace function public.admin_upsert_product_with_price(
  p_sku text,
  p_name text,
  p_category text,
  p_description text,
  p_uom text,
  p_package_label text,
  p_package_size numeric,
  p_pricing_mode public.product_pricing_mode,
  p_active boolean,
  p_price_list_id uuid,
  p_unit_price_net numeric,
  p_vat_rate numeric,
  p_effective_on date default null,
  p_product_id uuid default null
)
returns table (
  product_id uuid,
  sku text,
  name text,
  category text,
  description text,
  uom text,
  package_label text,
  package_size numeric,
  pricing_mode public.product_pricing_mode,
  active boolean,
  price_list_id uuid,
  unit_price_net numeric,
  vat_rate numeric,
  valid_from date,
  valid_to date
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products;
  v_price public.price_list_items;
begin
  if not private.is_admin() then
    raise exception using errcode = '42501', message = 'Administrator access required';
  end if;
  if nullif(btrim(p_sku), '') is null or length(btrim(p_sku)) > 64 then
    raise exception using errcode = '22023', message = 'SKU is required and must be at most 64 characters';
  end if;
  if nullif(btrim(p_name), '') is null or length(btrim(p_name)) > 160 then
    raise exception using errcode = '22023', message = 'Product name is required';
  end if;
  if nullif(btrim(p_uom), '') is null then
    raise exception using errcode = '22023', message = 'Unit of measure is required';
  end if;
  if p_package_size is not null
     and (
       p_package_size::text in ('NaN', 'Infinity', '-Infinity')
       or p_package_size <= 0
     ) then
    raise exception using errcode = '22023', message = 'Package size must be greater than zero';
  end if;
  if p_pricing_mode is null then
    raise exception using errcode = '22023', message = 'Pricing mode is required';
  end if;
  if p_pricing_mode = 'per_kg' and p_package_size is null then
    raise exception using errcode = '22023', message = 'Package size is required for per-kg pricing';
  end if;
  if p_product_id is null then
    insert into public.products (
      sku, name, category, description, uom, package_label, package_size, pricing_mode, active
    ) values (
      upper(btrim(p_sku)),
      btrim(p_name),
      coalesce(btrim(p_category), ''),
      coalesce(p_description, ''),
      btrim(p_uom),
      coalesce(p_package_label, ''),
      p_package_size,
      p_pricing_mode,
      true
    ) returning * into v_product;
  else
    perform 1 from public.products p where p.id = p_product_id for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'Product not found';
    end if;

    update public.products
    set sku = upper(btrim(p_sku)),
        name = btrim(p_name),
        category = coalesce(btrim(p_category), ''),
        description = coalesce(p_description, ''),
        uom = btrim(p_uom),
        package_label = coalesce(p_package_label, ''),
        package_size = p_package_size,
        pricing_mode = p_pricing_mode,
        active = true
    where id = p_product_id
    returning * into v_product;
  end if;

  v_price := public.admin_set_current_price(
    p_price_list_id,
    v_product.id,
    p_unit_price_net,
    p_vat_rate,
    p_effective_on
  );

  if not coalesce(p_active, true) then
    update public.products
    set active = false
    where id = v_product.id
    returning * into v_product;
  end if;

  insert into public.admin_audit_log(actor_user_id, action, details)
  values (
    auth.uid(),
    case when p_product_id is null then 'catalog.product_created' else 'catalog.product_updated' end,
    jsonb_build_object(
      'product_id', v_product.id,
      'sku', v_product.sku,
      'price_list_id', v_price.price_list_id
    )
  );

  return query select
    v_product.id,
    v_product.sku,
    v_product.name,
    v_product.category,
    v_product.description,
    v_product.uom,
    v_product.package_label,
    v_product.package_size,
    v_product.pricing_mode,
    v_product.active,
    v_price.price_list_id,
    v_price.unit_price_net,
    v_price.vat_rate,
    v_price.valid_from,
    v_price.valid_to;
end;
$$;

create or replace function public.admin_import_catalog(
  p_products jsonb,
  p_replace boolean default false
)
returns table (imported_count integer, deactivated_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_sku text;
  v_product_id uuid;
  v_package_size numeric;
  v_pricing_mode public.product_pricing_mode;
  v_unit_price_net numeric;
  v_vat_rate numeric;
  v_active boolean;
  v_imported integer := 0;
  v_deactivated integer := 0;
  v_price_list_id constant uuid := '00000000-0000-4000-8000-000000000001';
begin
  if not private.is_admin() then
    raise exception using errcode = '42501', message = 'Administrator access required';
  end if;
  if p_products is null
     or jsonb_typeof(p_products) <> 'array'
     or jsonb_array_length(p_products) = 0
     or jsonb_array_length(p_products) > 500 then
    raise exception using errcode = '22023', message = 'Catalog must contain between 1 and 500 products';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_products) entry(value)
    where jsonb_typeof(entry.value) <> 'object'
  ) then
    raise exception using errcode = '22023', message = 'Every catalog entry must be a JSON object';
  end if;
  if (
    select count(*) <> count(distinct upper(btrim(entry.value ->> 'sku')))
    from jsonb_array_elements(p_products) entry(value)
  ) then
    raise exception using errcode = '22023', message = 'Catalog SKUs must be unique';
  end if;

  for v_item in select value from jsonb_array_elements(p_products)
  loop
    v_sku := upper(btrim(v_item ->> 'sku'));
    if nullif(v_sku, '') is null then
      raise exception using errcode = '22023', message = 'Every catalog entry requires a SKU';
    end if;

    begin
      v_pricing_mode := (v_item ->> 'pricing_mode')::public.product_pricing_mode;
      v_package_size := case
        when not (v_item ? 'package_size') or jsonb_typeof(v_item -> 'package_size') = 'null' then null
        else (v_item ->> 'package_size')::numeric
      end;
      v_unit_price_net := (v_item ->> 'unit_price_net')::numeric;
      v_vat_rate := (v_item ->> 'vat_rate')::numeric;
      v_active := coalesce((v_item ->> 'active')::boolean, true);
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception using errcode = '22023', message = 'Invalid numeric, boolean or pricing value for SKU ' || v_sku;
    end;

    select p.id into v_product_id
    from public.products p
    where p.sku = v_sku;

    perform public.admin_upsert_product_with_price(
      v_sku,
      v_item ->> 'name',
      coalesce(v_item ->> 'category', ''),
      coalesce(v_item ->> 'description', ''),
      coalesce(nullif(btrim(v_item ->> 'uom'), ''), 'confezione'),
      coalesce(v_item ->> 'package_label', ''),
      v_package_size,
      v_pricing_mode,
      v_active,
      v_price_list_id,
      v_unit_price_net,
      v_vat_rate,
      (now() at time zone 'Europe/Rome')::date,
      v_product_id
    );
    v_imported := v_imported + 1;
  end loop;

  if coalesce(p_replace, false) then
    update public.products p
    set active = false
    where p.active
      and not exists (
        select 1
        from jsonb_array_elements(p_products) entry(value)
        where upper(btrim(entry.value ->> 'sku')) = p.sku
      );
    get diagnostics v_deactivated = row_count;
  end if;

  insert into public.admin_audit_log(actor_user_id, action, details)
  values (
    auth.uid(),
    'catalog.bulk_imported',
    jsonb_build_object(
      'price_list_id', v_price_list_id,
      'imported_count', v_imported,
      'deactivated_count', v_deactivated,
      'replace', coalesce(p_replace, false)
    )
  );

  return query select v_imported, v_deactivated;
end;
$$;

create or replace function public.admin_register_client_identity(
  p_user_id uuid,
  p_email text,
  p_display_name text,
  p_customer jsonb,
  p_existing_customer_id uuid default null,
  p_actor_user_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid;
  v_legal_name text;
  v_price_list_id uuid;
  v_existing_role public.app_role;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'Service role required';
  end if;
  if p_actor_user_id is null or not exists (
    select 1 from public.profiles p
    where p.user_id = p_actor_user_id and p.role = 'admin' and p.active
  ) then
    raise exception using errcode = '42501', message = 'Active administrator actor required';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception using errcode = '23503', message = 'Auth user does not exist';
  end if;
  if nullif(btrim(p_display_name), '') is null then
    raise exception using errcode = '22023', message = 'Display name is required';
  end if;

  select role into v_existing_role
  from public.profiles
  where user_id = p_user_id;
  if found and v_existing_role = 'admin' then
    raise exception using errcode = '22023', message = 'An administrator cannot be attached as a client';
  end if;

  if p_existing_customer_id is not null then
    select c.id into v_customer_id
    from public.customers c
    where c.id = p_existing_customer_id and c.active
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'Active customer not found';
    end if;
  else
    if p_customer is null or jsonb_typeof(p_customer) <> 'object' then
      raise exception using errcode = '22023', message = 'Customer object is required';
    end if;

    v_legal_name := coalesce(p_customer ->> 'legal_name', p_customer ->> 'legalName');
    if nullif(btrim(v_legal_name), '') is null then
      raise exception using errcode = '22023', message = 'Customer legal name is required';
    end if;

    if nullif(coalesce(p_customer ->> 'price_list_id', p_customer ->> 'priceListId'), '') is not null then
      v_price_list_id := coalesce(p_customer ->> 'price_list_id', p_customer ->> 'priceListId')::uuid;
      if not exists (select 1 from public.price_lists pl where pl.id = v_price_list_id and pl.active) then
        raise exception using errcode = 'P0002', message = 'Active price list not found';
      end if;
    else
      select pl.id into v_price_list_id
      from public.price_lists pl
      where pl.active
      order by
        (pl.id = '00000000-0000-4000-8000-000000000001'::uuid) desc,
        pl.created_at,
        pl.id
      limit 1;
      if v_price_list_id is null then
        raise exception using errcode = 'P0002', message = 'No active price list is configured';
      end if;
    end if;

    insert into public.customers (
      legal_name,
      contact_name,
      vat_number,
      tax_code,
      sdi_code,
      pec,
      email,
      phone,
      billing_address,
      shipping_address,
      price_list_id,
      payment_method
    ) values (
      btrim(v_legal_name),
      coalesce(p_customer ->> 'contact_name', p_customer ->> 'contactName', ''),
      coalesce(p_customer ->> 'vat_number', p_customer ->> 'vatNumber', ''),
      coalesce(p_customer ->> 'tax_code', p_customer ->> 'taxCode', ''),
      coalesce(p_customer ->> 'sdi_code', p_customer ->> 'sdiCode', ''),
      coalesce(p_customer ->> 'pec', ''),
      coalesce(nullif(p_customer ->> 'email', ''), p_email, ''),
      coalesce(p_customer ->> 'phone', ''),
      coalesce(p_customer -> 'billing_address', p_customer -> 'billingAddress', '{}'::jsonb),
      coalesce(p_customer -> 'shipping_address', p_customer -> 'shippingAddress', '{}'::jsonb),
      v_price_list_id,
      coalesce(
        nullif(coalesce(p_customer ->> 'payment_method', p_customer ->> 'paymentMethod'), ''),
        'end_of_month'
      )::public.payment_method
    ) returning id into v_customer_id;
  end if;

  insert into public.profiles(user_id, display_name, role, active)
  values (p_user_id, btrim(p_display_name), 'client', true)
  on conflict (user_id) do update
  set display_name = excluded.display_name,
      active = true;

  insert into public.customer_users(customer_id, user_id)
  values (v_customer_id, p_user_id)
  on conflict (customer_id, user_id) do nothing;

  insert into public.admin_audit_log(
    actor_user_id, action, target_user_id, customer_id, details
  ) values (
    p_actor_user_id,
    'client.identity_registered',
    p_user_id,
    v_customer_id,
    jsonb_build_object('email', lower(btrim(p_email)))
  );

  return v_customer_id;
end;
$$;

create or replace function public.admin_set_profile_active(
  p_user_id uuid,
  p_active boolean,
  p_actor_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'Service role required';
  end if;
  if p_actor_user_id is null or not exists (
    select 1 from public.profiles p
    where p.user_id = p_actor_user_id and p.role = 'admin' and p.active
  ) then
    raise exception using errcode = '42501', message = 'Active administrator actor required';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.user_id = p_user_id and p.role = 'client'
  ) then
    raise exception using errcode = 'P0002', message = 'Client profile not found';
  end if;

  update public.profiles
  set active = p_active
  where user_id = p_user_id;

  select customer_id into v_customer_id
  from public.customer_users
  where user_id = p_user_id;

  update public.customers
  set active = p_active
  where id = v_customer_id;

  insert into public.admin_audit_log(
    actor_user_id, action, target_user_id, customer_id, details
  ) values (
    p_actor_user_id,
    case when p_active then 'client.identity_enabled' else 'client.identity_disabled' end,
    p_user_id,
    v_customer_id,
    '{}'::jsonb
  );
end;
$$;

create or replace function public.admin_update_client_email(
  p_user_id uuid,
  p_email text,
  p_actor_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'Service role required';
  end if;
  if p_actor_user_id is null or not exists (
    select 1 from public.profiles p
    where p.user_id = p_actor_user_id and p.role = 'admin' and p.active
  ) then
    raise exception using errcode = '42501', message = 'Active administrator actor required';
  end if;
  if nullif(btrim(p_email), '') is null or length(btrim(p_email)) > 320 then
    raise exception using errcode = '22023', message = 'Email is invalid';
  end if;

  select cu.customer_id into v_customer_id
  from public.customer_users cu
  join public.profiles p on p.user_id = cu.user_id and p.role = 'client'
  where cu.user_id = p_user_id
  for update of cu;
  if not found then
    raise exception using errcode = 'P0002', message = 'Client identity not found';
  end if;

  update public.customers
  set email = lower(btrim(p_email))
  where id = v_customer_id;

  insert into public.admin_audit_log(
    actor_user_id, action, target_user_id, customer_id, details
  ) values (
    p_actor_user_id,
    'client.email_changed',
    p_user_id,
    v_customer_id,
    jsonb_build_object('email', lower(btrim(p_email)))
  );

  return v_customer_id;
end;
$$;

create or replace function private.can_access_price_list(p_price_list_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_admin() or exists (
    select 1
    from public.customer_users cu
    join public.customers c on c.id = cu.customer_id and c.active
    join public.profiles p on p.user_id = cu.user_id and p.active
    where cu.user_id = (select auth.uid())
      and c.price_list_id = p_price_list_id
  );
$$;

create or replace function private.can_access_order(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.orders o
    where o.id = p_order_id
      and private.can_access_customer(o.customer_id)
  );
$$;

insert into public.price_lists(id, name, currency, active)
values ('00000000-0000-4000-8000-000000000001', 'Listino base', 'EUR', true)
on conflict (id) do nothing;

insert into public.supplier_settings(id) values (1)
on conflict (id) do nothing;

alter table public.profiles enable row level security;
alter table public.supplier_settings enable row level security;
alter table public.products enable row level security;
alter table public.price_lists enable row level security;
alter table public.customers enable row level security;
alter table public.customer_users enable row level security;
alter table public.price_list_items enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_status_history enable row level security;
alter table public.document_counters enable row level security;
alter table public.delivery_documents enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.telegram_action_tokens enable row level security;
alter table public.telegram_updates enable row level security;
alter table public.admin_audit_log enable row level security;

create policy profiles_select_self_or_admin
on public.profiles for select to authenticated
using (
  (user_id = (select auth.uid()) and private.is_active_user())
  or private.is_admin()
);

create policy supplier_settings_select_authenticated
on public.supplier_settings for select to authenticated
using (private.is_active_user());
create policy supplier_settings_insert_admin
on public.supplier_settings for insert to authenticated
with check (private.is_admin());
create policy supplier_settings_update_admin
on public.supplier_settings for update to authenticated
using (private.is_admin()) with check (private.is_admin());

create policy products_select_active_or_admin
on public.products for select to authenticated
using ((active and private.is_active_user()) or private.is_admin());
create policy products_insert_admin
on public.products for insert to authenticated
with check (private.is_admin());
create policy products_update_admin
on public.products for update to authenticated
using (private.is_admin()) with check (private.is_admin());

create policy price_lists_select_assigned_or_admin
on public.price_lists for select to authenticated
using (private.can_access_price_list(id));
create policy price_lists_insert_admin
on public.price_lists for insert to authenticated
with check (private.is_admin());
create policy price_lists_update_admin
on public.price_lists for update to authenticated
using (private.is_admin()) with check (private.is_admin());

create policy customers_select_own_or_admin
on public.customers for select to authenticated
using (private.can_access_customer(id));
create policy customers_insert_admin
on public.customers for insert to authenticated
with check (private.is_admin());
create policy customers_update_admin
on public.customers for update to authenticated
using (private.is_admin()) with check (private.is_admin());

create policy customer_users_select_self_or_admin
on public.customer_users for select to authenticated
using (
  (user_id = (select auth.uid()) and private.is_active_user())
  or private.is_admin()
);

create policy price_list_items_select_assigned_or_admin
on public.price_list_items for select to authenticated
using (
  private.is_admin()
  or (
    private.can_access_price_list(price_list_id)
    and valid_from <= (now() at time zone 'Europe/Rome')::date
    and (valid_to is null or valid_to >= (now() at time zone 'Europe/Rome')::date)
  )
);
create policy price_list_items_insert_admin
on public.price_list_items for insert to authenticated
with check (private.is_admin());
create policy price_list_items_update_admin
on public.price_list_items for update to authenticated
using (private.is_admin()) with check (private.is_admin());
create policy price_list_items_delete_admin
on public.price_list_items for delete to authenticated
using (private.is_admin());

create policy orders_select_own_or_admin
on public.orders for select to authenticated
using (private.can_access_customer(customer_id));

create policy order_items_select_own_or_admin
on public.order_items for select to authenticated
using (private.can_access_order(order_id));

create policy order_status_history_select_own_or_admin
on public.order_status_history for select to authenticated
using (private.can_access_order(order_id));

create policy document_counters_select_admin
on public.document_counters for select to authenticated
using (private.is_admin());

create policy delivery_documents_select_own_or_admin
on public.delivery_documents for select to authenticated
using (private.can_access_customer(customer_id));

create policy notification_outbox_select_admin
on public.notification_outbox for select to authenticated
using (private.is_admin());

create policy telegram_action_tokens_select_admin
on public.telegram_action_tokens for select to authenticated
using (private.is_admin());

create policy telegram_updates_select_admin
on public.telegram_updates for select to authenticated
using (private.is_admin());

create policy admin_audit_log_select_admin
on public.admin_audit_log for select to authenticated
using (private.is_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ddt-pdf', 'ddt-pdf', false, 10485760, array['application/pdf'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy ddt_pdf_select_own_or_admin
on storage.objects for select to authenticated
using (
  bucket_id = 'ddt-pdf'
  and (
    private.is_admin()
    or (
      (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and private.can_access_customer(((storage.foldername(name))[1])::uuid)
    )
  )
);

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;

grant usage on schema public to authenticated;
grant usage on schema private to authenticated;
grant execute on function private.is_active_user() to authenticated;
grant execute on function private.is_admin() to authenticated;
grant execute on function private.can_access_customer(uuid) to authenticated;
grant execute on function private.can_access_price_list(uuid) to authenticated;
grant execute on function private.can_access_order(uuid) to authenticated;

grant select on public.profiles to authenticated;
grant select, insert, update on public.supplier_settings to authenticated;
grant select, insert, update on public.products to authenticated;
grant select, insert, update on public.price_lists to authenticated;
grant select, insert, update on public.customers to authenticated;
grant select on public.customer_users to authenticated;
grant select on public.price_list_items to authenticated;
grant select on public.orders to authenticated;
grant select on public.order_items to authenticated;
grant select on public.order_status_history to authenticated;
grant select on public.document_counters to authenticated;
grant select on public.delivery_documents to authenticated;
grant select on public.notification_outbox to authenticated;
grant select on public.telegram_action_tokens to authenticated;
grant select on public.telegram_updates to authenticated;
grant select on public.admin_audit_log to authenticated;

-- Edge Functions use the service role after performing their own authorization.
-- These explicit grants avoid relying on project-level default privileges.
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select, update on all sequences in schema public to service_role;

grant execute on function public.create_order(date, text, uuid) to authenticated;
grant execute on function public.update_order(uuid, date, text, integer) to authenticated;
grant execute on function public.set_order_item(uuid, uuid, numeric, integer) to authenticated;
grant execute on function public.remove_order_item(uuid, uuid, integer) to authenticated;
grant execute on function public.submit_order(uuid, integer, public.payment_method) to authenticated;
grant execute on function public.withdraw_order(uuid, integer) to authenticated;
grant execute on function public.place_order(uuid, date, text, jsonb, public.payment_method, integer, uuid, uuid) to authenticated;
grant execute on function public.admin_transition_order(uuid, public.order_status, integer, text) to authenticated;
grant execute on function public.admin_confirm_order_payment(uuid, integer) to authenticated;
grant execute on function public.prepare_delivery_document(
  uuid, integer, text, date, timestamptz, text, jsonb, jsonb, integer, text
) to authenticated;
grant execute on function public.mark_delivery_document_ready(uuid, text, text) to authenticated;
grant execute on function public.get_catalog(uuid) to authenticated;
grant execute on function public.admin_set_current_price(uuid, uuid, numeric, numeric, date) to authenticated;
grant execute on function public.admin_upsert_product_with_price(
  text, text, text, text, text, text, numeric, public.product_pricing_mode,
  boolean, uuid, numeric, numeric, date, uuid
) to authenticated;
grant execute on function public.admin_import_catalog(jsonb, boolean) to authenticated;

grant execute on function public.apply_telegram_order_action(
  bigint, text, public.order_status, bigint
) to service_role;
grant execute on function public.admin_register_client_identity(
  uuid, text, text, jsonb, uuid, uuid
) to service_role;
grant execute on function public.admin_set_profile_active(uuid, boolean, uuid) to service_role;
grant execute on function public.admin_update_client_email(uuid, text, uuid) to service_role;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

comment on table public.supplier_settings is
  'Single authenticated supplier profile. The repository contains no real IGEA fiscal data.';
comment on table public.delivery_documents is
  'Numbered immutable DDT snapshot. In the MVP the PDF is exported client-side; pdf_object_path/hash stay null.';
comment on column public.price_list_items.unit_price_net is
  'Net price for the product pricing basis: EUR/kg when products.pricing_mode=per_kg, EUR/unit otherwise.';
comment on column public.order_items.quantity is
  'Number of packages/units ordered. Server totals also apply package_size_snapshot for per_kg products.';
comment on column public.customers.payment_method is
  'Legacy default retained for compatibility. The operative payment method is chosen by the customer on each order.';
comment on column public.orders.payment_method_snapshot is
  'Payment method chosen by the customer for this order. It becomes immutable after acceptance/payment evidence.';
comment on column public.orders.payment_confirmed_at is
  'Immutable seller confirmation timestamp, used only for on-delivery payments.';
comment on column public.delivery_documents.payment_method_snapshot is
  'Immutable payment method copied from the submitted order when the DDT is prepared.';
comment on function public.admin_confirm_order_payment(uuid, integer) is
  'Admin-only, optimistic-locking confirmation of an on-delivery payment; retries are idempotent.';
comment on function public.admin_import_catalog(jsonb, boolean) is
  'Atomically imports up to 500 products into the base price list; replace mode deactivates absent SKUs without deleting history.';
comment on function public.prepare_delivery_document(
  uuid, integer, text, date, timestamptz, text, jsonb, jsonb, integer, text
) is 'Atomically allocates the annual DDT counter, stores snapshots and moves an accepted order to in_delivery.';
