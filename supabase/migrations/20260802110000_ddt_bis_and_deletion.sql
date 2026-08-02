begin;

-- Dal cut-over ogni nuovo DDT usa la serie tecnica BIS. Il progressivo resta
-- annuale, come nello schema originario, mentre il numero leggibile parte da
-- 1bis/ANNO. I contatori e i documenti storici della serie A non vengono
-- modificati e i loro numeri non vengono riutilizzati.
create or replace function private.apply_bis_delivery_document_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.document_year := extract(year from new.issued_on)::integer;
  new.series := 'BIS';
  new.display_number := new.sequence_number::text || 'bis/' || new.document_year::text;
  return new;
end;
$$;

-- Le RPC storiche allocano il contatore prima dell'INSERT del DDT. Il trigger
-- sul contatore canonicalizza gia quella singola allocazione su BIS: in questo
-- modo anche un client non ancora aggiornato non incrementa prima A/TEST e poi
-- BIS, e i contatori storici restano invariati.
create or replace function private.apply_bis_document_counter_series()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if upper(btrim(new.document_type)) = 'DDT' then
    new.document_type := 'DDT';
    new.series := 'BIS';
  end if;
  return new;
end;
$$;

-- Se la serie era stata soltanto provata senza produrre documenti, rimuoviamo
-- il contatore orfano così il primo DDT effettivo parte davvero da 1bis.
delete from public.document_counters c
where c.document_type = 'DDT'
  and c.series = 'BIS'
  and not exists (
    select 1
    from public.delivery_documents d
    where d.series = 'BIS'
      and d.document_year = c.document_year
  );

-- Se esistono già DDT BIS, il contatore non può rimanere indietro rispetto
-- allo storico. Questo mantiene sicure anche installazioni parziali/retry.
insert into public.document_counters (
  document_type,
  series,
  document_year,
  last_number
)
select
  'DDT',
  'BIS',
  d.document_year,
  max(d.sequence_number)
from public.delivery_documents d
where d.series = 'BIS'
group by d.document_year
on conflict (document_type, series, document_year) do update
set last_number = greatest(
      public.document_counters.last_number,
      excluded.last_number
    ),
    updated_at = now();

drop trigger if exists document_counters_apply_bis_series
on public.document_counters;
create trigger document_counters_apply_bis_series
before insert on public.document_counters
for each row execute function private.apply_bis_document_counter_series();

drop trigger if exists delivery_documents_apply_bis_numbering
on public.delivery_documents;
create trigger delivery_documents_apply_bis_numbering
before insert on public.delivery_documents
for each row execute function private.apply_bis_delivery_document_number();

