// server-logic.js – "Routen"-Logik, portiert aus server.js. Laeuft im Hauptthread
// (index.html) und ersetzt Express: statt app.get(...)/app.post(...) gibt es eine
// kleine eigene Routenliste. self.DB und self.Adapters muessen vorher geladen sein.
// Seit der Supabase-Umstellung sind ALLE D.*-Aufrufe async (Netzwerk statt
// lokaler Datenbank) -- deshalb ueberall await.

(function () {
  'use strict';

  const D = self.DB;
  const A = self.Adapters;

  function ok(json, status) { return { status: status || 200, json }; }
  function bad(status, json) { return { status, json }; }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function numOrNull(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    let s = String(v).trim();
    if (!s) return null;
    // Deutsches Format "1.234,56": Punkt = Tausendertrennzeichen, Komma = Dezimaltrennzeichen.
    if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
    else if (s.includes(',')) s = s.replace(',', '.');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }

  // Gemeinsame Preis-Aktualisierung fuer Sammlung/Verkauft/Wunschliste: laeuft
  // Karte fuer Karte durch und bricht NICHT komplett ab, wenn eine einzelne
  // Preisabfrage fehlschlaegt (z. B. Netzwerk-Hänger oder Rate-Limit) --
  // stattdessen wird der Fehler gesammelt und der Rest normal weiter aktualisiert.
  // Patch fuer ein Preis-Update bauen. Wenn die Quelle eine Waehrung mitliefert
  // (z. B. USD-Ersatzpreis von TCGplayer, weil Cardmarket nichts hat), wird sie
  // zusammen mit dem Preis gespeichert, damit Preis und Waehrung zusammenpassen.
  function pricePatch(p) {
    const patch = { price_current: p.price, price_low: p.low, price_trend: p.trend };
    if (p.currency && p.price != null) patch.currency = p.currency;
    return patch;
  }

  async function refreshPrices(rows, applyUpdate) {
    let updated = 0;
    const errors = [];
    for (const r of rows) {
      try {
        const p = await A.fetchPrices(r.game, r.external_id);
        if (p.price !== null || p.low !== null || p.trend !== null) {
          await applyUpdate(r.id, p);
          updated++;
        }
      } catch (e) {
        errors.push({ id: r.id, name: r.name || r.external_id, error: String((e && e.message) || e) });
      }
      await new Promise((res) => setTimeout(res, 120));
    }
    return { updated, total: rows.length, errors };
  }

  const EXPORT_HEADERS = [
    'Spiel', 'Name', 'Set', 'Set-Code', 'Nummer', 'Seltenheit', 'Anzahl', 'Zustand', 'Sprache',
    'Preis 30T-Schnitt', 'Ab-Preis', 'Preistrend', 'Währung', 'Kaufpreis', 'Kaufdatum', 'Status', 'Verkaufspreis', 'Verkaufsdatum', 'Notiz', 'ExterneID', 'BildURL', 'CardmarketURL',
  ];

  // Wichtig: Bei Routen mit gleicher Segmentanzahl muss die spezifischere
  // (statische) Route VOR der Route mit Platzhalter (:id) registriert werden,
  // da der Router die Liste linear durchgeht und die erste Übereinstimmung nimmt.
  const routes = [];
  function route(method, pattern, fn) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, fn });
  }

  // --- Meta / Namen -------------------------------------------------------
  route('GET', '/api/meta', async () => ok({ languages: A.LANGUAGES, numberSearch: A.NUMBER_SEARCH }));
  route('GET', '/api/names/onepiece', async () => {
    try { return ok({ names: await A.onePieceNames() }); }
    catch (e) { console.error('onePieceNames fehlgeschlagen:', e); return ok({ names: [] }); }
  });

  // --- Suche ----------------------------------------------------------------
  route('GET', '/api/search', async ({ query }) => {
    const { game, q, lang, mode } = query;
    if (!game || !q) return bad(400, { error: 'game und q sind erforderlich' });
    if (!A.SUPPORTED_GAMES.includes(game)) return bad(400, { error: `Spiel "${game}" wird nicht unterstützt` });
    try {
      const results = await A.search(game, String(q), { lang: String(lang || ''), mode: mode === 'number' ? 'number' : 'name' });
      return ok({ results });
    } catch (e) {
      if (e.code === 'NO_KEY') return bad(400, { error: e.message });
      return bad(502, { error: 'Quell-API nicht erreichbar', detail: e.message });
    }
  });

  route('POST', '/api/enrich', async ({ body }) => {
    const { game, ids, lang } = body || {};
    if (game !== 'pokemon') return bad(400, { error: 'enrich derzeit nur für Pokémon' });
    if (!Array.isArray(ids) || !ids.length) return ok({ details: {} });
    try {
      const details = await A.enrichPokemon(ids, { lang: String(lang || '') });
      return ok({ details });
    } catch (e) { return bad(502, { error: 'Details konnten nicht geladen werden' }); }
  });

  // --- Sammlung ---------------------------------------------------------------
  route('GET', '/api/collection', async () => ok({ cards: await D.listCards() }));

  route('POST', '/api/collection', async ({ body }) => {
    const c = body;
    if (!c || !c.game || !c.externalId || !c.name) return bad(400, { error: 'game, externalId und name sind erforderlich' });
    return ok({ card: await D.addCard(c) }, 201);
  });

  route('PATCH', '/api/collection/:id', async ({ params, body }) => {
    const card = await D.updateCard(Number(params.id), body || {});
    if (!card) return bad(404, { error: 'Nicht gefunden' });
    return ok({ card });
  });

  route('DELETE', '/api/collection/:id', async ({ params }) => {
    const okDel = await D.deleteCard(Number(params.id));
    return { status: okDel ? 204 : 404, json: null };
  });

  route('POST', '/api/collection/refresh-prices', async () => {
    const rows = await D.allForRefresh();
    const result = await refreshPrices(rows, (id, p) => D.updateCard(id, pricePatch(p)));
    await D.recordSnapshot();
    return ok(result);
  });

  route('GET', '/api/collection/history', async () => ok({ history: await D.getHistory(), totals: await D.computeTotals() }));

  route('GET', '/api/portfolio', async () => ok({ portfolio: await D.computePortfolio(), analysis: await D.getAnalysis() }));

  route('GET', '/api/collection/movers', async ({ query }) => {
    const days = Math.max(1, parseInt(query.days) || 30);
    return ok({ days, ...(await D.getMovers(days, 6)) });
  });

  // --- Verkaufte Karten -------------------------------------------------------
  route('GET', '/api/sold', async () => {
    const items = [];
    for (const c of await D.listSold()) items.push({
      source: 'card', id: c.id, name: c.name, image_url: c.image_url, cardmarket_url: c.cardmarket_url,
      currency: c.currency || 'EUR', quantity: c.quantity,
      purchase_price: c.purchase_price, sold_price: c.sold_price, sold_date: c.sold_date,
      current_value: c.price_current ?? c.price_at_add ?? null,
      game: c.game, set_name: c.set_name, set_code: c.set_code, number: c.number, language: c.language,
    });
    for (const s of await D.listSealedSold()) items.push({
      source: 'sealed', id: s.id, name: s.name, image_url: s.image_url, cardmarket_url: s.cardmarket_url,
      currency: s.currency || 'EUR', quantity: s.quantity,
      purchase_price: s.purchase_price, sold_price: s.sold_price, sold_date: s.sold_date,
      current_value: s.current_value,
      game: s.game, set_name: s.set_name, product_type: s.product_type,
    });
    for (const g of await D.listGradedSold()) items.push({
      source: 'graded', id: g.id, name: g.name, image_url: g.image_url, cardmarket_url: null,
      currency: g.currency || 'USD', quantity: 1,
      purchase_price: g.purchase_price, sold_price: g.sold_price, sold_date: g.sold_date,
      current_value: g.value,
      set_name: g.set_name, number: g.number, company: g.company, grade: g.grade,
    });
    items.sort((a, b) => String(b.sold_date || '').localeCompare(String(a.sold_date || '')));

    const acc = () => ({ realized: 0, proceeds: 0, current: 0, invested: 0, count: 0, qty: 0 });
    const totals = { eur: acc(), usd: acc() };
    for (const it of items) {
      const b = it.currency === 'USD' ? totals.usd : totals.eur;
      const q = it.quantity || 1;
      b.count += 1; b.qty += q;
      if (it.sold_price != null) b.proceeds += it.sold_price * q;
      if (it.sold_price != null && it.purchase_price != null) b.realized += (it.sold_price - it.purchase_price) * q;
      if (it.purchase_price != null) b.invested += it.purchase_price * q;
      if (it.current_value != null) b.current += it.current_value * q;
    }
    return ok({ items, totals });
  });

  route('POST', '/api/sold/refresh-prices', async () => {
    const rows = await D.soldForRefresh();
    const result = await refreshPrices(rows, (id, p) => D.updateCard(id, pricePatch(p)));
    return ok(result);
  });

  // --- Datensicherung ---------------------------------------------------------
  route('POST', '/api/backup', async () => ok(await D.backupDatabase()));
  route('GET', '/api/backups', async () => ok({ backups: await D.listBackups() }));

  route('GET', '/api/data/export', async () => ({
    status: 200, json: await D.exportAll(),
    headers: { 'Content-Disposition': `attachment; filename="tiny-tokyo-backup-${new Date().toISOString().slice(0, 10)}.json"` },
  }));
  route('POST', '/api/data/import', async ({ body }) => {
    try {
      const counts = await D.importAll(body && body.data);
      return ok({ ok: true, counts });
    } catch (e) { return bad(400, { ok: false, error: String((e && e.message) || e) }); }
  });

  route('GET', '/api/collection/:id/history', async ({ params }) => ok({ history: await D.getCardHistory(Number(params.id)) }));

  // --- Wunschliste ------------------------------------------------------------
  route('GET', '/api/wishlist', async () => ok({ items: await D.listWishlist(), totals: await D.wishlistTotals() }));
  route('POST', '/api/wishlist', async ({ body }) => {
    const c = body || {};
    if (!c.game || !c.externalId || !c.name) return bad(400, { error: 'game, externalId, name nötig' });
    return ok(await D.addWishlist(c));
  });
  route('PATCH', '/api/wishlist/:id', async ({ params, body }) => ok(await D.updateWishlist(Number(params.id), body || {})));
  route('DELETE', '/api/wishlist/:id', async ({ params }) => ok({ ok: await D.deleteWishlist(Number(params.id)) }));

  route('POST', '/api/wishlist/refresh-prices', async () => {
    const rows = await D.wishlistForRefresh();
    const result = await refreshPrices(rows, (id, p) => D.updateWishlist(id, pricePatch(p)));
    return ok(result);
  });

  route('POST', '/api/wishlist/:id/to-collection', async ({ params }) => {
    const list = await D.listWishlist();
    const item = list.find((w) => w.id === Number(params.id));
    if (!item) return bad(404, { error: 'nicht gefunden' });
    const card = await D.addCard({
      game: item.game, externalId: item.external_id, name: item.name,
      setName: item.set_name, setCode: item.set_code, number: item.number, rarity: item.rarity,
      imageUrl: item.image_url, cardmarketUrl: item.cardmarket_url,
      quantity: item.quantity || 1, condition: 'NM', language: item.language || 'DE',
      cardmarketPrice: item.price_current, priceLow: item.price_low, priceTrend: item.price_trend,
      currency: item.currency || 'EUR',
    });
    try {
      await D.deleteWishlist(item.id);
    } catch (e) {
      // Karte ist schon in der Sammlung, konnte aber nicht von der Wunschliste
      // entfernt werden -- neu angelegte Karte zurueckrollen, damit sie nicht doppelt ist.
      try { await D.deleteCard(card.id); } catch {}
      return bad(502, { error: 'Konnte nicht von der Wunschliste entfernt werden. Bitte erneut versuchen.' });
    }
    return ok({ ok: true, card });
  });

  // --- Set-Suche ----------------------------------------------------------------
  route('GET', '/api/sets', async ({ query }) => {
    const game = String(query.game || 'pokemon');
    if (!A.SUPPORTED_GAMES.includes(game)) return bad(400, { error: 'Spiel unbekannt' });
    try { return ok({ sets: await A.searchSets(game, String(query.q || '')) }); }
    catch (e) { return bad(500, { error: String((e && e.message) || e), sets: [] }); }
  });

  // --- Versiegelte Ware ---------------------------------------------------------
  route('GET', '/api/sealed', async () => ok({ items: await D.listSealed(), totals: await D.sealedTotals() }));
  route('POST', '/api/sealed', async ({ body }) => {
    const c = body || {};
    if (!c.game || !c.name || !c.productType) return bad(400, { error: 'game, name, productType nötig' });
    return ok(await D.addSealed(c));
  });
  route('PATCH', '/api/sealed/:id', async ({ params, body }) => ok(await D.updateSealed(Number(params.id), body || {})));
  route('DELETE', '/api/sealed/:id', async ({ params }) => ok({ ok: await D.deleteSealed(Number(params.id)) }));

  route('POST', '/api/collection/snapshot', async () => { await D.recordSnapshot(); return ok({ totals: await D.computeTotals() }); });

  route('GET', '/api/collection/history/export', async () => {
    const hist = await D.getHistory();
    const rows = hist.map((h) => ({
      'Datum': h.day, 'Wert 30T-Schnitt': h.total, 'Ab-Wert': h.total_low, 'Preistrend': h.total_trend,
    }));
    const ws = XLSX.utils.json_to_sheet(rows, { header: ['Datum', 'Wert 30T-Schnitt', 'Ab-Wert', 'Preistrend'] });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Wertverlauf');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    return {
      status: 200, buffer: buf, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      headers: { 'Content-Disposition': 'attachment; filename="tcg-wertverlauf.xlsx"' },
    };
  });

  // --- Gegradete Karten -----------------------------------------------------
  route('GET', '/api/graded/search', async ({ query }) => {
    const q = query.q;
    if (!q) return bad(400, { error: 'q ist erforderlich' });
    try { return ok({ results: await A.searchGraded(String(q)) }); }
    catch (e) {
      if (e.code === 'NO_KEY') return bad(400, { error: e.message });
      return bad(502, { error: 'Graded-Quelle nicht erreichbar', detail: e.message });
    }
  });
  route('GET', '/api/graded', async () => ok({ cards: await D.listGraded() }));
  route('POST', '/api/graded', async ({ body }) => {
    const c = body;
    if (!c || !c.name || !c.company || c.grade == null) return bad(400, { error: 'name, company und grade sind erforderlich' });
    return ok({ card: await D.addGraded(c) }, 201);
  });
  route('PATCH', '/api/graded/:id', async ({ params, body }) => {
    const card = await D.updateGraded(Number(params.id), body);
    if (!card) return bad(404, { error: 'Nicht gefunden' });
    return ok({ card });
  });
  route('DELETE', '/api/graded/:id', async ({ params }) => ({ status: (await D.deleteGraded(Number(params.id))) ? 204 : 404, json: null }));

  // --- Excel-Export/-Import ------------------------------------------------------
  route('GET', '/api/collection/export', async () => {
    const cards = await D.listCards();
    const rows = cards.map((c) => ({
      'Spiel': c.game, 'Name': c.name, 'Set': c.set_name, 'Set-Code': c.set_code, 'Nummer': c.number,
      'Seltenheit': c.rarity, 'Anzahl': c.quantity, 'Zustand': c.condition, 'Sprache': c.language,
      'Preis 30T-Schnitt': c.price_current ?? c.price_at_add, 'Ab-Preis': c.price_low, 'Preistrend': c.price_trend,
      'Währung': c.currency || 'EUR',
      'Kaufpreis': c.purchase_price, 'Kaufdatum': c.purchase_date, 'Status': c.status || 'owned',
      'Verkaufspreis': c.sold_price, 'Verkaufsdatum': c.sold_date,
      'Notiz': c.notes, 'ExterneID': c.external_id, 'BildURL': c.image_url, 'CardmarketURL': c.cardmarket_url,
    }));
    const ws = XLSX.utils.json_to_sheet(rows, { header: EXPORT_HEADERS });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sammlung');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    return {
      status: 200, buffer: buf, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      headers: { 'Content-Disposition': 'attachment; filename="tcg-sammlung.xlsx"' },
    };
  });

  route('POST', '/api/collection/import', async ({ body }) => {
    try {
      const b64 = ((body && body.data) || '').split(',').pop();
      const bytes = b64ToBytes(b64);
      const wb = XLSX.read(bytes, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
      let added = 0, skipped = 0;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const game = String(r['Spiel'] || '').toLowerCase().trim();
        const name = r['Name'];
        if (!A.SUPPORTED_GAMES.includes(game) || !name) { skipped++; continue; }
        const price = numOrNull(r['Preis 30T-Schnitt']);
        await D.addCard({
          game, name: String(name),
          externalId: r['ExterneID'] ? String(r['ExterneID']) : `import-${(self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID() : (Date.now() + '-' + i)}`,
          setName: r['Set'] ?? null, setCode: r['Set-Code'] ?? null,
          number: r['Nummer'] != null ? String(r['Nummer']) : null,
          rarity: r['Seltenheit'] ?? null,
          imageUrl: r['BildURL'] ?? null, cardmarketUrl: r['CardmarketURL'] ?? null,
          quantity: Math.max(1, parseInt(r['Anzahl']) || 1),
          condition: r['Zustand'] ?? 'NM', language: r['Sprache'] ?? 'DE', notes: r['Notiz'] ?? null,
          cardmarketPrice: price, priceLow: numOrNull(r['Ab-Preis']), priceTrend: numOrNull(r['Preistrend']),
          currency: (String(r['Währung'] || 'EUR').toUpperCase() === 'USD') ? 'USD' : 'EUR',
          purchasePrice: numOrNull(r['Kaufpreis']), purchaseDate: r['Kaufdatum'] ? String(r['Kaufdatum']) : null,
        });
        added++;
      }
      return ok({ added, skipped });
    } catch (e) {
      return bad(400, { error: 'Datei konnte nicht gelesen werden. Bitte eine .xlsx im Export-Format verwenden.' });
    }
  });

  // --- Einstellungen (z. B. PokemonPriceTracker-Key fuers Graded-Modul) --------
  // Allowlist statt beliebiger Keys: verhindert, dass ueber diese generische Route
  // versehentlich andere/zukuenftige Settings ausgelesen werden koennten.
  const SETTINGS_ALLOWLIST = ['pokepriceApiKey', 'displayName', 'contact', 'country'];
  route('GET', '/api/settings/:key', async ({ params }) => {
    if (!SETTINGS_ALLOWLIST.includes(params.key)) return bad(404, { error: 'Unbekannter Einstellungs-Schlüssel' });
    return ok({ value: await D.getSetting(params.key) });
  });
  route('POST', '/api/settings/:key', async ({ params, body }) => {
    if (!SETTINGS_ALLOWLIST.includes(params.key)) return bad(404, { error: 'Unbekannter Einstellungs-Schlüssel' });
    await D.setSetting(params.key, (body && body.value) != null ? body.value : null);
    return ok({ ok: true });
  });

  // --- Community-Marktplatz ---------------------------------------------------
  route('GET', '/api/market', async () => {
    try { return ok({ items: await D.listMarket() }); }
    catch (e) {
      // Sicht existiert noch nicht -> verstaendliche Meldung statt 500
      return bad(503, { error: 'Community noch nicht eingerichtet. Bitte supabase-community.sql im Supabase-SQL-Editor ausführen.', detail: String((e && e.message) || e) });
    }
  });

  // --- Nachrichten / Rangliste --------------------------------------------------
  const SQL2_HINT = 'Bitte zuerst supabase-community-2.sql im Supabase-SQL-Editor ausführen.';
  route('GET', '/api/messages/unread', async () => {
    try { return ok({ count: await D.unreadMessages() }); } catch { return ok({ count: 0 }); }
  });
  route('POST', '/api/messages/read', async ({ body }) => {
    const ids = ((body && body.ids) || []).map(Number).filter(Number.isFinite);
    try { return ok({ ok: true, n: await D.markMessagesRead(ids) }); }
    catch (e) { return bad(502, { error: String((e && e.message) || e) }); }
  });
  route('GET', '/api/messages', async () => {
    try { return ok({ items: await D.listMessages() }); }
    catch (e) { return bad(503, { error: 'Postfach noch nicht eingerichtet. ' + SQL2_HINT, detail: String((e && e.message) || e) }); }
  });
  route('POST', '/api/messages', async ({ body }) => {
    const b = body || {};
    const text = String(b.body || '').trim();
    if (!b.toUser || !text) return bad(400, { error: 'Empfänger und Nachrichtentext sind nötig' });
    if (text.length > 2000) return bad(400, { error: 'Nachricht zu lang (max. 2000 Zeichen)' });
    try { await D.sendMessage(String(b.toUser), b.cardName != null ? String(b.cardName) : null, text); return ok({ ok: true }, 201); }
    catch (e) {
      const msg = String((e && e.message) || e);
      return bad(502, { error: /relation|schema|messages/i.test(msg) ? ('Postfach noch nicht eingerichtet. ' + SQL2_HINT) : msg });
    }
  });
  route('DELETE', '/api/messages/:id', async ({ params }) => {
    try { return ok({ ok: await D.deleteMessage(Number(params.id)) }); }
    catch (e) { return bad(502, { error: String((e && e.message) || e) }); }
  });
  route('GET', '/api/leaderboard', async () => {
    try { return ok({ rows: await D.leaderboard() }); }
    catch (e) { return bad(503, { error: 'Rangliste noch nicht eingerichtet. ' + SQL2_HINT }); }
  });

  // --- Dispatcher -------------------------------------------------------------
  async function handle(request) {
    const url = new URL(request.url);
    const method = request.method;
    // Wenn die App nicht an der Domain-Wurzel liegt (z. B. GitHub Pages unter
    // "/reponame/"), enthaelt der Pfad einen Praefix. Wir matchen deshalb ab
    // dem ersten "/api/" -> funktioniert unabhaengig vom Hosting-Unterordner.
    const apiIdx = url.pathname.indexOf('/api/');
    if (apiIdx === -1) return null;
    const apiPath = url.pathname.slice(apiIdx);
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(apiPath);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const query = {};
      url.searchParams.forEach((v, k) => { query[k] = v; });
      let body = null;
      if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
        try { body = await request.json(); } catch { body = null; }
      }
      try { return await r.fn({ params, query, body }); }
      catch (e) { return { status: 500, json: { error: String((e && e.message) || e) } }; }
    }
    return null;
  }

  self.ServerLogic = { handle };
})();
