-- ============================================================
-- Tiny Tokyo Tracker: Trade-Feedback (Teil 5)
-- Bewertungen NUR nach tatsaechlich abgeschlossenem Trade --
-- erzwungen von der Datenbank, nicht vom Browser.
-- Einmalig ausfuehren: Supabase -> SQL Editor -> New query -> Run.
-- Voraussetzung: Teile 1-4 sind ausgefuehrt.
-- ============================================================

create table if not exists trade_feedback (
  trade_id bigint not null,
  rater uuid not null,
  rated uuid not null,
  recommend boolean not null,                 -- 👍 wuerde wieder tauschen / 👎
  stars int not null check (stars between 1 and 5),
  comment text check (comment is null or char_length(comment) <= 500),
  cat_kommunikation int check (cat_kommunikation between 1 and 5),
  cat_verpackung int check (cat_verpackung between 1 and 5),
  cat_versand int check (cat_versand between 1 and 5),
  cat_zustand int check (cat_zustand between 1 and 5),
  created_at timestamptz not null default now(),
  primary key (trade_id, rater),
  check (rater <> rated)
);

alter table trade_feedback enable row level security;
drop policy if exists "feedback read" on trade_feedback;
create policy "feedback read" on trade_feedback for select to authenticated using (true);
drop policy if exists "feedback insert" on trade_feedback;
create policy "feedback insert" on trade_feedback for insert to authenticated with check (rater = auth.uid());
drop policy if exists "feedback update own" on trade_feedback;
create policy "feedback update own" on trade_feedback for update to authenticated using (rater = auth.uid()) with check (rater = auth.uid());
drop policy if exists "feedback delete own" on trade_feedback;
create policy "feedback delete own" on trade_feedback for delete to authenticated using (rater = auth.uid());
grant select, insert, update, delete on trade_feedback to authenticated;

-- Nur Beteiligte eines ABGESCHLOSSENEN Trades duerfen bewerten;
-- bewertet wird automatisch der jeweils andere.
create or replace function trade_feedback_guard() returns trigger as $$
declare t trades%rowtype;
begin
  select * into t from trades where id = new.trade_id;
  if not found then raise exception 'Trade nicht gefunden'; end if;
  if t.status <> 'abgeschlossen' then raise exception 'Feedback geht erst nach abgeschlossenem Trade'; end if;
  if auth.uid() <> t.proposer and auth.uid() <> t.responder then raise exception 'Nur Trade-Beteiligte können bewerten'; end if;
  new.rater := auth.uid();
  new.rated := case when auth.uid() = t.proposer then t.responder else t.proposer end;
  new.created_at := now();
  return new;
end $$ language plpgsql security definer;
drop trigger if exists trade_feedback_guard_tg on trade_feedback;
create trigger trade_feedback_guard_tg before insert on trade_feedback
  for each row execute function trade_feedback_guard();

-- Beim Aendern: Schluesselfelder festnageln
create or replace function trade_feedback_update_guard() returns trigger as $$
begin
  new.trade_id := old.trade_id;
  new.rater := old.rater;
  new.rated := old.rated;
  new.created_at := old.created_at;
  return new;
end $$ language plpgsql security definer;
drop trigger if exists trade_feedback_update_guard_tg on trade_feedback;
create trigger trade_feedback_update_guard_tg before update on trade_feedback
  for each row execute function trade_feedback_update_guard();

-- Feedback-Sicht mit Namen und Karte
create or replace view feedback_view as
  select f.trade_id, f.rater, f.rated, f.recommend, f.stars, f.comment,
         f.cat_kommunikation, f.cat_verpackung, f.cat_versand, f.cat_zustand, f.created_at,
         coalesce(nullif(trim(u.display_name), ''), 'Sammler') as rater_name,
         t.card_name,
         (f.rater = auth.uid()) as is_mine
  from trade_feedback f
  left join user_settings u on u.user_id = f.rater
  left join trades t on t.id = f.trade_id;
revoke all on feedback_view from anon;
grant select on feedback_view to authenticated;

-- Profil-Sicht: Feedback-Statistiken anfuegen (nur NEUE Spalten am Ende!)
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
         (select round(avg(f.cat_zustand)::numeric, 1) from trade_feedback f where f.rated = i.user_id) as fb_zustand
  from ids i
  left join user_settings u on u.user_id = i.user_id
  left join rk on rk.user_id = i.user_id;
revoke all on profiles from anon;
grant select on profiles to authenticated;

-- Marktplatz-Sicht: Feedback des Verkaeufers anfuegen
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
         (select count(*) from trade_feedback f where f.rated = c.user_id) as seller_fb_count
  from cards c
  left join user_settings u on u.user_id = c.user_id
  where c.for_sale = true and c.status = 'owned';
