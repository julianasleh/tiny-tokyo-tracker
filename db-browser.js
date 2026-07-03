// db-browser.js – Datenbankschicht im Browser: sql.js (SQLite als WebAssembly)
// + IndexedDB-Persistenz. Ersetzt db.js (node:sqlite). Gleiche Funktionsnamen/
// Signaturen wie vorher, damit die Routen-Logik (server-logic.js) fast unverändert
// bleibt. Läuft als "classic script" im Service Worker (importScripts).
//
// Wichtiger Unterschied zu node:sqlite: hier läuft alles asynchron. Vor der ersten
// Nutzung MUSS `await DB.init()` aufgerufen werden (macht server-logic.js selbst).

(function () {
  'use strict';

  const IDB_NAME = 'tiny-tokyo-tracker';
  const IDB_VERSION = 1;
  const STORE_MAIN = 'sqlite';
  const STORE_BACKUPS = 'backups';
  const STORE_SETTINGS = 'settings';
  const BACKUP_KEEP = 10;

  let SQL = null;
  let sqljsDb = null;
  let idbHandle = null;
  let saveTimer = null;
  let initPromise = null;

  // ---- IndexedDB Hilfsfunktionen -------------------------------------------
  function openIdb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const idb = req.result;
        if (!idb.objectStoreNames.contains(STORE_MAIN)) idb.createObjectStore(STORE_MAIN, { keyPath: 'id' });
        if (!idb.objectStoreNames.contains(STORE_BACKUPS)) idb.createObjectStore(STORE_BACKUPS, { keyPath: 'id', autoIncrement: true });
        if (!idb.objectStoreNames.contains(STORE_SETTINGS)) idb.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function idbGet(store, key) {
    return new Promise((resolve, reject) => {
      const r = idbHandle.transaction(store, 'readonly').objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  function idbPut(store, value) {
    return new Promise((resolve, reject) => {
      const r = idbHandle.transaction(store, 'readwrite').objectStore(store).put(value);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  function idbGetAll(store) {
    return new Promise((resolve, reject) => {
      const r = idbHandle.transaction(store, 'readonly').objectStore(store).getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  function idbDelete(store, key) {
    return new Promise((resolve, reject) => {
      const r = idbHandle.transaction(store, 'readwrite').objectStore(store).delete(key);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  }

  async function persistNow() {
    const bytes = sqljsDb.export();
    await idbPut(STORE_MAIN, { id: 'main', bytes, updatedAt: new Date().toISOString() });
  }
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; persistNow().catch(() => {}); }, 150);
  }
  async function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    await persistNow();
  }

  // ---- sql.js-Kompatibilitätsschicht (imitiert die node:sqlite-API) --------
  function normalizeParams(p) {
    if (p === undefined) return undefined;
    if (Array.isArray(p)) return p;
    if (p !== null && typeof p === 'object') {
      const out = {};
      for (const k of Object.keys(p)) out['@' + k] = p[k] === undefined ? null : p[k];
      return out;
    }
    return [p];
  }

  class Stmt {
    constructor(sql) { this.sql = sql; }
    all(params) {
      const st = sqljsDb.prepare(this.sql);
      try {
        const np = normalizeParams(params);
        if (np !== undefined) st.bind(np);
        const rows = [];
        while (st.step()) rows.push(st.getAsObject());
        return rows;
      } finally { st.free(); }
    }
    get(params) {
      const st = sqljsDb.prepare(this.sql);
      try {
        const np = normalizeParams(params);
        if (np !== undefined) st.bind(np);
        let row;
        if (st.step()) row = st.getAsObject();
        return row;
      } finally { st.free(); }
    }
    run(params) {
      const st = sqljsDb.prepare(this.sql);
      let changes = 0, lastInsertRowid = null;
      try {
        const np = normalizeParams(params);
        if (np !== undefined) st.bind(np);
        st.step();
      } finally { st.free(); }
      changes = sqljsDb.getRowsModified();
      try {
        const r = sqljsDb.exec('SELECT last_insert_rowid() AS id');
        lastInsertRowid = (r[0] && r[0].values[0] && r[0].values[0][0]);
        if (lastInsertRowid === undefined) lastInsertRowid = null;
      } catch { /* egal */ }
      scheduleSave();
      return { changes, lastInsertRowid };
    }
  }

  const db = {
    prepare(sql) { return new Stmt(sql); },
    exec(sql) { sqljsDb.run(sql); scheduleSave(); },
  };

  const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS cards (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      game            TEXT    NOT NULL,
      external_id     TEXT    NOT NULL,
      name            TEXT    NOT NULL,
      set_name        TEXT,
      set_code        TEXT,
      number          TEXT,
      rarity          TEXT,
      image_url       TEXT,
      cardmarket_url  TEXT,
      quantity        INTEGER NOT NULL DEFAULT 1,
      condition       TEXT    DEFAULT 'NM',
      language        TEXT    DEFAULT 'DE',
      notes           TEXT,
      price_at_add    REAL,
      price_current   REAL,
      price_low       REAL,
      price_trend     REAL,
      currency        TEXT    DEFAULT 'EUR',
      purchase_price  REAL,
      purchase_date   TEXT,
      status          TEXT    DEFAULT 'owned',
      sold_price      REAL,
      sold_date       TEXT,
      added_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS value_history (
      day         TEXT PRIMARY KEY,
      total       REAL NOT NULL,
      total_low   REAL,
      total_trend REAL,
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS card_price_history (
      card_id INTEGER NOT NULL,
      day     TEXT    NOT NULL,
      price   REAL,
      PRIMARY KEY (card_id, day)
    );

    CREATE TABLE IF NOT EXISTS graded_cards (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT,
      name        TEXT NOT NULL,
      set_name    TEXT,
      number      TEXT,
      image_url   TEXT,
      company     TEXT NOT NULL,
      grade       TEXT NOT NULL,
      cert        TEXT,
      value       REAL,
      currency    TEXT DEFAULT 'USD',
      purchase_price REAL,
      purchase_date  TEXT,
      status         TEXT DEFAULT 'owned',
      sold_price     REAL,
      sold_date      TEXT,
      notes       TEXT,
      added_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS wishlist (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      game            TEXT    NOT NULL,
      external_id     TEXT    NOT NULL,
      name            TEXT    NOT NULL,
      set_name        TEXT,
      set_code        TEXT,
      number          TEXT,
      rarity          TEXT,
      image_url       TEXT,
      cardmarket_url  TEXT,
      quantity        INTEGER NOT NULL DEFAULT 1,
      language        TEXT    DEFAULT 'DE',
      notes           TEXT,
      price_current   REAL,
      price_low       REAL,
      price_trend     REAL,
      currency        TEXT    DEFAULT 'EUR',
      target_price    REAL,
      added_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sealed (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      game           TEXT    NOT NULL,
      set_name       TEXT,
      set_code       TEXT,
      product_type   TEXT    NOT NULL,
      name           TEXT    NOT NULL,
      image_url      TEXT,
      cardmarket_url TEXT,
      quantity       INTEGER NOT NULL DEFAULT 1,
      purchase_price REAL,
      purchase_date  TEXT,
      current_value  REAL,
      currency       TEXT    DEFAULT 'EUR',
      status         TEXT    DEFAULT 'owned',
      sold_price     REAL,
      sold_date      TEXT,
      notes          TEXT,
      added_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `;

  function runMigrations() {
    const cols = db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name);
    for (const [col, type, def] of [
      ['set_code', 'TEXT', null], ['price_low', 'REAL', null], ['price_trend', 'REAL', null], ['currency', 'TEXT', null],
      ['purchase_price', 'REAL', null], ['purchase_date', 'TEXT', null],
      ['status', 'TEXT', "'owned'"], ['sold_price', 'REAL', null], ['sold_date', 'TEXT', null],
    ]) {
      if (!cols.includes(col)) db.exec(`ALTER TABLE cards ADD COLUMN ${col} ${type}${def ? ` DEFAULT ${def}` : ''}`);
    }
    db.exec(`UPDATE cards SET status='owned' WHERE status IS NULL`);

    const sealedCols = db.prepare('PRAGMA table_info(sealed)').all().map((c) => c.name);
    for (const [col, type, def] of [
      ['purchase_date', 'TEXT', null], ['status', 'TEXT', "'owned'"], ['sold_price', 'REAL', null], ['sold_date', 'TEXT', null],
    ]) {
      if (!sealedCols.includes(col)) db.exec(`ALTER TABLE sealed ADD COLUMN ${col} ${type}${def ? ` DEFAULT ${def}` : ''}`);
    }
    db.exec(`UPDATE sealed SET status='owned' WHERE status IS NULL`);

    const gradedCols = db.prepare('PRAGMA table_info(graded_cards)').all().map((c) => c.name);
    for (const [col, type, def] of [
      ['purchase_price', 'REAL', null], ['purchase_date', 'TEXT', null],
      ['status', 'TEXT', "'owned'"], ['sold_price', 'REAL', null], ['sold_date', 'TEXT', null],
    ]) {
      if (!gradedCols.includes(col)) db.exec(`ALTER TABLE graded_cards ADD COLUMN ${col} ${type}${def ? ` DEFAULT ${def}` : ''}`);
    }
    db.exec(`UPDATE graded_cards SET status='owned' WHERE status IS NULL`);
  }

  async function init(opts) {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const locateFile = (opts && opts.locateFile) || ((f) => (opts && opts.libBase ? opts.libBase : './lib/') + f);
      SQL = await self.initSqlJs({ locateFile });
      idbHandle = await openIdb();
      const existing = await idbGet(STORE_MAIN, 'main');
      if (existing && existing.bytes) {
        sqljsDb = new SQL.Database(new Uint8Array(existing.bytes));
      } else {
        sqljsDb = new SQL.Database();
      }
      db.exec(SCHEMA_SQL);
      runMigrations();
      await flushSave();
    })();
    return initPromise;
  }

  function listCards() {
    return db.prepare('SELECT * FROM cards ORDER BY added_at DESC').all();
  }

  function addCard(c) {
    const info = db.prepare(`
      INSERT INTO cards
        (game, external_id, name, set_name, set_code, number, rarity, image_url,
         cardmarket_url, quantity, condition, language, notes,
         price_at_add, price_current, price_low, price_trend, currency,
         purchase_price, purchase_date, status)
      VALUES
        (@game, @external_id, @name, @set_name, @set_code, @number, @rarity, @image_url,
         @cardmarket_url, @quantity, @condition, @language, @notes,
         @price, @price, @low, @trend, @currency,
         @purchase_price, @purchase_date, 'owned')
    `).run({
      game: c.game, external_id: c.externalId, name: c.name,
      set_name: c.setName ?? null, set_code: c.setCode ?? null, number: c.number ?? null,
      rarity: c.rarity ?? null, image_url: c.imageUrl ?? null, cardmarket_url: c.cardmarketUrl ?? null,
      quantity: c.quantity ?? 1, condition: c.condition ?? 'NM', language: c.language ?? 'DE',
      notes: c.notes ?? null,
      price: c.cardmarketPrice ?? null, low: c.priceLow ?? null, trend: c.priceTrend ?? null,
      currency: c.currency ?? 'EUR',
      purchase_price: c.purchasePrice ?? null, purchase_date: c.purchaseDate ?? null,
    });
    recordSnapshot();
    return db.prepare('SELECT * FROM cards WHERE id = ?').get(info.lastInsertRowid);
  }

  function updateCard(id, fields) {
    const allowed = ['quantity', 'condition', 'language', 'notes', 'price_current', 'price_low', 'price_trend',
      'purchase_price', 'purchase_date', 'status', 'sold_price', 'sold_date'];
    const sets = [], params = { id };
    for (const k of allowed) if (fields[k] !== undefined) { sets.push(`${k} = @${k}`); params[k] = fields[k]; }
    if (!sets.length) return db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
    sets.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE cards SET ${sets.join(', ')} WHERE id = @id`).run(params);
    recordSnapshot();
    return db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  }

  function deleteCard(id) {
    db.prepare('DELETE FROM card_price_history WHERE card_id = ?').run(id);
    const ok = db.prepare('DELETE FROM cards WHERE id = ?').run(id).changes > 0;
    if (ok) recordSnapshot();
    return ok;
  }

  function allForRefresh() {
    return db.prepare("SELECT id, game, external_id FROM cards WHERE status='owned'").all();
  }

  function listSold() {
    return db.prepare("SELECT * FROM cards WHERE status='sold' ORDER BY COALESCE(sold_date, updated_at) DESC").all();
  }
  function soldForRefresh() {
    return db.prepare("SELECT id, game, external_id FROM cards WHERE status='sold'").all();
  }
  function soldTotals() {
    const rows = db.prepare("SELECT quantity, purchase_price, sold_price, price_current, price_at_add, currency FROM cards WHERE status='sold'").all();
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

  function computeTotals() {
    const rows = db.prepare("SELECT quantity, price_current, price_at_add, price_low, price_trend, currency FROM cards WHERE status='owned'").all();
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

  function recordCardHistory() {
    const rows = db.prepare("SELECT id, price_current, price_at_add FROM cards WHERE status='owned'").all();
    const stmt = db.prepare(`INSERT INTO card_price_history (card_id, day, price) VALUES (?, date('now'), ?)
      ON CONFLICT(card_id, day) DO UPDATE SET price=excluded.price`);
    db.exec('BEGIN');
    try {
      for (const r of rows) { const p = r.price_current ?? r.price_at_add; if (p != null) stmt.run([r.id, p]); }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  function recordSnapshot() {
    const { total, low, trend } = computeTotals();
    db.prepare(`
      INSERT INTO value_history (day, total, total_low, total_trend, recorded_at)
      VALUES (date('now'), @total, @low, @trend, datetime('now'))
      ON CONFLICT(day) DO UPDATE SET total=@total, total_low=@low, total_trend=@trend, recorded_at=datetime('now')
    `).run({ total, low, trend });
    recordCardHistory();
  }

  function getHistory() {
    return db.prepare('SELECT day, total, total_low, total_trend FROM value_history ORDER BY day ASC').all();
  }
  function getCardHistory(cardId) {
    return db.prepare('SELECT day, price FROM card_price_history WHERE card_id = ? ORDER BY day ASC').all(cardId);
  }

  function computePortfolio() {
    const owned = db.prepare("SELECT quantity, price_current, price_at_add, currency, purchase_price FROM cards WHERE status='owned'").all();
    const sold = db.prepare("SELECT quantity, currency, purchase_price, sold_price FROM cards WHERE status='sold'").all();
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

  function getMovers(days, limit) {
    days = days || 30; limit = limit || 5;
    const owned = db.prepare("SELECT id, name, set_name, set_code, number, image_url, currency, price_current, price_at_add FROM cards WHERE status='owned'").all();
    const histStmt = db.prepare('SELECT day, price FROM card_price_history WHERE card_id = ? ORDER BY day');
    const d = new Date(); d.setDate(d.getDate() - days);
    const cutoff = d.toISOString().slice(0, 10);
    const movers = [];
    for (const c of owned) {
      const hist = histStmt.all(c.id);
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

  function getAnalysis() {
    const owned = db.prepare("SELECT name, set_name, rarity, condition, game, image_url, quantity, price_current, price_at_add, currency FROM cards WHERE status='owned'").all();
    const val = (r) => (r.price_current ?? r.price_at_add ?? 0) * r.quantity;
    const eurCards = owned.filter(r => (r.currency || 'EUR') !== 'USD');
    const usdCards = owned.filter(r => (r.currency || 'EUR') === 'USD');

    const group = (cards, keyFn) => {
      const m = new Map();
      for (const r of cards) { const k = keyFn(r) || '—'; m.set(k, (m.get(k) || 0) + val(r)); }
      return [...m.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
    };

    const byGame = group(eurCards, r => ({ pokemon: 'Pokémon', magic: 'Magic', yugioh: 'Yu-Gi-Oh' }[r.game] || r.game));
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
    return { byGame, byRarity, bySet, byCondition, topCards, stats, usdValue };
  }

  function listGraded() { return db.prepare("SELECT * FROM graded_cards WHERE status='owned' ORDER BY added_at DESC").all(); }
  function listGradedSold() { return db.prepare("SELECT * FROM graded_cards WHERE status='sold' ORDER BY COALESCE(sold_date, updated_at) DESC").all(); }
  function addGraded(c) {
    const info = db.prepare(`
      INSERT INTO graded_cards (external_id, name, set_name, number, image_url, company, grade, cert, value, currency,
        purchase_price, purchase_date, notes, status)
      VALUES (@external_id, @name, @set_name, @number, @image_url, @company, @grade, @cert, @value, @currency,
        @purchase_price, @purchase_date, @notes, 'owned')
    `).run({
      external_id: c.externalId ?? null, name: c.name, set_name: c.setName ?? null,
      number: c.number ?? null, image_url: c.imageUrl ?? null,
      company: (c.company || 'PSA').toUpperCase(), grade: String(c.grade ?? ''),
      cert: c.cert ?? null, value: c.value ?? null, currency: c.currency ?? 'USD',
      purchase_price: c.purchasePrice ?? null, purchase_date: c.purchaseDate ?? null, notes: c.notes ?? null,
    });
    return db.prepare('SELECT * FROM graded_cards WHERE id = ?').get(info.lastInsertRowid);
  }
  function updateGraded(id, fields) {
    const allowed = ['company', 'grade', 'cert', 'value', 'currency', 'notes',
      'purchase_price', 'purchase_date', 'status', 'sold_price', 'sold_date'];
    const sets = [], params = { id };
    for (const k of allowed) if (fields[k] !== undefined) { sets.push(`${k} = @${k}`); params[k] = fields[k]; }
    if (!sets.length) return db.prepare('SELECT * FROM graded_cards WHERE id = ?').get(id);
    sets.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE graded_cards SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return db.prepare('SELECT * FROM graded_cards WHERE id = ?').get(id);
  }
  function deleteGraded(id) { return db.prepare('DELETE FROM graded_cards WHERE id = ?').run(id).changes > 0; }

  async function backupDatabase() {
    try {
      await flushSave();
      const bytes = sqljsDb.export();
      const stamp = new Date().toISOString();
      await idbPut(STORE_BACKUPS, { bytes, createdAt: stamp });
      await pruneBackups();
      const list = await listBackups();
      return { file: stamp, kept: list.length };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }
  async function listBackups() {
    try {
      const all = await idbGetAll(STORE_BACKUPS);
      return all
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map((b) => ({ id: b.id, file: b.createdAt, size: b.bytes ? b.bytes.length : 0, mtime: b.createdAt }));
    } catch { return []; }
  }
  async function pruneBackups() {
    const all = await idbGetAll(STORE_BACKUPS);
    const sorted = all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    for (const b of sorted.slice(BACKUP_KEEP)) { try { await idbDelete(STORE_BACKUPS, b.id); } catch { /* egal */ } }
  }
  async function restoreBackup(id) {
    const rec = await idbGet(STORE_BACKUPS, Number(id));
    if (!rec || !rec.bytes) throw new Error('Sicherung nicht gefunden');
    sqljsDb.close();
    sqljsDb = new SQL.Database(new Uint8Array(rec.bytes));
    await flushSave();
  }

  function listWishlist() { return db.prepare('SELECT * FROM wishlist ORDER BY added_at DESC').all(); }
  function addWishlist(c) {
    const existing = db.prepare('SELECT id FROM wishlist WHERE game=? AND external_id=? AND language=?')
      .get([c.game, c.externalId, c.language ?? 'DE']);
    if (existing) return db.prepare('SELECT * FROM wishlist WHERE id = ?').get(existing.id);
    const info = db.prepare(`
      INSERT INTO wishlist
        (game, external_id, name, set_name, set_code, number, rarity, image_url, cardmarket_url,
         quantity, language, notes, price_current, price_low, price_trend, currency, target_price)
      VALUES
        (@game, @external_id, @name, @set_name, @set_code, @number, @rarity, @image_url, @cardmarket_url,
         @quantity, @language, @notes, @price, @low, @trend, @currency, @target_price)
    `).run({
      game: c.game, external_id: c.externalId, name: c.name,
      set_name: c.setName ?? null, set_code: c.setCode ?? null, number: c.number ?? null,
      rarity: c.rarity ?? null, image_url: c.imageUrl ?? null, cardmarket_url: c.cardmarketUrl ?? null,
      quantity: c.quantity ?? 1, language: c.language ?? 'DE', notes: c.notes ?? null,
      price: c.cardmarketPrice ?? null, low: c.priceLow ?? null, trend: c.priceTrend ?? null,
      currency: c.currency ?? 'EUR', target_price: c.targetPrice ?? null,
    });
    return db.prepare('SELECT * FROM wishlist WHERE id = ?').get(info.lastInsertRowid);
  }
  function updateWishlist(id, fields) {
    const allowed = ['quantity', 'language', 'notes', 'price_current', 'price_low', 'price_trend', 'target_price'];
    const sets = [], params = { id };
    for (const k of allowed) if (fields[k] !== undefined) { sets.push(`${k} = @${k}`); params[k] = fields[k]; }
    if (!sets.length) return db.prepare('SELECT * FROM wishlist WHERE id = ?').get(id);
    sets.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE wishlist SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return db.prepare('SELECT * FROM wishlist WHERE id = ?').get(id);
  }
  function deleteWishlist(id) { return db.prepare('DELETE FROM wishlist WHERE id = ?').run(id).changes > 0; }
  function wishlistForRefresh() { return db.prepare('SELECT id, game, external_id FROM wishlist').all(); }
  function wishlistTotals() {
    const rows = db.prepare('SELECT quantity, price_current, currency FROM wishlist').all();
    let eur = 0, usd = 0;
    for (const r of rows) {
      const v = (r.price_current ?? 0) * r.quantity;
      if ((r.currency || 'EUR') === 'USD') usd += v; else eur += v;
    }
    return { eur, usd, count: rows.length };
  }

  function listSealed() { return db.prepare("SELECT * FROM sealed WHERE status='owned' ORDER BY added_at DESC").all(); }
  function listSealedSold() { return db.prepare("SELECT * FROM sealed WHERE status='sold' ORDER BY COALESCE(sold_date, updated_at) DESC").all(); }
  function addSealed(c) {
    const info = db.prepare(`
      INSERT INTO sealed
        (game, set_name, set_code, product_type, name, image_url, cardmarket_url,
         quantity, purchase_price, purchase_date, current_value, currency, notes, status, sold_price, sold_date)
      VALUES
        (@game, @set_name, @set_code, @product_type, @name, @image_url, @cardmarket_url,
         @quantity, @purchase_price, @purchase_date, @current_value, @currency, @notes, @status, @sold_price, @sold_date)
    `).run({
      game: c.game, set_name: c.setName ?? null, set_code: c.setCode ?? null,
      product_type: c.productType || 'Booster', name: c.name,
      image_url: c.imageUrl ?? null, cardmarket_url: c.cardmarketUrl ?? null,
      quantity: c.quantity ?? 1, purchase_price: c.purchasePrice ?? null, purchase_date: c.purchaseDate ?? null,
      current_value: c.currentValue ?? null, currency: c.currency ?? 'EUR', notes: c.notes ?? null,
      status: c.status === 'sold' ? 'sold' : 'owned', sold_price: c.sold_price ?? null, sold_date: c.sold_date ?? null,
    });
    return db.prepare('SELECT * FROM sealed WHERE id = ?').get(info.lastInsertRowid);
  }
  function updateSealed(id, fields) {
    const allowed = ['set_name', 'product_type', 'name', 'quantity', 'purchase_price', 'purchase_date',
      'current_value', 'currency', 'notes', 'cardmarket_url', 'status', 'sold_price', 'sold_date'];
    const sets = [], params = { id };
    for (const k of allowed) if (fields[k] !== undefined) { sets.push(`${k} = @${k}`); params[k] = fields[k]; }
    if (!sets.length) return db.prepare('SELECT * FROM sealed WHERE id = ?').get(id);
    sets.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE sealed SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return db.prepare('SELECT * FROM sealed WHERE id = ?').get(id);
  }
  function deleteSealed(id) { return db.prepare('DELETE FROM sealed WHERE id = ?').run(id).changes > 0; }
  function sealedTotals() {
    const rows = db.prepare("SELECT quantity, purchase_price, current_value, currency FROM sealed WHERE status='owned'").all();
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

  const BACKUP_TABLES = ['cards', 'wishlist', 'sealed', 'graded_cards', 'value_history', 'card_price_history'];

  function exportAll() {
    const out = { app: 'tiny-tokyo-tracker', version: 2, exportedAt: new Date().toISOString() };
    for (const t of BACKUP_TABLES) {
      try { out[t] = db.prepare(`SELECT * FROM ${t}`).all(); } catch { out[t] = []; }
    }
    return out;
  }

  function restoreTable(table, rows) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    db.exec(`DELETE FROM ${table}`);
    if (!Array.isArray(rows) || !rows.length) return 0;
    const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`);
    let n = 0;
    for (const r of rows) {
      const p = {};
      for (const c of cols) p[c] = (r[c] === undefined ? null : r[c]);
      try { stmt.run(p); n++; } catch { /* eine kaputte Zeile überspringen */ }
    }
    return n;
  }

  async function importAll(data) {
    if (!data || typeof data !== 'object') throw new Error('Ungültige Backup-Datei');
    if (!BACKUP_TABLES.some((t) => Array.isArray(data[t]))) throw new Error('Keine bekannten Daten in der Datei');
    const counts = {};
    for (const t of BACKUP_TABLES) counts[t] = restoreTable(t, data[t] || []);
    await flushSave();
    return counts;
  }

  async function getSetting(key) {
    const rec = await idbGet(STORE_SETTINGS, key);
    return rec ? rec.value : null;
  }
  async function setSetting(key, value) {
    await idbPut(STORE_SETTINGS, { key, value });
  }

  self.DB = {
    init, flushSave, getSetting, setSetting,
    listCards, addCard, updateCard, deleteCard, allForRefresh,
    listSold, soldForRefresh, soldTotals,
    computeTotals, recordSnapshot, getHistory, getCardHistory,
    computePortfolio, getMovers, getAnalysis,
    listGraded, listGradedSold, addGraded, updateGraded, deleteGraded,
    backupDatabase, listBackups, restoreBackup,
    listWishlist, addWishlist, updateWishlist, deleteWishlist, wishlistForRefresh, wishlistTotals,
    listSealed, listSealedSold, addSealed, updateSealed, deleteSealed, sealedTotals,
    exportAll, importAll,
  };
})();
