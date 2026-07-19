-- Quantità richieste e quantità effettivamente evase restano distinte.
-- Un DDT già emesso non viene riscritto: la rettifica lo annulla e genera
-- atomically un documento sostitutivo con un nuovo progressivo.

alter table public.order_items
  add column fulfilled_quantity numeric(12,3)
  check (
    fulfilled_quantity is null
    or (
      fulfilled_quantity >= 0
      and fulfilled_quantity <= quantity
      and fulfilled_quantity = trunc(fulfilled_quantity)
    )
  );

alter table public.orders
  add column fulfillment_adjusted_at timestamptz,
  add column fulfillment_adjusted_by uuid references auth.users(id) on delete restrict,
  add column fulfillment_adjustment_note text;

alter table public.orders
  add constraint orders_fulfillment_adjustment_complete check (
    (fulfillment_adjusted_at is null and fulfillment_adjusted_by is null and fulfillment_adjustment_note is null)
    or (
      fulfillment_adjusted_at is not null
      and fulfillment_adjusted_by is not null
      and length(btrim(fulfillment_adjustment_note)) between 3 and 300
    )
  );

alter table public.delivery_documents
  add column revision_number integer not null default 0 check (revision_number >= 0),
  add column revision_reason text,
  add column replaces_document_id uuid references public.delivery_documents(id) on delete restrict,
  add column delivery_fee_net numeric(12,2) not null default 3.50 check (delivery_fee_net >= 0),
  add column delivery_fee_vat_rate numeric(5,2) not null default 22 check (delivery_fee_vat_rate between 0 and 100);

alter table public.delivery_documents
  drop constraint if exists delivery_documents_order_id_key;

create unique index delivery_documents_one_active_per_order_idx
on public.delivery_documents(order_id)
where status in ('generating', 'ready');

create index delivery_documents_replaces_document_id_idx
on public.delivery_documents(replaces_document_id)
where replaces_document_id is not null;

