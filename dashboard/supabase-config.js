// Trade Flow — Supabase live-data config.
// The anon key is PUBLIC by design (PostgREST + Row Level Security limits it to
// read-only access on wa_trades / wa_meta). Fill these in after running
// supabase/schema.sql and the bot's first push; leave empty to keep using the
// baked-in static data/trades.json.
window.TRADE_FLOW = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
};
