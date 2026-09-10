const https = require('https');
const http = require('http');

const {
  STEAM_API_KEY,
  STEAM_ID,
  DISCORD_WEBHOOK_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
} = process.env;

const DEAL_SCORE_THRESHOLD = 8;
const NOTIFICATION_COOLDOWN_HOURS = 24;

// ─── HTTP Helper ───────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'DealRadar/1.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
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
    req.write(data);
    req.end();
  });
}

// ─── Supabase Helper (REST API) ────────────────────────────────
async function supabaseQuery(table, { select = '*', where = '', method = 'GET', body = null } = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${table}${where ? `?${where}` : ''}`;
  return new Promise((resolve, reject) => {
    const mod = https;
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY,
        'Prefer': 'return=representation',
      },
    };
    const req = mod.request(url, options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function supabaseInsert(table, rows) {
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(rows);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY,
        'Prefer': 'return=minimal',
      },
    }, (res) => {
      let resData = '';
      res.on('data', (c) => (resData += c));
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Steam Wishlist ────────────────────────────────────────────
async function getWishlist() {
  const url = `https://api.steampowered.com/IWishlistService/GetWishlist/v1?steamid=${STEAM_ID}&key=${STEAM_API_KEY}`;
  const data = await fetchJson(url);
  // Response: { response: { wishlists: { "0": [ { appid, timestamp, priority }, ... ] } } }
  const wishlists = data?.response?.wishlists || {};
  const allItems = Object.values(wishlists).flat();
  return allItems.map((item) => ({
    appId: item.appid,
    addedAt: new Date(item.timestamp * 1000).toISOString(),
  }));
}

// ─── CheapShark ────────────────────────────────────────────────
async function getGamePrice(appId) {
  // Search by steamAppID
  const url = `https://www.cheapshark.com/api/1.0/games?steamAppID=${appId}&pageSize=1`;
  const data = await fetchJson(url);
  if (!data || data.length === 0) return null;
  const game = data[0];
  return {
    title: game.title,
    cheapest: game.cheapest,
    cheapestDealID: game.cheapestDealID,
  };
}

async function getDealDetails(dealID) {
  const url = `https://www.cheapshark.com/api/1.0/deals?id=${dealID}`;
  const data = await fetchJson(url);
  if (!data) return null;
  return {
    storeID: data.storeID,
    storeName: data.storeName,
    salePrice: data.salePrice,
    normalPrice: data.normalPrice,
    savings: data.savings,
    lastChange: new Date(data.lastChange * 1000).toISOString(),
    url: data.url,
  };
}

async function getFreeGames() {
  const url = `https://www.cheapshark.com/api/1.0/deals?onSale=1&lowerPrice=0&upperPrice=0&pageSize=50`;
  const data = await fetchJson(url);
  return data || [];
}

// ─── Deal Score ────────────────────────────────────────────────
function calculateDealScore(currentPrice, originalPrice, allTimeLow, daysOnWishlist) {
  if (!allTimeLow || allTimeLow <= 0) return 0;
  if (!originalPrice || originalPrice <= 0) return 0;

  const priceFactor = (1 - currentPrice / allTimeLow) * 7;
  const discountFactor = (1 - currentPrice / originalPrice) * 2;
  const patienceFactor = Math.min(daysOnWishlist / 365, 1) * 1;

  return Math.max(0, Math.min(10, priceFactor + discountFactor + patienceFactor));
}

// ─── Discord Notification ──────────────────────────────────────
async function sendDiscordAlert(content, embeds = []) {
  await postJson(DISCORD_WEBHOOK_URL, { content, embeds });
}

