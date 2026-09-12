const https = require('https');
const http = require('http');

const {
  STEAM_API_KEY,
  STEAM_ID,
  DISCORD_WEBHOOK_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  ITAD_API_KEY,
} = process.env;

const DEAL_SCORE_THRESHOLD = 7;
const NOTIFICATION_COOLDOWN_HOURS = 24;
const REQUEST_TIMEOUT_MS = 10000;
const WISHLIST_REQUEST_DELAY_MS = 1000;

// ─── Startup validation ────────────────────────────────────────
function assertEnv() {
  const required = {
    STEAM_API_KEY,
    STEAM_ID,
    DISCORD_WEBHOOK_URL,
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }
}

// ─── HTTP Helpers ──────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}: ${data.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error from ${url}: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`Request timed out: ${url}`)));
  });
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? https : http;
    const req = mod.request(urlObj, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let resData = '';
      res.on('data', (c) => (resData += c));
      res.on('end', () => resolve({ status: res.statusCode, body: resData }));
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`Request timed out: ${url}`)));
    req.write(data);
    req.end();
  });
}

// ─── Supabase Helpers ──────────────────────────────────────────
function supabaseRequest(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = `${SUPABASE_URL}/rest/v1/${path}`;
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = https.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let resData = '';
      res.on('data', (c) => (resData += c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Supabase ${method} ${path} -> HTTP ${res.statusCode}: ${resData.slice(0, 300)}`));
          return;
        }
        if (!resData) { resolve(null); return; }
        try { resolve(JSON.parse(resData)); }
        catch { resolve(resData); }
      });
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`Supabase request timed out: ${path}`)));
    if (data) req.write(data);
    req.end();
  });
}

async function supabaseQuery(table, { select = '*', where = '' } = {}) {
  const qs = new URLSearchParams({ select });
  const path = `${table}?${qs.toString()}${where ? `&${where}` : ''}`;
  return supabaseRequest('GET', path, { headers: { 'Prefer': 'return=representation' } });
}

async function supabaseInsert(table, rows) {
  return supabaseRequest('POST', table, { body: rows, headers: { 'Prefer': 'return=minimal' } });
}

// Upsert avoids piling up duplicate rows for the same app_id on every alert/sighting.
async function supabaseUpsert(table, rows, conflictColumn) {
  const path = `${table}?on_conflict=${conflictColumn}`;
  return supabaseRequest('POST', path, {
    body: rows,
    headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
  });
}

// ─── Steam Wishlist ────────────────────────────────────────────
async function getWishlist() {
  const url = `https://api.steampowered.com/IWishlistService/GetWishlist/v1?steamid=${STEAM_ID}&key=${STEAM_API_KEY}`;
  const data = await fetchJson(url);
  const items = data?.response?.items || [];

  console.log(`Wishlist: ${items.length} games`);

  return items
    .map((item) => ({
      appId: item.appid,
      addedAt: item.date_added
        ? new Date(item.date_added * 1000).toISOString()
        : null,
    }))
    .filter((i) => i.appId);
}

// ─── ITAD Game Lookup ─────────────────────────────────────────
async function lookupItadGame(appId) {
  const url =
    `https://api.isthereanydeal.com/games/lookup/v1` +
    `?key=${encodeURIComponent(ITAD_API_KEY)}` +
    `&appid=${encodeURIComponent(appId)}`;

  const data = await fetchJson(url);

  if (!data?.found || !data?.game?.id) {
    return null;
  }

  return {
    id: data.game.id,
    title: data.game.title || null,
  };
}

async function matchWishlistGamesToItad(wishlist) {
  if (wishlist.length === 0) {
    console.log('Wishlist is empty — nothing to match.');
    return;
  }

  // Only send games to ITAD that are not already matched.
  const existing = await supabaseQuery('wishlist', {
    select: 'app_id,itad_game_id,itad_match_status',
    where: `app_id=in.(${wishlist.map((item) => item.appId).join(',')})`,
  });

  const existingMap = new Map(
    (Array.isArray(existing) ? existing : []).map((row) => [
      row.app_id,
      row,
    ])
  );

  const gamesToMatch = wishlist.filter((item) => {
    const row = existingMap.get(item.appId);
    return !row || row.itad_match_status !== 'matched';
  });

  if (gamesToMatch.length === 0) {
    console.log('All wishlist games are already matched to ITAD — nothing to match.');
    return;
  }

  console.log(
    `Matching ${gamesToMatch.length} wishlist games to ITAD ` +
    `(${wishlist.length - gamesToMatch.length} already matched)...`
  );

  const appIds = gamesToMatch.map((item) => item.appId);

  const url =
    `https://api.isthereanydeal.com/lookup/id/shop/61/v1` +
    `?key=${encodeURIComponent(ITAD_API_KEY)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(
      appIds.map((appId) => `app/${appId}`)
    ),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `ITAD batch lookup failed (${response.status}): ${text}`
    );
  }

  const results = await response.json();

  const updates = [];
  let matched = 0;
  let failed = 0;

  for (const item of gamesToMatch) {
    const key = `app/${item.appId}`;
    const itadGameId = results?.[key];

    if (itadGameId) {
      updates.push({
        app_id: item.appId,
        itad_game_id: itadGameId,
        itad_match_status: 'matched',
        itad_match_source: 'steam_appid',
        itad_matched_at: new Date().toISOString(),
      });

      matched++;

      console.log(
        `  Matched: ${item.appId} → ${itadGameId}`
      );
    } else {
      updates.push({
        app_id: item.appId,
        itad_game_id: item.itadGameId,
        itad_match_status: 'failed',
        itad_match_source: 'steam_appid',
      });

      failed++;

      console.log(
        `  No ITAD match: ${item.appId}`
      );
    }
  }

  if (updates.length > 0) {
    await supabaseUpsert(
      'wishlist',
      updates,
      'app_id'
    );
  }

  console.log(
    `ITAD matching complete: ${matched} matched, ${failed} not found`
  );
}

// ─── Wishlist Database Sync ───────────────────────────────────
async function syncWishlistToDatabase(wishlist) {
  if (wishlist.length === 0) {
    console.log('Wishlist is empty — nothing to sync.');
    return;
  }

  console.log(`Syncing ${wishlist.length} wishlist games to Supabase...`);

  const rows = [];
  let failed = 0;

  for (const item of wishlist) {
    try {
      // Steam's wishlist endpoint gives us the app ID and date added,
      // but not the game title. Reuse the existing Steam Store API
      // helper to retrieve the title.
      const game = await getGamePrice(item.appId);

      rows.push({
        app_id: item.appId,
        game_name: game?.title || `App ${item.appId}`,
        added_at: item.addedAt,
        last_synced: new Date().toISOString(),
      });

      console.log(
        `  Prepared: ${game?.title || `App ${item.appId}`}`
      );
    } catch (e) {
      failed++;
      console.warn(
        `  Failed to prepare wishlist app ${item.appId}: ${e.message}`
      );
    }

    await new Promise((r) => setTimeout(r, WISHLIST_REQUEST_DELAY_MS));
  }

  if (rows.length === 0) {
    console.log('No wishlist rows could be prepared.');
    return;
  }

  await supabaseUpsert('wishlist', rows, 'app_id');

  console.log(
    `Wishlist sync complete: ${rows.length} synced, ${failed} failed`
  );
}

// ─── Steam Store Price (Malaysia) ──────────────────────────────
async function getGamePrice(appId) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=my`;
  const data = await fetchJson(url);
  const entry = data?.[appId];
  if (!entry || !entry.data || !entry.data.name) return null;

  const priceOverview = entry.data.price_overview;
  if (!priceOverview) return null; // e.g. free-to-play or delisted — nothing to price

  const currentPrice = priceOverview.final / 100;
  const originalPrice = priceOverview.initial / 100;
  const discountPct = priceOverview.discount_percent || 0;

  // Allow currentPrice === 0: a genuine 100%-off promo, not a broken response,
  // as long as Steam actually returned a price_overview for it.
  if (!Number.isFinite(currentPrice) || currentPrice < 0) return null;
  if (!Number.isFinite(originalPrice) || originalPrice <= 0) return null;

  return {
    title: entry.data.name,
    cheapest: currentPrice,
    originalPrice,
    discountPct,
    isOnSale: discountPct > 0,
    storeName: 'Steam',
    url: `https://store.steampowered.com/app/${appId}`,
  };
}

// ─── ITAD Historical Low Prices ────────────────────────────────
async function getItadHistoricalLows(wishlistRows) {
  const map = new Map();

  const games = wishlistRows.filter(
    (item) => item.itad_game_id
  );

  const itadToAppId = new Map(
    games.map((game) => [game.itad_game_id, game.app_id])
  );

  if (games.length === 0) {
    console.log('No ITAD-matched wishlist games to query for historical lows.');
    return map;
  }

  const itadGameIds = games.map((item) => item.itad_game_id);

  const url =
    `https://api.isthereanydeal.com/games/historylow/v1` +
    `?key=${encodeURIComponent(ITAD_API_KEY)}` +
    `&country=MY`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(itadGameIds),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `ITAD historical-low lookup failed (${response.status}): ${text}`
    );
  }

  const results = await response.json();

  for (const result of Array.isArray(results) ? results : []) {
    const low = result?.low;

    if (
      result?.id &&
      low?.price?.amount !== undefined &&
      low?.price?.currency
    ) {
      const appId = itadToAppId.get(result.id);

      if (!appId) {
        continue;
      }

      map.set(appId, {
        price: Number(low.price.amount),
        currency: low.price.currency,
        store: low.shop?.name || null,
        storeId: low.shop?.id || null,
        timestamp: low.timestamp || null,
      });
    }
  }

  console.log(
    `ITAD historical lows: ${map.size}/${games.length} games returned`
  );

  return map;
}