create or replace function private.delivery_items_snapshot(p_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_agg(
    jsonb_build_object(
      'productId', lines.product_id,
      'sku', lines.sku_snapshot,
      'name', lines.name_snapshot,
      'category', lines.category_snapshot,
      'uom', lines.uom_snapshot,
      'packageLabel', lines.package_label_snapshot,
      'packageSize', lines.package_size_snapshot,
      'pricingMode', lines.pricing_mode_snapshot,
      'quantity', lines.effective_quantity,
      'orderedQuantity', lines.ordered_quantity,
      'unitPriceNet', lines.unit_price_net,
      'vatRate', lines.vat_rate,
      'lineNet', lines.line_net,
      'lineVat', lines.line_vat,
      'lineGross', lines.line_net + lines.line_vat
    ) order by lines.id
  )
  from (
    select
      oi.id,
      oi.product_id,
      oi.sku_snapshot,
      oi.name_snapshot,
      oi.category_snapshot,
      oi.uom_snapshot,
      oi.package_label_snapshot,
      oi.package_size_snapshot,
      oi.pricing_mode_snapshot,
      oi.quantity as ordered_quantity,
      coalesce(oi.fulfilled_quantity, oi.quantity) as effective_quantity,
      oi.unit_price_net,
      oi.vat_rate,
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
$$;

create or replace function private.delivery_packages(p_order_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(
    ceil(sum(coalesce(oi.fulfilled_quantity, oi.quantity)) filter (
      where oi.pricing_mode_snapshot = 'per_kg'
        and coalesce(oi.fulfilled_quantity, oi.quantity) > 0
    ))::integer,
    0
  )
  from public.order_items oi
  where oi.order_id = p_order_id;
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
    coalesce(sum(lines.line_net), 0),
    coalesce(sum(lines.line_vat), 0),
    coalesce(sum(lines.line_net + lines.line_vat), 0)
  into v_net, v_vat, v_gross
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

  update public.orders
  set net_total = v_net,
      vat_total = v_vat,
      gross_total = v_gross
  where id = p_order_id;
end;
$$;

create or replace function private.apply_fulfillment_to_delivery_document()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.items_snapshot := private.delivery_items_snapshot(new.order_id);
  if new.items_snapshot is null then
    raise exception using errcode = '22023', message = 'Cannot create a delivery document without fulfilled items';
  end if;
  new.packages := private.delivery_packages(new.order_id);
  return new;
end;
$$;

create trigger delivery_documents_apply_fulfillment
before insert on public.delivery_documents
for each row execute function private.apply_fulfillment_to_delivery_document();

create or replace function public.admin_adjust_order_fulfillment(
  p_order_id uuid,
  p_items jsonb,
  p_expected_version integer,
  p_reason text
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_item jsonb;
  v_product_id uuid;
  v_fulfilled numeric;
  v_order_item public.order_items;
  v_before jsonb;
  v_after jsonb;
  v_item_count integer := 0;
  v_positive_count integer := 0;
  v_changed boolean := false;
  v_document public.delivery_documents;
  v_replacement public.delivery_documents;
  v_year integer;
  v_sequence bigint;
  v_display_number text;
begin
  if not private.is_admin() then
    raise exception using errcode = '42501', message = 'Administrator access required';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'All fulfillment quantities are required';
  end if;
  if nullif(btrim(p_reason), '') is null or length(btrim(p_reason)) not between 3 and 300 then
    raise exception using errcode = '22023', message = 'Adjustment reason must contain between 3 and 300 characters';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) item
    group by coalesce(item ->> 'product_id', item ->> 'productId')
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Duplicate products are not allowed';
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
  if v_order.status not in ('submitted', 'accepted', 'in_delivery', 'delivered') then
    raise exception using errcode = 'P0001', message = 'Fulfillment cannot be adjusted in the current order status';
  end if;
  if v_order.payment_confirmed_at is not null then
    raise exception using errcode = 'P0001', message = 'A paid order requires a separate refund or integration workflow';
  end if;

  select jsonb_agg(jsonb_build_object(
    'product_id', oi.product_id,
    'ordered_quantity', oi.quantity,
    'fulfilled_quantity', coalesce(oi.fulfilled_quantity, oi.quantity)
  ) order by oi.id)
  into v_before
  from public.order_items oi
  where oi.order_id = p_order_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    begin
      v_product_id := coalesce(v_item ->> 'product_id', v_item ->> 'productId')::uuid;
      v_fulfilled := coalesce(v_item ->> 'fulfilled_quantity', v_item ->> 'fulfilledQuantity')::numeric;
    exception when others then
      raise exception using errcode = '22023', message = 'Invalid product or fulfillment quantity';
    end;

    select * into v_order_item
    from public.order_items oi
    where oi.order_id = p_order_id
      and oi.product_id = v_product_id
    for update;

    if not found then
      raise exception using errcode = 'P0002', message = 'Order product not found';
    end if;
    if v_fulfilled is null
       or v_fulfilled::text in ('NaN', 'Infinity', '-Infinity')
       or v_fulfilled < 0
       or v_fulfilled > v_order_item.quantity
       or v_fulfilled <> trunc(v_fulfilled) then
      raise exception using errcode = '22023', message = 'Fulfilled quantity must be a whole number between zero and the ordered quantity';
    end if;

    v_changed := v_changed or coalesce(v_order_item.fulfilled_quantity, v_order_item.quantity) <> v_fulfilled;
    v_item_count := v_item_count + 1;
    if v_fulfilled > 0 then v_positive_count := v_positive_count + 1; end if;

    update public.order_items
    set fulfilled_quantity = v_fulfilled,
        line_net = round(
          v_fulfilled
            * case when pricing_mode_snapshot = 'per_kg' then package_size_snapshot else 1 end
            * unit_price_net,
          2
        ),
        line_vat = round(
          round(
            v_fulfilled
              * case when pricing_mode_snapshot = 'per_kg' then package_size_snapshot else 1 end
              * unit_price_net,
            2
          ) * vat_rate / 100,
          2
        ),
        line_gross = round(
          v_fulfilled
            * case when pricing_mode_snapshot = 'per_kg' then package_size_snapshot else 1 end
            * unit_price_net,
          2
        ) + round(
          round(
            v_fulfilled
              * case when pricing_mode_snapshot = 'per_kg' then package_size_snapshot else 1 end
              * unit_price_net,
            2
          ) * vat_rate / 100,
          2
        )
    where id = v_order_item.id;
  end loop;

  if v_item_count <> (select count(*) from public.order_items oi where oi.order_id = p_order_id) then
    raise exception using errcode = '22023', message = 'All order products must be included exactly once';
  end if;
  if v_positive_count = 0 then
    raise exception using errcode = '22023', message = 'At least one fulfilled item is required';
  end if;
  if not v_changed then
    raise exception using errcode = '22023', message = 'No fulfillment quantity was changed';
  end if;

  perform private.recalculate_order_totals(p_order_id);
  v_after := private.delivery_items_snapshot(p_order_id);

  select * into v_document
  from public.delivery_documents d
  where d.order_id = p_order_id
    and d.status = 'ready'
  order by d.created_at desc
  limit 1
  for update;

  if found then
    update public.delivery_documents
    set status = 'void',
        notes = concat_ws(E'\n', nullif(notes, ''), 'Annullato per rettifica quantità: ' || btrim(p_reason))
    where id = v_document.id;

    v_year := extract(year from (now() at time zone 'Europe/Rome')::date)::integer;
    insert into public.document_counters (
      document_type, series, document_year, last_number
    ) values (
      'DDT', v_document.series, v_year, 1
    )
    on conflict (document_type, series, document_year) do update
    set last_number = public.document_counters.last_number + 1,
        updated_at = now()
    returning last_number into v_sequence;

    v_display_number := case
      when v_document.series = 'A'
        then 'DDT-' || v_year::text || '-' || lpad(v_sequence::text, 6, '0')
      else 'DDT-' || v_document.series || '-' || v_year::text || '-' || lpad(v_sequence::text, 6, '0')
    end;

    insert into public.delivery_documents (
      order_id, customer_id, series, document_year, sequence_number,
      display_number, issued_on, transport_started_at, transport_reason,
      carrier_snapshot, destination_snapshot, supplier_snapshot, customer_snapshot,
      payment_method_snapshot, items_snapshot, packages, notes, status, created_by,
      revision_number, revision_reason, replaces_document_id,
      delivery_fee_net, delivery_fee_vat_rate
    ) values (
      v_document.order_id, v_document.customer_id, v_document.series, v_year, v_sequence,
      v_display_number, (now() at time zone 'Europe/Rome')::date,
      v_document.transport_started_at, v_document.transport_reason,
      v_document.carrier_snapshot, v_document.destination_snapshot,
      v_document.supplier_snapshot, v_document.customer_snapshot,
      v_document.payment_method_snapshot, v_after, private.delivery_packages(p_order_id),
      concat_ws(E'\n', nullif(v_document.notes, ''), 'DDT sostitutivo: ' || btrim(p_reason)),
      'ready', auth.uid(), v_document.revision_number + 1, btrim(p_reason), v_document.id,
      v_document.delivery_fee_net, v_document.delivery_fee_vat_rate
    )
    returning * into v_replacement;
  end if;

  update public.orders
  set fulfillment_adjusted_at = now(),
      fulfillment_adjusted_by = auth.uid(),
      fulfillment_adjustment_note = btrim(p_reason),
      version = version + 1
  where id = p_order_id
  returning * into v_order;

  insert into public.admin_audit_log (
    actor_user_id, action, customer_id, details
  ) values (
    auth.uid(),
    'order.fulfillment_adjusted',
    v_order.customer_id,
    jsonb_build_object(
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'order_status', v_order.status,
      'reason', btrim(p_reason),
      'before_items', coalesce(v_before, '[]'::jsonb),
      'after_items', coalesce(v_after, '[]'::jsonb),
      'void_document_id', v_document.id,
      'replacement_document_id', v_replacement.id,
      'replacement_display_number', v_replacement.display_number
    )
  );

  insert into public.notification_outbox (
    event_type, aggregate_id, dedupe_key, payload
  ) values (
    'order.fulfillment_adjusted',
    v_order.id,
    'order.fulfillment_adjusted:' || v_order.id::text || ':' || v_order.version::text,
    jsonb_build_object(
      'order_id', v_order.id,
      'order_version', v_order.version,
      'reason', btrim(p_reason),
      'replacement_document_id', v_replacement.id,
      'replacement_display_number', v_replacement.display_number
    )
  ) on conflict (dedupe_key) do nothing;

  if v_order.status = 'submitted' then
    update public.telegram_action_tokens
    set expires_at = least(expires_at, now())
    where order_id = v_order.id
      and used_at is null;

    insert into public.notification_outbox (
      event_type, aggregate_id, dedupe_key, payload
    ) values (
      'order.submitted',
      v_order.id,
      'order.submitted:' || v_order.id::text || ':' || v_order.version::text,
      jsonb_build_object(
        'order_id', v_order.id,
        'order_version', v_order.version,
        'source', 'fulfillment_adjustment',
        'payment_method', v_order.payment_method_snapshot,
        'payment_confirmed_at', v_order.payment_confirmed_at
      )
    ) on conflict (dedupe_key) do nothing;
  end if;

  return v_order;
end;
$$;

revoke all on function public.admin_adjust_order_fulfillment(uuid, jsonb, integer, text)
from public, anon, authenticated;
grant execute on function public.admin_adjust_order_fulfillment(uuid, jsonb, integer, text)
to authenticated;

comment on column public.order_items.fulfilled_quantity is
  'Admin-confirmed packages actually fulfilled; null means the full ordered quantity.';
comment on function public.admin_adjust_order_fulfillment(uuid, jsonb, integer, text) is
  'Admin-only audited fulfillment adjustment. Existing ready DDTs are voided and atomically replaced with a new progressive document.';
