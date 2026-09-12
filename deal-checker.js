const https = require('https');
const http = require('http');
const zlib = require('zlib');

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
const MIN_HISTORY_DAYS_FOR_LOW = 14;
const DRY_RUN_DEAL_ALERTS = false;
const REQUEST_TIMEOUT_MS = 10000;
const WISHLIST_REQUEST_DELAY_MS = 1000;
const STEAM_BATCH_SIZE = 20;
const STEAM_BATCH_DELAY_MS = 2000;

const STEAM_ITAD_SHOP_ID = 61;
const DEFAULT_TRACKED_ITAD_SHOP_IDS = new Set([STEAM_ITAD_SHOP_ID, 6, 35, 37]);

// ─── Startup validation ────────────────────────────────────────
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
// Include URL-encoded variants so encoded keys in URLs are also
// masked if they leak into an error message.
const SECRETS_TO_REDACT = [
  STEAM_API_KEY,
  ITAD_API_KEY,
  DISCORD_WEBHOOK_URL,
  SUPABASE_SERVICE_KEY,
]
  .filter(Boolean)
  .flatMap((s) => [s, encodeURIComponent(s)]);

function redact(input) {
  const str = typeof input === 'string' ? input : String(input);
  let out = str;
  for (const secret of SECRETS_TO_REDACT) {
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
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
      // Steam (and some other APIs) gzip large responses, including
      // error bodies. Without this, HTTP 4xx/5xx bodies print as
      // binary garbage and we can't see the real error.
      let stream = res;
      const encoding = res.headers['content-encoding'];
      if (encoding === 'gzip') {
        stream = res.pipe(zlib.createGunzip());
        stream.on('error', (e) => reject(new Error(redact(`gunzip failed for ${url}: ${e.message}`))));
      } else if (encoding === 'deflate') {
        stream = res.pipe(zlib.createInflate());
        stream.on('error', (e) => reject(new Error(redact(`inflate failed for ${url}: ${e.message}`))));
      }

      let data = '';
      stream.on('data', (chunk) => (data += chunk));
      stream.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(redact(`HTTP ${res.statusCode} from ${url}: ${data.slice(0, 300)}`)));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(redact(`JSON parse error from ${url}: ${data.slice(0, 300)}`))); }
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

async function supabaseUpsert(table, rows, conflictColumn) {
  const path = `${table}?on_conflict=${conflictColumn}`;
  return supabaseRequest('POST', path, {
    body: rows,
    headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
  });
}

// Calls the Postgres function we just created.
// Returns Map<app_id, { historicalLow, firstSeen }>.
async function getSteamPriceLows(appIds) {
  if (!Array.isArray(appIds) || appIds.length === 0) return new Map();
  const rows = await supabaseRequest('POST', 'rpc/get_steam_price_lows', {
    body: { app_ids: appIds },
  });
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (
      row &&
      row.app_id != null &&
      Number.isFinite(Number(row.historical_low)) &&
      row.first_seen
    ) {
      map.set(row.app_id, {
        historicalLow: Number(row.historical_low),
        firstSeen: new Date(row.first_seen),
      });
    }
  }
  return map;
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

  const existing = await supabaseQuery('wishlist', {
    select: 'app_id,itad_game_id,itad_match_status',
    where: `app_id=in.(${wishlist.map((item) => item.appId).join(',')})`,
  });

  const existingMap = new Map(
    (Array.isArray(existing) ? existing : []).map((row) => [row.app_id, row])
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(appIds.map((appId) => `app/${appId}`)),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(redact(`ITAD batch lookup failed (${response.status}): ${text}`));
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
      console.log(`  Matched: ${item.appId} → ${itadGameId}`);
    } else {
      updates.push({
        app_id: item.appId,
        itad_game_id: null, // ← explicit null, not undefined
        itad_match_status: 'failed',
        itad_match_source: 'steam_appid',
      });
      failed++;
      console.log(`  No ITAD match: ${item.appId}`);
    }
  }

  if (updates.length > 0) {
    await supabaseUpsert('wishlist', updates, 'app_id');
  }

  console.log(`ITAD matching complete: ${matched} matched, ${failed} not found`);
}

