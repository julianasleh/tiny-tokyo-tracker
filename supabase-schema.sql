-- Tiny Tokyo Tracker – Supabase-Schema (Postgres) mit Mehrbenutzer-Trennung
-- Jede Zeile gehört zu genau einem Account (user_id). Row Level Security (RLS)
-- sorgt dafuer, dass niemand die Daten eines anderen Accounts sehen oder
-- aendern kann -- auch nicht ueber die offene REST-API.

-- ---------- cards ----------
create table if not exists cards (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references auth.users(id) on delete cascade default auth.uid(),
  game            text not null,
  external_id     text not null,
  name            text not null,
  set_name        text,
  set_code        text,
  number          text,
  rarity          text,
  image_url       text,
  cardmarket_url  text,
  quantity        integer not null default 1,
  condition       text default 'NM',
  language        text default 'DE',
  notes           text,
  price_at_add    double precision,
  price_current   double precision,
  price_low       double precision,
  price_trend     double precision,
  currency        text default 'EUR',
  purchase_price  double precision,
  purchase_date   text,
  status          text default 'owned',
  sold_price      double precision,
  sold_date       text,
  added_at        timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------- value_history (pro Nutzer + Tag) ----------
create table if not exists value_history (
  user_id     uuid not null references auth.users(id) on delete cascade default auth.uid(),
  day         date not null,
  total       double precision not null,
  total_low   double precision,
  total_trend double precision,
  recorded_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- ---------- card_price_history ----------
create table if not exists card_price_history (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  card_id bigint not null,
  day     date not null,
  price   double precision,
  primary key (user_id, card_id, day)
);

-- ---------- graded_cards ----------
create table if not exists graded_cards (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users(id) on delete cascade default auth.uid(),
  external_id    text,
  name           text not null,
  set_name       text,
  number         text,
  image_url      text,
  company        text not null,
  grade          text not null,
  cert           text,
  value          double precision,
  currency       text default 'USD',
  purchase_price double precision,
  purchase_date  text,
  status         text default 'owned',
  sold_price     double precision,
  sold_date      text,
  notes          text,
  added_at       timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ---------- wishlist ----------
create table if not exists wishlist (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users(id) on delete cascade default auth.uid(),
  game           text not null,
  external_id    text not null,
  name           text not null,
  set_name       text,
  set_code       text,
  number         text,
  rarity         text,
  image_url      text,
  cardmarket_url text,
  quantity       integer not null default 1,
  language       text default 'DE',
  notes          text,
  price_current  double precision,
  price_low      double precision,
  price_trend    double precision,
  currency       text default 'EUR',
  target_price   double precision,
  added_at       timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ---------- sealed ----------
create table if not exists sealed (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users(id) on delete cascade default auth.uid(),
  game           text not null,
  set_name       text,
  set_code       text,
  product_type   text not null,
  name           text not null,
  image_url      text,
  cardmarket_url text,
  quantity       integer not null default 1,
  purchase_price double precision,
  purchase_date  text,
  current_value  double precision,
  currency       text default 'EUR',
  status         text default 'owned',
  sold_price     double precision,
  sold_date      text,
  notes          text,
  added_at       timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ---------- settings (z.B. PokemonPriceTracker-Key, pro Nutzer eine Zeile) ----------
create table if not exists user_settings (
  user_id           uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  pokeprice_api_key text
);

-- ================= Row Level Security =================
alter table cards enable row level security;
alter table value_history enable row level security;
alter table card_price_history enable row level security;
alter table graded_cards enable row level security;
alter table wishlist enable row level security;
alter table sealed enable row level security;
alter table user_settings enable row level security;

-- Jede Tabelle: nur eigene Zeilen sehen/aendern/loeschen/anlegen.
create policy "own rows select" on cards for select using (auth.uid() = user_id);
create policy "own rows insert" on cards for insert with check (auth.uid() = user_id);
create policy "own rows update" on cards for update using (auth.uid() = user_id);
create policy "own rows delete" on cards for delete using (auth.uid() = user_id);

create policy "own rows select" on value_history for select using (auth.uid() = user_id);
create policy "own rows insert" on value_history for insert with check (auth.uid() = user_id);
create policy "own rows update" on value_history for update using (auth.uid() = user_id);
create policy "own rows delete" on value_history for delete using (auth.uid() = user_id);

create policy "own rows select" on card_price_history for select using (auth.uid() = user_id);
create policy "own rows insert" on card_price_history for insert with check (auth.uid() = user_id);
create policy "own rows update" on card_price_history for update using (auth.uid() = user_id);
create policy "own rows delete" on card_price_history for delete using (auth.uid() = user_id);

create policy "own rows select" on graded_cards for select using (auth.uid() = user_id);
create policy "own rows insert" on graded_cards for insert with check (auth.uid() = user_id);
create policy "own rows update" on graded_cards for update using (auth.uid() = user_id);
create policy "own rows delete" on graded_cards for delete using (auth.uid() = user_id);

create policy "own rows select" on wishlist for select using (auth.uid() = user_id);
create policy "own rows insert" on wishlist for insert with check (auth.uid() = user_id);
create policy "own rows update" on wishlist for update using (auth.uid() = user_id);
create policy "own rows delete" on wishlist for delete using (auth.uid() = user_id);

create policy "own rows select" on sealed for select using (auth.uid() = user_id);
create policy "own rows insert" on sealed for insert with check (auth.uid() = user_id);
create policy "own rows update" on sealed for update using (auth.uid() = user_id);
create policy "own rows delete" on sealed for delete using (auth.uid() = user_id);

create policy "own row select" on user_settings for select using (auth.uid() = user_id);
create policy "own row insert" on user_settings for insert with check (auth.uid() = user_id);
create policy "own row update" on user_settings for update using (auth.uid() = user_id);
