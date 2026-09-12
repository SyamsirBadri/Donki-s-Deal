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

const DEAL_SCORE_THRESHOLD = 8;
const NOTIFICATION_COOLDOWN_HOURS = 24;
const DRY_RUN_DEAL_ALERTS = false;
const REQUEST_TIMEOUT_MS = 10000;
const WISHLIST_REQUEST_DELAY_MS = 1000;

// ITAD shop IDs we specifically track for cross-store price comparison.
// 61 = Steam. Cross-reference the others against your `tracked_stores`
// table (or api.isthereanydeal.com/service/shops/v1) if you need names.
const STEAM_ITAD_SHOP_ID = 61;
const TRACKED_ITAD_SHOP_IDS = new Set([STEAM_ITAD_SHOP_ID, 6, 35, 37]);

// ─── Startup validation ────────────────────────────────────────
// ITAD_API_KEY is required here, not optional: wishlist-to-ITAD matching,
// historical lows, and current cross-store prices all depend on it and
// will throw and abort the run if it's missing. Only the third-party
// (Fanatical/Humble/etc.) free-game check treats it as optional, since
// that source is a nice-to-have rather than part of the core deal flow.
function assertEnv() {
  const required = {
    STEAM_API_KEY,
    STEAM_ID,
    DISCORD_WEBHOOK_URL,
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
    ITAD_API_KEY,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }
}

// ─── Secret redaction ──────────────────────────────────────────
// Several URLs we build (Steam wishlist call, ITAD calls, the Discord
// webhook itself) carry a secret inline. If a request fails, the raw URL
// can end up inside an Error message that gets console.error'd — this
// strips known secret values out of any string before it's logged.
// (GitHub Actions also masks registered secrets in log output, but that's
// a safety net, not a reason to leak them into error text in the first place.)
const SECRETS_TO_REDACT = [
  STEAM_API_KEY,
  ITAD_API_KEY,
  DISCORD_WEBHOOK_URL,
  SUPABASE_SERVICE_KEY,
].filter(Boolean);

