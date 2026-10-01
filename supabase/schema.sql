-- House App: accounts + shared cloud sync.
-- Paste the whole file into Supabase > SQL Editor and press Run.
-- Safe to run again later (every statement replaces or skips what exists),
-- which is how future changes will be delivered.
-- This copy in the app repo is the one to edit; test-cloud.js runs it.
--
-- Who can do what is enforced HERE, by row-level security, not by the app:
-- the app's publishable key is public, so anything these rules allow, anyone
-- with an account can do from any browser. Anyone can create an account
-- (sign-ups are open), so an account alone gets nothing:
--
--   owner    the account whose email is in private.settings, set by a
--            separate, private script so the email isn't published here.
--            The only one who adds or removes people.
--   member   an account whose confirmed email the owner put in house_members.
--            Sees and edits ALL the household data, same as the owner.
--   anyone else, or signed out: nothing.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create table if not exists private.settings (
  id boolean primary key default true check (id),
  owner_email text not null
);
revoke all on private.settings from public, anon, authenticated;

---------------------------------------------------------------- tables

-- The access list. Emails, not account ids, so someone can be added before
-- they have ever signed in.
create table if not exists public.house_members (
  email      text primary key check (email = lower(email) and email like '%_@_%' and char_length(email) <= 254),
  label      text not null default '' check (char_length(label) <= 80),   -- "Mum", "Aimi's phone"…
  added_by   uuid,
  created_at timestamptz not null default now()
);

-- Every tool's data, one row per thing (a bill, a to-do, an invoice…), so two
-- people changing different things at once never overwrite each other.
--   store  the tool's localStorage key, e.g. 'todo.items.v1'
--   id     the record's own id; '_' for a store that is one settings object;
--          '_order' for the saved order of a list
-- Rows are never deleted (other devices need to see "this was removed"),
-- they are flagged instead.
create table if not exists public.house_items (
  store      text not null check (store ~ '^[a-z]+\.[A-Za-z]+\.v[0-9]+$'),
  id         text not null check (char_length(id) between 1 and 200),
  data       jsonb not null default '{}'::jsonb,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (store, id)
);
create index if not exists house_items_updated_idx on public.house_items (updated_at);

---------------------------------------------------------------- who is asking
-- security definer so the policies can read auth.users and private.settings,
-- which the signed-in role cannot.

-- The caller's email, only once they have proved they own it (typed the code).
create or replace function private.my_email() returns text
language sql stable security definer set search_path = '' as $$
  select lower(u.email) from auth.users u
   where u.id = auth.uid() and u.email_confirmed_at is not null;
$$;

create or replace function private.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.my_email() = (select lower(s.owner_email) from private.settings s), false);
$$;

create or replace function private.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_owner()
      or exists (select 1 from public.house_members m where m.email = private.my_email());
$$;

grant execute on function private.my_email(), private.is_owner(), private.is_member() to authenticated;

-- What the app asks right after signing in.
create or replace function public.house_whoami() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('email', private.my_email(),
                            'owner', private.is_owner(),
                            'member', private.is_member());
$$;
revoke all on function public.house_whoami() from public, anon;
grant execute on function public.house_whoami() to authenticated;

---------------------------------------------------------------- triggers

-- The server's clock and the real caller, whatever the client sent.
create or replace function private.house_touch() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

drop trigger if exists house_items_touch on public.house_items;
create trigger house_items_touch before insert or update on public.house_items
  for each row execute function private.house_touch();

create or replace function private.house_member_clean() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.email := lower(trim(new.email));
  new.added_by := auth.uid();
  return new;
end $$;

drop trigger if exists house_members_clean on public.house_members;
create trigger house_members_clean before insert on public.house_members
  for each row execute function private.house_member_clean();

---------------------------------------------------------------- row-level security

alter table public.house_items enable row level security;
alter table public.house_members enable row level security;

revoke all on public.house_items, public.house_members from anon, authenticated;
grant select, insert, update on public.house_items to authenticated;
grant select, insert, update, delete on public.house_members to authenticated;

drop policy if exists house_items_read on public.house_items;
create policy house_items_read on public.house_items for select to authenticated
  using ((select private.is_member()));
drop policy if exists house_items_add on public.house_items;
create policy house_items_add on public.house_items for insert to authenticated
  with check ((select private.is_member()));
drop policy if exists house_items_change on public.house_items;
create policy house_items_change on public.house_items for update to authenticated
  using ((select private.is_member())) with check ((select private.is_member()));

-- Members can see who else has access; only the owner changes the list.
drop policy if exists house_members_read on public.house_members;
create policy house_members_read on public.house_members for select to authenticated
  using ((select private.is_member()));
drop policy if exists house_members_add on public.house_members;
create policy house_members_add on public.house_members for insert to authenticated
  with check ((select private.is_owner()));
drop policy if exists house_members_change on public.house_members;
create policy house_members_change on public.house_members for update to authenticated
  using ((select private.is_owner())) with check ((select private.is_owner()));
drop policy if exists house_members_remove on public.house_members;
create policy house_members_remove on public.house_members for delete to authenticated
  using ((select private.is_owner()));

---------------------------------------------------------------- live updates
-- So a change on one device reaches the others as it happens. Row-level
-- security applies to these too.

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['house_items', 'house_members'] loop
      if not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
