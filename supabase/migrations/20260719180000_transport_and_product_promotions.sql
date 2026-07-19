-- Il trasporto e una voce economica dell'ordine/DDT, non un prodotto.
-- Le promo prodotto sono percentuali server-authoritative: il browser mostra
-- il prezzo, ma il database lo ricalcola sempre dal listino corrente.

alter table public.products
  add column promoted boolean not null default false,
  add column promo_percent_discount numeric(5,2)
    check (promo_percent_discount is null or (promo_percent_discount > 0 and promo_percent_discount <= 100)),
  add column promo_label text not null default '';

alter table public.products
  add constraint products_active_promotion_has_percent check (
    not promoted or promo_percent_discount is not null
  );

alter table public.customers
  add column delivery_fee_mode text not null default 'standard'
    check (delivery_fee_mode in ('standard', 'free'));

alter table public.orders
  add column delivery_fee_net numeric(12,2) not null default 3.50
    check (delivery_fee_net >= 0),
  add column delivery_fee_vat_rate numeric(5,2) not null default 22
    check (delivery_fee_vat_rate = 22);

create or replace function private.is_delivery_service_product(p_sku text, p_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select upper(btrim(coalesce(p_sku, ''))) in ('TRASP', 'TRASP2')
    or lower(btrim(coalesce(p_name, ''))) in ('trasporto', 'trasporto doppio', 'spese di trasporto');
$$;

-- Conserva gli eventuali riferimenti storici, ma non espone piu queste righe.
update public.products
set active = false,
    promoted = false,
    promo_percent_discount = null,
    promo_label = ''
where private.is_delivery_service_product(sku, name);

create or replace function private.reject_active_delivery_service_product()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.active and private.is_delivery_service_product(new.sku, new.name) then
    raise exception using errcode = '22023',
      message = 'Delivery is added automatically and cannot be stored as an active product';
  end if;
  return new;
end;
$$;

create trigger products_reject_delivery_service
before insert or update of sku, name, active on public.products
for each row execute function private.reject_active_delivery_service_product();

create or replace function private.reject_delivery_service_order_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.products p
    where p.id = new.product_id
      and private.is_delivery_service_product(p.sku, p.name)
  ) then
    raise exception using errcode = '22023',
      message = 'Delivery is added automatically and cannot be ordered as a product';
  end if;
  return new;
end;
$$;

create trigger order_items_reject_delivery_service
before insert or update of product_id on public.order_items
for each row execute function private.reject_delivery_service_order_item();

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
    'paymentMethod', c.payment_method,
    'deliveryFeeMode', c.delivery_fee_mode
  )
  from public.customers c
  where c.id = p_customer_id;
$$;

create or replace function private.apply_order_delivery_fee_default()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mode text;
begin
  select c.delivery_fee_mode into v_mode
  from public.customers c
  where c.id = new.customer_id;

  if not found then
    raise exception using errcode = '23503', message = 'Customer not found for delivery fee';
  end if;

  new.delivery_fee_net := case when v_mode = 'free' then 0 else 3.50 end;
  new.delivery_fee_vat_rate := 22;
  return new;
end;
$$;

create trigger orders_apply_delivery_fee_default
before insert on public.orders
for each row execute function private.apply_order_delivery_fee_default();

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
  select
    round(
      pli.unit_price_net * case
        when p.promoted and p.promo_percent_discount is not null
          then 1 - p.promo_percent_discount / 100
        else 1
      end,
      2
    ) as unit_price_net,
    pli.vat_rate
  from public.customers c
  join public.price_lists pl on pl.id = c.price_list_id and pl.active
  join public.price_list_items pli on pli.price_list_id = pl.id
  join public.products p on p.id = pli.product_id and p.active
  where c.id = p_customer_id
    and c.active
    and pli.product_id = p_product_id
    and not private.is_delivery_service_product(p.sku, p.name)
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
  v_goods_net numeric(14,2);
  v_goods_vat numeric(14,2);
  v_delivery_net numeric(12,2);
  v_delivery_vat_rate numeric(5,2);
  v_net numeric(14,2);
  v_vat numeric(14,2);
begin
  select
    coalesce(sum(lines.line_net), 0),
    coalesce(sum(lines.line_vat), 0)
  into v_goods_net, v_goods_vat
  from (
    select
      round(
        coalesce(oi.fulfilled_quantity, oi.quantity)
          * case when oi.pricing_mode_snapshot = 'per_kg' then oi.package_size_snapshot else 1 end
          * oi.unit_price_net,
        2
      ) as line_net,
      round(
        round(
          coalesce(oi.fulfilled_quantity, oi.quantity)
            * case when oi.pricing_mode_snapshot = 'per_kg' then oi.package_size_snapshot else 1 end
            * oi.unit_price_net,
          2
        ) * oi.vat_rate / 100,
        2
      ) as line_vat
    from public.order_items oi
    where oi.order_id = p_order_id
      and coalesce(oi.fulfilled_quantity, oi.quantity) > 0
  ) lines;

  select o.delivery_fee_net, o.delivery_fee_vat_rate
  into v_delivery_net, v_delivery_vat_rate
  from public.orders o
  where o.id = p_order_id;

  v_net := round(v_goods_net + coalesce(v_delivery_net, 0), 2);
  v_vat := round(v_goods_vat + round(coalesce(v_delivery_net, 0) * coalesce(v_delivery_vat_rate, 22) / 100, 2), 2);

  update public.orders
  set net_total = v_net,
      vat_total = v_vat,
      gross_total = round(v_net + v_vat, 2)
  where id = p_order_id;
