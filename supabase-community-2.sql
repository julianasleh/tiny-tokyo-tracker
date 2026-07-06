-- ============================================================
-- Tiny Tokyo Tracker: Community-Ausbau (Teil 2)
-- Land/Flagge, Nachrichten-Postfach, Punkte-Rangliste
-- Einmalig ausfuehren: Supabase -> SQL Editor -> New query ->
-- kompletten Inhalt einfuegen -> Run.
-- Voraussetzung: supabase-community.sql wurde bereits ausgefuehrt.
-- ============================================================

-- 1) Land im Community-Profil
alter table user_settings add column if not exists country text;

-- 2) Marktplatz-Sicht erweitern (neue Spalten werden NUR hinten angefuegt,
--    das erlaubt "create or replace" ohne die Sicht zu loeschen)
create or replace view market_cards as
  select c.id, c.game, c.name, c.set_name, c.set_code, c.number, c.rarity,
         c.image_url, c.cardmarket_url, c.language, c.condition, c.quantity,
         c.asking_price, c.currency, c.price_current,
         coalesce(nullif(trim(u.display_name), ''), 'Sammler') as seller_name,
         nullif(trim(u.contact), '') as seller_contact,
         (c.user_id = auth.uid()) as is_mine,
         c.external_id,
         c.user_id as seller_id,
         nullif(trim(u.country), '') as seller_country
  from cards c
  left join user_settings u on u.user_id = c.user_id
  where c.for_sale = true and c.status = 'owned';

-- 3) Nachrichten zwischen Nutzern
create table if not exists messages (
  id bigint generated always as identity primary key,
  from_user uuid not null,
  to_user uuid not null,
  card_name text,
  body text not null check (char_length(body) between 1 and 2000),
  read boolean not null default false,
  created_at timestamptz not null default now()
);
alter table messages enable row level security;

drop policy if exists "messages send" on messages;
create policy "messages send" on messages for insert to authenticated
  with check (from_user = auth.uid() and to_user <> auth.uid());

drop policy if exists "messages read own" on messages;
create policy "messages read own" on messages for select to authenticated
  using (from_user = auth.uid() or to_user = auth.uid());

drop policy if exists "messages mark read" on messages;
create policy "messages mark read" on messages for update to authenticated
  using (to_user = auth.uid()) with check (to_user = auth.uid());

drop policy if exists "messages delete own" on messages;
create policy "messages delete own" on messages for delete to authenticated
  using (from_user = auth.uid() or to_user = auth.uid());

grant select, insert, update, delete on messages to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Sicht mit Anzeigenamen (zeigt nur die eigenen Unterhaltungen)
create or replace view messages_view as
  select m.id, m.from_user, m.to_user, m.card_name, m.body, m.read, m.created_at,
         coalesce(nullif(trim(fu.display_name), ''), 'Sammler') as from_name,
         coalesce(nullif(trim(tu.display_name), ''), 'Sammler') as to_name,
         (m.to_user = auth.uid()) as incoming
  from messages m
  left join user_settings fu on fu.user_id = m.from_user
  left join user_settings tu on tu.user_id = m.to_user
  where m.from_user = auth.uid() or m.to_user = auth.uid();
revoke all on messages_view from anon;
grant select on messages_view to authenticated;

-- 4) Punkte-Rangliste (wird live berechnet, nichts wird gespeichert):
--    10 P. je Karte, 25 P. je aktives Angebot, 50 P. je Verkauf, 5 P. je Wunsch
create or replace view leaderboard as
  with c as (
    select user_id,
           count(*) * 10
           + count(*) filter (where for_sale) * 25
           + count(*) filter (where status = 'sold') * 50 as p
    from cards group by user_id
  ), w as (
    select user_id, count(*) * 5 as p from wishlist group by user_id
  )
  select coalesce(nullif(trim(u.display_name), ''), 'Sammler') as name,
         nullif(trim(u.country), '') as country,
         coalesce(c.p, 0) + coalesce(w.p, 0) as points,
         (coalesce(c.user_id, w.user_id) = auth.uid()) as is_me
  from c full outer join w on w.user_id = c.user_id
  left join user_settings u on u.user_id = coalesce(c.user_id, w.user_id)
  order by points desc
  limit 50;
revoke all on leaderboard from anon;
grant select on leaderboard to authenticated;
