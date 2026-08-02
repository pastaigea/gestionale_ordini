begin;

-- Stato tecnico privo di dati applicativi. La tabella resta nello schema
-- private: dal browser è invocabile soltanto la funzione limitata qui sotto.
create table if not exists private.project_heartbeat (
  singleton boolean primary key default true check (singleton),
  last_seen_at timestamptz not null default now()
);

insert into private.project_heartbeat(singleton, last_seen_at)
values (true, now())
on conflict (singleton) do nothing;

create or replace function public.keep_project_active()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_last_seen_at timestamptz;
begin
  -- Anche chiamate ripetute o ostili causano al massimo una scrittura l'ora.
  update private.project_heartbeat
  set last_seen_at = now()
  where singleton
    and last_seen_at < now() - interval '1 hour'
  returning last_seen_at into v_last_seen_at;

  if v_last_seen_at is null then
    select h.last_seen_at
    into v_last_seen_at
    from private.project_heartbeat h
    where h.singleton;
  end if;

  return v_last_seen_at;
end;
$$;

revoke all on table private.project_heartbeat from public, anon, authenticated;
revoke all on function public.keep_project_active() from public;
grant execute on function public.keep_project_active() to anon, authenticated;

comment on function public.keep_project_active() is
  'Data-free, rate-limited heartbeat used by the daily maintenance workflow.';

commit;
