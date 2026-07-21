begin;

alter table public.orders
  add column if not exists discount_code text;

create table if not exists public.discount_codes (
  id text primary key default gen_random_uuid()::text,
  code text not null unique,
  description text not null default '',
  active boolean not null default true,
  valid_until date,
  product_price_overrides jsonb not null default '{}'::jsonb check (jsonb_typeof(product_price_overrides) = 'object'),
  product_percent_discounts jsonb not null default '{}'::jsonb check (jsonb_typeof(product_percent_discounts) = 'object'),
  free_delivery boolean not null default false,
  delivery_fee_net numeric(12,2) check (delivery_fee_net is null or delivery_fee_net >= 0),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (code = upper(btrim(code)) and char_length(code) between 2 and 40)
);

create or replace function private.validate_discount_code_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_value text;
begin
  for v_value in select value from jsonb_each_text(new.product_price_overrides)
  loop
    if v_value !~ '^[0-9]+([.][0-9]+)?$' or v_value::numeric < 0 then
      raise exception using errcode = '22023', message = 'Invalid fixed product price in discount code';
    end if;
  end loop;
  for v_value in select value from jsonb_each_text(new.product_percent_discounts)
  loop
    if v_value !~ '^[0-9]+([.][0-9]+)?$' or v_value::numeric < 0 or v_value::numeric > 100 then
      raise exception using errcode = '22023', message = 'Invalid product discount percentage';
    end if;
  end loop;
  new.code := upper(btrim(new.code));
  return new;
end;
$$;

drop trigger if exists discount_codes_validate_rules on public.discount_codes;
create trigger discount_codes_validate_rules
before insert or update on public.discount_codes
for each row execute function private.validate_discount_code_rules();

drop trigger if exists discount_codes_set_updated_at on public.discount_codes;
create trigger discount_codes_set_updated_at
before update on public.discount_codes
for each row execute function private.set_updated_at();

alter table public.discount_codes enable row level security;

drop policy if exists discount_codes_admin_all on public.discount_codes;
create policy discount_codes_admin_all
on public.discount_codes
for all to authenticated
using (private.is_admin())
with check (private.is_admin());

grant select, insert, update, delete on public.discount_codes to authenticated;

create or replace function public.resolve_discount_code(
  p_code text,
  p_customer_id uuid default null
)
returns table (
  id text,
  code text,
  description text,
  active boolean,
  valid_until date,
  product_price_overrides jsonb,
  product_percent_discounts jsonb,
  free_delivery boolean,
  delivery_fee_net numeric
)
language plpgsql
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
    v_customer_id := coalesce(p_customer_id, private.current_customer_id());
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
  select d.id, d.code, d.description, d.active, d.valid_until,
         d.product_price_overrides, d.product_percent_discounts,
         d.free_delivery, d.delivery_fee_net
  from public.discount_codes d
  where d.code = upper(btrim(p_code))
    and d.active
    and (d.valid_until is null or d.valid_until >= (now() at time zone 'Europe/Rome')::date)
  limit 1;
end;
$$;