// ─── Wishlist Database Sync ───────────────────────────────────
async function syncWishlistToDatabase(wishlist, gameDataByAppId) {
  if (wishlist.length === 0) {
    console.log('Wishlist is empty — nothing to sync.');
    return;
  }

  console.log(`Syncing ${wishlist.length} wishlist games to Supabase...`);

  const rows = wishlist.map((item) => {
    const game = gameDataByAppId.get(item.appId);
    const row = {
      app_id: item.appId,
      added_at: item.addedAt,
      last_synced: new Date().toISOString(),
    };
    // Only include game_name if we have a real title. Omitting it
    // leaves the existing DB value untouched (upsert only updates
    // the columns present in the row) instead of blanking it with
    // "App 12345" when Steam prices fail.
    if (game?.title) {
      row.game_name = game.title;
    }
    return row;
  });

  await supabaseUpsert('wishlist', rows, 'app_id');

  console.log(`Wishlist sync complete: ${rows.length} synced`);
}

// ─── Steam Store Prices (Malaysia, batched) ────────────────────
// Fetches price + title for the whole wishlist in batches, instead
// of one HTTP request per game. Steam's appdetails endpoint accepts
// comma-separated appids and returns an object keyed by appid string.
//
// Returns Map<app_id, { title, cheapest, originalPrice, discountPct,
//                       isOnSale, storeName, url }> — the same shape
// the old single-game getGamePrice() returned, so downstream code
// doesn't need to change.
async function fetchAllSteamPrices(appIds) {
  const result = new Map();
  if (!Array.isArray(appIds) || appIds.length === 0) return result;

  const batches = chunk(appIds, STEAM_BATCH_SIZE);
  console.log(`Steam price fetch: ${appIds.length} games in ${batches.length} batch(es)`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    let data = await fetchSteamBatch(batch, i + 1, batches.length);

    // One retry after a longer pause — covers transient rate limits.
    if (!data) {
      console.warn(`  Retrying batch ${i + 1} after 5s...`);
      await new Promise((r) => setTimeout(r, 5000));
      data = await fetchSteamBatch(batch, i + 1, batches.length);
    }

    if (!data) {
      console.warn(`  Batch ${i + 1} failed twice; skipping ${batch.length} games.`);
      // No fallback to single-appid here yet — see if the retry
      // succeeds first. If a batch genuinely can't be fetched,
      // we'll know from the log and can add a fallback.
    } else {
      for (const appId of batch) {
        const entry = data?.[appId];
        if (!entry?.data?.name) {
          console.log(`  No Steam data for ${appId}`);
          continue;
        }

        const priceOverview = entry.data.price_overview;

        if (!priceOverview) {
          const isComingSoon = entry.data.release_date?.coming_soon === true;
          const isFree = entry.data.is_free === true;
          if (isComingSoon) {
            console.log(`  Coming soon (no price yet): ${appId} — ${entry.data.name}`);
          } else if (isFree) {
            console.log(`  Free-to-play: ${appId} — ${entry.data.name}`);
          } else {
            console.log(`  No Steam-MY price: ${appId} — ${entry.data.name}`);
          }
          continue;
        }

        const currentPrice = priceOverview.final / 100;
        const originalPrice = priceOverview.initial / 100;
        const discountPct = priceOverview.discount_percent || 0;

        if (!Number.isFinite(currentPrice) || currentPrice < 0) continue;
        if (!Number.isFinite(originalPrice) || originalPrice <= 0) continue;

        result.set(Number(appId), {
          title: entry.data.name,
          cheapest: currentPrice,
          originalPrice,
          discountPct,
          isOnSale: discountPct > 0,
          storeName: 'Steam',
          url: `https://store.steampowered.com/app/${appId}`,
        });
      }
    }

    if (i < batches.length - 1) {
      await new Promise((r) => setTimeout(r, STEAM_BATCH_DELAY_MS));
    }
  }

  return result;
}

