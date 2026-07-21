begin;

-- Questa migrazione rende il salvataggio dei codici sconto indipendente
-- dal tipo storico della colonna id e dalle policy di upsert del client.
create table if not exists public.discount_codes (
  id text primary key default gen_random_uuid()::text,
  code text not null unique,
  description text not null default '',
  active boolean not null default true,
  valid_until date,
  product_price_overrides jsonb not null default '{}'::jsonb,
  product_percent_discounts jsonb not null default '{}'::jsonb,
  free_delivery boolean not null default false,
  delivery_fee_net numeric(12,2),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.discount_codes
  add column if not exists description text not null default '',
  add column if not exists active boolean not null default true,
  add column if not exists valid_until date,
  add column if not exists product_price_overrides jsonb not null default '{}'::jsonb,
  add column if not exists product_percent_discounts jsonb not null default '{}'::jsonb,
  add column if not exists free_delivery boolean not null default false,
  add column if not exists delivery_fee_net numeric(12,2),
  add column if not exists created_by uuid references auth.users(id) on delete set null default auth.uid(),
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

-- Alcune installazioni precedenti possono avere id uuid, altre id text.
-- In entrambi i casi lasciamo che sia PostgreSQL a generare l'id dei nuovi record.
do $$
declare
  v_id_type text;
begin
  select c.udt_name
  into v_id_type
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'discount_codes'
    and c.column_name = 'id';

  if v_id_type = 'uuid' then
    execute 'alter table public.discount_codes alter column id set default gen_random_uuid()';
  else
    execute 'alter table public.discount_codes alter column id set default gen_random_uuid()::text';
  end if;
end;
$$;

alter table public.discount_codes enable row level security;

drop policy if exists discount_codes_admin_all on public.discount_codes;
create policy discount_codes_admin_all
on public.discount_codes
for all to authenticated
using (private.is_admin())
with check (private.is_admin());

grant select, insert, update, delete on public.discount_codes to authenticated;

create or replace function public.admin_save_discount_code(
  p_id text default null,
  p_code text default null,
  p_description text default '',
  p_active boolean default true,
  p_valid_until date default null,
  p_product_price_overrides jsonb default '{}'::jsonb,
  p_product_percent_discounts jsonb default '{}'::jsonb,
  p_free_delivery boolean default false,
  p_delivery_fee_net numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_target_id text;
  v_saved jsonb;
  v_entry record;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if not private.is_admin() then
    raise exception using errcode = '42501', message = 'Solo un amministratore può salvare i codici sconto';
  end if;
  if char_length(v_code) < 2 or char_length(v_code) > 40 then
    raise exception using errcode = '22023', message = 'Il codice sconto deve contenere da 2 a 40 caratteri';
  end if;
  if jsonb_typeof(coalesce(p_product_price_overrides, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'I prezzi personalizzati non sono validi';
  end if;
  if jsonb_typeof(coalesce(p_product_percent_discounts, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'Le percentuali di sconto non sono valide';
  end if;
  if p_delivery_fee_net is not null and p_delivery_fee_net < 0 then
    raise exception using errcode = '22023', message = 'Il prezzo del trasporto non può essere negativo';
  end if;

  for v_entry in select key, value from jsonb_each(coalesce(p_product_price_overrides, '{}'::jsonb))
  loop
    if jsonb_typeof(v_entry.value) <> 'number' or (v_entry.value #>> '{}')::numeric < 0 then
      raise exception using errcode = '22023', message = 'Un prezzo prodotto non è valido';
    end if;
  end loop;

  for v_entry in select key, value from jsonb_each(coalesce(p_product_percent_discounts, '{}'::jsonb))
  loop
    if jsonb_typeof(v_entry.value) <> 'number'
       or (v_entry.value #>> '{}')::numeric < 0
       or (v_entry.value #>> '{}')::numeric > 100 then
      raise exception using errcode = '22023', message = 'Una percentuale prodotto deve essere compresa tra 0 e 100';
    end if;
  end loop;

  if nullif(btrim(coalesce(p_id, '')), '') is not null then
    select d.id::text
    into v_target_id
    from public.discount_codes d
    where d.id::text = p_id
    limit 1;
  end if;

  if v_target_id is null then
    select d.id::text
    into v_target_id
    from public.discount_codes d
    where upper(btrim(d.code)) = v_code
    limit 1;
  end if;

  if v_target_id is not null then
    if exists (
      select 1
      from public.discount_codes d
      where upper(btrim(d.code)) = v_code
        and d.id::text <> v_target_id
    ) then
      raise exception using errcode = '23505', message = 'Esiste già un altro sconto con questo codice';
    end if;

    update public.discount_codes d
    set code = v_code,
        description = btrim(coalesce(p_description, '')),
        active = coalesce(p_active, true),
        valid_until = p_valid_until,
        product_price_overrides = coalesce(p_product_price_overrides, '{}'::jsonb),
        product_percent_discounts = coalesce(p_product_percent_discounts, '{}'::jsonb),
        free_delivery = coalesce(p_free_delivery, false),
        delivery_fee_net = p_delivery_fee_net,
        updated_at = now()
    where d.id::text = v_target_id
    returning to_jsonb(d.*) into v_saved;
  else
    insert into public.discount_codes (
      code,
      description,
      active,
      valid_until,
      product_price_overrides,
      product_percent_discounts,
      free_delivery,
      delivery_fee_net,
      created_by,
      created_at,
      updated_at
    ) values (
      v_code,
      btrim(coalesce(p_description, '')),
      coalesce(p_active, true),
      p_valid_until,
      coalesce(p_product_price_overrides, '{}'::jsonb),
      coalesce(p_product_percent_discounts, '{}'::jsonb),
      coalesce(p_free_delivery, false),
      p_delivery_fee_net,
      auth.uid(),
      now(),
      now()
    )
    returning to_jsonb(public.discount_codes.*) into v_saved;
  end if;

  return v_saved;
end;
$$;

revoke all on function public.admin_save_discount_code(text, text, text, boolean, date, jsonb, jsonb, boolean, numeric) from public;
grant execute on function public.admin_save_discount_code(text, text, text, boolean, date, jsonb, jsonb, boolean, numeric) to authenticated;

commit;
