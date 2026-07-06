-- ============================================================
-- Tiny Tokyo Tracker: Community-Ausbau (Teil 9)
-- Freunde (Anfrage/Bestaetigung), Chat-Raeume (pro TCG + allgemein)
-- und Forum (Unterbereiche pro TCG + allgemein + offtopic).
-- Einmalig ausfuehren: Supabase -> SQL Editor -> New query -> Run.
--
-- Online-Status laeuft NICHT ueber eine Tabelle, sondern ueber
-- Supabase Realtime "Presence" (fluechtig, direkt im Browser) -- hier
-- ist dafuer nichts einzurichten.
-- ============================================================

-- Hilfsfunktion: fuellt author_name/author_country beim Einfuegen aus den
-- eigenen Einstellungen (nicht vom Client faelschbar). So enthaelt auch die
-- Realtime-Nachricht direkt den Anzeigenamen, ohne Extra-Abfrage.
create or replace function fill_author_name()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select coalesce(nullif(trim(display_name), ''), 'Sammler'),
         nullif(trim(country), '')
    into new.author_name, new.author_country
    from user_settings
   where user_id = new.user_id;
  if new.author_name is null then new.author_name := 'Sammler'; end if;
  return new;
end;
$$;

-- ------------------------------------------------------------
-- 1) Freunde ------------------------------------------------
-- Eine Zeile pro Beziehung. requester stellt die Anfrage, addressee
-- nimmt an (status 'accepted') oder die Zeile wird geloescht (ablehnen).
create table if not exists friendships (
  id         bigint generated always as identity primary key,
  requester  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  addressee  uuid not null references auth.users(id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending','accepted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint friendship_not_self check (requester <> addressee),
  constraint friendship_unique unique (requester, addressee)
);
alter table friendships enable row level security;

drop policy if exists "friend read"   on friendships;
drop policy if exists "friend insert" on friendships;
drop policy if exists "friend update" on friendships;
drop policy if exists "friend delete" on friendships;
create policy "friend read"   on friendships for select to authenticated using (auth.uid() in (requester, addressee));
create policy "friend insert" on friendships for insert to authenticated with check (auth.uid() = requester);
create policy "friend update" on friendships for update to authenticated using (auth.uid() in (requester, addressee)) with check (auth.uid() in (requester, addressee));
create policy "friend delete" on friendships for delete to authenticated using (auth.uid() in (requester, addressee));

-- Sicht mit aufgeloesten Namen/Laendern beider Seiten (nur eigene Beziehungen).
create or replace view friendships_view as
  select f.id, f.requester, f.addressee, f.status, f.created_at, f.updated_at,
         coalesce(nullif(trim(ur.display_name), ''), 'Sammler') as requester_name,
         nullif(trim(ur.country), '') as requester_country,
         coalesce(nullif(trim(ua.display_name), ''), 'Sammler') as addressee_name,
         nullif(trim(ua.country), '') as addressee_country
    from friendships f
    left join user_settings ur on ur.user_id = f.requester
    left join user_settings ua on ua.user_id = f.addressee
   where auth.uid() in (f.requester, f.addressee);
revoke all on friendships_view from anon;
grant select on friendships_view to authenticated;

-- ------------------------------------------------------------
-- 2) Chat ---------------------------------------------------
-- Ein Raum je TCG plus ein allgemeiner Raum. Lesen duerfen alle
-- eingeloggten Nutzer, schreiben nur unter eigener user_id.
create table if not exists chat_messages (
  id             bigint generated always as identity primary key,
  room           text not null check (room in ('general','pokemon','magic','yugioh','onepiece')),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  author_name    text,
  author_country text,
  body           text not null check (char_length(body) between 1 and 1000),
  created_at     timestamptz not null default now()
);
alter table chat_messages enable row level security;

drop policy if exists "chat read"       on chat_messages;
drop policy if exists "chat insert"     on chat_messages;
drop policy if exists "chat delete own" on chat_messages;
create policy "chat read"       on chat_messages for select to authenticated using (true);
create policy "chat insert"     on chat_messages for insert to authenticated with check (auth.uid() = user_id);
create policy "chat delete own" on chat_messages for delete to authenticated using (auth.uid() = user_id);

drop trigger if exists chat_fill_author on chat_messages;
create trigger chat_fill_author before insert on chat_messages
  for each row execute function fill_author_name();

create index if not exists chat_room_time_idx on chat_messages (room, created_at desc);

-- Realtime fuer Live-Chat aktivieren (idempotent).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_messages'
  ) then
    execute 'alter publication supabase_realtime add table chat_messages';
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 3) Forum --------------------------------------------------
-- Threads in Kategorien (pro TCG, allgemein, offtopic) + Antworten.
create table if not exists forum_threads (
  id             bigint generated always as identity primary key,
  category       text not null check (category in ('general','pokemon','magic','yugioh','onepiece','offtopic')),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  author_name    text,
  author_country text,
  title          text not null check (char_length(title) between 1 and 160),
  body           text not null check (char_length(body) between 1 and 5000),
  created_at     timestamptz not null default now(),
  last_activity  timestamptz not null default now()
);
alter table forum_threads enable row level security;

drop policy if exists "thread read"       on forum_threads;
drop policy if exists "thread insert"     on forum_threads;
drop policy if exists "thread update own" on forum_threads;
drop policy if exists "thread delete own" on forum_threads;
create policy "thread read"       on forum_threads for select to authenticated using (true);
create policy "thread insert"     on forum_threads for insert to authenticated with check (auth.uid() = user_id);
create policy "thread update own" on forum_threads for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "thread delete own" on forum_threads for delete to authenticated using (auth.uid() = user_id);

drop trigger if exists thread_fill_author on forum_threads;
create trigger thread_fill_author before insert on forum_threads
  for each row execute function fill_author_name();

create table if not exists forum_posts (
  id             bigint generated always as identity primary key,
  thread_id      bigint not null references forum_threads(id) on delete cascade,
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  author_name    text,
  author_country text,
  body           text not null check (char_length(body) between 1 and 5000),
  created_at     timestamptz not null default now()
);
alter table forum_posts enable row level security;

drop policy if exists "post read"       on forum_posts;
drop policy if exists "post insert"     on forum_posts;
drop policy if exists "post delete own" on forum_posts;
create policy "post read"       on forum_posts for select to authenticated using (true);
create policy "post insert"     on forum_posts for insert to authenticated with check (auth.uid() = user_id);
create policy "post delete own" on forum_posts for delete to authenticated using (auth.uid() = user_id);

drop trigger if exists post_fill_author on forum_posts;
create trigger post_fill_author before insert on forum_posts
  for each row execute function fill_author_name();

create index if not exists forum_threads_cat_idx on forum_threads (category, last_activity desc);
create index if not exists forum_posts_thread_idx on forum_posts (thread_id, created_at);

-- Neue Antwort hebt last_activity des Threads an (fuer die Sortierung).
create or replace function bump_thread_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update forum_threads set last_activity = now() where id = new.thread_id;
  return new;
end;
$$;

drop trigger if exists post_bump_thread on forum_posts;
create trigger post_bump_thread after insert on forum_posts
  for each row execute function bump_thread_activity();

-- Thread-Liste mit Antwortzahl.
create or replace view forum_threads_view as
  select t.id, t.category, t.user_id, t.author_name, t.author_country,
         t.title, t.body, t.created_at, t.last_activity,
         (select count(*) from forum_posts p where p.thread_id = t.id) as reply_count
    from forum_threads t;
revoke all on forum_threads_view from anon;
grant select on forum_threads_view to authenticated;
