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

---------------------------------------------------------------- PowerPass
-- Logins for PowerPass (powerpass.html here, and the standalone PowerPass
-- app, which signs in to this same project). Unlike house_items these are
-- NOT household data: every row belongs to one account, and nobody else, the
-- owner included, can read it. Only accounts on the access list can have any.
--
-- The server only ever holds ciphertext. Each login is encrypted in the
-- browser (AES-GCM) with a key derived from the person's master password
-- (PBKDF2), which never leaves their device. So even someone who can read the
-- database (a project admin, a leaked backup) sees no passwords, and a
-- forgotten master password can't be recovered by anyone.

-- One per person: what's needed to turn the master password back into the
-- key. `check_*` is a known text encrypted with that key, so a wrong master
-- password is caught before anything else is decrypted.
create table if not exists public.powerpass_vaults (
  user_id    uuid primary key default auth.uid(),
  kdf        text not null check (kdf = 'PBKDF2-SHA256'),
  iterations integer not null check (iterations between 100000 and 10000000),
  salt       text not null check (char_length(salt) between 16 and 100),
  check_iv   text not null check (char_length(check_iv) between 12 and 40),
  check_data text not null check (char_length(check_data) between 16 and 200),
  created_at timestamptz not null default now()
);

-- One row per login. `data` is the encrypted login, `iv` its nonce. Deleted
-- logins are flagged (data emptied) so other devices see they were removed.
create table if not exists public.powerpass_items (
  user_id    uuid not null default auth.uid(),
  id         text not null check (char_length(id) between 1 and 100),
  iv         text not null default '' check (char_length(iv) <= 40),
  data       text not null default '' check (char_length(data) <= 20000),
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists powerpass_items_updated_idx on public.powerpass_items (user_id, updated_at);

-- The real caller and the server's clock, whatever the client sent.
create or replace function private.powerpass_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.user_id := auth.uid();
  if tg_table_name = 'powerpass_items' then new.updated_at := now(); end if;
  return new;
end $$;

drop trigger if exists powerpass_vaults_owner on public.powerpass_vaults;
create trigger powerpass_vaults_owner before insert on public.powerpass_vaults
  for each row execute function private.powerpass_owner();
drop trigger if exists powerpass_items_owner on public.powerpass_items;
create trigger powerpass_items_owner before insert or update on public.powerpass_items
  for each row execute function private.powerpass_owner();

alter table public.powerpass_vaults enable row level security;
alter table public.powerpass_items enable row level security;

-- A vault is never edited in place: changing it would strand every login
-- encrypted under it. Deleting it (with the logins) is how someone who forgot
-- their master password starts again.
revoke all on public.powerpass_vaults, public.powerpass_items from anon, authenticated;
grant select, insert, delete on public.powerpass_vaults to authenticated;
grant select, insert, update, delete on public.powerpass_items to authenticated;

drop policy if exists powerpass_vaults_own on public.powerpass_vaults;
create policy powerpass_vaults_own on public.powerpass_vaults for all to authenticated
  using (user_id = (select auth.uid()) and (select private.is_member()))
  with check (user_id = (select auth.uid()) and (select private.is_member()));
drop policy if exists powerpass_items_own on public.powerpass_items;
create policy powerpass_items_own on public.powerpass_items for all to authenticated
  using (user_id = (select auth.uid()) and (select private.is_member()))
  with check (user_id = (select auth.uid()) and (select private.is_member()));
