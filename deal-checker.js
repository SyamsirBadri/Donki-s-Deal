const https = require('https');
const http = require('http');

const {
  STEAM_API_KEY,
  STEAM_ID,
  DISCORD_WEBHOOK_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
} = process.env;

const DEAL_SCORE_THRESHOLD = 4;
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
      addedAt: new Date(item.date_added * 1000).toISOString(),
    }))
    .filter((i) => i.appId);
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

  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null;
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

// ─── Historical Low Prices ─────────────────────────────────────
// Pulls the lowest recorded current_price per app_id from price_snapshots,
// scoped to the given app IDs, so "all-time low" is real history rather
// than always equal to today's price.
async function getHistoricalLows(appIds) {
  const map = new Map();
  if (appIds.length === 0) return map;

  const idsFilter = `app_id=in.(${appIds.join(',')})`;
  const rows = await supabaseQuery('price_snapshots', {
    select: 'app_id,current_price',
    where: idsFilter,
  });

  for (const row of Array.isArray(rows) ? rows : []) {
    const prev = map.get(row.app_id);
    if (prev === undefined || row.current_price < prev) {
      map.set(row.app_id, row.current_price);
    }
  }
  return map;
}

// ─── Free Games (stub) ─────────────────────────────────────────
async function getFreeGames() {
  return [];
}

// ─── Deal Scoring ──────────────────────────────────────────────
// Same weighting as the original: price-vs-all-time-low dominates (7),
// discount-vs-original matters some (2), time spent on wishlist adds
// a little patience credit (1). Guards against div-by-zero producing NaN.
function calculateDealScore({ currentPrice, originalPrice, allTimeLow, daysOnWishlist }) {
  const priceFactor = allTimeLow > 0 ? (1 - currentPrice / allTimeLow) * 7 : 0;
  const discountFactor = originalPrice > 0 ? (1 - currentPrice / originalPrice) * 2 : 0;
  const patienceFactor = Math.min(daysOnWishlist / 365, 1) * 1;
  const rawScore = priceFactor + discountFactor + patienceFactor;
  const score = Math.max(0, Math.min(10, rawScore));
  return { score, priceFactor, discountFactor, patienceFactor };
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

  // 2. Get purchased games
  const purchased = await supabaseQuery('purchased', { select: 'app_id' });
  const purchasedSet = new Set(Array.isArray(purchased) ? purchased.map((r) => r.app_id) : []);
  const toCheck = wishlist.filter((item) => !purchasedSet.has(item.appId));

  // 3. Get last notification times
  const lastNotified = await supabaseQuery('last_notified', { select: 'app_id,last_notification' });
  const cooldownMap = new Map(
    Array.isArray(lastNotified) ? lastNotified.map((r) => [r.app_id, new Date(r.last_notification)]) : []
  );

  // 4. Get historical lows in one bulk query instead of per-game
  const historicalLows = await getHistoricalLows(toCheck.map((i) => i.appId));

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
      const priorLow = historicalLows.get(item.appId);
      const allTimeLow = priorLow !== undefined ? Math.min(currentPrice, priorLow) : currentPrice;
      const daysOnWishlist = Math.floor((now - new Date(item.addedAt)) / 86400000);

      const { score, priceFactor, discountFactor, patienceFactor } = calculateDealScore({
        currentPrice, originalPrice, allTimeLow, daysOnWishlist,
      });

      console.log(
        `  ${game.title}: score=${score.toFixed(2)} ` +
        `[pf=${priceFactor.toFixed(2)}, df=${discountFactor.toFixed(2)}, pt=${patienceFactor.toFixed(2)}] ` +
        `price=${currentPrice} orig=${originalPrice} atl=${allTimeLow} disc=${discountPct}%`
      );

      newSnapshots.push({
        app_id: item.appId,
        game_name: game.title,
        store: game.storeName.toLowerCase(),
        current_price: currentPrice,
        original_price: originalPrice,
        discount_pct: discountPct,
        all_time_low: allTimeLow,
        deal_score: Math.round(score * 100) / 100,
        sale_end_date: null,
        snapshot_time: now.toISOString(),
      });

      const lastNotif = cooldownMap.get(item.appId);
      const inCooldown = lastNotif && (now - lastNotif) < NOTIFICATION_COOLDOWN_HOURS * 3600000;

      if (score >= DEAL_SCORE_THRESHOLD && !inCooldown && discountPct > 0) {
        alerts.push({
          appId: item.appId,
          title: game.title,
          score,
          currentPrice,
          originalPrice,
          discountPct,
          storeName: game.storeName,
          daysOnWishlist,
          url: game.url,
        });
      }
    } catch (e) {
      console.warn(`Error checking app ${item.appId}: ${e.message}`);
    }

    await new Promise((r) => setTimeout(r, WISHLIST_REQUEST_DELAY_MS));
  }

  // 6. Check free games
  try {
    const freeGames = await getFreeGames();
    const seenFree = await supabaseQuery('free_games_seen', { select: 'app_id' });
    const seenSet = new Set(Array.isArray(seenFree) ? seenFree.map((r) => r.app_id) : []);

    for (const fg of freeGames) {
      const appId = fg.steamAppID || fg.app_id;
      if (!appId || seenSet.has(appId)) continue;
      await sendDiscordAlert(
        `FREE GAME: ${fg.title}\nAvailable on ${fg.storeName}. [Claim Now](${fg.url})`
      );
      await supabaseUpsert('free_games_seen', [{ app_id: appId, first_seen: now.toISOString() }], 'app_id');
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
