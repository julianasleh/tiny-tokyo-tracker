// adapters-browser.js – Quell-APIs für die Kartenspiele, portiert für den Browser
// (läuft im Service Worker). Fast identisch zu adapters.js – der einzige echte
// Unterschied: der optionale PokemonPriceTracker-Key kommt jetzt aus der lokalen
// Datenbank (Einstellungen) statt aus einer .env-Datei, weil es keinen Server mehr gibt.
//
// WICHTIG (ehrlich kommunizieren): Diese Aufrufe laufen jetzt direkt aus dem Browser.
// Das funktioniert nur, wenn die jeweilige API "CORS" für Browser-Zugriffe erlaubt.
// TCGdex, Scryfall, YGOPRODeck und optcgapi.com sind dafür ausgelegt (getestet).

(function () {
  'use strict';

  const TIMEOUT_MS = 9000;
  const SAFETY_MAX = 500;
  const POKEMON_MAX = 400;
  const POKEMON_CONCURRENCY = 12;

  const LANGUAGES = {
    pokemon: [
      ['de', 'Deutsch'], ['en', 'English'], ['fr', 'Français'], ['es', 'Español'], ['it', 'Italiano'],
      ['pt', 'Português'], ['pt-br', 'Português (BR)'], ['pt-pt', 'Português (PT)'], ['nl', 'Nederlands'],
      ['pl', 'Polski'], ['ru', 'Русский'], ['ja', '日本語'], ['ko', '한국어'],
      ['zh-tw', '中文 (繁體)'], ['zh-cn', '中文 (简体)'], ['id', 'Bahasa Indonesia'], ['th', 'ไทย'],
    ],
    magic: [
      ['de', 'Deutsch'], ['en', 'English'], ['fr', 'Français'], ['es', 'Español'], ['it', 'Italiano'],
      ['pt', 'Português'], ['ja', '日本語'], ['ko', '한국어'], ['ru', 'Русский'], ['zhs', '中文 (简体)'], ['zht', '中文 (繁體)'],
    ],
    yugioh: [['de', 'Deutsch'], ['en', 'English'], ['fr', 'Français'], ['it', 'Italiano'], ['pt', 'Português']],
    onepiece: [['en', 'English']],
  };

  function langFor(game, lang) {
    const list = LANGUAGES[game] || [['en', 'English']];
    return list.some(([c]) => c === lang) ? lang : list[0][0];
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  async function get(url, headers) {
    headers = headers || {};
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: Object.assign({ Accept: 'application/json' }, headers),
      });
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      return await res.json();
    } finally { clearTimeout(t); }
  }

  function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
  // Preis > 0 oder null -- "0.00" bedeutet bei den Quellen "kein Preis erfasst".
  function posOrNull(v) { const n = num(v); return n != null && n > 0 ? n : null; }

  function cmSearchUrl(game, name) {
    const path = { pokemon: 'Pokemon', yugioh: 'YuGiOh', onepiece: 'One-Piece' }[game] || 'Pokemon';
    return `https://www.cardmarket.com/de/${path}/Products/Search?searchString=${encodeURIComponent(name)}`;
  }

  function parseNumberQuery(q) {
    const raw = q.trim();
    const m = raw.match(/(\d+)/);
    const rawDigits = m ? m[1] : null;
    const number = m ? String(parseInt(m[1], 10)) : null;
    const letters = (raw.match(/[A-Za-z]{2,}/) || [])[0] || null;
    return { number, rawDigits, setHint: letters, raw };
  }

  // --- Pokémon: Set-Codes -> TCGdex-Set-ID -----------------------------------
  const pokeSetsCache = {};
  const POKE_SETS_TTL = 12 * 60 * 60 * 1000;
  const normCode = (x) => String(x).toUpperCase().replace(/\s+/g, '');

  function indexSet(byCode, s) {
    if (!s || !s.id) return;
    const add = (code) => { if (code) { const k = normCode(code); if (k && !byCode.has(k)) byCode.set(k, s.id); } };
    add(s.tcgOnline);
    const ab = s.abbreviations;
    if (ab && typeof ab === 'object') for (const v of Object.values(ab)) add(v);
    add(s.id);
  }

  async function loadPokeSets(locale) {
    const c = pokeSetsCache[locale];
    if (c && (Date.now() - c.ts) < POKE_SETS_TTL) return c;
    const sets = await get(`https://api.tcgdex.net/v2/${locale}/sets`).catch(() => []);
    const list = Array.isArray(sets) ? sets : [];
    const byCode = new Map();
    for (const s of list) indexSet(byCode, s);
    const entry = { ts: Date.now(), byCode, list, ids: list.map((s) => s && s.id).filter(Boolean), deep: false };
    pokeSetsCache[locale] = entry;
    return entry;
  }

  async function deepLoadPokeSets(locale, entry) {
    if (entry.deep) return entry;
    entry.deep = true;
    await mapLimit(entry.ids, POKEMON_CONCURRENCY, async (id) => {
      const s = await get(`https://api.tcgdex.net/v2/${locale}/sets/${encodeURIComponent(id)}`).catch(() => null);
      if (s) indexSet(entry.byCode, s);
    });
    return entry;
  }

  async function resolvePokeSetId(hint, locale) {
    if (!hint) return null;
    const key = normCode(hint);
    let entry = await loadPokeSets(locale);
    if (entry.byCode.has(key)) return entry.byCode.get(key);
    entry = await deepLoadPokeSets(locale, entry);
    return entry.byCode.get(key) || null;
  }

  // --- Pokémon: mehrsprachige Namensauflösung -------------------------------
  // Die TCGdex-Datenbanken sind pro Sprache getrennt und kennen nur die Namen
  // ihrer eigenen Sprache ("Pikachu" findet in der japanischen DB nichts,
  // "ピカチュウ" in der englischen nichts). Über pokemon-i18n.json wird der
  // Suchbegriff deshalb übersetzt, damit jede Datenbank mit dem passenden
  // Namen abgefragt werden kann.
  let pokeI18n = null;
  async function loadPokeI18n() {
    if (pokeI18n) return pokeI18n;
    try { pokeI18n = await (await fetch('pokemon-i18n.json')).json(); }
    catch { pokeI18n = { langs: [], rows: [] }; }
    if (!pokeI18n || !Array.isArray(pokeI18n.langs) || !Array.isArray(pokeI18n.rows)) pokeI18n = { langs: [], rows: [] };
    return pokeI18n;
  }
  // Erkennt das Pokémon im Suchbegriff und liefert pro Sprache passende
  // Suchbegriffe. Wichtig: Zusätze bleiben erhalten -- "ピカチュウex" wird zu
  // "Pikachu ex" übersetzt (und NICHT zu einem nackten "Pikachu", das alle
  // Pikachu-Karten fluten würde). Modi:
  //   exact    -- Eingabe ist genau ein Pokémon-Name -> Name pro Sprache
  //   suffix   -- Eingabe enthält einen Pokémon-Namen + Zusatz -> Zusatz mitnehmen
  //   partial  -- Eingabe ist ein Namensanfang/-teil -> voller Name pro Sprache
  async function pokeQueryPlan(q) {
    const data = await loadPokeI18n();
    const raw = String(q || '').trim();
    const t = raw.toLowerCase();
    if (!t || !data.rows.length) return null;
    let best = null; // { row, name, mode }
    for (const row of data.rows) {
      for (const n of row) {
        if (!n) continue;
        const ln = n.toLowerCase();
        if (ln === t) { best = { row, name: n, mode: 'exact' }; break; }
        if (t.includes(ln)) {
          if (!best || best.mode === 'partial' || (best.mode === 'suffix' && n.length > best.name.length)) best = { row, name: n, mode: 'suffix' };
        } else if (ln.includes(t)) {
          if (!best) best = { row, name: n, mode: 'partial' };
        }
      }
      if (best && best.mode === 'exact') break;
    }
    if (!best) return null;
    const idx = {};
    data.langs.forEach((lg, i) => { idx[lg] = i; });
    const nameFor = (lg) => { const i = idx[lg]; return i == null ? null : (best.row[i] || null); };
    if (best.mode === 'suffix') {
      const pos = t.indexOf(best.name.toLowerCase());
      const before = raw.slice(0, pos), after = raw.slice(pos + best.name.length);
      return { mode: 'suffix', terms(lg) {
        const n = nameFor(lg); if (!n) return [];
        const t1 = (before + n + after).trim();
        const t2 = ((before ? before.trim() + ' ' : '') + n + (after ? ' ' + after.trim() : '')).trim();
        // Variante ohne Leerzeichen: japanische/chinesische Namen kleben den
        // Zusatz direkt an ("ピカチュウex"), westliche trennen ihn ("Pikachu ex").
        const t3 = (before.trim() + n + after.trim()).trim();
        return [...new Set([t1, t2, t3])];
      } };
    }
    return { mode: best.mode, terms(lg) { const n = nameFor(lg); return n ? [n] : []; } };
  }
  // Erkennt japanische/chinesische/koreanische Schriftzeichen im Suchbegriff.
  const hasCJK = (s) => /[぀-ヿ㐀-䶿一-鿿가-힯ｦ-ﾟ]/.test(String(s || ''));

  function localIdMatches(lid, number, forms) {
    const s = String(lid);
    return forms.includes(s) || String(parseInt(s, 10)) === number;
  }

  function pokeSetCode(id, localId) {
    if (!id) return null;
    const suffix = '-' + String(localId);
    const setId = localId != null && id.endsWith(suffix) ? id.slice(0, -suffix.length) : id.split('-')[0];
    return setId ? setId.toUpperCase() : null;
  }

  async function searchPokemon(q, opts) {
    const lang = (opts && opts.lang) || 'de', mode = (opts && opts.mode) || 'name';
    const locale = langFor('pokemon', lang);
    let briefs = [], setHint = null;
    if (mode === 'number') {
      // Set-Kürzel auch mit Ziffern erlauben (z. B. "SV8a 236", "OBF 125"):
      // erstes Wort mit Buchstaben = Set-Hinweis, letzte Zahlengruppe = Nummer.
      const raw = q.trim();
      const tokens = raw.split(/\s+/).filter(Boolean);
      let h = null, numPart = raw;
      if (tokens.length >= 2 && /[A-Za-z]/.test(tokens[0])) { h = tokens[0]; numPart = tokens.slice(1).join(' '); }
      if (!h) h = parseNumberQuery(raw).setHint;
      const m = numPart.match(/(\d+)(?!.*\d)/);
      const rawDigits = m ? m[1] : null;
      const number = m ? String(parseInt(m[1], 10)) : null;
      setHint = h;
      if (!number) return [];
      const forms = [...new Set([number, rawDigits].filter(Boolean))];
      // Set-Hinweis in mehreren Sprach-Datenbanken auflösen (gewählte Sprache,
      // dann Englisch, Japanisch, Trad. Chinesisch) -- asiatische Sets wie
      // "SV8a" oder "SV-P" existieren nur in ihrer eigenen Datenbank.
      const locs = [...new Set([locale, 'en', 'ja', 'zh-tw'])];
      let resolved = null;
      if (h) {
        for (const loc of locs) {
          const sid = await resolvePokeSetId(h, loc).catch(() => null);
          if (sid) { resolved = { sid, loc }; break; }
        }
      }
      if (resolved) {
        const set = await get(`https://api.tcgdex.net/v2/${resolved.loc}/sets/${encodeURIComponent(resolved.sid)}`).catch(() => null);
        const setCards = set && Array.isArray(set.cards) ? set.cards : [];
        briefs = setCards.filter((b) => localIdMatches(b.localId, number, forms));
        for (const b of briefs) b._loc = resolved.loc;
        setHint = null;
      } else {
        const seen = new Set();
        for (const loc of locs) {
          const arrays = await Promise.all(
            forms.map((f) => get(`https://api.tcgdex.net/v2/${loc}/cards?localId=eq:${encodeURIComponent(f)}`).catch(() => []))
          );
          for (const arr of arrays) for (const b of (Array.isArray(arr) ? arr : [])) {
            if (b && !seen.has(b.id)) { seen.add(b.id); b._loc = loc; briefs.push(b); }
          }
        }
      }
    } else {
      // Pro Sprach-Datenbank mit dem passenden Namen suchen: Japanisch und
      // Chinesisch werden immer mit abgefragt (übersetzt über die Namenstabelle),
      // Zusätze wie "ex"/"VMAX" bleiben dabei erhalten.
      const plan = await pokeQueryPlan(q).catch(() => null);
      const cjk = hasCJK(q);
      const queries = new Map(); // locale -> Set von Suchbegriffen
      const addQ = (loc, term) => {
        if (!loc || !term) return;
        if (!queries.has(loc)) queries.set(loc, new Set());
        queries.get(loc).add(term);
      };
      // Roh-Eingabe in die Datenbanken, deren Schrift dazu passt
      if (!cjk) { addQ(locale, q); addQ('en', q); }
      else { addQ('ja', q); addQ('zh-tw', q); if (locale === 'ja' || locale === 'zh-tw' || locale === 'zh-cn') addQ(locale, q); }
      // Übersetzte Begriffe (inkl. Zusätzen) für alle relevanten Sprachen
      if (plan) {
        for (const loc of new Set([locale, 'en', 'ja', 'zh-tw', 'zh-cn'])) {
          for (const term of plan.terms(loc)) addQ(loc, term);
        }
      }
      const pairs = [];
      for (const [loc, terms] of queries) for (const term of terms) pairs.push([loc, term]);
      const arrays = await Promise.all(
        pairs.map(([loc, term]) => get(`https://api.tcgdex.net/v2/${loc}/cards?name=${encodeURIComponent(term)}`).catch(() => []))
      );
      const seen = new Set();
      arrays.forEach((arr, i) => {
        const loc = pairs[i][0];
        for (const b of (Array.isArray(arr) ? arr : [])) {
          if (b && !seen.has(b.id)) { seen.add(b.id); b._loc = loc; briefs.push(b); }
        }
      });
    }
    let cards = briefs.slice(0, POKEMON_MAX).map((b) => ({
      game: 'pokemon', externalId: b.id, name: b.name, lang: b._loc || locale,
      setName: null, setCode: pokeSetCode(b.id, b.localId),
      number: b.localId != null ? String(b.localId) : null,
      rarity: null, imageUrl: b.image ? `${b.image}/low.webp` : null,
      cardmarketPrice: null, priceLow: null, priceTrend: null, currency: 'EUR',
      cardmarketUrl: cmSearchUrl('pokemon', b.name),
      extra: {}, needsDetail: true,
    }));
    if (setHint) {
      const h = setHint.toLowerCase();
      const f = cards.filter((c) => c.setCode && c.setCode.toLowerCase().includes(h));
      if (f.length) cards = f;
    }
    return cards;
  }

  // Preis aus einem TCGdex-Kartendetail ziehen. Reihenfolge:
  // 1) Cardmarket-Durchschnitt -- auch die Holo-Felder ("avg30-holo" usw.),
  //    denn viele Karten haben NUR diese gefüllt.
  // 2) Falls Cardmarket gar nichts hat: TCGplayer-Marktpreis in USD
  //    (die Währung wird mitgeliefert und in der App pro Karte gespeichert).
  const TP_VARIANTS = ['holofoil', 'normal', 'reverseHolofoil', '1stEditionHolofoil', '1stEditionNormal', 'unlimitedHolofoil', 'unlimited'];
  function pokePricing(c) {
    const cm = (c && c.pricing && c.pricing.cardmarket) || null;
    const pick = (...vals) => { for (const v of vals) { const n = posOrNull(v); if (n != null) return n; } return null; };
    let price = cm ? pick(cm['avg30'], cm['avg30-holo'], cm.trend, cm['trend-holo'], cm.avg, cm['avg-holo']) : null;
    let low = cm ? pick(cm.low, cm['low-holo']) : null;
    let trend = cm ? pick(cm.trend, cm['trend-holo']) : null;
    let currency = 'EUR';
    if (price == null) {
      const tp = (c && c.pricing && c.pricing.tcgplayer) || null;
      if (tp && typeof tp === 'object') {
        const keys = [...new Set([...TP_VARIANTS, ...Object.keys(tp)])];
        for (const k of keys) {
          const v = tp[k];
          if (!v || typeof v !== 'object') continue;
          const p = pick(v.marketPrice, v.midPrice, v.directLowPrice);
          if (p != null) { price = p; low = pick(v.lowPrice); trend = null; currency = 'USD'; break; }
        }
      }
    }
    return { price, low, trend, currency };
  }

  // Kartendetail laden -- mit Sprach-Fallback: Karten aus rein englischen oder
  // japanischen Sets existieren in der de-Datenbank nicht (404). Deshalb wird
  // nacheinander die gewünschte Sprache, dann Englisch, dann Japanisch probiert.
  async function getPokeCard(id, locale) {
    const locs = [...new Set([locale, 'en', 'ja', 'zh-tw', 'zh-cn'])];
    for (const loc of locs) {
      try { return await get(`https://api.tcgdex.net/v2/${loc}/cards/${encodeURIComponent(id)}`); } catch {}
    }
    return null;
  }

  async function enrichPokemon(ids, opts) {
    const lang = (opts && opts.lang) || 'de';
    const locale = langFor('pokemon', lang);
    const result = {};
    await mapLimit(ids.slice(0, POKEMON_MAX), POKEMON_CONCURRENCY, async (id) => {
      const c = await getPokeCard(id, locale);
      if (!c) { result[id] = { needsDetail: false }; return; }
      const p = pokePricing(c);
      result[id] = {
        name: c.name ?? null,
        setName: (c.set && c.set.name) ?? null,
        setCode: (c.set && c.set.id) ? String(c.set.id).toUpperCase() : pokeSetCode(id, c.localId),
        rarity: c.rarity ?? null,
        cardmarketPrice: p.price,
        priceLow: p.low,
        priceTrend: p.trend,
        currency: p.currency,
        extra: { category: c.category ?? null, hp: c.hp ?? null, types: c.types ?? null, stage: c.stage ?? null },
      };
    });
    return result;
  }

  // --- Magic: Scryfall --------------------------------------------------------
  async function searchMagic(q, opts) {
    const lang = (opts && opts.lang) || 'de', mode = (opts && opts.mode) || 'name';
    const code = langFor('magic', lang);
    let query;
    if (mode === 'number') {
      const parsed = parseNumberQuery(q);
      if (!parsed.number) return [];
      query = `cn:${parsed.number}` + (parsed.setHint ? ` set:${parsed.setHint}` : '');
    } else { query = q; }
    if (code !== 'en') query += ` lang:${code}`;

    let url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&unique=prints&order=released&dir=desc`;
    const all = [];
    try {
      while (url && all.length < SAFETY_MAX) {
        const data = await get(url);
        all.push(...(data.data || []));
        url = data.has_more ? data.next_page : null;
        if (url) await sleep(80);
      }
    } catch (e) {
      if (String(e.message).includes('404')) return finishMagic(all);
      throw e;
    }
    return finishMagic(all);
  }
  function magicPrice(c) {
    const pr = (c && c.prices) || {};
    // EUR bevorzugt (auch Foil, wenn Non-Foil fehlt), sonst USD als Ersatz.
    let price = posOrNull(pr.eur) ?? posOrNull(pr.eur_foil), currency = 'EUR';
    if (price == null) { const u = posOrNull(pr.usd) ?? posOrNull(pr.usd_foil); if (u != null) { price = u; currency = 'USD'; } }
    return { price, currency };
  }
  function finishMagic(all) {
    return all.slice(0, SAFETY_MAX).map((c) => {
      const mp = magicPrice(c);
      return {
        game: 'magic', externalId: c.id, name: c.printed_name || c.name,
        setName: c.set_name ?? null, setCode: c.set ? String(c.set).toUpperCase() : null,
        number: c.collector_number ?? null, rarity: c.rarity ?? null,
        imageUrl: (c.image_uris && c.image_uris.normal) ?? (c.card_faces && c.card_faces[0] && c.card_faces[0].image_uris && c.card_faces[0].image_uris.normal) ?? null,
        cardmarketPrice: mp.price, priceLow: null, priceTrend: null, currency: mp.currency, cardmarketUrl: (c.purchase_uris && c.purchase_uris.cardmarket) ?? null,
        extra: { typeLine: c.printed_type_line || c.type_line || null, manaCost: c.mana_cost ?? null, colors: c.colors ?? null },
      };
    });
  }

  // --- Yu-Gi-Oh: YGOPRODeck ---------------------------------------------------
  function ygoPrice(c) {
    const cp = (c && c.card_prices && c.card_prices[0]) || {};
    // Cardmarket bevorzugt; "0.00" heißt "kein Preis" -> TCGplayer (USD) als Ersatz.
    let price = posOrNull(cp.cardmarket_price), currency = 'EUR';
    if (price == null) { const u = posOrNull(cp.tcgplayer_price); if (u != null) { price = u; currency = 'USD'; } }
    return { price, currency };
  }
  async function searchYugioh(q, opts) {
    const lang = (opts && opts.lang) || 'de';
    const code = langFor('yugioh', lang);
    const langParam = code !== 'en' ? `&language=${code}` : '';
    let data;
    try {
      data = await get(`https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(q)}${langParam}`);
    } catch (e) {
      if (String(e.message).includes('400')) return [];
      throw e;
    }
    return (data.data || []).slice(0, SAFETY_MAX).map((c) => {
      const yp = ygoPrice(c);
      return {
        game: 'yugioh', externalId: String(c.id), name: c.name,
        setName: (c.card_sets && c.card_sets[0] && c.card_sets[0].set_name) ?? null,
        setCode: (c.card_sets && c.card_sets[0] && c.card_sets[0].set_code) ?? null,
        number: (c.card_sets && c.card_sets[0] && c.card_sets[0].set_code) ?? null,
        rarity: (c.card_sets && c.card_sets[0] && c.card_sets[0].set_rarity) ?? c.type ?? null,
        imageUrl: (c.card_images && c.card_images[0] && (c.card_images[0].image_url_small || c.card_images[0].image_url)) ?? null,
        cardmarketPrice: yp.price, priceLow: null, priceTrend: null, currency: yp.currency, cardmarketUrl: cmSearchUrl('yugioh', c.name),
        extra: { type: c.type ?? null, atk: c.atk ?? null, def: c.def ?? null, level: c.level ?? null, attribute: c.attribute ?? null, race: c.race ?? null },
      };
    });
  }

  // --- One Piece: optcgapi.com -------------------------------------------------
  let opCache = { cards: null, at: 0 };
  const OP_TTL = 12 * 3600 * 1000;
  async function loadOnePieceCards() {
    if (opCache.cards && Date.now() - opCache.at < OP_TTL) return opCache.cards;
    // Booster-Sets, Starter-Decks UND Promo-/Turnierkarten laden. Die Promo-Tabelle
    // enthält auch die Turnier-Karten (Winner/Finalist/Participant, Store-Championship-
    // Trophy, Super-Pre-Release usw.) – dieselben Feldnamen wie bei Set-/ST-Karten.
    const [sets, st, promo] = await Promise.all([
      get('https://optcgapi.com/api/allSetCards/').catch(() => []),
      get('https://optcgapi.com/api/allSTCards/').catch(() => []),
      get('https://optcgapi.com/api/allPromoCards/').catch(() => []),
    ]);
    const cards = [
      ...(Array.isArray(sets) ? sets : []),
      ...(Array.isArray(st) ? st : []),
      ...(Array.isArray(promo) ? promo : []),
    ];
    if (cards.length) opCache = { cards, at: Date.now() };
    return cards;
  }
  function mapOnePiece(c) {
    return {
      game: 'onepiece', externalId: c.card_image_id || c.card_set_id, name: c.card_name,
      setName: c.set_name ?? null, setCode: c.card_set_id ?? null, number: c.card_set_id ?? null,
      rarity: c.rarity ?? null, imageUrl: c.card_image ?? null,
      cardmarketPrice: posOrNull(c.market_price), priceLow: posOrNull(c.inventory_price), priceTrend: null,
      currency: 'USD',
      cardmarketUrl: cmSearchUrl('onepiece', c.card_name),
      extra: { type: c.card_type ?? null, color: c.card_color ?? null, cost: c.card_cost ?? null, power: c.card_power ?? null, family: c.sub_types ?? null },
    };
  }
  async function onePieceNames() {
    const cards = await loadOnePieceCards();
    return [...new Set(cards.map((c) => c.card_name).filter(Boolean))].sort();
  }

  async function searchOnePiece(q, opts) {
    const mode = (opts && opts.mode) || 'name';
    const cards = await loadOnePieceCards();
    let matches;
    if (mode === 'number') {
      // Set-Kuerzel + Kartennummer trennen. Das Kuerzel kann rein alphabetisch
      // sein ("P" fuer Promos), Ziffern enthalten ("OP01","ST01","EB01","PRB01")
      // und mit "-", Leerzeichen oder ohne Trennung stehen ("P-001","P 001","P001").
      const raw = String(q || '').trim();
      let setPart = null, numStr = null, m;
      if ((m = raw.match(/^\s*([A-Za-z]{1,4}\d{0,3})\s*-\s*(\d{1,4})\s*$/))) { setPart = m[1]; numStr = m[2]; }
      else if ((m = raw.match(/^\s*([A-Za-z]{1,4}\d{0,3})\s+(\d{1,4})\s*$/))) { setPart = m[1]; numStr = m[2]; }
      else if ((m = raw.match(/^\s*([A-Za-z]+)(\d{1,4})\s*$/))) { setPart = m[1]; numStr = m[2]; }
      if (!setPart) { const g = raw.match(/\d{1,4}/g) || []; numStr = g.length ? g[g.length - 1] : null; }
      const cardNum = numStr != null ? parseInt(numStr, 10) : null;
      if (cardNum == null) return [];
      matches = cards.filter((c) => {
        const parts = String(c.card_set_id || '').split('-');
        const okNum = parseInt(parts[1], 10) === cardNum;
        const okSet = !setPart || String(parts[0] || '').toUpperCase() === setPart.toUpperCase();
        return okNum && okSet;
      });
    } else {
      const t = q.toLowerCase();
      matches = cards.filter((c) => String(c.card_name || '').toLowerCase().includes(t));
    }
    return matches.slice(0, SAFETY_MAX).map(mapOnePiece);
  }

  const GAMES = { pokemon: searchPokemon, magic: searchMagic, yugioh: searchYugioh, onepiece: searchOnePiece };
  const NUMBER_SEARCH = { pokemon: true, magic: true, yugioh: false, onepiece: true };

  // --- Set-Suche ---------------------------------------------------------------
  const setListCache = {};
  const SET_LIST_TTL = 12 * 60 * 60 * 1000;

  async function allSets(game) {
    const c = setListCache[game];
    if (c && (Date.now() - c.ts) < SET_LIST_TTL) return c.list;
    let list = [];
    try {
      if (game === 'pokemon') {
        const [de, en] = await Promise.all([loadPokeSets('de'), loadPokeSets('en')]);
        const enById = new Map((en.list || []).map((s) => [s.id, s]));
        const seen = new Set();
        const push = (s, other) => {
          if (!s || !s.id || seen.has(s.id)) return; seen.add(s.id);
          const names = [s.name, other && other.name].filter(Boolean);
          list.push({
            game, name: s.name || (other && other.name), code: s.id,
            logo: s.logo ? `${s.logo}.webp` : null, releaseDate: null,
            search: names.join(' ').toLowerCase(),
          });
        };
        for (const s of (de.list || [])) push(s, enById.get(s.id));
        for (const s of (en.list || [])) push(s, null);
        list.reverse();
      } else if (game === 'magic') {
        const d = await get('https://api.scryfall.com/sets');
        list = ((d && d.data) || []).map((s) => ({
          game, name: s.name, code: (s.code || '').toUpperCase(),
          logo: s.icon_svg_uri || null, releaseDate: s.released_at || null, search: (s.name || '').toLowerCase(),
        }));
      } else if (game === 'yugioh') {
        const d = await get('https://db.ygoprodeck.com/api/v7/cardsets.php');
        list = (Array.isArray(d) ? d : []).map((s) => ({
          game, name: s.set_name, code: s.set_code || null, logo: null, releaseDate: s.tcg_date || null,
          search: (s.set_name || '').toLowerCase(),
        }));
      } else if (game === 'onepiece') {
        const all = await loadOnePieceCards();
        const seen = new Map();
        for (const r of (all || [])) {
          const k = r.set_name;
          if (k && !seen.has(k)) seen.set(k, { game, name: r.set_name, code: r.set_id || null, logo: null, releaseDate: null, search: String(r.set_name).toLowerCase() });
        }
        list = [...seen.values()];
      }
    } catch { list = []; }
    list = list.filter((s) => s && s.name);
    if (list.length) setListCache[game] = { ts: Date.now(), list };
    return list;
  }

  async function searchSets(game, q) {
    const term = String(q || '').trim().toLowerCase();
    const list = await allSets(game);
    let res = term ? list.filter((s) => (s.search || s.name || '').includes(term)) : list.slice();
    if (res.some((s) => s.releaseDate)) res.sort((a, b) => String(b.releaseDate || '').localeCompare(String(a.releaseDate || '')));
    return res.slice(0, 40);
  }

  // --- Gegradete Pokémon-Karten: PokemonPriceTracker --------------------------
  function parseGraded(obj) {
    if (!obj || typeof obj !== 'object') return [];
    const out = [];
    const push = (company, grade, val) => {
      const p = num((val && (val.avg ?? val.median ?? val.medianPrice ?? val.averagePrice ?? val.smartMarketPrice ?? val.price)) ?? val);
      if (p != null) out.push({ company: String(company).toUpperCase(), grade: String(grade).replace('_', '.'), price: p });
    };
    for (const [k, v] of Object.entries(obj)) {
      const m = k.match(/^(psa|cgc|bgs|sgc|ace|tag)[ _-]?(\d+(?:[._]5)?)$/i);
      if (m) { push(m[1], m[2], v); continue; }
      if (/^(psa|cgc|bgs|sgc|ace|tag)$/i.test(k) && v && typeof v === 'object') {
        for (const [g, val] of Object.entries(v)) push(k, String(g).replace(/^g/i, ''), val);
      } else if ((k === 'graded' || k === 'grades') && v && typeof v === 'object') {
        out.push(...parseGraded(v));
      }
    }
    return out;
  }

  async function searchGraded(q) {
    const key = await self.DB.getSetting('pokepriceApiKey');
    if (!key) {
      const err = new Error('Für gegradete Karten fehlt der API-Key. Hol dir einen kostenlosen Key auf pokemonpricetracker.com und trag ihn unter Einstellungen ein.');
      err.code = 'NO_KEY';
      throw err;
    }
    const data = await get(
      `https://www.pokemonpricetracker.com/api/v2/cards?search=${encodeURIComponent(q)}&includeEbay=true&limit=30`,
      { Authorization: `Bearer ${key}` }
    );
    const cards = data.data || data.cards || [];
    return cards.map((c) => ({
      externalId: String(c.tcgPlayerId || c.id || c._id || c.cardId || ''),
      name: c.name || '',
      setName: (c.set && c.set.name) || c.setName || c.set || null,
      number: c.number || c.cardNumber || null,
      imageUrl: (c.images && c.images.small) || c.image || c.imageUrl || null,
      graded: parseGraded(c.ebay || c.graded || (c.prices && c.prices.graded) || (c.prices && c.prices.ebay)),
    })).filter((c) => c.name);
  }

  async function search(game, q, opts) {
    opts = opts || {};
    const fn = GAMES[game];
    if (!fn) throw new Error(`Unbekanntes Spiel: ${game}`);
    return fn(q, Object.assign({}, opts, { lang: langFor(game, opts.lang) }));
  }

  async function fetchPrices(game, externalId, opts) {
    opts = opts || {};
    try {
      if (game === 'pokemon') {
        const locale = langFor('pokemon', opts.lang);
        const d = await getPokeCard(externalId, locale);
        if (!d) return { price: null, low: null, trend: null };
        return pokePricing(d);
      }
      if (game === 'magic') {
        const d = await get(`https://api.scryfall.com/cards/${externalId}`);
        const mp = magicPrice(d);
        return { price: mp.price, low: null, trend: null, currency: mp.currency };
      }
      if (game === 'yugioh') {
        const d = await get(`https://db.ygoprodeck.com/api/v7/cardinfo.php?id=${externalId}`);
        const yp = ygoPrice(d.data && d.data[0]);
        return { price: yp.price, low: null, trend: null, currency: yp.currency };
      }
      if (game === 'onepiece') {
        // card_set_id aus der externalId lösen (Bild-Suffixe wie "_pr12"/"_p1" abtrennen)
        // und den passenden Endpunkt wählen: Promos (P-…), Starter-Decks (ST…) oder Sets.
        const setId = String(externalId).split('_')[0];
        const path = /^P-/i.test(setId) ? 'promos' : /^ST/i.test(setId) ? 'decks' : 'sets';
        const arr = await get(`https://optcgapi.com/api/${path}/card/${encodeURIComponent(setId)}/`);
        const list = Array.isArray(arr) ? arr : [];
        const row = list.find((c) => (c.card_image_id || c.card_set_id) === externalId) || list[0];
        return { price: posOrNull(row && row.market_price), low: posOrNull(row && row.inventory_price), trend: null, currency: 'USD' };
      }
    } catch { return { price: null, low: null, trend: null }; }
    return { price: null, low: null, trend: null };
  }
  const SUPPORTED_GAMES = Object.keys(GAMES);
  self.Adapters = { LANGUAGES, NUMBER_SEARCH, SUPPORTED_GAMES, langFor, search, fetchPrices, enrichPokemon, searchGraded, searchSets, onePieceNames };
})();