// ─── ITAD Current Prices ───────────────────────────────────────
async function getItadCurrentPrices(wishlistRows) {
  const map = new Map();

  const games = wishlistRows.filter(
    (item) => item.itad_game_id
  );

  if (games.length === 0) {
    console.log('No ITAD-matched wishlist games to query for current prices.');
    return map;
  }

  const itadGameIds = games.map((item) => item.itad_game_id);

  const url =
  `https://api.isthereanydeal.com/games/prices/v3` +
  `?key=${encodeURIComponent(ITAD_API_KEY)}` +
  `&country=MY`;

console.log(
  'ITAD current-price URL:',
  url.replace(ITAD_API_KEY, 'REDACTED')
);

const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(itadGameIds),
  });

  if (!response.ok) {
  const text = await response.text();

  console.warn(
    `ITAD current-price lookup failed (${response.status}): ${text}`
  );

  return new Map();
}

    const results = await response.json();

  console.log(
  'ITAD current-price sample:',
  JSON.stringify(results?.[0], null, 2)
);

const storeCounts = {};

for (const result of results) {
  for (const deal of result?.deals || []) {
    const key = `${deal?.shop?.id}:${deal?.shop?.name}`;
    storeCounts[key] = (storeCounts[key] || 0) + 1;
  }
}