async function fetchSteamBatch(batch, index, total) {
  // No `filters` param — it's a known source of 400s when combined
  // with multiple appids. The full response is larger but reliable,
  // and we only read the fields we need.
  const url =
    `https://store.steampowered.com/api/appdetails` +
    `?appids=${batch.join(',')}&cc=my`;

  try {
    return await fetchJson(url);
  } catch (e) {
    console.warn(`Steam batch ${index}/${total} failed: ${redact(e.message)}`);
    return null;
  }
}

// ─── ITAD Current Prices ───────────────────────────────────────
// Returns Map<app_id, { historyLow, trackedDeals, rawDeals }>.
// `trackedDeals` is filtered to TRACKED_ITAD_SHOP_IDS and deduped
// per-shop (cheapest per store). `rawDeals` is everything ITAD sent,
// used for the informational "other stores" line in Discord.
async function getItadCurrentPrices(wishlistRows, trackedShopIds) {
  const map = new Map();

  const games = wishlistRows.filter((item) => item.itad_game_id);
  if (games.length === 0) {
    console.log('No ITAD-matched wishlist games to query for current prices.');
    return map;
  }

  const itadGameIds = games.map((item) => item.itad_game_id);

  const url =
    `https://api.isthereanydeal.com/games/prices/v3` +
    `?key=${encodeURIComponent(ITAD_API_KEY)}&country=MY`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(itadGameIds),
  });

  if (!response.ok) {
    const text = await response.text();
    console.warn(redact(`ITAD current-price lookup failed (${response.status}): ${text}`));
    return new Map();
  }

  const results = await response.json();
  const itadToAppId = new Map(games.map((g) => [g.itad_game_id, g.app_id]));

  for (const result of Array.isArray(results) ? results : []) {
    const appId = itadToAppId.get(result?.id);
    if (!appId) continue;

        const trackedDealsByShop = new Map();
    for (const deal of result?.deals || []) {
      const shopId = deal?.shop?.id;
      if (!trackedShopIds.has(shopId)) continue;
      const existing = trackedDealsByShop.get(shopId);
      if (!existing || deal?.price?.amount < existing?.price?.amount) {
        trackedDealsByShop.set(shopId, deal);
      }
    }

    map.set(appId, {
      historyLow: result?.historyLow,
      trackedDeals: Array.from(trackedDealsByShop.values()),
      rawDeals: result?.deals || [],
    });
  }

  console.log(`ITAD current prices: ${map.size}/${games.length} games returned`);
  return map;
}

// ─── Free Games ────────────────────────────────────────────────
async function getSteamFreebies() {
  const url = 'https://store.steampowered.com/api/featuredcategories?cc=my&l=english';
  const data = await fetchJson(url);
  const items = data?.specials?.items || [];
  const freebies = items.filter((item) => item.discount_percent === 100);
  console.log(`Steam specials scanned: ${items.length}, at 100% off: ${freebies.length}`);
  return freebies
    .filter((item) => item.id && item.name)
    .map((item) => ({
      id: `steam:${item.id}`,
      title: item.name,
      storeName: 'Steam',
      url: `https://store.steampowered.com/app/${item.id}`,
    }));
}

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

  return freebies
    .filter((el) => el.id && el.title)
    .map((el) => ({
      id: `epic:${el.id}`,
      title: el.title,
      storeName: 'Epic Games',
      url: el.productSlug
        ? `https://store.epicgames.com/p/${el.productSlug}`
        : 'https://store.epicgames.com/en-US/free-games',
    }));
}

