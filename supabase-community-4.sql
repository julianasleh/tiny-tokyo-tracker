-- ============================================================
-- Tiny Tokyo Tracker: Trade-System (Teil 4)
-- Tauschgeschaefte mit Statuskette und beidseitiger Bestaetigung.
-- Die Regeln erzwingt die DATENBANK (Trigger) -- nicht der Browser.
-- Einmalig ausfuehren: Supabase -> SQL Editor -> New query -> Run.
-- Voraussetzung: Teile 1-3 sind ausgefuehrt.
-- ============================================================

create table if not exists trades (
  id bigint generated always as identity primary key,
  proposer uuid not null,            -- wer anfragt
  responder uuid not null,           -- wessen Angebot es ist
  card_id bigint,
  card_name text not null,
  card_game text,
  price numeric,
  currency text not null default 'EUR',
  message text check (message is null or char_length(message) <= 1000),
  status text not null default 'angefragt'
    check (status in ('angefragt','angenommen','abgelehnt','abgebrochen','abgeschlossen')),
  proposer_done boolean not null default false,
  responder_done boolean not null default false,
  was_accepted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (proposer <> responder)
);

alter table trades enable row level security;

drop policy if exists "trades insert" on trades;
create policy "trades insert" on trades for insert to authenticated
  with check (proposer = auth.uid() and status = 'angefragt'
              and proposer_done = false and responder_done = false);

drop policy if exists "trades read" on trades;
create policy "trades read" on trades for select to authenticated
  using (proposer = auth.uid() or responder = auth.uid());

drop policy if exists "trades update" on trades;
create policy "trades update" on trades for update to authenticated
  using (proposer = auth.uid() or responder = auth.uid())
  with check (proposer = auth.uid() or responder = auth.uid());

grant select, insert, update on trades to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Statusmaschine: erlaubte Uebergaenge und Zustaendigkeiten
create or replace function trades_guard() returns trigger as $$
begin
  -- Unveraenderliche Felder festnageln
  new.proposer := old.proposer;
  new.responder := old.responder;
  new.card_id := old.card_id;
  new.card_name := old.card_name;
  new.card_game := old.card_game;
  new.created_at := old.created_at;
  new.was_accepted := old.was_accepted;
  new.updated_at := now();

  if old.status in ('abgeschlossen','abgelehnt','abgebrochen') then
    raise exception 'Dieser Trade ist bereits beendet und kann nicht mehr geändert werden';
  end if;

  -- Bestaetigungs-Haken: jeder darf nur den eigenen setzen, nie zuruecknehmen
  if new.proposer_done <> old.proposer_done then
    if auth.uid() <> old.proposer then raise exception 'Nur der Anfragende kann seine Bestätigung setzen'; end if;
    if old.proposer_done then raise exception 'Bestätigung kann nicht zurückgenommen werden'; end if;
  end if;
  if new.responder_done <> old.responder_done then
    if auth.uid() <> old.responder then raise exception 'Nur der Anbieter kann seine Bestätigung setzen'; end if;
    if old.responder_done then raise exception 'Bestätigung kann nicht zurückgenommen werden'; end if;
  end if;

  if old.status = 'angefragt' then
    if new.status = 'angenommen' then
      if auth.uid() <> old.responder then raise exception 'Nur der Anbieter kann annehmen'; end if;
      new.was_accepted := true;
    elsif new.status = 'abgelehnt' then
      if auth.uid() <> old.responder then raise exception 'Nur der Anbieter kann ablehnen'; end if;
    elsif new.status = 'abgebrochen' then
      if auth.uid() <> old.proposer then raise exception 'Nur der Anfragende kann die Anfrage zurückziehen'; end if;
    elsif new.status not in ('angefragt') then
      raise exception 'Ungültiger Statuswechsel';
    end if;
    if new.proposer_done or new.responder_done then
      raise exception 'Bestätigen geht erst nach der Annahme';
    end if;
  elsif old.status = 'angenommen' then
    if new.status not in ('angenommen','abgebrochen','abgeschlossen') then
      raise exception 'Ungültiger Statuswechsel';
    end if;
    if new.status = 'abgeschlossen' and not (new.proposer_done and new.responder_done) then
      raise exception 'Abschluss erst, wenn beide bestätigt haben';
    end if;
    -- Sobald beide bestaetigt haben: automatisch abschliessen
    if new.proposer_done and new.responder_done then
      new.status := 'abgeschlossen';
    end if;
  end if;

  return new;
end $$ language plpgsql security definer;

drop trigger if exists trades_guard_tg on trades;
create trigger trades_guard_tg before update on trades
  for each row execute function trades_guard();

-- Sicht mit Partnernamen (zeigt nur eigene Trades)
create or replace view trades_view as
  select t.*,
         coalesce(nullif(trim(pu.display_name), ''), 'Sammler') as proposer_name,
         coalesce(nullif(trim(ru.display_name), ''), 'Sammler') as responder_name,
         (t.proposer = auth.uid()) as i_am_proposer
  from trades t
  left join user_settings pu on pu.user_id = t.proposer
  left join user_settings ru on ru.user_id = t.responder
  where t.proposer = auth.uid() or t.responder = auth.uid();
revoke all on trades_view from anon;
grant select on trades_view to authenticated;

-- Profil-Sicht: Trade-Statistiken anfuegen (nur NEUE Spalten am Ende!)
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
          ) x) as trades_by_game
  from ids i
  left join user_settings u on u.user_id = i.user_id
  left join rk on rk.user_id = i.user_id;
revoke all on profiles from anon;
grant select on profiles to authenticated;

-- Marktplatz-Sicht: abgeschlossene Trades des Verkaeufers anfuegen
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
         (select count(*) from trades t where (t.proposer = c.user_id or t.responder = c.user_id) and t.status = 'abgeschlossen') as seller_trades
  from cards c
  left join user_settings u on u.user_id = c.user_id
  where c.for_sale = true and c.status = 'owned';
