-- ============================================================
-- Tiny Tokyo Tracker: Trade-Abwicklung (Teil 6)
-- Beim Abschluss eines Trades bucht die Datenbank die Karte
-- automatisch um:
--   Verkaeufer: 1 Exemplar geht in "Verkauft" (bei mehreren
--               Exemplaren wird die Menge um 1 reduziert),
--               Verkaufspreis = Trade-Preis.
--   Kaeufer:    bekommt die Karte in seine Sammlung,
--               Kaufpreis = Trade-Preis.
-- Einmalig ausfuehren: Supabase -> SQL Editor -> New query -> Run.
-- Voraussetzung: Teile 1-5 sind ausgefuehrt.
-- ============================================================

create or replace function trades_settle() returns trigger as $$
declare c cards%rowtype;
begin
  if new.status = 'abgeschlossen' and old.status <> 'abgeschlossen' then
    if new.card_id is not null then
      select * into c from cards where id = new.card_id and user_id = new.responder;
      if found and c.status = 'owned' then

        -- 1) Verkaeufer-Seite
        if c.quantity > 1 then
          -- Menge reduzieren, Angebot bleibt bestehen (weitere Exemplare da)
          update cards set quantity = quantity - 1, updated_at = now() where id = c.id;
          -- 1 Exemplar als verkauft ablegen
          insert into cards (user_id, game, external_id, name, set_name, set_code, number, rarity,
                             image_url, cardmarket_url, quantity, condition, language, notes,
                             price_at_add, price_current, price_low, price_trend, currency,
                             purchase_price, purchase_date, status, sold_price, sold_date, for_sale)
          values (c.user_id, c.game, c.external_id, c.name, c.set_name, c.set_code, c.number, c.rarity,
                  c.image_url, c.cardmarket_url, 1, c.condition, c.language, c.notes,
                  c.price_at_add, c.price_current, c.price_low, c.price_trend,
                  coalesce(new.currency, c.currency),
                  c.purchase_price, c.purchase_date, 'sold', new.price, current_date::text, false);
        else
          -- letztes Exemplar: Karte wird zur verkauften Karte
          update cards
             set status = 'sold', for_sale = false,
                 sold_price = new.price, sold_date = current_date::text,
                 currency = coalesce(new.currency, currency),
                 updated_at = now()
           where id = c.id;
        end if;

        -- 2) Kaeufer-Seite: Karte in dessen Sammlung (ohne private Notizen des Verkaeufers)
        insert into cards (user_id, game, external_id, name, set_name, set_code, number, rarity,
                           image_url, cardmarket_url, quantity, condition, language,
                           price_at_add, price_current, price_low, price_trend, currency,
                           purchase_price, purchase_date, status, for_sale)
        values (new.proposer, c.game, c.external_id, c.name, c.set_name, c.set_code, c.number, c.rarity,
                c.image_url, c.cardmarket_url, 1, c.condition, c.language,
                c.price_current, c.price_current, c.price_low, c.price_trend, c.currency,
                new.price, current_date::text, 'owned', false);
      end if;
    end if;
  end if;
  return new;
end $$ language plpgsql security definer;

drop trigger if exists trades_settle_tg on trades;
create trigger trades_settle_tg after update on trades
  for each row execute function trades_settle();
