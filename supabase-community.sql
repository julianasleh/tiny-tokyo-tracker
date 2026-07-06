-- ============================================================
-- Tiny Tokyo Tracker: Community-Marktplatz + Profil
-- Einmalig ausfuehren: Supabase -> SQL Editor -> New query ->
-- diesen kompletten Inhalt einfuegen -> Run.
-- ============================================================

-- 1) Karten koennen zum Verkauf markiert werden (+ Wunschpreis)
alter table cards add column if not exists for_sale boolean not null default false;
alter table cards add column if not exists asking_price numeric;

-- 2) Community-Profil (Anzeigename + frei waehlbare Kontaktinfo)
alter table user_settings add column if not exists display_name text;
alter table user_settings add column if not exists contact text;

-- 3) Oeffentliche Sicht: NUR zum Verkauf markierte Karten, NUR harmlose
--    Spalten (kein Kaufpreis, keine Notizen, keine sonstige Sammlung).
--    Die Sicht laeuft mit Owner-Rechten und umgeht damit gezielt die
--    Row-Level-Security der Tabellen -- genau dafuer ist sie da.
create or replace view market_cards as
  select c.id, c.game, c.name, c.set_name, c.set_code, c.number, c.rarity,
         c.image_url, c.cardmarket_url, c.language, c.condition, c.quantity,
         c.asking_price, c.currency, c.price_current,
         coalesce(nullif(trim(u.display_name), ''), 'Sammler') as seller_name,
         nullif(trim(u.contact), '') as seller_contact,
         (c.user_id = auth.uid()) as is_mine
  from cards c
  left join user_settings u on u.user_id = c.user_id
  where c.for_sale = true and c.status = 'owned';

-- Nur eingeloggte Nutzer duerfen die Angebote sehen
revoke all on market_cards from anon;
grant select on market_cards to authenticated;