console.log('ITAD current-price stores:', storeCounts);

  const itadToAppId = new Map(
    games.map((game) => [game.itad_game_id, game.app_id])
  );

    const trackedShopIds = new Set([61, 6, 35, 37]);

  for (const result of Array.isArray(results) ? results : []) {
    const appId = itadToAppId.get(result?.id);

    if (!appId) {
      continue;
    }

  const trackedDealsByShop = new Map();

for (const deal of result?.deals || []) {
  const shopId = deal?.shop?.id;

  if (!trackedShopIds.has(shopId)) {
    continue;
  }

  const existing = trackedDealsByShop.get(shopId);

  if (!existing || deal?.price?.amount < existing?.price?.amount) {
    trackedDealsByShop.set(shopId, deal);
  }
}

const trackedDeals = Array.from(trackedDealsByShop.values());

    map.set(appId, {
      ...result,
      trackedDeals,
    });
  }

  console.log(
    `ITAD current prices: ${map.size}/${games.length} games returned`
  );

  return map;
}
// ─── Free Games (100% off, any store, not limited to wishlist) ────
// Each source resolves to a normalized list of:
//   { id, title, storeName, url }
// `id` is prefixed per-store (e.g. "steam:730") so free_games_seen can
// dedupe across stores whose native IDs aren't comparable (Steam app IDs
// are numeric, Epic's are opaque hex strings, ITAD's are slugs).

