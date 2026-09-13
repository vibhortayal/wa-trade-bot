-- Trade Flow bot schema.
-- Run once in the Supabase dashboard: SQL Editor > New query > paste > Run.
-- Tables hold ANONYMIZED trade actions only: no names, phone numbers,
-- message text, or group identifiers.

create table if not exists wa_trades (
  id         text primary key,          -- msg-<n>-<actionidx>, stable across pushes
  day        date not null,
  ts         bigint not null,           -- unix seconds, America/Los_Angeles day bucket
  trader     text not null,             -- "You" or "Trader 01".. (pseudonym)
  action     text not null,             -- BUY ADD SELL TRIM EXIT HOLD PLAN WATCH
  symbol     text,
  instrument text,                      -- stock call put spread crypto
  strike     numeric,
  expiry     text,                      -- YYYY-MM
  price      numeric,
  target     numeric,                    -- explicit price target (PLANs), else null
  quantity   text,
  confidence text,                      -- high medium low
  note       text,
  outcome    jsonb,                      -- scored by score-outcomes.py: {scored, kind,
                            --   entry, entry_src, ret, favorable, tgt_hit, roundtrip, ...}
  created_at timestamptz default now()
);
create index if not exists wa_trades_day_idx on wa_trades (day desc);
-- Idempotent for machines that ran an earlier version of this schema:
alter table wa_trades add column if not exists target numeric;
alter table wa_trades add column if not exists outcome jsonb;

create table if not exists wa_meta (
  key        text primary key,
  value      text not null,
  updated_at timestamptz default now()
);

alter table wa_trades enable row level security;
alter table wa_meta enable row level security;

-- Public (anon key) read-only access; writes only via service_role key on the bot.
drop policy if exists "public read trades" on wa_trades;
create policy "public read trades" on wa_trades for select using (true);
drop policy if exists "public read meta" on wa_meta;
create policy "public read meta" on wa_meta for select using (true);
-- service_role bypasses RLS; these are belt-and-braces.
drop policy if exists "service write trades" on wa_trades;
create policy "service write trades" on wa_trades for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
drop policy if exists "service write meta" on wa_meta;
create policy "service write meta" on wa_meta for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