async function getThirdPartyFreebies() {
  const url = `https://api.isthereanydeal.com/deals/v2?key=${encodeURIComponent(ITAD_API_KEY)}&country=MY&limit=200`;
  let data;
  try {
    data = await fetchJson(url);
  } catch (e) {
    console.warn('ITAD request failed:', redact(e.message));
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
    return shop && shop !== 'steam';
  });
  console.log(`ITAD deals scanned: ${list.length}, at 100% off: ${freeDeals.length}, non-Steam: ${thirdPartyFree.length}`);

  return thirdPartyFree
    .map((deal) => ({
      id: `itad:${deal.id || deal.game?.id}`,
      title: deal.title || deal.game?.title,
      storeName: deal.deal?.shop?.name || deal.shop?.name,
      url: deal.deal?.url || deal.url,
    }))
    .filter((fg) => fg.id && fg.title && fg.url);
}

async function getFreeGames() {
  const sources = [getSteamFreebies, getEpicFreebies, getThirdPartyFreebies];
  const results = await Promise.allSettled(sources.map((fn) => fn()));

  const freebies = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      freebies.push(...result.value);
    } else {
      console.warn(`Free games source #${i} (${sources[i].name}) failed: ${redact(result.reason?.message || String(result.reason))}`);
    }
  });
  return freebies;
}

