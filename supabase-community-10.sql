-- ============================================================
-- Tiny Tokyo Tracker: Gesuche / Marktplatz-Nachfrage (Teil 10)
-- Wunschlisten-Karten koennen oeffentlich als "Gesuch" eingestellt
-- werden (was ich suche) -- Gegenstueck zu den Angeboten (was ich
-- verkaufe). Einmalig ausfuehren: Supabase -> SQL Editor -> Run.
-- ============================================================

-- 1) Wunschliste um Gesuch-Felder erweitern (Zustand, Budget/Max-Preis).
--    Die Anzahl nutzt die vorhandene Spalte wishlist.quantity.
alter table wishlist add column if not exists seeking        boolean not null default false;
alter table wishlist add column if not exists seek_condition text;
alter table wishlist add column if not exists seek_max_price numeric;
alter table wishlist add column if not exists seek_currency  text default 'EUR';

-- 2) Oeffentliche Sicht der Gesuche (analog zu market_cards fuer Angebote).
--    Zeigt alle als seeking markierten Wunschlisten-Karten mit dem
--    Anzeigenamen/Land des Suchenden. is_mine markiert die eigenen.
create or replace view seeking_cards as
  select w.id, w.game, w.name, w.set_name, w.set_code, w.number, w.rarity,
         w.image_url, w.cardmarket_url, w.language, w.quantity,
         w.seek_condition, w.seek_max_price,
         coalesce(w.seek_currency, 'EUR') as seek_currency,
         w.price_current,
         coalesce(nullif(trim(u.display_name), ''), 'Sammler') as seeker_name,
         nullif(trim(u.contact), '') as seeker_contact,
         (w.user_id = auth.uid()) as is_mine,
         w.external_id,
         w.user_id as seeker_id,
         nullif(trim(u.country), '') as seeker_country,
         exists(select 1 from user_badges b where b.user_id = w.user_id and b.badge = 'verified') as seeker_verified
    from wishlist w
    left join user_settings u on u.user_id = w.user_id
   where w.seeking = true;
revoke all on seeking_cards from anon;
grant select on seeking_cards to authenticated;
