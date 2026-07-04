// config.js – Supabase-Zugangsdaten. Der "publishable"/"anon"-Key ist bewusst
// oeffentlich im Frontend sichtbar (das ist bei Supabase so vorgesehen) -- die
// eigentliche Absicherung passiert über Row Level Security in der Datenbank
// (siehe supabase-schema.sql). NIE den "service_role"-Key hier eintragen!
window.SUPABASE_URL = 'https://ruxjfznugisdrusjhrvz.supabase.co';
window.SUPABASE_ANON_KEY = 'sb_publishable_XtL4aBMxgkXwkIMif8UIuw_CSoWup6w';