end;
$$;

do $$
declare
  v_order_id uuid;
begin
  for v_order_id in select o.id from public.orders o
  loop
    perform private.recalculate_order_totals(v_order_id);
  end loop;
end;
$$;

create or replace function private.apply_order_delivery_fee_to_document()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select o.delivery_fee_net, o.delivery_fee_vat_rate
  into new.delivery_fee_net, new.delivery_fee_vat_rate
  from public.orders o
  where o.id = new.order_id;

  if not found then
    raise exception using errcode = '23503', message = 'Order not found for delivery document';
  end if;
  return new;
end;
$$;

create trigger delivery_documents_apply_order_delivery_fee
before insert on public.delivery_documents
for each row execute function private.apply_order_delivery_fee_to_document();

drop function public.get_catalog(uuid);
create function public.get_catalog(p_customer_id uuid default null)
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
  currency char(3),
  promoted boolean,
  promo_percent_discount numeric,
  promo_label text
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
    current_price.unit_price_net,
    current_price.vat_rate,
    pl.currency,
    p.promoted,
    p.promo_percent_discount,
    case
      when p.promoted and p.promo_percent_discount is not null
        then 'Sconto ' || trim(to_char(p.promo_percent_discount, 'FM999990D99')) || '%'
      else ''
    end
  from public.customers c
  join public.price_lists pl on pl.id = c.price_list_id and pl.active
  join public.products p on p.active
  join lateral (
    select pli.unit_price_net, pli.vat_rate
    from public.price_list_items pli
    where pli.price_list_id = pl.id
      and pli.product_id = p.id
      and pli.valid_from <= (now() at time zone 'Europe/Rome')::date
      and (pli.valid_to is null or pli.valid_to >= (now() at time zone 'Europe/Rome')::date)
    order by pli.valid_from desc
    limit 1
  ) current_price on true
  where c.id = v_customer_id
    and c.active
    and not private.is_delivery_service_product(p.sku, p.name)
  order by p.promoted desc, p.category, p.name, p.id;
end;
$$;

create or replace function public.admin_update_delivery_fee(
  p_document_id uuid,
  p_delivery_fee_net numeric
)
returns public.delivery_documents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_document public.delivery_documents;
  v_order public.orders;
  v_previous_fee numeric(12,2);
begin
  if not private.is_admin() then
    raise exception using errcode = '42501', message = 'Administrator access required';
  end if;
  if p_delivery_fee_net is null
     or p_delivery_fee_net::text in ('NaN', 'Infinity', '-Infinity')
     or p_delivery_fee_net < 0
     or p_delivery_fee_net > 99999 then
    raise exception using errcode = '22023', message = 'Invalid delivery fee';
  end if;

  select * into v_document
  from public.delivery_documents d
  where d.id = p_document_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Delivery document not found';
  end if;
  if v_document.status = 'void' then
    raise exception using errcode = '22023', message = 'A void delivery document cannot be changed';
  end if;

  select * into v_order
  from public.orders o
  where o.id = v_document.order_id
  for update;

  if v_order.payment_confirmed_at is not null then
    raise exception using errcode = '22023',
      message = 'A paid order requires a separate refund or integration workflow';
  end if;

  v_previous_fee := v_document.delivery_fee_net;
  update public.delivery_documents
  set delivery_fee_net = round(p_delivery_fee_net, 2),
      delivery_fee_vat_rate = 22,
      pdf_object_path = null,
      pdf_sha256 = null
  where id = p_document_id
  returning * into v_document;

  update public.orders
  set delivery_fee_net = v_document.delivery_fee_net,
      delivery_fee_vat_rate = 22,
      version = version + 1
  where id = v_document.order_id;
  perform private.recalculate_order_totals(v_document.order_id);

  insert into public.admin_audit_log(actor_user_id, action, details)
  values (
    auth.uid(),
    'delivery_document.fee_updated',
    jsonb_build_object(
      'delivery_document_id', v_document.id,
      'order_id', v_document.order_id,
      'previous_delivery_fee_net', v_previous_fee,
      'delivery_fee_net', v_document.delivery_fee_net,
      'delivery_fee_vat_rate', v_document.delivery_fee_vat_rate
    )
  );

  return v_document;
end;
$$;

grant execute on function public.get_catalog(uuid) to authenticated;
grant execute on function public.admin_update_delivery_fee(uuid, numeric) to authenticated;

comment on column public.products.promo_percent_discount is
  'Global product promotion percentage. Applied server-side when promoted is true.';
comment on column public.orders.delivery_fee_net is
  'Single delivery service snapshot, stored separately from order_items.';
comment on function public.admin_update_delivery_fee(uuid, numeric) is
  'Admin-only audited update of the single delivery fee; VAT remains fixed at 22 percent.';
