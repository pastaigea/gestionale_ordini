-- Consente all'amministratore di rettificare le quantita consegnate anche
-- oltre la richiesta originale. La richiesta resta immutata in `quantity`;
-- `fulfilled_quantity` contiene la quantita effettivamente consegnata.

begin;

-- Il check storico era anonimo e il nome assegnato da PostgreSQL dipende dagli
-- altri vincoli gia presenti. Lo individuiamo dalla colonna, senza assumere il
-- nome generato automaticamente.
do $constraints$
declare
  v_constraint record;
begin
  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.order_items'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%fulfilled_quantity%'
  loop
    execute format(
      'alter table public.order_items drop constraint %I',
      v_constraint.conname
    );
  end loop;
end;
$constraints$;

alter table public.order_items
  add constraint order_items_fulfilled_quantity_check check (
    fulfilled_quantity is null
    or (
      fulfilled_quantity >= 0
      and fulfilled_quantity <= 999
      and fulfilled_quantity = trunc(fulfilled_quantity)
    )
  );

-- Mantiene l'implementazione auditata gia installata e sostituisce soltanto
-- il limite superiore. I controlli espliciti rendono la migration fail-safe
-- se la funzione di partenza non corrisponde alla versione attesa.
do $migration$
declare
  v_definition text;
  v_old_guard constant text := 'or v_fulfilled > v_order_item.quantity';
  v_new_guard constant text := 'or v_fulfilled > 999';
  v_old_message constant text := 'Fulfilled quantity must be a whole number between zero and the ordered quantity';
  v_new_message constant text := 'Fulfilled quantity must be a whole number between zero and 999';
begin
  select pg_get_functiondef(
    'public.admin_adjust_order_fulfillment(uuid,jsonb,integer,text)'::regprocedure
  ) into v_definition;

  if strpos(v_definition, v_old_guard) = 0 or strpos(v_definition, v_old_message) = 0 then
    raise exception 'Unexpected admin_adjust_order_fulfillment definition; migration stopped';
  end if;

  v_definition := replace(v_definition, v_old_guard, v_new_guard);
  v_definition := replace(v_definition, v_old_message, v_new_message);
  execute v_definition;
end;
$migration$;

comment on column public.order_items.fulfilled_quantity is
  'Admin-confirmed packages actually fulfilled (0..999); null means the original ordered quantity.';
comment on function public.admin_adjust_order_fulfillment(uuid, jsonb, integer, text) is
  'Admin-only audited fulfillment adjustment (0..999). Existing ready DDTs are voided and atomically replaced.';

commit;