// Steam-wide — scans everything Steam is currently featuring as a
// special, not just your wishlist. Same host as getGamePrice(), so no
// new blocking risk.
async function getSteamFreebies() {
  const url = 'https://store.steampowered.com/api/featuredcategories?cc=my&l=english';
  const data = await fetchJson(url);
  const items = data?.specials?.items || [];
  const freebies = items.filter((item) => item.discount_percent === 100);
  console.log(`Steam specials scanned: ${items.length}, at 100% off: ${freebies.length}`);
  return freebies.map((item) => ({
    id: `steam:${item.id}`,
    title: item.name,
    storeName: 'Steam',
    url: `https://store.steampowered.com/app/${item.id}`,
  }));
}

// Epic Games' official public freebies endpoint — no auth, no key,
// widely used and stable. Confirmed live and working as of this writing.
async function getEpicFreebies() {
  const url = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=MY&allowCountries=MY';
  const data = await fetchJson(url);
  const elements = data?.data?.Catalog?.searchStore?.elements || [];
  const now = Date.now();

  const freebies = elements.filter((el) => {
    const blocks = el?.promotions?.promotionalOffers || [];
    return blocks.some((block) =>
      (block.promotionalOffers || []).some((offer) => {
        if (offer.discountSetting?.discountPercentage !== 0) return false;
        const starts = new Date(offer.startDate).getTime();
        const ends = new Date(offer.endDate).getTime();
        return now >= starts && now <= ends;
      })
    );
  });
  console.log(`Epic catalog scanned: ${elements.length}, currently free: ${freebies.length}`);

  return freebies.map((el) => ({
    id: `epic:${el.id}`,
    title: el.title,
    storeName: 'Epic Games',
    url: el.productSlug
      ? `https://store.epicgames.com/p/${el.productSlug}`
      : 'https://store.epicgames.com/en-US/free-games',
  }));
}

// Third-party keyshops (Fanatical, Humble Store, GOG, etc.) via
// IsThereAnyDeal — a different service from gg.deals/CheapShark, so the
// block you're hitting on those two shouldn't apply here.
//
// Needs a free API key from https://isthereanydeal.com/apps/my/ — set
// ITAD_API_KEY in your environment. If unset, this source just skips
// itself; everything else still runs.
//
// NOTE: I could not hit this endpoint live to confirm its current
// response shape (verify against docs.isthereanydeal.com if this logs
// a shape warning or comes back empty when you know a deal is live).
async function getThirdPartyFreebies() {
  const { ITAD_API_KEY } = process.env;
  if (!ITAD_API_KEY) {
    console.log('ITAD_API_KEY not set — skipping third-party (Fanatical/Humble/etc.) freebie check');
    return [];
  }

  const url = `https://api.isthereanydeal.com/deals/v2?key=${ITAD_API_KEY}&country=MY&limit=200`;
  let data;
  try {
    data = await fetchJson(url);
  } catch (e) {
    console.warn('ITAD request failed:', e.message);
    return [];
  }

  const list = data?.list || data?.deals;
  if (!Array.isArray(list)) {
    console.warn('Unexpected ITAD response shape — top-level keys:', Object.keys(data || {}));
    return [];
  }

  const freeDeals = list.filter((deal) => (deal.deal?.cut ?? deal.cut) === 100);
  const thirdPartyFree = freeDeals.filter((deal) => {
    const shop = (deal.deal?.shop?.name || deal.shop?.name || '').toLowerCase();
    return shop && shop !== 'steam'; // Steam already covered by getSteamFreebies()
  });
  console.log(`ITAD deals scanned: ${list.length}, at 100% off: ${freeDeals.length}, non-Steam: ${thirdPartyFree.length}`);

  return thirdPartyFree.map((deal) => ({
    id: `itad:${deal.id || deal.game?.id}`,
    title: deal.title || deal.game?.title,
    storeName: deal.deal?.shop?.name || deal.shop?.name,
    url: deal.deal?.url || deal.url,
  }));
}

