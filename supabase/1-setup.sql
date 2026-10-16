-- FOMO website: database setup. Paste all of this into Supabase → SQL Editor → New query → Run.
-- Safe to run again.

-- 1. One table holds every document, addressed by a path like "events/su123" or "data/users/<uid>/state".
create table if not exists public.docs (
  path text primary key,
  coll text generated always as (regexp_replace(path, '/[^/]+$', '')) stored,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists docs_coll_idx on public.docs (coll);
alter table public.docs replica identity full;

-- 2. Admins (page owners): can edit events, societies, approvals. Add your own login email below.
create table if not exists public.admins (email text primary key);
alter table public.admins enable row level security;
drop policy if exists "admins readable by self" on public.admins;
create policy "admins readable by self" on public.admins for select using (lower(email) = lower(auth.email()));

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.admins where lower(email) = lower(auth.email())) $$;

-- 5. Log in with a username: looks up the email for a username (only returns the email, nothing else).
create or replace function public.login_email(uname text) returns text
language sql stable security definer set search_path = public as $$
  select d.data->>'email' from public.docs d
  where d.path like 'logins/%' and lower(d.data->>'username') = lower(uname) limit 1
$$;
-- "logins/<uid>" docs map username -> email and are never readable directly.
drop policy if exists "read" on public.docs;
create policy "read" on public.docs for select using (
  case
    when path like 'logins/%' then path = 'logins/' || coalesce(auth.uid()::text, '-')
    when path like 'data/users/%' then path like 'data/users/' || coalesce(auth.uid()::text, '-') || '/%'
    when path like 'applications/%' then public.is_admin() or path = 'applications/' || coalesce(auth.uid()::text, '-')
    else true
  end
);
create or replace function public.owns_path(p text) returns boolean
language sql stable as $$
  select auth.uid() is not null and (
    (split_part(p, '/', 1) in ('profiles','regs','votes','snaps','cevents','cposts','applications','logins')
       and split_part(p, '/', 2) = auth.uid()::text and split_part(p, '/', 3) = '')
    or p like 'data/users/' || auth.uid()::text || '/%'
  )
$$;
-- Usernames must be unique.
create unique index if not exists logins_username_uniq on public.docs (lower(data->>'username')) where path like 'logins/%';
create or replace function public.username_taken(uname text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.docs where path like 'logins/%' and lower(data->>'username') = lower(uname))
$$;

-- 3. Access rules (same as the Claude version):
--    everyone can read shared data; private data/users/* and applications/* only by their owner (or admins);
--    people write only their own docs; admins write anything.
alter table public.docs enable row level security;
drop policy if exists "insert" on public.docs;
create policy "insert" on public.docs for insert with check (public.is_admin() or public.owns_path(path));
drop policy if exists "update" on public.docs;
create policy "update" on public.docs for update using (public.is_admin() or public.owns_path(path)) with check (public.is_admin() or public.owns_path(path));
drop policy if exists "delete" on public.docs;
create policy "delete" on public.docs for delete using (public.is_admin() or public.owns_path(path));

-- 4. Live updates.
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- 6. Photo storage (snaps, profile pictures, event covers).
insert into storage.buckets (id, name, public) values ('media', 'media', true) on conflict (id) do nothing;
drop policy if exists "media read" on storage.objects;
create policy "media read" on storage.objects for select using (bucket_id = 'media');
drop policy if exists "media upload own folder" on storage.objects;
create policy "media upload own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

-- 7. Make yourself an admin: replace the email, then run.
insert into public.admins (email) values ('YOUR-EMAIL@ucl.ac.uk') on conflict do nothing;