create or replace function private.apply_order_discount(
  p_order_id uuid,
  p_discount_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_discount public.discount_codes;
  v_base_delivery_fee numeric(12,2);
begin
  select o.* into v_order
  from public.orders o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Order not found';
  end if;
  if not private.can_access_customer(v_order.customer_id) then
    raise exception using errcode = '42501', message = 'Order access denied';
  end if;

  select case when c.delivery_fee_mode = 'free' then 0 else 3.50 end
  into v_base_delivery_fee
  from public.customers c
  where c.id = v_order.customer_id;

  if nullif(upper(btrim(coalesce(p_discount_code, ''))), '') is not null then
    select d.* into v_discount
    from public.discount_codes d
    where d.code = upper(btrim(p_discount_code))
      and d.active
      and (d.valid_until is null or d.valid_until >= (now() at time zone 'Europe/Rome')::date)
    for share;

    if not found then
      raise exception using errcode = '22023', message = 'Codice sconto non valido, scaduto o non attivo';
    end if;
  end if;

  with priced as (
    select
      oi.id,
      case
        when v_discount.id is not null and v_discount.product_price_overrides ? oi.product_id::text
          then round((v_discount.product_price_overrides ->> oi.product_id::text)::numeric, 4)
        when v_discount.id is not null and v_discount.product_percent_discounts ? oi.product_id::text
          then round(ep.unit_price_net * (1 - (v_discount.product_percent_discounts ->> oi.product_id::text)::numeric / 100), 4)
        else ep.unit_price_net
      end as new_unit_price
    from public.order_items oi
    join lateral private.effective_price(
      v_order.customer_id,
      oi.product_id,
      (now() at time zone 'Europe/Rome')::date
    ) ep on true
    where oi.order_id = p_order_id
  )
  update public.order_items oi
  set unit_price_net = p.new_unit_price,
      line_net = round(oi.quantity * case when oi.pricing_mode_snapshot = 'per_kg' then oi.package_size_snapshot else 1 end * p.new_unit_price, 2),
      line_vat = round(round(oi.quantity * case when oi.pricing_mode_snapshot = 'per_kg' then oi.package_size_snapshot else 1 end * p.new_unit_price, 2) * oi.vat_rate / 100, 2),
      line_gross = round(oi.quantity * case when oi.pricing_mode_snapshot = 'per_kg' then oi.package_size_snapshot else 1 end * p.new_unit_price, 2)
        + round(round(oi.quantity * case when oi.pricing_mode_snapshot = 'per_kg' then oi.package_size_snapshot else 1 end * p.new_unit_price, 2) * oi.vat_rate / 100, 2)
  from priced p
  where oi.id = p.id;

  update public.orders
  set discount_code = v_discount.code,
      delivery_fee_net = case
        when v_discount.id is null then coalesce(v_base_delivery_fee, 3.50)
        when v_discount.free_delivery then 0
        when v_discount.delivery_fee_net is not null then v_discount.delivery_fee_net
        else coalesce(v_base_delivery_fee, 3.50)
      end,
      delivery_fee_vat_rate = 22
  where id = p_order_id;

  perform private.recalculate_order_totals(p_order_id);
end;
$$;

create or replace function public.place_order_with_discount(
  p_order_id uuid default null,
  p_requested_delivery_date date default null,
  p_notes text default null,
  p_items jsonb default '[]'::jsonb,
  p_payment_method public.payment_method default 'end_of_month',
  p_expected_version integer default null,
  p_customer_id uuid default null,
  p_idempotency_key uuid default null,
  p_discount_code text default null
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  v_order := public.place_order(
    p_order_id,
    p_requested_delivery_date,
    p_notes,
    p_items,
    p_payment_method,
    p_expected_version,
    p_customer_id,
    p_idempotency_key
  );
  perform private.apply_order_discount(v_order.id, p_discount_code);
  select * into v_order from public.orders where id = v_order.id;
  return v_order;
end;
$$;

create or replace function private.protect_order_payment_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.payment_method_snapshot is not null
     and new.payment_method_snapshot is distinct from old.payment_method_snapshot
     and coalesce(current_setting('app.allow_payment_method_update', true), '') <> 'on'
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

create or replace function public.admin_update_order_payment_method(
  p_order_id uuid,
  p_payment_method public.payment_method
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
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Order not found';
  end if;
  if v_order.status not in ('submitted', 'accepted', 'in_delivery', 'delivered') then
    raise exception using errcode = '22023', message = 'Payment method cannot be changed in the current status';
  end if;
  if v_order.payment_confirmed_at is not null and v_order.payment_method_snapshot <> p_payment_method then
    raise exception using errcode = '22023', message = 'A confirmed payment cannot be reclassified';
  end if;

  perform set_config('app.allow_payment_method_update', 'on', true);

  update public.orders
  set payment_method_snapshot = p_payment_method,
      customer_snapshot = jsonb_set(coalesce(customer_snapshot, '{}'::jsonb), '{paymentMethod}', to_jsonb(p_payment_method), true),
      version = version + 1
  where id = p_order_id
  returning * into v_order;

  update public.delivery_documents
  set payment_method_snapshot = p_payment_method,
      customer_snapshot = jsonb_set(customer_snapshot, '{paymentMethod}', to_jsonb(p_payment_method), true),
      pdf_object_path = null,
      pdf_sha256 = null
  where order_id = p_order_id and status <> 'void';

  insert into public.admin_audit_log(actor_user_id, action, details)
  values (auth.uid(), 'order.payment_method_updated', jsonb_build_object('order_id', p_order_id, 'payment_method', p_payment_method));
  return v_order;
end;
$$;

create or replace function public.admin_update_delivery_document_metadata(
  p_document_id uuid,
  p_display_number text,
  p_issued_on date,
  p_payment_method public.payment_method
)
returns public.delivery_documents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_document public.delivery_documents;
  v_order public.orders;
  v_number text := btrim(p_display_number);
begin
  if not private.is_admin() then
    raise exception using errcode = '42501', message = 'Administrator access required';
  end if;
  if nullif(v_number, '') is null or char_length(v_number) > 80 then
    raise exception using errcode = '22023', message = 'Invalid delivery document number';
  end if;
  if p_issued_on is null or p_issued_on < date '2000-01-01' or p_issued_on > (now() at time zone 'Europe/Rome')::date then
    raise exception using errcode = '22023', message = 'Invalid delivery document date';
  end if;

  select * into v_document from public.delivery_documents where id = p_document_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Delivery document not found';
  end if;
  if v_document.status = 'void' then
    raise exception using errcode = '22023', message = 'A void delivery document cannot be changed';
  end if;

  select * into v_order from public.orders where id = v_document.order_id for update;
  if v_order.payment_confirmed_at is not null and v_order.payment_method_snapshot <> p_payment_method then
    raise exception using errcode = '22023', message = 'A confirmed payment cannot be reclassified';
  end if;

  perform set_config('app.allow_payment_method_update', 'on', true);

  update public.orders
  set payment_method_snapshot = p_payment_method,
      customer_snapshot = jsonb_set(coalesce(customer_snapshot, '{}'::jsonb), '{paymentMethod}', to_jsonb(p_payment_method), true),
      version = version + 1
  where id = v_document.order_id;

  update public.delivery_documents
  set display_number = v_number,
      issued_on = p_issued_on,
      payment_method_snapshot = p_payment_method,
      customer_snapshot = jsonb_set(customer_snapshot, '{paymentMethod}', to_jsonb(p_payment_method), true),
      pdf_object_path = null,
      pdf_sha256 = null
  where id = p_document_id
  returning * into v_document;

  insert into public.admin_audit_log(actor_user_id, action, details)
  values (
    auth.uid(),
    'delivery_document.metadata_updated',
    jsonb_build_object(
      'delivery_document_id', p_document_id,
      'order_id', v_document.order_id,
      'display_number', v_document.display_number,
      'issued_on', v_document.issued_on,
      'payment_method', v_document.payment_method_snapshot
    )
  );
  return v_document;
end;
$$;

grant execute on function public.resolve_discount_code(text, uuid) to authenticated;
grant execute on function public.place_order_with_discount(uuid, date, text, jsonb, public.payment_method, integer, uuid, uuid, text) to authenticated;
grant execute on function public.admin_update_order_payment_method(uuid, public.payment_method) to authenticated;
grant execute on function public.admin_update_delivery_document_metadata(uuid, text, date, public.payment_method) to authenticated;

commit;