function redact(str) {
  let out = str;
  for (const secret of SECRETS_TO_REDACT) {
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
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
          reject(new Error(redact(`HTTP ${res.statusCode} from ${url}: ${data.slice(0, 200)}`)));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(redact(`JSON parse error from ${url}: ${data.slice(0, 200)}`))); }
      });
    });
    req.on('error', (e) => reject(new Error(redact(e.message))));
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(redact(`Request timed out: ${url}`))));
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
    req.on('error', (e) => reject(new Error(redact(e.message))));
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(redact(`Request timed out: ${url}`))));
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
          reject(new Error(redact(`Supabase ${method} ${path} -> HTTP ${res.statusCode}: ${resData.slice(0, 300)}`)));
          return;
        }
        if (!resData) { resolve(null); return; }
        try { resolve(JSON.parse(resData)); }
        catch { resolve(resData); }
      });
    });
    req.on('error', (e) => reject(new Error(redact(e.message))));
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(redact(`Supabase request timed out: ${path}`))));
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
// `gameDataByAppId` is the Map already built in main() by the single
// Steam-price-fetch pass — this function makes no network calls of its
// own. (Previously this re-fetched every game's price/title from Steam
// a second time just to read the title, doubling both the request count
// and the per-item rate-limit delay for no benefit — the title was the
// only thing used from that second call.)
async function syncWishlistToDatabase(wishlist, gameDataByAppId) {
  if (wishlist.length === 0) {
    console.log('Wishlist is empty — nothing to sync.');
    return;
  }

  console.log(`Syncing ${wishlist.length} wishlist games to Supabase...`);

  const rows = wishlist.map((item) => {
    const game = gameDataByAppId.get(item.appId);
    return {
      app_id: item.appId,
      game_name: game?.title || `App ${item.appId}`,
      added_at: item.addedAt,
      last_synced: new Date().toISOString(),
    };
  });

  await supabaseUpsert('wishlist', rows, 'app_id');

  console.log(`Wishlist sync complete: ${rows.length} synced`);
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

    const trackedShopIds = TRACKED_ITAD_SHOP_IDS;

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
// block you're hitting on those two shouldn't apply here. ITAD_API_KEY is
// validated as required in assertEnv(), so no separate presence check is
// needed here.
//
// NOTE: this endpoint's response shape (list vs. deals, nesting of
// deal/shop/cut) was not confirmed against a live call while writing this.
// Trigger it during a known-active third-party freebie and check the logs
// below — a silent "0 non-Steam free deals" result with no warning could
// mean the shape assumption is wrong, not that nothing's free right now.
async function getThirdPartyFreebies() {
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

// ─── Buy Scoring ────────────────────────────────────────────────
// V1.1 Buy Score — reflects what's actually implemented below:
//
// Historical-low proximity     up to 3.5 points
// Discount depth                up to 4.0 points
// Personal interest (wishlist)  flat 1.5 points
// Wishlist persistence          up to 0.5 points
// Exceptional deep-discount bonus up to 0.5 points
//
// Total                         10 points
//
// Affordability is stored as an informational field (affordability_score)
// but is hardcoded to 0 and does not add to the score — it's a reserved
// column, not an implemented signal. Cross-store advantage
// (cross_store_score) is likewise hardcoded to 0; the non-Steam price
// comparison that used to feed it was removed entirely (see git history)
// since nothing ever read the values it computed. `best_store` /
// `best_store_price` elsewhere in main() are unrelated — those come from
// the single cheapest tracked deal across all stores (including Steam),
// not from a Steam-vs-non-Steam comparison.
//
// The goal is:
// "Is this a good purchase for me right now?"
//
// Wishlist age is intentionally a weak signal.
// A game being on the wishlist for a long time does NOT mean
// it is inherently more valuable. Age only provides a small
// persistence signal.
//
// Currency safety:
// - Steam current price is MYR.
// - ITAD prices/history are compared only when their currencies match.
// - No manual currency conversion is performed.
//
// Recommendation tiering (buy/watch) is decided by the caller in main()
// against DEAL_SCORE_THRESHOLD, not in here — this function only returns
// the raw score and its components.

function calculateBuyScore({
  currentPrice,
  currentCurrency,
  steamDiscountPct,
  itadCurrentPrice,
  itadCurrentCurrency,
  itadHistoryLow,
  itadHistoryLowCurrency,
  daysOnWishlist,
}) {
  // ------------------------------------------------------------
  // 1. Historical-price quality — 3.5 points
  // How close is the current ITAD price to its historical low?
  // Only compare values when currencies match.
  // ------------------------------------------------------------

  let historicalLowScore = 0;
  let historicalLowDistancePct = null;

  if (
    Number.isFinite(itadCurrentPrice) &&
    Number.isFinite(itadHistoryLow) &&
    itadCurrentCurrency &&
    itadHistoryLowCurrency &&
    itadCurrentCurrency === itadHistoryLowCurrency &&
    itadHistoryLow > 0
  ) {
    historicalLowDistancePct =
      ((itadCurrentPrice - itadHistoryLow) / itadHistoryLow) * 100;

    if (historicalLowDistancePct <= 5) {
      historicalLowScore = 3.5;
    } else if (historicalLowDistancePct <= 15) {
      historicalLowScore = 2.75;
    } else if (historicalLowDistancePct <= 30) {
      historicalLowScore = 2.0;
    } else if (historicalLowDistancePct <= 50) {
      historicalLowScore = 1.0;
    }
  }

  // ------------------------------------------------------------
  // 2. Discount depth — 4.0 points
  // Deeper discounts are increasingly valuable.
  // ------------------------------------------------------------

  let discountScore = 0;
  const discountPct = Number(steamDiscountPct);

  if (Number.isFinite(discountPct)) {
    if (discountPct >= 70) {
      discountScore = 4.0;
    } else if (discountPct >= 60) {
      discountScore = 2.75;
    } else if (discountPct >= 50) {
      discountScore = 2.5;
    } else if (discountPct >= 40) {
      discountScore = 2.0;
    } else if (discountPct >= 30) {
      discountScore = 1.5;
    } else if (discountPct >= 20) {
      discountScore = 1.0;
    } else if (discountPct >= 10) {
      discountScore = 0.5;
    }
  }

  // ------------------------------------------------------------
  // 3. Personal interest — 1.5 points
  // Being on the user's Steam wishlist is the primary signal.
  // ------------------------------------------------------------

  const wishlistScore = 1.5;

  // ------------------------------------------------------------
  // 4. Wishlist persistence — 0.5 points
  // A game that has stayed on the wishlist for a long time gets
  // a small additional boost.
  // ------------------------------------------------------------

  let wishlistPersistenceScore = 0;

  if (daysOnWishlist >= 730) {
    wishlistPersistenceScore = 0.5;
  } else if (daysOnWishlist >= 365) {
    wishlistPersistenceScore = 0.4;
  } else if (daysOnWishlist >= 180) {
    wishlistPersistenceScore = 0.25;
  } else if (daysOnWishlist >= 90) {
    wishlistPersistenceScore = 0.15;
  } else if (daysOnWishlist >= 30) {
    wishlistPersistenceScore = 0.05;
  }

  // ------------------------------------------------------------
  // 5. Cross-store advantage — reserved, not implemented
  // The Steam-vs-non-Steam price comparison that used to feed this was
  // removed (it was computed and never read). Kept as an explicit 0
  // rather than dropping the field, since cross_store_score is still a
  // real column in buy_decisions — wire in a real comparison here if
  // you want this to actually score points later.
  // ------------------------------------------------------------

  const crossStoreScore = 0;

  // ------------------------------------------------------------
  // 6. Exceptional deep-discount bonus — 0.5 points
  // Reward an unusually deep discount when the price is also
  // reasonably close to the historical low.
  // ------------------------------------------------------------

  let exceptionalDealScore = 0;

  if (
    discountPct >= 70 &&
    Number.isFinite(historicalLowDistancePct) &&
    historicalLowDistancePct <= 30
  ) {
    exceptionalDealScore = 0.5;
  }
  
    const buyScore = Math.min(
    10,
    Math.max(
      0,
      historicalLowScore +
        discountScore +
        wishlistScore +
        wishlistPersistenceScore +
        exceptionalDealScore
    )
  );

  // Recommendation tiering happens in main() against DEAL_SCORE_THRESHOLD,
  // not here — see the comment block above this function.

  return {
    buyScore,
    wishlistScore,
    historicalLowScore,
    discountScore,
    affordabilityScore: 0,
    crossStoreScore,
    wishlistPersistenceScore,
    currentPrice,
    currentCurrency,
    historicalLow: itadHistoryLow,
    historicalLowDistancePct,
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

// 1a. Fetch Steam price/title data once per wishlist game.
// This single pass feeds both the Supabase sync below (which only needs
// the title) and the buy-score evaluation loop further down (which needs
// the full price/discount data) — so each game only costs one Steam
// Store API call and one rate-limit delay per run, not two.
const gameDataByAppId = new Map();
for (const item of wishlist) {
  try {
    const game = await getGamePrice(item.appId);
    if (game) {
      gameDataByAppId.set(item.appId, game);
    } else {
      console.warn(`Skipping ${item.appId}: Steam price lookup returned no game data`);
    }
  } catch (e) {
    console.warn(`Failed to fetch Steam data for app ${item.appId}: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, WISHLIST_REQUEST_DELAY_MS));
}

// 1b. Sync wishlist to Supabase
try {
  await syncWishlistToDatabase(wishlist, gameDataByAppId);
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

  // Historical low comes from getItadCurrentPrices()'s /games/prices/v3
  // response (itad.historyLow.all below) — that endpoint already returns
  // it alongside current prices, so there's no separate historical-low
  // fetch here.
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

  // 4. Prepare accumulators for this run's snapshots and alerts
  const newSnapshots = [];
  const alerts = [];

  // 5. Check each game
  // Reuses the Steam price data fetched once in step 1a — no repeat
  // Steam Store API calls or delays needed here.
for (const item of toCheck) {
  try {
    const game = gameDataByAppId.get(item.appId);

if (!game) {
  // Already logged as a warning in step 1a when the lookup failed.
  continue;
}

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
  currentCurrency: 'MYR',
  steamDiscountPct: discountPct,

  itadCurrentPrice: bestItadDeal?.price?.amount ?? null,
  itadCurrentCurrency: bestItadDeal?.price?.currency ?? null,

  itadHistoryLow: itad?.historyLow?.all?.amount ?? null,
  itadHistoryLowCurrency: itad?.historyLow?.all?.currency ?? null,

  daysOnWishlist,
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
  // Reuse the value calculateBuyScore() already derived from the same
  // inputs, instead of recomputing the same formula a second time here.
  historical_low_distance_pct: buyScoreData.historicalLowDistancePct,

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
  itad_shop_id: STEAM_ITAD_SHOP_ID,
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
  if (deal?.shop?.id === STEAM_ITAD_SHOP_ID) {
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

      // ─── Deal alert eligibility ────────────────────────────────────
// Only positive Buy Score recommendations can enter the alert queue.
//
// Notification cooldown prevents the same game from being
// repeatedly alerted every time the workflow runs.
//
// Discord sending itself remains protected by DRY_RUN_DEAL_ALERTS.

if (buyDecision.recommendation === 'buy') {
  const lastNotification = cooldownMap.get(item.appId);

  const cooldownExpired =
    !lastNotification ||
    (now - lastNotification) >=
      NOTIFICATION_COOLDOWN_HOURS * 60 * 60 * 1000;

  if (cooldownExpired) {
    alerts.push({
      appId: item.appId,
      title: game.title,
      score: buyDecision.buy_score,
      currentPrice,
      originalPrice,
      discountPct,
      daysOnWishlist,
      storeName: 'Steam',
      url: game.url,
    });

    console.log(
      `  ALERT ELIGIBLE: ${game.title} ` +
      `(score=${buyDecision.buy_score.toFixed(2)}, ` +
      `price=RM${currentPrice.toFixed(2)})`
    );
  } else {
    console.log(
      `  ALERT COOLDOWN: ${game.title} ` +
      `(last notified ${lastNotification.toISOString()})`
    );
  }
}
    
    } catch (e) {
      console.warn(`Error checking app ${item.appId}: ${e.message}`);
    }
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
let sentDealAlerts = 0;
let failedDealAlerts = 0;

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

  if (DRY_RUN_DEAL_ALERTS) {
    console.log(
      `DRY RUN — would send deal alert: ${alert.title} ` +
      `(score=${alert.score.toFixed(2)}, price=RM${alert.currentPrice.toFixed(2)})`
    );
    continue;
  }

  try {
    await sendDiscordAlert(
      `Deal Score ${alert.score.toFixed(2)}`,
      [embed]
    );

        // Record the successful notification in permanent history.
    await supabaseInsert('notification_log', [{
      app_id: alert.appId,
      game_name: alert.title,
      notification_type: 'deal',
      buy_score: alert.score,
      store: alert.storeName,
      price: alert.currentPrice,
      currency: 'MYR',
      historical_low: null,
      sent_at: now.toISOString(),
    }]);

    // Update cooldown state only after Discord delivery and
    // notification history have both been recorded.
    await supabaseUpsert(
      'last_notified',
      [{
        app_id: alert.appId,
        last_notification: now.toISOString(),
      }],
      'app_id'
    );

    sentDealAlerts++;

    console.log(
      `Sent deal alert: ${alert.title} ` +
      `(score=${alert.score.toFixed(2)}, price=RM${alert.currentPrice.toFixed(2)})`
    );
  } catch (e) {
    failedDealAlerts++;

    console.warn(
      `Failed to send/record alert for ${alert.title}: ${e.message}`
    );
  }
}

if (DRY_RUN_DEAL_ALERTS) {
  console.log(
    `Done. ${alerts.length} deal alert(s) eligible; ` +
    `Discord delivery skipped because DRY_RUN_DEAL_ALERTS=true.`
  );
} else {
  console.log(
    `Done. ${sentDealAlerts} deal alert(s) sent, ` +
    `${failedDealAlerts} failed.`
  );
}
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
