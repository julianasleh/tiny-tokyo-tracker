-- ============================================================
-- Tiny Tokyo Tracker: Nutzer-Profile, Bewertungen, Abzeichen (Teil 3)
-- Einmalig ausfuehren: Supabase -> SQL Editor -> New query -> Run.
-- Voraussetzung: supabase-community.sql und -2.sql sind ausgefuehrt.
-- ============================================================

-- 1) Profil-Felder
alter table user_settings add column if not exists bio text;
alter table user_settings add column if not exists member_since timestamptz not null default now();

-- 2) Abzeichen: bewusst OHNE Schreib-Policies -- Badges vergibt NUR der
--    Shop-Betreiber direkt in Supabase. Beispiel (User-ID steht unter
--    Authentication -> Users):
--    insert into user_badges (user_id, badge) values ('<USER_ID>', 'verified');
create table if not exists user_badges (
  user_id uuid not null,
  badge text not null,
  granted_at timestamptz not null default now(),
  primary key (user_id, badge)
);
alter table user_badges enable row level security;
drop policy if exists "badges read" on user_badges;
create policy "badges read" on user_badges for select to authenticated using (true);
grant select on user_badges to authenticated;

-- 3) Bewertungen: jeder eingeloggte Nutzer kann jeden anderen genau EINMAL
--    bewerten (1-5 Sterne + optionaler Kommentar), die eigene Bewertung
--    laesst sich aendern oder loeschen. Sich selbst bewerten geht nicht.
create table if not exists user_ratings (
  rater uuid not null,
  rated uuid not null,
  stars int not null check (stars between 1 and 5),
  comment text check (comment is null or char_length(comment) <= 500),
  created_at timestamptz not null default now(),
  primary key (rater, rated),
  check (rater <> rated)
);
alter table user_ratings enable row level security;
drop policy if exists "ratings read" on user_ratings;
create policy "ratings read" on user_ratings for select to authenticated using (true);
drop policy if exists "ratings insert own" on user_ratings;
create policy "ratings insert own" on user_ratings for insert to authenticated with check (rater = auth.uid());
drop policy if exists "ratings update own" on user_ratings;
create policy "ratings update own" on user_ratings for update to authenticated using (rater = auth.uid()) with check (rater = auth.uid());
drop policy if exists "ratings delete own" on user_ratings;
create policy "ratings delete own" on user_ratings for delete to authenticated using (rater = auth.uid());
grant select, insert, update, delete on user_ratings to authenticated;

-- 4) Profil-Sicht: oeffentliche Infos + live berechnete Statistiken
create or replace view profiles as
  with ids as (
    select user_id from user_settings
    union select user_id from cards
    union select user_id from wishlist
  ), pts as (
    select i.user_id,
      coalesce((select count(*) * 10
                + count(*) filter (where for_sale) * 25
                + count(*) filter (where status = 'sold') * 50
                from cards c where c.user_id = i.user_id), 0)
      + coalesce((select count(*) * 5 from wishlist w where w.user_id = i.user_id), 0) as p
    from ids i
  ), rk as (
    select user_id, p, rank() over (order by p desc) as rnk from pts
  )
  select i.user_id,
         coalesce(nullif(trim(u.display_name), ''), 'Sammler') as name,
         nullif(trim(u.country), '') as country,
         u.bio,
         u.contact,
         u.member_since,
         coalesce(rk.p, 0) as points,
         rk.rnk as rank,
         (select count(*) from cards c where c.user_id = i.user_id and c.for_sale and c.status = 'owned') as active_offers,
         (select count(*) from cards c where c.user_id = i.user_id and c.status = 'sold') as sold_count,
         (select round(avg(r.stars)::numeric, 1) from user_ratings r where r.rated = i.user_id) as rating_avg,
         (select count(*) from user_ratings r where r.rated = i.user_id) as rating_count,
         coalesce((select array_agg(b.badge) from user_badges b where b.user_id = i.user_id), '{}') as badges,
         (i.user_id = auth.uid()) as is_me
  from ids i
  left join user_settings u on u.user_id = i.user_id
  left join rk on rk.user_id = i.user_id;
revoke all on profiles from anon;
grant select on profiles to authenticated;

-- Bewertungen mit Anzeigenamen der Bewerter
create or replace view ratings_view as
  select r.rated, r.rater, r.stars, r.comment, r.created_at,
         coalesce(nullif(trim(u.display_name), ''), 'Sammler') as rater_name,
         (r.rater = auth.uid()) as is_mine
  from user_ratings r
  left join user_settings u on u.user_id = r.rater;
revoke all on ratings_view from anon;
grant select on ratings_view to authenticated;

-- 5) Marktplatz-Sicht: Bewertung + Verifiziert-Status des Verkaeufers
--    (neue Spalten NUR hinten anfuegen)
create or replace view market_cards as
  select c.id, c.game, c.name, c.set_name, c.set_code, c.number, c.rarity,
         c.image_url, c.cardmarket_url, c.language, c.condition, c.quantity,
         c.asking_price, c.currency, c.price_current,
         coalesce(nullif(trim(u.display_name), ''), 'Sammler') as seller_name,
         nullif(trim(u.contact), '') as seller_contact,
         (c.user_id = auth.uid()) as is_mine,
         c.external_id,
         c.user_id as seller_id,
         nullif(trim(u.country), '') as seller_country,
         (select round(avg(r.stars)::numeric, 1) from user_ratings r where r.rated = c.user_id) as seller_rating,
         (select count(*) from user_ratings r where r.rated = c.user_id) as seller_rating_count,
         exists(select 1 from user_badges b where b.user_id = c.user_id and b.badge = 'verified') as seller_verified
  from cards c
  left join user_settings u on u.user_id = c.user_id
  where c.for_sale = true and c.status = 'owned';

-- 6) Rangliste: user_id anfuegen (macht Zeilen anklickbar)
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
         (coalesce(c.user_id, w.user_id) = auth.uid()) as is_me,
         coalesce(c.user_id, w.user_id) as user_id
  from c full outer join w on w.user_id = c.user_id
  left join user_settings u on u.user_id = coalesce(c.user_id, w.user_id)
  order by points desc
  limit 50;
