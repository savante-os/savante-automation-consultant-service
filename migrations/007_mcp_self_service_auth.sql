-- Phase 3: link mcp_users to Supabase Auth and let a logged-in person manage
-- their own API key(s) and see their own usage, without any new RLS policies
-- on the underlying tables — every self-service action goes through one of
-- the four narrow `security definer` RPCs below, granted to `authenticated`
-- only. See docs/MCP_CATALOG.md Phase 3.
--
-- mcp_users.id is left untouched (still its own uuid, not auth.users.id) so
-- the existing FKs on mcp_api_keys/mcp_request_log don't need to move. A new
-- auth_user_id column links the two; a trigger on auth.users keeps it in
-- sync at signup, matching an existing invite-only row by email if one exists.

alter table public.mcp_users
  add column if not exists auth_user_id uuid unique references auth.users (id) on delete cascade;

comment on column public.mcp_users.auth_user_id is
  'Supabase Auth identity for self-service login. Null for invite-only rows never claimed via signup.';

-- pgcrypto for gen_random_bytes()/digest() — Supabase projects normally have this already.
create extension if not exists pgcrypto;

-- On signup, create (or claim) the matching mcp_users row.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.mcp_users (auth_user_id, email, plan)
  values (new.id, new.email, 'free')
  on conflict (email) do update
    set auth_user_id = excluded.auth_user_id
    where public.mcp_users.auth_user_id is null;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

comment on function public.handle_new_auth_user() is
  'Creates or claims (by email) the mcp_users row for a newly signed-up auth.users identity.';

-- Max active (non-revoked) keys a single account may hold. Adjust here if plans differ later.
create or replace function public.mcp_own_user_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.mcp_users where auth_user_id = auth.uid();
$$;

create or replace function public.create_own_api_key(p_name text default 'default')
returns table (id uuid, secret text, key_prefix text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_secret text;
  v_key_prefix text;
  v_key_hash text;
  v_id uuid;
  v_active_count int;
  v_max_active_keys constant int := 3;
begin
  if auth.uid() is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  v_user_id := public.mcp_own_user_id();
  if v_user_id is null then
    -- Defensive fallback: trigger should have created this row at signup.
    insert into public.mcp_users (auth_user_id, email, plan)
    values (auth.uid(), (select email from auth.users where auth.users.id = auth.uid()), 'free')
    on conflict (email) do update
      set auth_user_id = excluded.auth_user_id
      where public.mcp_users.auth_user_id is null
    returning public.mcp_users.id into v_user_id;
  end if;

  select count(*) into v_active_count
  from public.mcp_api_keys
  where user_id = v_user_id and revoked_at is null;

  if v_active_count >= v_max_active_keys then
    raise exception 'key_limit_reached: max % active keys' , v_max_active_keys using errcode = 'P0001';
  end if;

  v_secret := 'sav_live_' || encode(gen_random_bytes(32), 'hex');
  v_key_prefix := left(v_secret, 16);
  v_key_hash := encode(digest(v_secret, 'sha256'), 'hex');

  insert into public.mcp_api_keys (user_id, name, key_prefix, key_hash)
  values (v_user_id, nullif(trim(p_name), ''), v_key_prefix, v_key_hash)
  returning public.mcp_api_keys.id into v_id;

  return query select v_id, v_secret, v_key_prefix;
end;
$$;

create or replace function public.revoke_own_api_key(p_key_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_updated int;
begin
  if auth.uid() is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  v_user_id := public.mcp_own_user_id();

  update public.mcp_api_keys
  set revoked_at = now()
  where id = p_key_id
    and user_id = v_user_id
    and revoked_at is null;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'not_found_or_not_yours' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.list_own_api_keys()
returns table (
  id uuid,
  name text,
  key_prefix text,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select k.id, k.name, k.key_prefix, k.revoked_at, k.last_used_at, k.created_at
  from public.mcp_api_keys k
  where k.user_id = public.mcp_own_user_id()
  order by k.created_at desc;
$$;

create or replace function public.list_own_usage_by_day()
returns table (
  day timestamptz,
  tool text,
  calls bigint,
  ok_calls bigint,
  rate_limited bigint,
  avg_latency_ms int
)
language sql
stable
security definer
set search_path = public
as $$
  select
    date_trunc('day', l.at) as day,
    l.tool,
    count(*) as calls,
    count(*) filter (where l.status = 200) as ok_calls,
    count(*) filter (where l.status = 429) as rate_limited,
    avg(l.latency_ms)::int as avg_latency_ms
  from public.mcp_request_log l
  where l.user_id = public.mcp_own_user_id()
  group by 1, 2
  order by 1 desc, 2;
$$;

-- Every function grants EXECUTE to PUBLIC by default — revoking only "from
-- anon"/"from authenticated" would leave that implicit PUBLIC grant in place
-- and anon could still call these. Revoke from PUBLIC first, then grant back
-- explicitly only to authenticated.
revoke execute on function public.mcp_own_user_id() from public;
revoke execute on function public.handle_new_auth_user() from public;
revoke execute on function public.create_own_api_key(text) from public;
revoke execute on function public.revoke_own_api_key(uuid) from public;
revoke execute on function public.list_own_api_keys() from public;
revoke execute on function public.list_own_usage_by_day() from public;

grant execute on function public.create_own_api_key(text) to authenticated;
grant execute on function public.revoke_own_api_key(uuid) to authenticated;
grant execute on function public.list_own_api_keys() to authenticated;
grant execute on function public.list_own_usage_by_day() to authenticated;

comment on function public.create_own_api_key(text) is
  'Self-service key issuance for the caller''s own account (auth.uid()). Returns the secret once. Max 3 active keys.';
comment on function public.revoke_own_api_key(uuid) is
  'Self-service revoke, scoped to a key the caller owns.';
comment on function public.list_own_api_keys() is
  'Self-service key list for the caller''s own account. Never returns key_hash.';
comment on function public.list_own_usage_by_day() is
  'Self-service per-day/tool usage for the caller''s own account (same shape as mcp_usage_by_day).';
