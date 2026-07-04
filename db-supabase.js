// db-supabase.js – Datenschicht auf Basis von Supabase (Postgres + Auth).
// Ersetzt db-browser.js (sql.js/IndexedDB). Gleiche Funktionsnamen wie vorher,
// aber jetzt ALLE asynchron (Netzwerk statt lokaler Datenbank) und pro
// eingeloggtem Nutzer getrennt (Row Level Security in Supabase uebernimmt die
// Trennung automatisch -- wir muessen nur bei INSERT/UPSERT die user_id
// mitschicken, bei SELECT/UPDATE/DELETE filtert Supabase selbst).

(function () {
  'use strict';

  let client = null;
  let currentUserId = null;

  function getClient() {
    if (!client) {
      if (!window.supabase || !window.supabase.createClient) throw new Error('Supabase-Bibliothek nicht geladen');
      client = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    }
    return client;
  }

  function must(res) {
    if (res.error) throw new Error(res.error.message || String(res.error));
    return res.data;
  }

  async function requireUserId() {
    if (currentUserId) return currentUserId;
    const { data, error } = await getClient().auth.getUser();
    if (error || !data || !data.user) throw new Error('Nicht eingeloggt');
    currentUserId = data.user.id;
    return currentUserId;
  }

  // ---- Auth --------------------------------------------------------------
  async function signUp(email, password) {
    const { data, error } = await getClient().auth.signUp({ email, password });
    if (error) throw new Error(error.message);
    return data;
  }
  async function signIn(email, password) {
    const { data, error } = await getClient().auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    currentUserId = data.user ? data.user.id : null;
    return data;
  }
  async function signOut() {
    await getClient().auth.signOut();
    currentUserId = null;
  }
  async function resetPassword(email) {
    const { error } = await getClient().auth.resetPasswordForEmail(email);
    if (error) throw new Error(error.message);
  }
  async function updatePassword(password) {
    const { error } = await getClient().auth.updateUser({ password });
    if (error) throw new Error(error.message);
  }
  async function getSession() {
    const { data } = await getClient().auth.getSession();
    return data.session || null;
  }
  function onAuthChange(cb) {
    getClient().auth.onAuthStateChange((event, session) => {
      currentUserId = session && session.user ? session.user.id : null;
      cb(event, session);
    });
  }

  async function init() {
    getClient();
    const s = await getSession();
    if (s && s.user) currentUserId = s.user.id;
    return true;
  }

  // --- Sammlung ---------------------------------------------------------------
  async function listCards() {
    return must(await getClient().from('cards').select('*').order('added_at', { ascending: false }));
  }

  function cardRow(c, uid) {
    return {
      user_id: uid, game: c.game, external_id: c.externalId, name: c.name,
      set_name: c.setName ?? null, set_code: c.setCode ?? null, number: c.number ?? null,
      rarity: c.rarity ?? null, image_url: c.imageUrl ?? null, cardmarket_url: c.cardmarketUrl ?? null,
      quantity: c.quantity ?? 1, condition: c.condition ?? 'NM', language: c.language ?? 'DE',
      notes: c.notes ?? null,
      price_at_add: c.cardmarketPrice ?? null, price_current: c.cardmarketPrice ?? null,
      price_low: c.priceLow ?? null, price_trend: c.priceTrend ?? null, currency: c.currency ?? 'EUR',
      purchase_price: c.purchasePrice ?? null, purchase_date: c.purchaseDate ?? null, status: 'owned',
    };
  }

  async function addCard(c) {
    const uid = await requireUserId();
    const row = await must(await getClient().from('cards').insert(cardRow(c, uid)).select().single());
    await recordSnapshot();
    return row;
  }

  async function updateCard(id, fields) {
    const allowed = ['quantity', 'condition', 'language', 'notes', 'price_current', 'price_low', 'price_trend',
      'currency', 'purchase_price', 'purchase_date', 'status', 'sold_price', 'sold_date', 'for_sale', 'asking_price'];
    const patch = {};
    for (const k of allowed) if (fields[k] !== undefined) patch[k] = fields[k];
    if (!Object.keys(patch).length) {
      const cur = await getClient().from('cards').select('*').eq('id', id).maybeSingle();
      return must(cur);
    }
    patch.updated_at = new Date().toISOString();
    const row = await must(await getClient().from('cards').update(patch).eq('id', id).select().single());
    await recordSnapshot();
    return row;
  }

  async function deleteCard(id) {
    await getClient().from('card_price_history').delete().eq('card_id', id);
    const { error, count } = await getClient().from('cards').delete({ count: 'exact' }).eq('id', id);
    if (error) throw new Error(error.message);
    const ok = (count || 0) > 0;
    if (ok) await recordSnapshot();
    return ok;
  }

  async function allForRefresh() {
    return must(await getClient().from('cards').select('id, game, external_id, name').eq('status', 'owned'));
  }

  // --- Verkaufte Karten -------------------------------------------------------
  async function listSold() {
    return must(await getClient().from('cards').select('*').eq('status', 'sold')
      .order('sold_date', { ascending: false, nullsFirst: false }));
  }
  async function soldForRefresh() {
    return must(await getClient().from('cards').select('id, game, external_id, name').eq('status', 'sold'));
  }
  async function soldTotals() {
    const rows = must(await getClient().from('cards')
      .select('quantity, purchase_price, sold_price, price_current, price_at_add, currency').eq('status', 'sold'));
    const mk = () => ({ realized: 0, proceeds: 0, current: 0, invested: 0, count: 0, qty: 0 });
    const eur = mk(), usd = mk();
    for (const r of rows) {
      const b = (r.currency || 'EUR') === 'USD' ? usd : eur;
      b.count += 1; b.qty += r.quantity;
      if (r.sold_price != null) b.proceeds += r.sold_price * r.quantity;
      if (r.sold_price != null && r.purchase_price != null) b.realized += (r.sold_price - r.purchase_price) * r.quantity;
      if (r.purchase_price != null) b.invested += r.purchase_price * r.quantity;
      b.current += (r.price_current ?? r.price_at_add ?? 0) * r.quantity;
    }
    return { eur, usd };
  }

  // --- Wertverlauf --------------------------------------------------------
  async function computeTotals() {
    const rows = must(await getClient().from('cards')
      .select('quantity, price_current, price_at_add, price_low, price_trend, currency').eq('status', 'owned'));
    let total = 0, low = 0, trend = 0, totalUsd = 0;
    for (const r of rows) {
      const main = (r.price_current ?? r.price_at_add ?? 0) * r.quantity;
      if ((r.currency || 'EUR') === 'USD') { totalUsd += main; continue; }
      total += main;
      low += (r.price_low ?? r.price_current ?? r.price_at_add ?? 0) * r.quantity;
      trend += (r.price_trend ?? r.price_current ?? r.price_at_add ?? 0) * r.quantity;
    }
    return { total, low, trend, totalUsd };
  }

  function today() { return new Date().toISOString().slice(0, 10); }

  async function recordCardHistory(uid) {
    const rows = must(await getClient().from('cards').select('id, price_current, price_at_add').eq('status', 'owned'));
    const day = today();
    const upserts = rows
      .map((r) => ({ user_id: uid, card_id: r.id, day, price: r.price_current ?? r.price_at_add }))
      .filter((r) => r.price != null);
    if (upserts.length) {
      const { error } = await getClient().from('card_price_history').upsert(upserts, { onConflict: 'user_id,card_id,day' });
      if (error) throw new Error(error.message);
    }
  }

  async function recordSnapshot() {
    const uid = await requireUserId();
    const { total, low, trend } = await computeTotals();
    const { error } = await getClient().from('value_history').upsert(
      { user_id: uid, day: today(), total, total_low: low, total_trend: trend, recorded_at: new Date().toISOString() },
      { onConflict: 'user_id,day' }
    );
    if (error) throw new Error(error.message);
    await recordCardHistory(uid);
  }

  async function getHistory() {
    return must(await getClient().from('value_history').select('day, total, total_low, total_trend').order('day', { ascending: true }));
  }
  async function getCardHistory(cardId) {
    return must(await getClient().from('card_price_history').select('day, price').eq('card_id', cardId).order('day', { ascending: true }));
  }

  // --- Portfolio ----------------------------------------------------------
  async function computePortfolio() {
    const owned = must(await getClient().from('cards')
      .select('quantity, price_current, price_at_add, currency, purchase_price').eq('status', 'owned'));
    const sold = must(await getClient().from('cards')
      .select('quantity, currency, purchase_price, sold_price').eq('status', 'sold'));
    const acc = () => ({ current: 0, invested: 0, costBase: 0, curOfInvested: 0 });
    const eur = acc(), usd = acc();
    for (const r of owned) {
      const bucket = (r.currency || 'EUR') === 'USD' ? usd : eur;
      const cur = (r.price_current ?? r.price_at_add ?? 0) * r.quantity;
      bucket.current += cur;
      if (r.purchase_price != null) { bucket.invested += r.purchase_price * r.quantity; bucket.curOfInvested += cur; }
    }
    let realizedEur = 0, realizedUsd = 0, proceedsEur = 0, proceedsUsd = 0;
    for (const r of sold) {
      if (r.sold_price == null) continue;
      const proceeds = r.sold_price * r.quantity;
      const gain = r.purchase_price != null ? (r.sold_price - r.purchase_price) * r.quantity : 0;
      if ((r.currency || 'EUR') === 'USD') { proceedsUsd += proceeds; realizedUsd += gain; }
      else { proceedsEur += proceeds; realizedEur += gain; }
    }
    const mk = (b) => ({
      current: b.current, invested: b.invested,
      unrealized: b.curOfInvested - b.invested,
      roi: b.invested > 0 ? (b.curOfInvested - b.invested) / b.invested * 100 : null,
    });
    return {
      eur: { ...mk(eur), realized: realizedEur, proceeds: proceedsEur },
      usd: { ...mk(usd), realized: realizedUsd, proceeds: proceedsUsd },
    };
  }

  async function getMovers(days, limit) {
    days = days || 30; limit = limit || 5;
    const owned = must(await getClient().from('cards')
      .select('id, name, set_name, set_code, number, image_url, currency, price_current, price_at_add').eq('status', 'owned'));
    const d = new Date(); d.setDate(d.getDate() - days);
    const cutoff = d.toISOString().slice(0, 10);
    const movers = [];
    for (const c of owned) {
      const hist = must(await getClient().from('card_price_history').select('day, price').eq('card_id', c.id).order('day', { ascending: true }));
      if (hist.length < 2) continue;
      const cur = c.price_current ?? c.price_at_add ?? hist[hist.length - 1].price;
      if (cur == null) continue;
      let past = null;
      for (const h of hist) { if (h.day <= cutoff) past = h; }
      if (!past) past = hist[0];
      if (past.price == null || past.price <= 0) continue;
      const change = cur - past.price;
      if (Math.abs(change) < 0.001) continue;
      movers.push({
        id: c.id, name: c.name, setName: c.set_name, setCode: c.set_code, number: c.number,
        imageUrl: c.image_url, currency: c.currency || 'EUR',
        from: past.price, to: cur, change, pct: change / past.price * 100, since: past.day,
      });
    }
    const gainers = [...movers].filter(m => m.change > 0).sort((a, b) => b.pct - a.pct).slice(0, limit);
    const losers = [...movers].filter(m => m.change < 0).sort((a, b) => a.pct - b.pct).slice(0, limit);
    return { gainers, losers, count: movers.length };
  }

  async function getAnalysis() {
    const owned = must(await getClient().from('cards')
      .select('name, set_name, rarity, condition, game, language, image_url, quantity, price_current, price_at_add, currency')
      .eq('status', 'owned'));
    const val = (r) => (r.price_current ?? r.price_at_add ?? 0) * r.quantity;
    const eurCards = owned.filter(r => (r.currency || 'EUR') !== 'USD');
    const usdCards = owned.filter(r => (r.currency || 'EUR') === 'USD');

    const group = (cards, keyFn) => {
      const m = new Map();
      for (const r of cards) { const k = keyFn(r) || '—'; m.set(k, (m.get(k) || 0) + val(r)); }
      return [...m.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
    };

    const byGame = group(eurCards, r => ({ pokemon: 'Pokémon', magic: 'Magic', yugioh: 'Yu-Gi-Oh' }[r.game] || r.game));
    const byLanguage = group(eurCards, r => (r.language || '—').toLowerCase());
    const byRarity = group(eurCards, r => r.rarity).slice(0, 10);
    const bySet = group(eurCards, r => r.set_name).slice(0, 10);
    const byCondition = group(eurCards, r => r.condition);

    const topCards = [...owned].map(r => ({
      name: r.name, setName: r.set_name, value: val(r), currency: r.currency || 'EUR',
      qty: r.quantity, imageUrl: r.image_url,
    })).sort((a, b) => b.value - a.value).slice(0, 10);

    const totalQty = owned.reduce((s, r) => s + r.quantity, 0);
    const eurValue = eurCards.reduce((s, r) => s + val(r), 0);
    const usdValue = usdCards.reduce((s, r) => s + val(r), 0);
    const stats = {
      totalQty, unique: owned.length,
      eurValue, usdValue,
      avgEur: eurCards.length ? eurValue / eurCards.reduce((s, r) => s + r.quantity, 0) : 0,
      mostValuable: topCards[0] || null,
    };
    return { byGame, byLanguage, byRarity, bySet, byCondition, topCards, stats, usdValue };
  }

  // --- Gegradete Karten -----------------------------------------------------
  async function listGraded() {
    return must(await getClient().from('graded_cards').select('*').eq('status', 'owned').order('added_at', { ascending: false }));
  }
  async function listGradedSold() {
    return must(await getClient().from('graded_cards').select('*').eq('status', 'sold').order('sold_date', { ascending: false, nullsFirst: false }));
  }
  async function addGraded(c) {
    const uid = await requireUserId();
    const row = {
      user_id: uid, external_id: c.externalId ?? null, name: c.name, set_name: c.setName ?? null,
      number: c.number ?? null, image_url: c.imageUrl ?? null,
      company: (c.company || 'PSA').toUpperCase(), grade: String(c.grade ?? ''),
      cert: c.cert ?? null, value: c.value ?? null, currency: c.currency ?? 'USD',
      purchase_price: c.purchasePrice ?? null, purchase_date: c.purchaseDate ?? null, notes: c.notes ?? null,
      status: 'owned',
    };
    return must(await getClient().from('graded_cards').insert(row).select().single());
  }
  async function updateGraded(id, fields) {
    const allowed = ['company', 'grade', 'cert', 'value', 'currency', 'notes',
      'purchase_price', 'purchase_date', 'status', 'sold_price', 'sold_date'];
    const patch = {};
    for (const k of allowed) if (fields[k] !== undefined) patch[k] = fields[k];
    if (!Object.keys(patch).length) return must(await getClient().from('graded_cards').select('*').eq('id', id).maybeSingle());
    patch.updated_at = new Date().toISOString();
    return must(await getClient().from('graded_cards').update(patch).eq('id', id).select().single());
  }
  async function deleteGraded(id) {
    const { error, count } = await getClient().from('graded_cards').delete({ count: 'exact' }).eq('id', id);
    if (error) throw new Error(error.message);
    return (count || 0) > 0;
  }

  // --- "Sicherung jetzt" -- bei Supabase uebernimmt die Cloud-Datenbank die
  // dauerhafte Speicherung selbst; dieser Knopf dient nur noch als Test, ob die
  // Verbindung steht. Fuer eine eigene Kopie: "Komplett-Backup" (exportAll) nutzen.
  async function backupDatabase() {
    try {
      await requireUserId();
      return { file: 'in-der-cloud-gespeichert', kept: 0 };
    } catch (e) { return { error: String((e && e.message) || e) }; }
  }
  async function listBackups() { return []; }

  // --- Wunschliste ------------------------------------------------------------
  async function listWishlist() {
    return must(await getClient().from('wishlist').select('*').order('added_at', { ascending: false }));
  }
  async function addWishlist(c) {
    const uid = await requireUserId();
    const existing = await getClient().from('wishlist').select('id')
      .eq('game', c.game).eq('external_id', c.externalId).eq('language', c.language ?? 'DE').maybeSingle();
    if (existing.data) return must(await getClient().from('wishlist').select('*').eq('id', existing.data.id).single());
    const row = {
      user_id: uid, game: c.game, external_id: c.externalId, name: c.name,
      set_name: c.setName ?? null, set_code: c.setCode ?? null, number: c.number ?? null,
      rarity: c.rarity ?? null, image_url: c.imageUrl ?? null, cardmarket_url: c.cardmarketUrl ?? null,
      quantity: c.quantity ?? 1, language: c.language ?? 'DE', notes: c.notes ?? null,
      price_current: c.cardmarketPrice ?? null, price_low: c.priceLow ?? null, price_trend: c.priceTrend ?? null,
      currency: c.currency ?? 'EUR', target_price: c.targetPrice ?? null,
    };
    return must(await getClient().from('wishlist').insert(row).select().single());
  }
  async function updateWishlist(id, fields) {
    const allowed = ['quantity', 'language', 'notes', 'price_current', 'price_low', 'price_trend', 'currency', 'target_price'];
    const patch = {};
    for (const k of allowed) if (fields[k] !== undefined) patch[k] = fields[k];
    if (!Object.keys(patch).length) return must(await getClient().from('wishlist').select('*').eq('id', id).maybeSingle());
    patch.updated_at = new Date().toISOString();
    return must(await getClient().from('wishlist').update(patch).eq('id', id).select().single());
  }
  async function deleteWishlist(id) {
    const { error, count } = await getClient().from('wishlist').delete({ count: 'exact' }).eq('id', id);
    if (error) throw new Error(error.message);
    return (count || 0) > 0;
  }
  async function wishlistForRefresh() {
    return must(await getClient().from('wishlist').select('id, game, external_id, name'));
  }
  async function wishlistTotals() {
    const rows = must(await getClient().from('wishlist').select('quantity, price_current, currency'));
    let eur = 0, usd = 0;
    for (const r of rows) {
      const v = (r.price_current ?? 0) * r.quantity;
      if ((r.currency || 'EUR') === 'USD') usd += v; else eur += v;
    }
    return { eur, usd, count: rows.length };
  }

  // --- Versiegelte Ware ---------------------------------------------------
  async function listSealed() {
    return must(await getClient().from('sealed').select('*').eq('status', 'owned').order('added_at', { ascending: false }));
  }
  async function listSealedSold() {
    return must(await getClient().from('sealed').select('*').eq('status', 'sold').order('sold_date', { ascending: false, nullsFirst: false }));
  }
  async function addSealed(c) {
    const uid = await requireUserId();
    const row = {
      user_id: uid, game: c.game, set_name: c.setName ?? null, set_code: c.setCode ?? null,
      product_type: c.productType || 'Booster', name: c.name,
      image_url: c.imageUrl ?? null, cardmarket_url: c.cardmarketUrl ?? null,
      quantity: c.quantity ?? 1, purchase_price: c.purchasePrice ?? null, purchase_date: c.purchaseDate ?? null,
      current_value: c.currentValue ?? null, currency: c.currency ?? 'EUR', notes: c.notes ?? null,
      status: c.status === 'sold' ? 'sold' : 'owned', sold_price: c.sold_price ?? null, sold_date: c.sold_date ?? null,
    };
    return must(await getClient().from('sealed').insert(row).select().single());
  }
  async function updateSealed(id, fields) {
    const allowed = ['set_name', 'product_type', 'name', 'quantity', 'purchase_price', 'purchase_date',
      'current_value', 'currency', 'notes', 'cardmarket_url', 'status', 'sold_price', 'sold_date'];
    const patch = {};
    for (const k of allowed) if (fields[k] !== undefined) patch[k] = fields[k];
    if (!Object.keys(patch).length) return must(await getClient().from('sealed').select('*').eq('id', id).maybeSingle());
    patch.updated_at = new Date().toISOString();
    return must(await getClient().from('sealed').update(patch).eq('id', id).select().single());
  }
  async function deleteSealed(id) {
    const { error, count } = await getClient().from('sealed').delete({ count: 'exact' }).eq('id', id);
    if (error) throw new Error(error.message);
    return (count || 0) > 0;
  }
  async function sealedTotals() {
    const rows = must(await getClient().from('sealed').select('quantity, purchase_price, current_value, currency').eq('status', 'owned'));
    const acc = { eur: { current: 0, invested: 0 }, usd: { current: 0, invested: 0 } };
    for (const r of rows) {
      const b = (r.currency || 'EUR') === 'USD' ? acc.usd : acc.eur;
      b.current += (r.current_value ?? 0) * r.quantity;
      if (r.purchase_price != null) b.invested += r.purchase_price * r.quantity;
    }
    return {
      eur: { ...acc.eur, pl: acc.eur.current - acc.eur.invested },
      usd: { ...acc.usd, pl: acc.usd.current - acc.usd.invested },
      count: rows.length,
    };
  }

  // --- Vollstaendiges Backup (JSON-Export/Import) -----------------------------
  const BACKUP_TABLES = ['cards', 'wishlist', 'sealed', 'graded_cards', 'value_history', 'card_price_history'];

  async function exportAll() {
    const out = { app: 'tiny-tokyo-tracker', version: 3, exportedAt: new Date().toISOString() };
    for (const t of BACKUP_TABLES) {
      try { out[t] = must(await getClient().from(t).select('*')); } catch { out[t] = []; }
    }
    return out;
  }

  async function restoreTable(table, rows, uid) {
    await getClient().from(table).delete().eq('user_id', uid);
    if (!Array.isArray(rows) || !rows.length) return 0;
    const cleaned = rows.map((r) => {
      const c = Object.assign({}, r);
      delete c.id; // neue IDs vergeben lassen
      c.user_id = uid;
      return c;
    });
    const CHUNK = 200;
    let n = 0;
    for (let i = 0; i < cleaned.length; i += CHUNK) {
      const slice = cleaned.slice(i, i + CHUNK);
      const { error, data } = await getClient().from(table).insert(slice).select('id');
      if (error) { console.warn('Import-Fehler bei', table, error.message); continue; }
      n += (data || []).length;
    }
    return n;
  }

  async function importAll(data) {
    if (!data || typeof data !== 'object') throw new Error('Ungültige Backup-Datei');
    if (!BACKUP_TABLES.some((t) => Array.isArray(data[t]))) throw new Error('Keine bekannten Daten in der Datei');
    const uid = await requireUserId();
    const counts = {};
    // Reihenfolge: cards zuerst (card_price_history verweist per card_id darauf,
    // die IDs aendern sich beim Import allerdings -- Verlaufsdaten pro Karte
    // koennen sich dadurch nicht 1:1 zuordnen lassen und werden bewusst NICHT
    // re-importiert; der Gesamtwertverlauf (value_history) bleibt erhalten).
    for (const t of BACKUP_TABLES) {
      if (t === 'card_price_history') { counts[t] = 0; continue; }
      counts[t] = await restoreTable(t, data[t] || [], uid);
    }
    return counts;
  }

  // --- Einstellungen --------------------------------------------------------
  const SETTINGS_COLS = { pokepriceApiKey: 'pokeprice_api_key', displayName: 'display_name', contact: 'contact', country: 'country' };
  async function getSetting(key) {
    const col = SETTINGS_COLS[key];
    if (!col) return null;
    const uid = await requireUserId();
    const { data } = await getClient().from('user_settings').select(col).eq('user_id', uid).maybeSingle();
    return data ? data[col] : null;
  }
  async function setSetting(key, value) {
    const col = SETTINGS_COLS[key];
    if (!col) return;
    const uid = await requireUserId();
    const { error } = await getClient().from('user_settings').upsert({ user_id: uid, [col]: value }, { onConflict: 'user_id' });
    if (error) throw new Error(error.message);
  }

  // --- Community-Marktplatz (oeffentliche Sicht market_cards) ---------------
  async function listMarket() {
    return must(await getClient().from('market_cards').select('*').order('game', { ascending: true }));
  }

  // --- Nachrichten -----------------------------------------------------------
  async function listMessages() {
    return must(await getClient().from('messages_view').select('*').order('created_at', { ascending: false }).limit(200));
  }
  async function unreadMessages() {
    const uid = await requireUserId();
    const { count, error } = await getClient().from('messages')
      .select('id', { count: 'exact', head: true }).eq('to_user', uid).eq('read', false);
    if (error) throw new Error(error.message);
    return count || 0;
  }
  async function sendMessage(toUser, cardName, body) {
    const uid = await requireUserId();
    const { error } = await getClient().from('messages')
      .insert({ from_user: uid, to_user: toUser, card_name: cardName ?? null, body });
    if (error) throw new Error(error.message);
    return true;
  }
  async function markMessagesRead(ids) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const { error } = await getClient().from('messages').update({ read: true }).in('id', ids);
    if (error) throw new Error(error.message);
    return ids.length;
  }
  async function deleteMessage(id) {
    const { error, count } = await getClient().from('messages').delete({ count: 'exact' }).eq('id', id);
    if (error) throw new Error(error.message);
    return (count || 0) > 0;
  }

  // --- Punkte-Rangliste --------------------------------------------------------
  async function leaderboard() {
    return must(await getClient().from('leaderboard').select('*'));
  }

  window.DB = {
    init, signUp, signIn, signOut, getSession, onAuthChange, resetPassword, updatePassword,
    getSetting, setSetting, listMarket,
    listMessages, unreadMessages, sendMessage, markMessagesRead, deleteMessage, leaderboard,
    listCards, addCard, updateCard, deleteCard, allForRefresh,
    listSold, soldForRefresh, soldTotals,
    computeTotals, recordSnapshot, getHistory, getCardHistory,
    computePortfolio, getMovers, getAnalysis,
    listGraded, listGradedSold, addGraded, updateGraded, deleteGraded,
    backupDatabase, listBackups,
    listWishlist, addWishlist, updateWishlist, deleteWishlist, wishlistForRefresh, wishlistTotals,
    listSealed, listSealedSold, addSealed, updateSealed, deleteSealed, sealedTotals,
    exportAll, importAll,
  };
})();
