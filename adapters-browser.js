// adapters-browser.js – Quell-APIs für die Kartenspiele, portiert für den Browser
// (läuft im Service Worker). Fast identisch zu adapters.js – der einzige echte
// Unterschied: der optionale PokemonPriceTracker-Key kommt jetzt aus der lokalen
// Datenbank (Einstellungen) statt aus einer .env-Datei, weil es keinen Server mehr gibt.
//
// WICHTIG (ehrlich kommunizieren): Diese Aufrufe laufen jetzt direkt aus dem Browser.
// Das funktioniert nur, wenn die jeweilige API "CORS" für Browser-Zugriffe erlaubt.
// TCGdex, Scryfall und YGOPRODeck sind dafür ausgelegt. Bei optcgapi.com (One Piece)
// ist das nicht mit letzter Sicherheit getestet – falls dort Fehler auftreten, ist das
// eine Grenze der kostenlosen Quelle, kein Bug in der App.

(function () {
  'use strict';

  const TIMEOUT_MS = 9000;
  const SAFETY_MAX = 500;
  const POKEMON_MAX = 250;
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
      const parsed = parseNumberQuery(q);
      const number = parsed.number, rawDigits = parsed.rawDigits, h = parsed.setHint;
      setHint = h;
      if (!number) return [];
      const forms = [...new Set([number, rawDigits].filter(Boolean))];
      const resolvedSetId = h ? await resolvePokeSetId(h, locale) : null;
      if (resolvedSetId) {
        const set = await get(`https://api.tcgdex.net/v2/${locale}/sets/${encodeURIComponent(resolvedSetId)}`).catch(() => null);
        const setCards = set && Array.isArray(set.cards) ? set.cards : [];
        briefs = setCards.filter((b) => localIdMatches(b.localId, number, forms));
        setHint = null;
      } else {
        const arrays = await Promise.all(
          forms.map((f) => get(`https://api.tcgdex.net/v2/${locale}/cards?localId=eq:${encodeURIComponent(f)}`).catch(() => []))
        );
        const seen = new Set();
        for (const arr of arrays) for (const b of (Array.isArray(arr) ? arr : [])) {
          if (b && !seen.has(b.id)) { seen.add(b.id); briefs.push(b); }
        }
      }
    } else {
      const locales = locale === 'en' ? ['en'] : [locale, 'en'];
      const arrays = await Promise.all(
        locales.map((loc) => get(`https://api.tcgdex.net/v2/${loc}/cards?name=${encodeURIComponent(q)}`).catch(() => []))
      );
      const seen = new Set();
      for (const arr of arrays) for (const b of (Array.isArray(arr) ? arr : [])) {
        if (b && !seen.has(b.id)) { seen.add(b.id); briefs.push(b); }
      }
    }
    let cards = briefs.slice(0, POKEMON_MAX).map((b) => ({
      game: 'pokemon', externalId: b.id, name: b.name, lang: locale,
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

  async function enrichPokemon(ids, opts) {
    const lang = (opts && opts.lang) || 'de';
    const locale = langFor('pokemon', lang);
    const result = {};
    await mapLimit(ids.slice(0, POKEMON_MAX), POKEMON_CONCURRENCY, async (id) => {
      try {
        const c = await get(`https://api.tcgdex.net/v2/${locale}/cards/${id}`);
        const cm = c.pricing && c.pricing.cardmarket;
        result[id] = {
          name: c.name ?? null,
          setName: (c.set && c.set.name) ?? null,
          setCode: (c.set && c.set.id) ? String(c.set.id).toUpperCase() : pokeSetCode(id, c.localId),
          rarity: c.rarity ?? null,
          cardmarketPrice: num(cm && cm['avg30']) ?? num(cm && cm.trend) ?? num(cm && cm.avg),
          priceLow: num(cm && cm.low),
          priceTrend: num(cm && cm.trend),
          extra: { category: c.category ?? null, hp: c.hp ?? null, types: c.types ?? null, stage: c.stage ?? null },
        };
      } catch { result[id] = { needsDetail: false }; }
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
  function finishMagic(all) {
    return all.slice(0, SAFETY_MAX).map((c) => ({
      game: 'magic', externalId: c.id, name: c.printed_name || c.name,
      setName: c.set_name ?? null, setCode: c.set ? String(c.set).toUpperCase() : null,
      number: c.collector_number ?? null, rarity: c.rarity ?? null,
      imageUrl: (c.image_uris && c.image_uris.normal) ?? (c.card_faces && c.card_faces[0] && c.card_faces[0].image_uris && c.card_faces[0].image_uris.normal) ?? null,
      cardmarketPrice: num(c.prices && c.prices.eur), priceLow: null, priceTrend: null, currency: 'EUR', cardmarketUrl: (c.purchase_uris && c.purchase_uris.cardmarket) ?? null,
      extra: { typeLine: c.printed_type_line || c.type_line || null, manaCost: c.mana_cost ?? null, colors: c.colors ?? null },
    }));
  }

  // --- Yu-Gi-Oh: YGOPRODeck ---------------------------------------------------
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
    return (data.data || []).slice(0, SAFETY_MAX).map((c) => ({
      game: 'yugioh', externalId: String(c.id), name: c.name,
      setName: (c.card_sets && c.card_sets[0] && c.card_sets[0].set_name) ?? null,
      setCode: (c.card_sets && c.card_sets[0] && c.card_sets[0].set_code) ?? null,
      number: (c.card_sets && c.card_sets[0] && c.card_sets[0].set_code) ?? null,
      rarity: (c.card_sets && c.card_sets[0] && c.card_sets[0].set_rarity) ?? c.type ?? null,
      imageUrl: (c.card_images && c.card_images[0] && (c.card_images[0].image_url_small || c.card_images[0].image_url)) ?? null,
      cardmarketPrice: num(c.card_prices && c.card_prices[0] && c.card_prices[0].cardmarket_price), priceLow: null, priceTrend: null, currency: 'EUR', cardmarketUrl: cmSearchUrl('yugioh', c.name),
      extra: { type: c.type ?? null, atk: c.atk ?? null, def: c.def ?? null, level: c.level ?? null, attribute: c.attribute ?? null, race: c.race ?? null },
    }));
  }

  // --- One Piece: optcgapi.com -------------------------------------------------
  let opCache = { cards: null, at: 0 };
  const OP_TTL = 12 * 3600 * 1000;
  async function loadOnePieceCards() {
    if (opCache.cards && Date.now() - opCache.at < OP_TTL) return opCache.cards;
    const [sets, st] = await Promise.all([
      get('https://optcgapi.com/api/allSetCards/').catch(() => []),
      get('https://optcgapi.com/api/allSTCards/').catch(() => []),
    ]);
    const cards = [...(Array.isArray(sets) ? sets : []), ...(Array.isArray(st) ? st : [])];
    if (cards.length) opCache = { cards, at: Date.now() };
    return cards;
  }
  function mapOnePiece(c) {
    return {
      game: 'onepiece', externalId: c.card_image_id || c.card_set_id, name: c.card_name,
      setName: c.set_name ?? null, setCode: c.card_set_id ?? null, number: c.card_set_id ?? null,
      rarity: c.rarity ?? null, imageUrl: c.card_image ?? null,
      cardmarketPrice: num(c.market_price), priceLow: num(c.inventory_price), priceTrend: null,
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
      const setPart = (q.match(/[A-Za-z]{1,3}\d{1,2}/) || [])[0] || null;
      const digitGroups = q.match(/\d{1,4}/g) || [];
      const cardNum = digitGroups.length ? parseInt(digitGroups[digitGroups.length - 1], 10) : null;
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
        const d = await get(`https://api.tcgdex.net/v2/${locale}/cards/${externalId}`);
        const cm = d.pricing && d.pricing.cardmarket;
        return { price: num(cm && cm['avg30']) ?? num(cm && cm.trend) ?? num(cm && cm.avg), low: num(cm && cm.low), trend: num(cm && cm.trend) };
      }
      if (game === 'magic') { const d = await get(`https://api.scryfall.com/cards/${externalId}`); return { price: num(d.prices && d.prices.eur), low: null, trend: null }; }
      if (game === 'yugioh') { const d = await get(`https://db.ygoprodeck.com/api/v7/cardinfo.php?id=${externalId}`); return { price: num(d.data && d.data[0] && d.data[0].card_prices && d.data[0].card_prices[0] && d.data[0].card_prices[0].cardmarket_price), low: null, trend: null }; }
      if (game === 'onepiece') {
        const baseId = String(externalId).replace(/_p\d+$/, '');
        const arr = await get(`https://optcgapi.com/api/sets/card/${baseId}/`);
        const row = (Array.isArray(arr) ? arr : []).find((c) => (c.card_image_id || c.card_set_id) === externalId) || (arr && arr[0]);
        return { price: num(row && row.market_price), low: num(row && row.inventory_price), trend: null };
      }
    } catch { return { price: null, low: null, trend: null }; }
    return { price: null, low: null, trend: null };
  }

  const SUPPORTED_GAMES = Object.keys(GAMES);

  self.Adapters = {
    LANGUAGES, NUMBER_SEARCH, SUPPORTED_GAMES,
    langFor, search, fetchPrices, enrichPokemon, searchGraded, searchSets, onePieceNames,
  };
})();