create or replace function private.protect_bis_delivery_document_number()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.series = 'BIS' and (
    new.series is distinct from old.series
    or new.document_year is distinct from old.document_year
    or new.sequence_number is distinct from old.sequence_number
    or new.display_number is distinct from old.display_number
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'A BIS delivery document number is immutable';
  end if;

  if old.series = 'BIS'
     and extract(year from new.issued_on)::integer <> old.document_year then
    raise exception using
      errcode = '22023',
      message = 'A BIS delivery document date must remain in its numbering year';
  end if;

  return new;
end;
$$;

drop trigger if exists delivery_documents_protect_bis_numbering
on public.delivery_documents;
create trigger delivery_documents_protect_bis_numbering
before update on public.delivery_documents
for each row execute function private.protect_bis_delivery_document_number();

-- I clienti vedono soltanto i propri DDT validi. Le revisioni annullate e le
-- motivazioni amministrative restano consultabili esclusivamente dagli admin.
drop policy if exists delivery_documents_select_own_or_admin
on public.delivery_documents;
create policy delivery_documents_select_own_or_admin
on public.delivery_documents for select to authenticated
using (
  private.is_admin()
  or (
    status = 'ready'
    and private.can_access_customer(customer_id)
  )
);

-- "Elimina" nell'interfaccia è intenzionalmente un annullamento logico:
-- conserva audit e numero emesso, ma rende di nuovo riemettibile l'ordine.
-- La cancellazione fisica dei soli dati di prova resta una procedura one-shot
-- separata, eseguita soltanto dopo backup e inventario degli UUID interessati.
create or replace function public.admin_delete_delivery_document(
  p_document_id uuid,
  p_confirm_display_number text,
  p_reason text
)
returns public.delivery_documents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_document public.delivery_documents;
  v_order public.orders;
  v_previous_status public.order_status;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not private.is_admin() then
    raise exception using
      errcode = '42501',
      message = 'Administrator access required';
  end if;

  if char_length(v_reason) < 3 or char_length(v_reason) > 300 then
    raise exception using
      errcode = '22023',
      message = 'A deletion reason between 3 and 300 characters is required';
  end if;

  select d.*
  into v_document
  from public.delivery_documents d
  where d.id = p_document_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Delivery document not found';
  end if;

  if btrim(coalesce(p_confirm_display_number, '')) <> v_document.display_number then
    raise exception using
      errcode = '22023',
      message = 'Delivery document number confirmation does not match';
  end if;

  -- Retry idempotente: il numero è già annullato e non viene consumato di
  -- nuovo né viene duplicato l'audit.
  if v_document.status = 'void' then
    return v_document;
  end if;

  select o.*
  into v_order
  from public.orders o
  where o.id = v_document.order_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Linked order not found';
  end if;

  if v_order.payment_confirmed_at is not null then
    raise exception using
      errcode = '22023',
      message = 'A paid delivery document cannot be deleted without a refund workflow';
  end if;

  update public.delivery_documents
  set status = 'void',
      notes = concat_ws(
        E'\n',
        nullif(notes, ''),
        'Eliminato dall''amministratore: ' || v_reason
      )
  where id = v_document.id
  returning * into v_document;

  v_previous_status := v_order.status;
  if v_previous_status in ('in_delivery', 'delivered')
     and not exists (
       select 1
       from public.delivery_documents d
       where d.order_id = v_order.id
         and d.status in ('generating', 'ready')
     ) then
    update public.orders
    set status = 'accepted',
        delivered_at = null,
        version = version + 1
    where id = v_order.id
    returning * into v_order;

    insert into public.order_status_history (
      order_id,
      from_status,
      to_status,
      actor_user_id,
      actor_channel,
      note,
      metadata
    ) values (
      v_order.id,
      v_previous_status,
      'accepted',
      auth.uid(),
      'admin',
      'DDT eliminato: ' || v_reason,
      jsonb_build_object(
        'delivery_document_id', v_document.id,
        'display_number', v_document.display_number
      )
    );
  end if;

  insert into public.admin_audit_log (
    actor_user_id,
    action,
    customer_id,
    details
  ) values (
    auth.uid(),
    'delivery_document.deleted',
    v_document.customer_id,
    jsonb_build_object(
      'delivery_document_id', v_document.id,
      'order_id', v_document.order_id,
      'display_number', v_document.display_number,
      'reason', v_reason,
      'previous_order_status', v_previous_status,
      'new_order_status', v_order.status
    )
  );

  return v_document;
end;
$$;

revoke all on function public.admin_delete_delivery_document(uuid, text, text)
from public, anon;
grant execute on function public.admin_delete_delivery_document(uuid, text, text)
to authenticated;

comment on function private.apply_bis_delivery_document_number() is
  'Forces every newly inserted DDT onto the annual BIS series and formats numbers as 1bis/YYYY.';
comment on function private.protect_bis_delivery_document_number() is
  'Keeps BIS series, structured progressive and display number aligned after issuance.';
comment on function public.admin_delete_delivery_document(uuid, text, text) is
  'Admin-only audited logical deletion of a DDT. The number is retained and the unpaid linked order becomes reissuable.';

commit;