async function getFreeGames() {
  const sources = [getSteamFreebies, getEpicFreebies, getThirdPartyFreebies];
  const results = await Promise.allSettled(sources.map((fn) => fn()));

  const freebies = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      freebies.push(...result.value);
    } else {
      console.warn(`Free games source #${i} (${sources[i].name}) failed: ${result.reason?.message}`);
    }
  });
  return freebies;
}

// ─── Deal Scoring ──────────────────────────────────────────────
// Same weighting as the original: price-vs-all-time-low dominates (7),
// discount-vs-original matters some (2), time spent on wishlist adds
// a little patience credit (1).
//
// priceFactor is scaled against THIS GAME's own range (original price
// down to its all-time low), not an unbounded ratio. That keeps it in
// [0, 7]: 7 when today's price ties the all-time low, 0 when it's at
// (or above) full price, and a smooth reward in between. Because
// allTimeLow = min(currentPrice, priorLow) by construction, currentPrice
// can never be below allTimeLow — a naive (1 - currentPrice/allTimeLow)
// ratio is therefore always <= 0 and can never reward a real discount,
// which is why every score floored at 0 before this fix.
function calculateBuyScore({
  currentPrice,
  daysOnWishlist,
  discountPct,
  itadCurrentPrice,
  itadCurrentCurrency,
  itadHistoricalLow,
  itadHistoricalLowCurrency,
  itadDealsForScoring,
}) {
  // 1. Wishlist desire
  const wishlistScore =
    Math.min(daysOnWishlist / 365, 1) * 3;

  // 2. Absolute Steam price
  let affordabilityScore = 0;

  if (currentPrice <= 20) {
    affordabilityScore = 3;
  } else if (currentPrice <= 40) {
    affordabilityScore = 2.5;
  } else if (currentPrice <= 60) {
    affordabilityScore = 2;
  } else if (currentPrice <= 100) {
    affordabilityScore = 1.5;
  } else if (currentPrice <= 150) {
    affordabilityScore = 1;
  } else if (currentPrice <= 200) {
    affordabilityScore = 0.5;
  }

  // 3. Discount is supporting evidence only.
  let discountScore = 0;

  if (discountPct >= 50) {
    discountScore = 1;
  } else if (discountPct >= 30) {
    discountScore = 0.7;
  } else if (discountPct >= 15) {
    discountScore = 0.4;
  } else if (discountPct > 0) {
    discountScore = 0.2;
  }

  // 4. Historical-low proximity.
  // Both values are ITAD prices in the same currency.
  let historicalLowScore = 0;

  const currentItadPrice = Number(itadCurrentPrice);
  const historicalLow = Number(itadHistoricalLow);

  if (
    Number.isFinite(currentItadPrice) &&
    Number.isFinite(historicalLow) &&
    historicalLow > 0 &&
    itadCurrentCurrency &&
    itadHistoricalLowCurrency &&
    itadCurrentCurrency === itadHistoricalLowCurrency
  ) {
  const distancePct =
    ((currentItadPrice - historicalLow) / historicalLow) * 100;

    if (distancePct <= 5) {
      historicalLowScore = 2;
    } else if (distancePct <= 15) {
      historicalLowScore = 1.5;
    } else if (distancePct <= 30) {
      historicalLowScore = 1;
    } else if (distancePct <= 50) {
      historicalLowScore = 0.5;
    }
    }

  // 5. Cross-store advantage.
  // Compare the best tracked-store price against the Steam price
  // reported by ITAD. This is a relative store comparison only;
  // we do not convert currencies manually.
  let crossStoreScore = 0;

  const steamItadDeal = itadDealsForScoring?.find(
    (deal) => deal?.shop?.id === 61
  );

  const bestNonSteamItadDeal = itadDealsForScoring
  ?.filter((deal) => deal?.shop?.id !== 61)
  ?.reduce((best, deal) => {
    if (!best) return deal;

    // Only compare prices when they are in the same currency.
    if (deal.price.currency !== best.price.currency) {
      return best;
    }

    return deal.price.amount < best.price.amount
      ? deal
      : best;
  }, null);

  if (
    steamItadDeal?.price?.amount > 0 &&
    bestNonSteamItadDeal?.price?.amount > 0 &&
    steamItadDeal.price.currency === bestNonSteamItadDeal.price.currency
  ) {
    const storeSavingsPct =
      ((steamItadDeal.price.amount - bestNonSteamItadDeal.price.amount) /
        steamItadDeal.price.amount) *
      100;

    if (storeSavingsPct >= 20) {
      crossStoreScore = 1;
    } else if (storeSavingsPct >= 10) {
      crossStoreScore = 0.7;
    } else if (storeSavingsPct >= 5) {
      crossStoreScore = 0.4;
    }
  }

    const rawScore =
    wishlistScore +
    affordabilityScore +
    discountScore +
    historicalLowScore +
    crossStoreScore;

  const buyScore = Math.max(0, Math.min(10, rawScore));

  return {
  buyScore,
  wishlistScore,
  affordabilityScore,
  discountScore,
  historicalLowScore,
  crossStoreScore,
};
}