// ─── Buy Scoring (Option A: Steam-only, MYR) ──────────────────
// Everything scored is Steam and MYR:
//   Historical-low proximity  up to 3.5 pts  (Steam current vs Steam low, both MYR)
//   Discount depth            up to 4.0 pts  (% only, currency-agnostic)
//   Personal interest           flat 1.5 pts (on the Steam wishlist)
//   Wishlist persistence      up to 0.5 pts  (age)
//   Exceptional bonus         up to 0.5 pts  (deep discount + near low)
//
// Cold start: if we have no Steam historical low yet for a game, the
// historical-low component contributes 0. Scores cap at 6.5/10 until
// ~30 days of snapshots exist. Nothing is seeded — we only score what
// we've actually observed.
//
// Cross-store prices are NOT scored. They appear in the Discord embed
// as informational lines in their native currency (USD).
function calculateBuyScore({
  currentPrice,
  currentCurrency,
  steamDiscountPct,
  steamHistoricalLow,
  steamHistoricalLowCurrency,
  daysOnWishlist,
}) {
  // 1. Historical-low proximity (Steam-MY vs Steam-MY) — 3.5 pts
  let historicalLowScore = 0;
  let historicalLowDistancePct = null;

  if (
    Number.isFinite(currentPrice) &&
    Number.isFinite(steamHistoricalLow) &&
    steamHistoricalLow > 0 &&
    currentCurrency &&
    steamHistoricalLowCurrency &&
    currentCurrency === steamHistoricalLowCurrency
  ) {
    historicalLowDistancePct =
      ((currentPrice - steamHistoricalLow) / steamHistoricalLow) * 100;

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

  // 2. Discount depth — 4.0 pts
  let discountScore = 0;
  const discountPct = Number(steamDiscountPct);

  if (Number.isFinite(discountPct)) {
    if (discountPct >= 70) discountScore = 4.0;
    else if (discountPct >= 60) discountScore = 2.75;
    else if (discountPct >= 50) discountScore = 2.5;
    else if (discountPct >= 40) discountScore = 2.0;
    else if (discountPct >= 30) discountScore = 1.5;
    else if (discountPct >= 20) discountScore = 1.0;
    else if (discountPct >= 10) discountScore = 0.5;
  }

  // 3. Personal interest — flat 1.5 pts
  const wishlistScore = 1.5;

  // 4. Wishlist persistence — 0.5 pts
  let wishlistPersistenceScore = 0;
  if (daysOnWishlist >= 730) wishlistPersistenceScore = 0.5;
  else if (daysOnWishlist >= 365) wishlistPersistenceScore = 0.4;
  else if (daysOnWishlist >= 180) wishlistPersistenceScore = 0.25;
  else if (daysOnWishlist >= 90) wishlistPersistenceScore = 0.15;
  else if (daysOnWishlist >= 30) wishlistPersistenceScore = 0.05;

  // 5. Exceptional deep-discount bonus — 0.5 pts
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

  return {
    buyScore,
    wishlistScore,
    historicalLowScore,
    discountScore,
    wishlistPersistenceScore,
    exceptionalDealScore,
    currentPrice,
    currentCurrency,
    historicalLow: steamHistoricalLow,
    historicalLowCurrency: steamHistoricalLowCurrency,
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
    console.error('Failed to fetch wishlist:', redact(e.message));
    process.exit(1);
  }

  // 1a. Fetch Steam price/title data for the whole wishlist in batches.
  let gameDataByAppId;
  try {
    gameDataByAppId = await fetchAllSteamPrices(wishlist.map((w) => w.appId));
  } catch (e) {
    console.error('Failed to fetch Steam prices:', redact(e.message));
    process.exit(1);
  }
  if (gameDataByAppId.size === 0) {
    console.warn('No Steam prices fetched — check the batch logs above.');
  } else {
    console.log(`Steam prices fetched: ${gameDataByAppId.size}/${wishlist.length}`);
  }

  // 1b. Sync wishlist to Supabase
  try {
    await syncWishlistToDatabase(wishlist, gameDataByAppId);
  } catch (e) {
    console.error('Failed to sync wishlist to Supabase:', redact(e.message));
    process.exit(1);
  }

  // 1c. Match wishlist games to ITAD (skip already-matched)
  try {
    await matchWishlistGamesToItad(wishlist);
  } catch (e) {
    console.error('Failed to match wishlist to ITAD:', redact(e.message));
    process.exit(1);
  }

  // 1d. Load ITAD IDs from the wishlist
  let wishlistWithItad;
  try {
    wishlistWithItad = await supabaseQuery('wishlist', {
      select: 'app_id,itad_game_id,itad_match_status',
    });
  } catch (e) {
    console.error('Failed to load ITAD wishlist mappings:', redact(e.message));
    process.exit(1);
  }

  const itadIdByAppId = new Map(
    (Array.isArray(wishlistWithItad) ? wishlistWithItad : [])
      .filter((row) => row.itad_game_id)
      .map((row) => [row.app_id, row.itad_game_id])
  );

  // 1e. Load Steam-MY historical lows from our own snapshots
  const currentAppIds = wishlist.map((w) => w.appId);
  let steamLowByAppId = new Map();
  try {
    steamLowByAppId = await getSteamPriceLows(currentAppIds);
    console.log(`Steam historical lows known for ${steamLowByAppId.size}/${currentAppIds.length} games`);
  } catch (e) {
    console.warn('Failed to load Steam historical lows:', redact(e.message));
  }

  // 1f. Load tracked stores — the source of truth for which ITAD
  // shops count as "tracked" for cross-store snapshots and alerts.
  // Falls back to DEFAULT_TRACKED_ITAD_SHOP_IDS if the query fails
  // or the table is empty.
  let trackedShopIds = DEFAULT_TRACKED_ITAD_SHOP_IDS;
  try {
    const trackedStores = await supabaseQuery('tracked_stores', {
      select: 'store_code,store_name,itad_shop_id,enabled,include_in_comparison,priority',
    });

    if (Array.isArray(trackedStores) && trackedStores.length > 0) {
      const enabled = trackedStores.filter(
        (s) => s.enabled && s.include_in_comparison && s.itad_shop_id != null
      );

      if (enabled.length > 0) {
        trackedShopIds = new Set(enabled.map((s) => s.itad_shop_id));
        // Steam is always included, even if its row is misconfigured.
        trackedShopIds.add(STEAM_ITAD_SHOP_ID);
      }

      console.log(
        'Tracked stores:',
        trackedStores
          .filter((s) => s.enabled)
          .map((s) => `${s.store_name} (${s.itad_shop_id ?? 'no ITAD ID'})`)
          .join(', ')
      );
    } else {
      console.warn('tracked_stores is empty — using default shop list');
    }
  } catch (e) {
    console.warn('Failed to load tracked stores, using defaults:', redact(e.message));
  }

  // 1g. Load ITAD current prices (informational — cross-store)
  const currentItadPrices = await getItadCurrentPrices(
    Array.isArray(wishlistWithItad) ? wishlistWithItad : [],
    trackedShopIds
  );

  // 2. Get purchased games
  const purchased = await supabaseQuery('purchased', { select: 'app_id' });
  const purchasedSet = new Set(Array.isArray(purchased) ? purchased.map((r) => r.app_id) : []);
  const toCheck = wishlist.filter((item) => !purchasedSet.has(item.appId));

  // 3. Get last notification times
  const lastNotified = await supabaseQuery('last_notified', { select: 'app_id,last_notification' });
  const cooldownMap = new Map(
    Array.isArray(lastNotified) ? lastNotified.map((r) => [r.app_id, new Date(r.last_notification)]) : []
  );

  // 4. Accumulators
  const newSnapshots = [];
  const alerts = [];

  // 5. Check each game
  for (const item of toCheck) {
    try {
      const game = gameDataByAppId.get(item.appId);
      if (!game) continue;

      const currentPrice = game.cheapest;
      const originalPrice = game.originalPrice;
      const discountPct = game.discountPct;

      // Guard against null addedAt (some Steam wishlist items lack it).
      const addedAt = item.addedAt ? new Date(item.addedAt) : null;
      const daysOnWishlist = addedAt
        ? Math.max(0, Math.floor((now - addedAt) / 86400000))
        : 0;

      const itad = currentItadPrices.get(item.appId);

      const lowRecord = steamLowByAppId.get(item.appId);
      let effectiveSteamLow = null;
      if (lowRecord) {
        const historyDays = (now - lowRecord.firstSeen) / 86400000;
        if (historyDays >= MIN_HISTORY_DAYS_FOR_LOW) {
          effectiveSteamLow = Math.min(lowRecord.historicalLow, currentPrice);
        }
      }

      // Best non-Steam ITAD deal (informational only)
      const nonSteamDeals = (itad?.rawDeals || []).filter(
        (deal) =>
          deal?.shop?.id !== STEAM_ITAD_SHOP_ID &&
          Number.isFinite(deal?.price?.amount) &&
          deal?.price?.currency
      );
      const otherStores = nonSteamDeals
        .sort((a, b) => a.price.amount - b.price.amount)
        .slice(0, 4);

      const buyScoreData = calculateBuyScore({
        currentPrice,
        currentCurrency: 'MYR',
        steamDiscountPct: discountPct,
        steamHistoricalLow: effectiveSteamLow,
        steamHistoricalLowCurrency: effectiveSteamLow != null ? 'MYR' : null,
        daysOnWishlist,
      });

      const buyDecision = {
        app_id: item.appId,
        game_name: game.title,
        itad_game_id: itadIdByAppId.get(item.appId) ?? null,

        buy_score: buyScoreData.buyScore,
        recommendation: buyScoreData.buyScore >= DEAL_SCORE_THRESHOLD ? 'buy' : 'watch',

        wishlist_score: buyScoreData.wishlistScore,
        discount_score: buyScoreData.discountScore,
        historical_low_score: buyScoreData.historicalLowScore,
        affordability_score: 0,
        cross_store_score: 0,
        wishlist_persistence_score: buyScoreData.wishlistPersistenceScore,
        exceptional_deal_score: buyScoreData.exceptionalDealScore,

        discount_pct: discountPct,
        current_price: currentPrice,
        current_currency: 'MYR',
        current_store: 'Steam',

        historical_low: itad?.historyLow?.all?.amount ?? null,
        historical_low_currency: itad?.historyLow?.all?.currency ?? null,
        historical_low_steam: effectiveSteamLow,
        historical_low_steam_currency: effectiveSteamLow != null ? 'MYR' : null,
        historical_low_distance_pct: buyScoreData.historicalLowDistancePct,

        itad_current_price: nonSteamDeals[0]?.price?.amount ?? null,
        itad_current_currency: nonSteamDeals[0]?.price?.currency ?? null,

        best_store: nonSteamDeals[0]?.shop?.name ?? 'Steam',
        best_store_price: nonSteamDeals[0]?.price?.amount ?? currentPrice,
        best_store_currency: nonSteamDeals[0]?.price?.currency ?? 'MYR',

        wishlist_days: daysOnWishlist,
        evaluated_at: now.toISOString(),
      };

      await supabaseInsert('buy_decisions', [buyDecision]);

      console.log(
        `  ${game.title}: ` +
        `price=RM${currentPrice.toFixed(2)} ` +
        `disc=${discountPct}% ` +
        `low=${effectiveSteamLow != null ? 'RM' + effectiveSteamLow.toFixed(2) : 'none'} ` +
        `score=${buyScoreData.buyScore.toFixed(2)} ` +
        `wishlist=${daysOnWishlist}d`
      );

      newSnapshots.push({
        app_id: item.appId,
        game_name: game.title,
        itad_game_id: itadIdByAppId.get(item.appId) ?? null,
        itad_shop_id: STEAM_ITAD_SHOP_ID,
        price_source: 'steam',
        store: 'steam',
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

      // Save tracked-store prices from ITAD (informational)
      for (const deal of itad?.trackedDeals || []) {
        if (deal?.shop?.id === STEAM_ITAD_SHOP_ID) continue;
        const shopId = deal?.shop?.id;
        const shopName = deal?.shop?.name;
        if (!shopId || !shopName || !Number.isFinite(deal?.price?.amount)) continue;

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

      // Deal alert eligibility
      if (buyDecision.recommendation === 'buy') {
        const lastNotification = cooldownMap.get(item.appId);
        const cooldownExpired =
          !lastNotification ||
          (now - lastNotification) >= NOTIFICATION_COOLDOWN_HOURS * 60 * 60 * 1000;

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
            steamHistoricalLow: effectiveSteamLow,
            steamHistoricalLowDistancePct: buyScoreData.historicalLowDistancePct,
            otherStores: otherStores.map((d) => ({
              shopName: d.shop.name,
              price: d.price.amount,
              currency: d.price.currency,
            })),
          });
          console.log(`  ALERT ELIGIBLE: ${game.title} (score=${buyDecision.buy_score.toFixed(2)})`);
        } else {
          console.log(`  ALERT COOLDOWN: ${game.title} (last notified ${lastNotification.toISOString()})`);
        }
      }
    } catch (e) {
      console.warn(`Error checking app ${item.appId}: ${redact(e.message)}`);
    }
  }

  // 6. Free games — isolated try/catch per source and per item.
  try {
    const freeGames = await getFreeGames();
    const seenFree = await supabaseQuery('free_games_seen', { select: 'item_id' });
    const seenSet = new Set(Array.isArray(seenFree) ? seenFree.map((r) => r.item_id) : []);

    for (const fg of freeGames) {
      if (!fg.id || seenSet.has(fg.id)) continue;
      try {
        await sendDiscordAlert(
          `FREE GAME: ${fg.title}\nAvailable on ${fg.storeName}. [Claim Now](${fg.url})`
        );
        await supabaseUpsert(
          'free_games_seen',
          [{
            item_id: fg.id,
            first_seen: now.toISOString(),
            game_name: fg.title,
            store: fg.storeName,
            store_url: fg.url,
          }],
          'item_id'
        );
      } catch (e) {
        console.warn(`Free game alert failed for ${fg.id}: ${redact(e.message)}`);
      }
    }
  } catch (e) {
    console.warn('Free games check failed:', redact(e.message));
  }

  // 7. Send deal alerts BEFORE snapshot insert — an insert failure
  // must not prevent notifications.
  let sentDealAlerts = 0;
  let failedDealAlerts = 0;

  for (const alert of alerts) {
    const fields = [];

    if (alert.steamHistoricalLow != null) {
      const distance = alert.steamHistoricalLowDistancePct;
      fields.push({
        name: 'Steam historical low (tracker)',
        value:
          `RM${alert.steamHistoricalLow.toFixed(2)} ` +
          `(${distance >= 0 ? '+' : ''}${distance.toFixed(1)}% vs current)`,
        inline: false,
      });
    } else {
      fields.push({
        name: 'Steam historical low (tracker)',
        value: 'Not yet recorded — building history',
        inline: false,
      });
    }

    if (alert.otherStores?.length) {
      fields.push({
        name: 'Other stores (informational, not scored)',
        value: alert.otherStores
          .map((s) => `• ${s.shopName} — ${s.price} ${s.currency}`)
          .join('\n'),
        inline: false,
      });
    }

    const embed = {
      title: `DEAL: ${alert.title}`,
      description: [
        `**Score:** ${alert.score.toFixed(2)}/10`,
        `**Steam:** RM${alert.currentPrice.toFixed(2)} ` +
          `(was RM${alert.originalPrice.toFixed(2)}, ${alert.discountPct}% off)`,
        `**On wishlist:** ${alert.daysOnWishlist} days`,
      ].join('\n'),
      color: 0x00ff00,
      url: alert.url,
      fields,
    };

    if (DRY_RUN_DEAL_ALERTS) {
      console.log(
        `DRY RUN — would send deal alert: ${alert.title} ` +
        `(score=${alert.score.toFixed(2)}, price=RM${alert.currentPrice.toFixed(2)})`
      );
      continue;
    }

    try {
      await sendDiscordAlert(`Deal Score ${alert.score.toFixed(2)}`, [embed]);

      // Record cooldown state immediately after Discord send so a
      // logging failure below can't cause a repeat on the next run.
      await supabaseUpsert(
        'last_notified',
        [{ app_id: alert.appId, last_notification: now.toISOString() }],
        'app_id'
      );

      sentDealAlerts++;

      try {
        await supabaseInsert('notification_log', [{
          app_id: alert.appId,
          game_name: alert.title,
          notification_type: 'deal',
          buy_score: alert.score,
          store: alert.storeName,
          price: alert.currentPrice,
          currency: 'MYR',
          historical_low: alert.steamHistoricalLow,
          sent_at: now.toISOString(),
        }]);
      } catch (e) {
        console.warn(`notification_log insert failed for ${alert.title}: ${redact(e.message)}`);
      }

      console.log(
        `Sent deal alert: ${alert.title} ` +
        `(score=${alert.score.toFixed(2)}, price=RM${alert.currentPrice.toFixed(2)})`
      );
    } catch (e) {
      failedDealAlerts++;
      console.warn(`Failed to send alert for ${alert.title}: ${redact(e.message)}`);
    }
  }

  // 8. Insert snapshots AFTER alerts (failure here no longer blocks notifications).
  if (newSnapshots.length > 0) {
    try {
      await supabaseInsert('price_snapshots', newSnapshots);
      console.log(`Inserted ${newSnapshots.length} snapshots`);
    } catch (e) {
      console.warn(`Snapshot insert failed: ${redact(e.message)}`);
    }
  }

  if (DRY_RUN_DEAL_ALERTS) {
    console.log(`Done. ${alerts.length} deal alert(s) eligible; Discord delivery skipped.`);
  } else {
    console.log(`Done. ${sentDealAlerts} deal alert(s) sent, ${failedDealAlerts} failed.`);
  }
}

main().catch((e) => {
  console.error('Fatal:', redact(e.stack || e.message || String(e)));
  process.exit(1);
});