// ─── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('Deal Radar: Starting check...');
  const now = new Date();

  // 1. Get wishlist
  let wishlist;
  try {
    wishlist = await getWishlist();
    console.log(`Wishlist: ${wishlist.length} games`);
  } catch (e) {
    console.error('Failed to fetch wishlist:', e.message);
    process.exit(1);
  }

  // 2. Get purchased games (to skip)
  const purchased = await supabaseQuery('purchased', { select: 'app_id' });
  const purchasedSet = new Set(purchased.map((r) => r.app_id));

  // 3. Get last notification times (for cooldown)
  const lastNotified = await supabaseQuery('last_notified', { select: 'app_id,last_notification' });
  const cooldownMap = new Map(
    lastNotified.map((r) => [r.app_id, new Date(r.last_notification)])
  );

  // 4. Check each game
  const newSnapshots = [];
  const alerts = [];

  for (const item of wishlist) {
    if (purchasedSet.has(item.appId)) continue;

    try {
      const game = await getGamePrice(item.appId);
      if (!game) continue;

      let deal = null;
      if (game.cheapestDealID) {
        deal = await getDealDetails(game.cheapestDealID);
      }

      const currentPrice = deal ? deal.salePrice : game.cheapest;
      const originalPrice = deal ? deal.normalPrice : game.cheapest;
      const discountPct = deal ? Math.round(deal.savings) : 0;

      // Get all-time low from CheapShark (it's in the game search response sometimes,
      // but for simplicity we use the current cheapest as a proxy for now.
      // In a future iteration, you could store history and compute it.)
      const allTimeLow = currentPrice; // TODO: compute from history after first 30 days

      const daysOnWishlist = Math.floor((now - new Date(item.addedAt)) / 86400000);
      const score = calculateDealScore(currentPrice, originalPrice, allTimeLow, daysOnWishlist);

      newSnapshots.push({
        app_id: item.appId,
        game_name: game.title,
        store: deal ? deal.storeName.toLowerCase() : 'steam',
        current_price: currentPrice,
        original_price: originalPrice,
        discount_pct: discountPct,
        all_time_low: allTimeLow,
        deal_score: Math.round(score * 100) / 100,
        sale_end_date: null, // TODO: parse from deal if available
        snapshot_time: now.toISOString(),
      });

      // Check if we should alert
      const lastNotif = cooldownMap.get(item.appId);
      const inCooldown = lastNotif && (now - lastNotif) < NOTIFICATION_COOLDOWN_HOURS * 3600000;

      if (score >= DEAL_SCORE_THRESHOLD && !inCooldown) {
        alerts.push({
          appId: item.appId,
          title: game.title,
          score,
          currentPrice,
          originalPrice,
          discountPct,
          daysOnWishlist,
          url: deal ? deal.url : `https://store.steampowered.com/app/${item.appId}`,
        });
      }
    } catch (e) {
      console.warn(`Error checking app ${item.appId}: ${e.message}`);
    }

    // Be polite: small delay between API calls
    await new Promise((r) => setTimeout(r, 200));
  }

  // 5. Check free games
  try {
    const freeGames = await getFreeGames();
    const seenFree = await supabaseQuery('free_games_seen', { select: 'app_id' });
    const seenSet = new Set(seenFree.map((r) => r.app_id));

    for (const fg of freeGames) {
      const appId = fg.steamAppID;
      if (!appId || seenSet.has(appId)) continue;

      // New free game!
      await sendDiscordAlert(
        `🆓 **FREE GAME: ${fg.title}**\nAvailable on ${fg.storeName}. [Claim Now](${fg.url})`
      );
      await supabaseInsert('free_games_seen', [{ app_id: appId, first_seen: now.toISOString() }]);
    }
  } catch (e) {
    console.warn('Free games check failed:', e.message);
  }

  // 6. Insert snapshots
  if (newSnapshots.length > 0) {
    await supabaseInsert('price_snapshots', newSnapshots);
    console.log(`Inserted ${newSnapshots.length} snapshots`);
  }

  // 7. Send deal alerts
  for (const alert of alerts) {
    const embed = {
      title: `🔥 ${alert.title}`,
      description: [
        `**Score:** ${alert.score.toFixed(1)}/10`,
        `**Price:** $${alert.currentPrice.toFixed(2)} (was $${alert.originalPrice.toFixed(2)}, ${alert.discountPct}% off)`,
        `**On wishlist:** ${alert.daysOnWishlist} days`,
      ].join('\n'),
      color: 0x00ff00,
      url: alert.url,
    };
    await sendDiscordAlert(`Deal Score ${alert.score.toFixed(1)} — above threshold!`, [embed]);
    await supabaseInsert('last_notified', [{ app_id: alert.appId, last_notification: now.toISOString() }]);
  }

  console.log(`Done. ${alerts.length} deal alert(s) sent.`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});   