// ─── Discord Notification ──────────────────────────────────────
async function sendDiscordAlert(content, embeds = []) {
  const result = await postJson(DISCORD_WEBHOOK_URL, { content, embeds });
  console.log(`Discord webhook response: ${result.status}`);
  if (result.status !== 204) {
    console.warn(`Discord webhook body: ${result.body?.slice(0, 200)}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────
async function main() {
  assertEnv();
  console.log('Deal Radar: Starting check...');
  const now = new Date();
  
 // 1. Get wishlist
let wishlist;
try {
  wishlist = await getWishlist();
} catch (e) {
  console.error('Failed to fetch wishlist:', e.message);
  process.exit(1);
}

// 1b. Sync wishlist to Supabase
try {
  await syncWishlistToDatabase(wishlist);
} catch (e) {
  console.error('Failed to sync wishlist to Supabase:', e.message);
  process.exit(1);
}

try {
  await matchWishlistGamesToItad(wishlist);
} catch (e) {
  console.error('Failed to match wishlist to ITAD:', e.message);
  process.exit(1);
}

    // 1c. Load ITAD IDs from the wishlist
  let wishlistWithItad;
  try {
    wishlistWithItad = await supabaseQuery('wishlist', {
      select: 'app_id,itad_game_id,itad_match_status',
    });
  } catch (e) {
    console.error('Failed to load ITAD wishlist mappings:', e.message);
    process.exit(1);
  }

  const itadIdByAppId = new Map(
  (Array.isArray(wishlistWithItad) ? wishlistWithItad : [])
    .filter((row) => row.itad_game_id)
    .map((row) => [row.app_id, row.itad_game_id])
);

  const historicalLows = await getItadHistoricalLows(
  Array.isArray(wishlistWithItad) ? wishlistWithItad : []
);

const currentItadPrices = await getItadCurrentPrices(
  Array.isArray(wishlistWithItad) ? wishlistWithItad : []
);

    // Diagnostic: show prices from our tracked stores
  console.log('\nTracked-store price check:');

  for (const item of wishlistWithItad) {
    const itad = currentItadPrices.get(item.app_id);

    if (!itad?.trackedDeals?.length) {
      continue;
    }

    const prices = itad.trackedDeals.map((deal) => {
      return `${deal.shop.name}: ${deal.price.amount} ${deal.price.currency}`;
    });

    console.log(`  ${item.app_id}: ${prices.join(' | ')}`);
  }

  console.log('End tracked-store price check.\n');

    // 1d. Load tracked stores
  let trackedStores;
  try {
    trackedStores = await supabaseQuery('tracked_stores', {
      select: 'store_code,store_name,itad_shop_id,enabled,include_in_comparison,priority',
    });

    console.log(
      'Tracked stores:',
      Array.isArray(trackedStores)
        ? trackedStores
            .filter((store) => store.enabled)
            .map((store) => `${store.store_name} (${store.itad_shop_id ?? 'no ITAD ID'})`)
            .join(', ')
        : 'none'
    );
  } catch (e) {
    console.error('Failed to load tracked stores:', e.message);
    process.exit(1);
  }
  
  // 2. Get purchased games
  const purchased = await supabaseQuery('purchased', { select: 'app_id' });
  const purchasedSet = new Set(Array.isArray(purchased) ? purchased.map((r) => r.app_id) : []);
  const toCheck = wishlist.filter((item) => !purchasedSet.has(item.appId));

  // 3. Get last notification times
  const lastNotified = await supabaseQuery('last_notified', { select: 'app_id,last_notification' });
  const cooldownMap = new Map(
    Array.isArray(lastNotified) ? lastNotified.map((r) => [r.app_id, new Date(r.last_notification)]) : []
  );

  const newSnapshots = [];
  const alerts = [];

 // 5. Check each game
for (const item of toCheck) {
  try {
    const game = await getGamePrice(item.appId);
    if (!game) continue;

    const currentPrice = game.cheapest;
    const originalPrice = game.originalPrice;
    const discountPct = game.discountPct;
    const daysOnWishlist = Math.floor(
      (now - new Date(item.addedAt)) / 86400000
    );

        const itad = currentItadPrices.get(item.appId);

    const itadDeals = (itad?.trackedDeals || []).filter(
      (deal) =>
        Number.isFinite(deal?.price?.amount) &&
        deal?.price?.currency
    );

    const bestItadDeal = itadDeals.length
  ? itadDeals.reduce((best, deal) => {
      if (!best) return deal;

      // Only compare prices when they are in the same currency.
      if (deal.price.currency !== best.price.currency) {
        return best;
      }

      return deal.price.amount < best.price.amount
        ? deal
        : best;
    }, null)
  : null;

    const buyScoreData = calculateBuyScore({
  currentPrice,
  daysOnWishlist,
  discountPct,
  itadCurrentPrice: bestItadDeal?.price?.amount ?? null,
  itadCurrentCurrency: bestItadDeal?.price?.currency ?? null,
  itadHistoricalLow: itad?.historyLow?.all?.amount ?? null,
  itadHistoricalLowCurrency: itad?.historyLow?.all?.currency ?? null,
  itadDealsForScoring: itadDeals,
});
    
    const buyDecision = {
  app_id: item.appId,
  game_name: game.title,
  itad_game_id: itadIdByAppId.get(item.appId) ?? null,

  buy_score: buyScoreData.buyScore,
  recommendation:
  buyScoreData.buyScore >= DEAL_SCORE_THRESHOLD
    ? 'buy'
    : 'watch',

  wishlist_score: buyScoreData.wishlistScore,
  discount_score: buyScoreData.discountScore,
  historical_low_score: buyScoreData.historicalLowScore,
  affordability_score: buyScoreData.affordabilityScore,
  cross_store_score: buyScoreData.crossStoreScore,

  current_price: currentPrice,
  current_store: 'Steam',

  itad_current_price: bestItadDeal?.price?.amount ?? null,
  itad_current_currency: bestItadDeal?.price?.currency ?? null,

  historical_low: itad?.historyLow?.all?.amount ?? null,
  historical_low_currency: itad?.historyLow?.all?.currency ?? null,
  historical_low_distance_pct:
  Number.isFinite(Number(bestItadDeal?.price?.amount)) &&
  Number.isFinite(Number(itad?.historyLow?.all?.amount)) &&
  Number(itad?.historyLow?.all?.amount) > 0 &&
  bestItadDeal?.price?.currency &&
  itad?.historyLow?.all?.currency &&
  bestItadDeal.price.currency === itad.historyLow.all.currency
    ? ((Number(bestItadDeal.price.amount) -
        Number(itad.historyLow.all.amount)) /
        Number(itad.historyLow.all.amount)) *
      100
    : null,

  best_store: bestItadDeal?.shop?.name ?? null,
  best_store_price: bestItadDeal?.price?.amount ?? null,
  best_store_currency: bestItadDeal?.price?.currency ?? null,

  wishlist_days: daysOnWishlist,
  evaluated_at: now.toISOString(),
};

    await supabaseInsert('buy_decisions', [buyDecision]);

    console.log(
      `  ${game.title}: ` +
      `price=RM${currentPrice.toFixed(2)} ` +
      `orig=RM${originalPrice.toFixed(2)} ` +
      `disc=${discountPct}% ` +
      `wishlist=${daysOnWishlist}d`
    );
      
newSnapshots.push({
  app_id: item.appId,
  game_name: game.title,
  itad_game_id: itadIdByAppId.get(item.appId) ?? null,
  itad_shop_id: 61,
  price_source: 'steam',
  store: game.storeName.toLowerCase(),
  current_price: currentPrice,
  original_price: originalPrice,
  discount_pct: discountPct,
  all_time_low: null,
  itad_history_low: itad?.historyLow?.all?.amount ?? null,
  itad_history_low_currency: itad?.historyLow?.all?.currency ?? null,
  currency: 'MYR',
  store_url: null,
  deal_score: null,
  sale_end_date: null,
  is_best_current_price: false,
  snapshot_time: now.toISOString(),
});

// Save tracked-store prices from ITAD
for (const deal of itad?.trackedDeals || []) {
  if (deal?.shop?.id === 61) {
  continue;
}
  const shopId = deal?.shop?.id;
  const shopName = deal?.shop?.name;

  if (!shopId || !shopName || !deal?.price?.amount) {
    continue;
  }

  newSnapshots.push({
    app_id: item.appId,
    game_name: game.title,
    itad_game_id: itadIdByAppId.get(item.appId) ?? null,
    itad_shop_id: shopId,
    price_source: 'itad',
    store: shopName.toLowerCase(),
    current_price: deal.price.amount,
    original_price: deal.regular?.amount ?? deal.price.amount,
    discount_pct: deal.cut ?? 0,
    all_time_low: null,
    itad_history_low: itad?.historyLow?.all?.amount ?? null,
    itad_history_low_currency: itad?.historyLow?.all?.currency ?? null,
    currency: deal.price.currency ?? null,
    store_url: deal.url ?? null,
    deal_score: null,
    sale_end_date: deal.expiry ?? null,
    is_best_current_price: false,
    snapshot_time: now.toISOString(),
  });
}

      // Deal alerts are temporarily disabled while we build the new Buy Score.
      // Price snapshots continue to be collected normally.
    } catch (e) {
      console.warn(`Error checking app ${item.appId}: ${e.message}`);
    }

    await new Promise((r) => setTimeout(r, WISHLIST_REQUEST_DELAY_MS));
  }

  // 6. Check free games — Steam-wide, Epic, and third-party keyshops,
  // independent of your wishlist entirely.
  try {
    const freeGames = await getFreeGames();
    const seenFree = await supabaseQuery('free_games_seen', { select: 'item_id' });
    const seenSet = new Set(Array.isArray(seenFree) ? seenFree.map((r) => r.item_id) : []);

    for (const fg of freeGames) {
      if (!fg.id || seenSet.has(fg.id)) continue;
      await sendDiscordAlert(
        `FREE GAME: ${fg.title}\nAvailable on ${fg.storeName}. [Claim Now](${fg.url})`
      );
      await supabaseUpsert('free_games_seen', [{ item_id: fg.id, first_seen: now.toISOString() }], 'item_id');
    }
  } catch (e) {
    console.warn('Free games check failed:', e.message);
  }

  // 7. Insert snapshots (append-only history — insert is correct here, not upsert)
  if (newSnapshots.length > 0) {
    await supabaseInsert('price_snapshots', newSnapshots);
    console.log(`Inserted ${newSnapshots.length} snapshots`);
  }

  // 8. Send deal alerts
  for (const alert of alerts) {
    const embed = {
      title: `DEAL: ${alert.title}`,
      description: [
        `**Score:** ${alert.score.toFixed(2)}/10`,
        `**Price:** RM${alert.currentPrice.toFixed(2)} (was RM${alert.originalPrice.toFixed(2)}, ${alert.discountPct}% off)`,
        `**Store:** ${alert.storeName}`,
        `**On wishlist:** ${alert.daysOnWishlist} days`,
      ].join('\n'),
      color: 0x00ff00,
      url: alert.url,
    };
    try {
      await sendDiscordAlert(`Deal Score ${alert.score.toFixed(2)}`, [embed]);
      await supabaseUpsert('last_notified', [{ app_id: alert.appId, last_notification: now.toISOString() }], 'app_id');
    } catch (e) {
      console.warn(`Failed to send/record alert for ${alert.title}: ${e.message}`);
    }
  }

  console.log(`Done. ${alerts.length} deal alert(s) sent.`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
