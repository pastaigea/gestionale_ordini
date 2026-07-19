-- Infrastructure used by the Telegram outbox webhook and retry scheduler.
-- No endpoint credential is stored in this migration: custom headers remain
-- configured through the Supabase Dashboard / Vault.

do $$
begin
  -- Hosted Supabase provides both extensions. The availability checks keep the
  -- schema reproducible in lightweight test engines that do not ship them.
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    execute 'create extension if not exists pg_net with schema extensions';
  else
    raise notice 'pg_net is not available in this database runtime';
  end if;

  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    execute 'create extension if not exists pg_cron';
  else
    raise notice 'pg_cron is not available in this database runtime';
  end if;
end
$$;
