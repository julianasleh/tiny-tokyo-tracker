-- ============================================================
-- Tiny Tokyo Tracker: Vertrauensindikatoren + Profil-Extras (Teil 7)
-- Antwortzeit, Aktivitaet, E-Mail-Verifizierung, Lieblings-TCGs,
-- Sammler-Typ, Zahlen fuer Erfolge/Achievements.
-- Einmalig ausfuehren: Supabase -> SQL Editor -> New query -> Run.
-- Voraussetzung: Teile 1-6 sind ausgefuehrt.
-- ============================================================

-- 1) Profil-Extras
alter table user_settings add column if not exists fav_games text;
alter table user_settings add column if not exists collector_type text;

-- 2) Profil-Sicht: neue Kennzahlen anfuegen (nur NEUE Spalten am Ende!)
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
         (i.user_id = auth.uid()) as is_me,
         (select count(*) from trades t where (t.proposer = i.user_id or t.responder = i.user_id) and t.status = 'abgeschlossen') as trades_done,
         (select count(*) from trades t where (t.proposer = i.user_id or t.responder = i.user_id) and t.status = 'abgebrochen' and t.was_accepted) as trades_cancelled,
         (select json_agg(x) from (
            select t.card_game as game, count(*) as n
            from trades t
            where (t.proposer = i.user_id or t.responder = i.user_id) and t.status = 'abgeschlossen'
            group by t.card_game order by count(*) desc
          ) x) as trades_by_game,
         (select count(*) from trade_feedback f where f.rated = i.user_id) as fb_count,
         (select count(*) from trade_feedback f where f.rated = i.user_id and f.stars >= 4) as fb_pos,
         (select count(*) from trade_feedback f where f.rated = i.user_id and f.stars = 3) as fb_neutral,
         (select count(*) from trade_feedback f where f.rated = i.user_id and f.stars <= 2) as fb_neg,
         (select round(avg(f.stars)::numeric, 2) from trade_feedback f where f.rated = i.user_id) as fb_avg,
         (select round(avg(case when f.recommend then 100.0 else 0.0 end)::numeric, 0) from trade_feedback f where f.rated = i.user_id) as fb_recommend_pct,
         (select round(avg(f.cat_kommunikation)::numeric, 1) from trade_feedback f where f.rated = i.user_id) as fb_kommunikation,
         (select round(avg(f.cat_verpackung)::numeric, 1) from trade_feedback f where f.rated = i.user_id) as fb_verpackung,
         (select round(avg(f.cat_versand)::numeric, 1) from trade_feedback f where f.rated = i.user_id) as fb_versand,
         (select round(avg(f.cat_zustand)::numeric, 1) from trade_feedback f where f.rated = i.user_id) as fb_zustand,
         -- ab hier neu (Teil 7):
         greatest(
           (select max(c.updated_at) from cards c where c.user_id = i.user_id),
           (select max(m.created_at) from messages m where m.from_user = i.user_id),
           (select max(t.updated_at) from trades t where t.proposer = i.user_id or t.responder = i.user_id)
         ) as last_active,
         exists(select 1 from auth.users au where au.id = i.user_id and au.email_confirmed_at is not null) as email_verified,
         (select round(avg(extract(epoch from (r.first_reply - f2.first_msg)) / 3600.0)::numeric, 1)
            from (select m.from_user as partner, min(m.created_at) as first_msg
                    from messages m where m.to_user = i.user_id group by m.from_user) f2
            join lateral (select min(r2.created_at) as first_reply from messages r2
                            where r2.from_user = i.user_id and r2.to_user = f2.partner
                              and r2.created_at > f2.first_msg) r on true
           where r.first_reply is not null) as response_hours,
         nullif(trim(u.fav_games), '') as fav_games,
         nullif(trim(u.collector_type), '') as collector_type,
         (select count(*) from cards c where c.user_id = i.user_id and c.status = 'owned') as total_cards,
         (select coalesce(sum(c.quantity), 0) from cards c where c.user_id = i.user_id and c.status = 'owned') as total_qty,
         (select max(t.price) from trades t where (t.proposer = i.user_id or t.responder = i.user_id) and t.status = 'abgeschlossen') as max_trade_price,
         (select count(distinct nullif(trim(u2.country), '')) from trades t
            join user_settings u2 on u2.user_id = case when t.proposer = i.user_id then t.responder else t.proposer end
           where (t.proposer = i.user_id or t.responder = i.user_id) and t.status = 'abgeschlossen') as traded_countries
  from ids i
  left join user_settings u on u.user_id = i.user_id
  left join rk on rk.user_id = i.user_id;
revoke all on profiles from anon;
grant select on profiles to authenticated;

-- 3) Marktplatz-Sicht: Erfolgsquote des Verkaeufers anfuegen
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
         exists(select 1 from user_badges b where b.user_id = c.user_id and b.badge = 'verified') as seller_verified,
         (select count(*) from trades t where (t.proposer = c.user_id or t.responder = c.user_id) and t.status = 'abgeschlossen') as seller_trades,
         (select round(avg(f.stars)::numeric, 1) from trade_feedback f where f.rated = c.user_id) as seller_fb_avg,
         (select count(*) from trade_feedback f where f.rated = c.user_id) as seller_fb_count,
         (select case when count(*) filter (where t.status = 'abgeschlossen')
                       + count(*) filter (where t.status = 'abgebrochen' and t.was_accepted) > 0
            then round(100.0 * count(*) filter (where t.status = 'abgeschlossen')
                 / (count(*) filter (where t.status = 'abgeschlossen')
                    + count(*) filter (where t.status = 'abgebrochen' and t.was_accepted)))
            else null end
          from trades t where t.proposer = c.user_id or t.responder = c.user_id) as seller_quote
  from cards c
  left join user_settings u on u.user_id = c.user_id
  where c.for_sale = true and c.status = 'owned';
