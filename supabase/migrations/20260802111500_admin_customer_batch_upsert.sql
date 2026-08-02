-- Importa o aggiorna anagrafiche cliente senza creare utenti Auth e senza
-- inviare email. I dati reali restano fuori dalle migrazioni e vengono passati
-- alla RPC soltanto durante un'importazione autenticata dall'area admin.

begin;

create or replace function private.normalize_customer_vat_number(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  with normalized as (
    select regexp_replace(upper(coalesce(p_value, '')), '[^A-Z0-9]', '', 'g') as value
  )
  select case
    -- Considera equivalenti una P.IVA italiana scritta con o senza prefisso IT.
    when value ~ '^IT[0-9]{11}$' then substring(value from 3)
    else value
  end
  from normalized;
$$;

do $$
begin
  if exists (
    select 1
    from public.customers c
    where private.normalize_customer_vat_number(c.vat_number) <> ''
    group by private.normalize_customer_vat_number(c.vat_number)
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'Existing customers contain duplicate normalized VAT numbers';
  end if;
end;
$$;

create unique index if not exists customers_normalized_vat_number_idx
on public.customers (private.normalize_customer_vat_number(vat_number))
where private.normalize_customer_vat_number(vat_number) <> '';

do $$
begin
  if exists (
    select 1
    from public.customer_users cu
    group by cu.customer_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'A customer is already linked to multiple Auth accounts; resolve it before applying the one-account constraint';
  end if;
end;
$$;

-- Il modello UI espone un solo account per cliente. L'indice evita anche che
-- due richieste di invito concorrenti creino collegamenti ambigui.
create unique index if not exists customer_users_one_account_per_customer_idx
on public.customer_users (customer_id);

create or replace function public.admin_upsert_customers(p_customers jsonb)
returns table (
  row_number integer,
  customer_id uuid,
  outcome text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_customer jsonb;
  v_row_number bigint;
  v_legal_name text;
  v_contact_name text;
  v_vat_number text;
  v_vat_key text;
  v_tax_code text;
  v_sdi_code text;
  v_pec text;
  v_email text;
  v_phone text;
  v_billing_address jsonb;
  v_shipping_address jsonb;
  v_price_list_text text;
  v_price_list_id uuid;
  v_payment_method_text text;
  v_payment_method public.payment_method;
  v_delivery_fee_mode text;
  v_active boolean;
  v_active_value jsonb;
  v_existing public.customers%rowtype;
  v_existing_ids uuid[];
  v_is_linked boolean;
  v_seen_vat_keys text[] := '{}'::text[];
  v_inserted integer := 0;
  v_updated integer := 0;
  v_unchanged integer := 0;
  v_changed boolean;
begin
  if v_actor_user_id is null or not private.is_admin() then
    raise exception using errcode = '42501', message = 'Active administrator required';
  end if;

  if p_customers is null or jsonb_typeof(p_customers) <> 'array' then
    raise exception using errcode = '22023', message = 'customers must be a JSON array';
  end if;
  if jsonb_array_length(p_customers) = 0 then
    raise exception using errcode = '22023', message = 'customers must contain at least one row';
  end if;
  if jsonb_array_length(p_customers) > 500 then
    raise exception using errcode = '22023', message = 'A maximum of 500 customers can be imported at once';
  end if;
  if octet_length(p_customers::text) > 5 * 1024 * 1024 then
    raise exception using errcode = '22023', message = 'Customer import payload is too large';
  end if;

  -- Serializza le importazioni per rendere deterministico il match per P.IVA.
  perform pg_advisory_xact_lock(hashtextextended('public.admin_upsert_customers', 0));

  for v_customer, v_row_number in
    select value, ordinality
    from jsonb_array_elements(p_customers) with ordinality
  loop
    if jsonb_typeof(v_customer) <> 'object' then
      raise exception using
        errcode = '22023',
        message = format('Customer row %s must be a JSON object', v_row_number);
    end if;
    if octet_length(v_customer::text) > 32768 then
      raise exception using
        errcode = '22023',
        message = format('Customer row %s is too large', v_row_number);
    end if;

    v_legal_name := coalesce(
      nullif(btrim(v_customer ->> 'legal_name'), ''),
      nullif(btrim(v_customer ->> 'legalName'), ''),
      nullif(btrim(v_customer ->> 'companyName'), '')
    );
    if v_legal_name is null or length(v_legal_name) > 200 then
      raise exception using
        errcode = '22023',
        message = format('Customer row %s requires a legal name up to 200 characters', v_row_number);
    end if;

    v_vat_number := coalesce(
      nullif(btrim(v_customer ->> 'vat_number'), ''),
      nullif(btrim(v_customer ->> 'vatNumber'), '')
    );
    v_vat_key := private.normalize_customer_vat_number(v_vat_number);
    if v_vat_number is null or length(v_vat_number) > 64 or length(v_vat_key) < 5 then
      raise exception using
        errcode = '22023',
        message = format('Customer row %s requires a valid VAT number', v_row_number);
    end if;
    if v_vat_key = any(v_seen_vat_keys) then
      raise exception using
        errcode = '22023',
        message = format('Customer row %s duplicates a VAT number in the same batch', v_row_number);
    end if;
    v_seen_vat_keys := array_append(v_seen_vat_keys, v_vat_key);

    v_contact_name := coalesce(
      nullif(btrim(v_customer ->> 'contact_name'), ''),
      nullif(btrim(v_customer ->> 'contactName'), ''),
      ''
    );
    v_tax_code := coalesce(
      nullif(btrim(v_customer ->> 'tax_code'), ''),
      nullif(btrim(v_customer ->> 'taxCode'), ''),
      nullif(btrim(v_customer ->> 'fiscalCode'), ''),
      ''
    );
    v_sdi_code := coalesce(
      nullif(btrim(v_customer ->> 'sdi_code'), ''),
      nullif(btrim(v_customer ->> 'sdiCode'), ''),
      ''
    );
    v_pec := coalesce(nullif(btrim(v_customer ->> 'pec'), ''), '');
    v_email := lower(coalesce(nullif(btrim(v_customer ->> 'email'), ''), ''));
    v_phone := coalesce(nullif(btrim(v_customer ->> 'phone'), ''), '');

    if length(v_contact_name) > 200
       or length(v_tax_code) > 64
       or length(v_sdi_code) > 32
       or length(v_pec) > 320
       or length(v_email) > 320
       or length(v_phone) > 64 then
      raise exception using
        errcode = '22023',
        message = format('Customer row %s contains a field that is too long', v_row_number);
    end if;
    if v_email <> '' and v_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      raise exception using
        errcode = '22023',
        message = format('Customer row %s contains an invalid email address', v_row_number);
    end if;
    if v_pec <> '' and v_pec !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      raise exception using
        errcode = '22023',
        message = format('Customer row %s contains an invalid PEC address', v_row_number);
    end if;

    v_billing_address := coalesce(
      v_customer -> 'billing_address',
      v_customer -> 'billingAddress',
      '{}'::jsonb
    );
    if jsonb_typeof(v_billing_address) <> 'object' then
      raise exception using
        errcode = '22023',
        message = format('Customer row %s billing address must be an object', v_row_number);
    end if;
    v_shipping_address := coalesce(
      v_customer -> 'shipping_address',
      v_customer -> 'shippingAddress',
      v_customer -> 'deliveryAddress',
      v_billing_address
    );
    if v_shipping_address = '{}'::jsonb then
      v_shipping_address := v_billing_address;
    end if;
    if jsonb_typeof(v_shipping_address) <> 'object' then
      raise exception using
        errcode = '22023',
        message = format('Customer row %s shipping address must be an object', v_row_number);
    end if;

    v_price_list_text := coalesce(
      nullif(btrim(v_customer ->> 'price_list_id'), ''),
      nullif(btrim(v_customer ->> 'priceListId'), '')
    );
    v_price_list_id := null;
    if v_price_list_text is not null then
      begin
        v_price_list_id := v_price_list_text::uuid;
      exception when invalid_text_representation then
        raise exception using
          errcode = '22023',
          message = format('Customer row %s contains an invalid price list id', v_row_number);
      end;
      if not exists (
        select 1 from public.price_lists pl
        where pl.id = v_price_list_id and pl.active
      ) then
        raise exception using
          errcode = 'P0002',
          message = format('Customer row %s references an inactive or missing price list', v_row_number);
      end if;
    end if;

    v_payment_method_text := coalesce(
      nullif(btrim(v_customer ->> 'payment_method'), ''),
      nullif(btrim(v_customer ->> 'paymentMethod'), '')
    );
    if v_payment_method_text is not null
       and v_payment_method_text not in ('end_of_month', 'on_delivery') then
      raise exception using
        errcode = '22023',
        message = format('Customer row %s contains an invalid payment method', v_row_number);
    end if;
    v_payment_method := coalesce(v_payment_method_text::public.payment_method, 'end_of_month');

    v_delivery_fee_mode := coalesce(
      nullif(btrim(v_customer ->> 'delivery_fee_mode'), ''),
      nullif(btrim(v_customer ->> 'deliveryFeeMode'), ''),
      'standard'
    );
    if v_delivery_fee_mode not in ('standard', 'free') then
      raise exception using
        errcode = '22023',
        message = format('Customer row %s contains an invalid delivery fee mode', v_row_number);
    end if;

    v_active_value := coalesce(v_customer -> 'active', 'true'::jsonb);
    if jsonb_typeof(v_active_value) <> 'boolean' then
      raise exception using
        errcode = '22023',
        message = format('Customer row %s active must be a boolean', v_row_number);
    end if;
    v_active := (v_active_value #>> '{}')::boolean;

    select array_agg(c.id order by c.id)
    into v_existing_ids
    from public.customers c
    where private.normalize_customer_vat_number(c.vat_number) = v_vat_key;

    if coalesce(cardinality(v_existing_ids), 0) > 1 then
      raise exception using
        errcode = '23505',
        message = format('Customer row %s matches multiple existing customers by VAT number', v_row_number);
    end if;

    if coalesce(cardinality(v_existing_ids), 0) = 0 then
      if v_price_list_id is null then
        select pl.id
        into v_price_list_id
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
        payment_method,
        delivery_fee_mode,
        active
      ) values (
        v_legal_name,
        coalesce(nullif(v_contact_name, ''), v_legal_name),
        v_vat_number,
        v_tax_code,
        v_sdi_code,
        v_pec,
        v_email,
        v_phone,
        v_billing_address,
        v_shipping_address,
        v_price_list_id,
        v_payment_method,
        v_delivery_fee_mode,
        v_active
      )
      returning id into customer_id;

      outcome := 'inserted';
      v_inserted := v_inserted + 1;
      insert into public.admin_audit_log(actor_user_id, action, customer_id, details)
      values (
        v_actor_user_id,
        'customer.imported_without_identity',
        customer_id,
        jsonb_build_object('source_row', v_row_number)
      );
    else
      select c.*
      into v_existing
      from public.customers c
      where c.id = v_existing_ids[1]
      for update;

      select exists (
        select 1 from public.customer_users cu where cu.customer_id = v_existing.id
      ) into v_is_linked;

      if v_is_linked and v_email <> '' and lower(v_existing.email) <> v_email then
        raise exception using
          errcode = '22023',
          message = format(
            'Customer row %s is linked to an Auth account; update its email through the account workflow',
            v_row_number
          );
      end if;

      -- Un valore email vuoto non cancella mai un contatto esistente. Per i
      -- clienti collegati, questa RPC non cambia l'email Auth né quella locale.
      v_email := case
        when v_is_linked then v_existing.email
        when v_email = '' and v_existing.email <> '' then v_existing.email
        else v_email
      end;
      v_contact_name := coalesce(nullif(v_contact_name, ''), v_existing.contact_name, v_legal_name);
      if not (v_customer ? 'tax_code' or v_customer ? 'taxCode' or v_customer ? 'fiscalCode') then
        v_tax_code := v_existing.tax_code;
      end if;
      if not (v_customer ? 'sdi_code' or v_customer ? 'sdiCode') then
        v_sdi_code := v_existing.sdi_code;
      end if;
      if not (v_customer ? 'pec') then
        v_pec := v_existing.pec;
      end if;
      if not (v_customer ? 'phone') then
        v_phone := v_existing.phone;
      end if;
      if not (v_customer ? 'billing_address' or v_customer ? 'billingAddress') then
        v_billing_address := v_existing.billing_address;
      end if;
      if not (
        v_customer ? 'shipping_address'
        or v_customer ? 'shippingAddress'
        or v_customer ? 'deliveryAddress'
      ) then
        v_shipping_address := v_existing.shipping_address;
      end if;
      v_price_list_id := coalesce(v_price_list_id, v_existing.price_list_id);
      if v_payment_method_text is null then
        v_payment_method := v_existing.payment_method;
      end if;
      if not (v_customer ? 'delivery_fee_mode' or v_customer ? 'deliveryFeeMode') then
        v_delivery_fee_mode := v_existing.delivery_fee_mode;
      end if;
      if not (v_customer ? 'active') then
        v_active := v_existing.active;
      end if;

      v_changed :=
        v_existing.legal_name is distinct from v_legal_name
        or v_existing.contact_name is distinct from v_contact_name
        or v_existing.vat_number is distinct from v_vat_number
        or v_existing.tax_code is distinct from v_tax_code
        or v_existing.sdi_code is distinct from v_sdi_code
        or v_existing.pec is distinct from v_pec
        or v_existing.email is distinct from v_email
        or v_existing.phone is distinct from v_phone
        or v_existing.billing_address is distinct from v_billing_address
        or v_existing.shipping_address is distinct from v_shipping_address
        or v_existing.price_list_id is distinct from v_price_list_id
        or v_existing.payment_method is distinct from v_payment_method
        or v_existing.delivery_fee_mode is distinct from v_delivery_fee_mode
        or v_existing.active is distinct from v_active;

      customer_id := v_existing.id;
      if v_changed then
        update public.customers
        set legal_name = v_legal_name,
            contact_name = v_contact_name,
            vat_number = v_vat_number,
            tax_code = v_tax_code,
            sdi_code = v_sdi_code,
            pec = v_pec,
            email = v_email,
            phone = v_phone,
            billing_address = v_billing_address,
            shipping_address = v_shipping_address,
            price_list_id = v_price_list_id,
            payment_method = v_payment_method,
            delivery_fee_mode = v_delivery_fee_mode,
            active = v_active
        where id = v_existing.id;

        outcome := 'updated';
        v_updated := v_updated + 1;
        insert into public.admin_audit_log(actor_user_id, action, customer_id, details)
        values (
          v_actor_user_id,
          'customer.import_updated_without_identity',
          customer_id,
          jsonb_build_object('source_row', v_row_number)
        );
      else
        outcome := 'unchanged';
        v_unchanged := v_unchanged + 1;
      end if;
    end if;

    row_number := v_row_number::integer;
    return next;
  end loop;

  insert into public.admin_audit_log(actor_user_id, action, details)
  values (
    v_actor_user_id,
    'customers.batch_upserted_without_identity',
    jsonb_build_object(
      'row_count', jsonb_array_length(p_customers),
      'inserted_count', v_inserted,
      'updated_count', v_updated,
      'unchanged_count', v_unchanged
    )
  );
end;
$$;

revoke all on function private.normalize_customer_vat_number(text)
  from public, anon, authenticated;
-- La funzione e usata implicitamente dall'indice univoco durante INSERT e
-- UPDATE eseguiti dagli admin autenticati. Elabora soltanto il valore ricevuto
-- e lo schema private non e esposto da PostgREST.
grant execute on function private.normalize_customer_vat_number(text) to authenticated;
revoke all on function public.admin_upsert_customers(jsonb)
  from public, anon, authenticated;
grant execute on function public.admin_upsert_customers(jsonb) to authenticated;

comment on function public.admin_upsert_customers(jsonb) is
  'Admin-only, max-500 customer upsert by normalized VAT number. It never creates Auth identities or sends email.';

commit;
