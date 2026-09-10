const https = require('https');
const http = require('http');

const {
  STEAM_API_KEY,
  STEAM_ID,
  DISCORD_WEBHOOK_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  GG_DEALS_API_KEY,
} = process.env;

const DEAL_SCORE_THRESHOLD = 2;
const NOTIFICATION_COOLDOWN_HOURS = 24;

// ─── HTTP Helper ───────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, {
      headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Referer': 'https://gg.deals/',
    },   
    }, (res) => {
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
async function supabaseQuery(table, { select = '*', where = '' } = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${table}${where ? `?${where}` : ''}`;
  return new Promise((resolve, reject) => {
    const options = {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY,
        'Prefer': 'return=representation',
      },
    };
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
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
  const items = data?.response?.items || [];
  console.log(`Wishlist: ${items.length} games`);
  return items.map((item) => ({
    appId: item.appid,
    addedAt: new Date(item.date_added * 1000).toISOString(),
  })).filter((i) => i.appId);
}

// ─── GG.deals Batch Price Lookup ───────────────────────────────
async function getGamePrices(appIds) {
  const chunks = [];
  for (let i = 0; i < appIds.length; i += 100) {
    chunks.push(appIds.slice(i, i + 100));
  }

  const allResults = {};
  for (let i = 0; i < chunks.length; i++) {
    const ids = chunks[i].join(',');
    const url = `https://api.gg.deals/v1/prices/by-steam-app-id/?ids=${ids}&key=${GG_DEALS_API_KEY}`;
    console.log(`GG.deals batch ${i + 1}/${chunks.length} (${chunks[i].length} games)...`);

    try {
      const data = await fetchJson(url);
      if (data?.success && data.data) {
        Object.assign(allResults, data.data);
      } else {
        console.warn(`GG.deals batch ${i + 1} returned no data:`, JSON.stringify(data).slice(0, 200));
      }
    } catch (e) {
      console.warn(`GG.deals batch ${i + 1} failed: ${e.message}`);
    }

    // Rate limit: 100 records/min. Only need delay between batches.
    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  console.log(`GG.deals: got prices for ${Object.keys(allResults).length} games`);
  return allResults;
}

// ─── Free Games (stub — expand later) ──────────────────────────
async function getFreeGames() {
  return [];
}

// ─── Deal Score ────────────────────────────────────────────────
function calculateDealScore(currentPrice, originalPrice, allTimeLow, daysOnWishlist) {
  if (!allTimeLow || allTimeLow <= 0) return 0;
  if (!originalPrice || originalPrice <= 0) return 0;
  if (!currentPrice || currentPrice <= 0) return 0;

  const priceFactor = (1 - currentPrice / allTimeLow) * 7;
  const discountFactor = (1 - currentPrice / originalPrice) * 2;
  const patienceFactor = Math.min(daysOnWishlist / 365, 1) * 1;

  return Math.max(0, Math.min(10, priceFactor + discountFactor + patienceFactor));
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

  // 3. Get last notification times
  const lastNotified = await supabaseQuery('last_notified', { select: 'app_id,last_notification' });
  const cooldownMap = new Map(
    Array.isArray(lastNotified) ? lastNotified.map((r) => [r.app_id, new Date(r.last_notification)]) : []
  );

  // 4. Batch fetch prices from GG.deals (single call for all games)
  const activeGames = wishlist.filter((item) => !purchasedSet.has(item.appId));
  const appIds = activeGames.map((item) => item.appId);
  const priceData = await getGamePrices(appIds);

  const newSnapshots = [];
  const alerts = [];

  // 5. Process each game
  for (const item of activeGames) {
    try {
      const priceInfo = priceData[item.appId];
      if (!priceInfo) continue;

      const currentPrice = parseFloat(priceInfo.currentRetail);
      const allTimeLow = parseFloat(priceInfo.historicalRetail) || currentPrice;
      const originalPrice = parseFloat(priceInfo.retail) || currentPrice;
      const discountPct = parseInt(priceInfo.discount) || 0;
      const storeName = priceInfo.store || 'Unknown';
      const dealUrl = priceInfo.url || `https://store.steampowered.com/app/${item.appId}`;
      const gameTitle = priceInfo.title || `App ${item.appId}`;

      if (isNaN(currentPrice) || currentPrice <= 0) continue;

      const daysOnWishlist = Math.floor((now - new Date(item.addedAt)) / 86400000);
      const score = calculateDealScore(currentPrice, originalPrice, allTimeLow, daysOnWishlist);

      newSnapshots.push({
        app_id: item.appId,
        game_name: gameTitle,
        store: storeName.toLowerCase(),
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

      if (score >= DEAL_SCORE_THRESHOLD && !inCooldown) {
        alerts.push({
          appId: item.appId,
          title: gameTitle,
          score,
          currentPrice,
          originalPrice,
          allTimeLow,
          discountPct,
          storeName,
          daysOnWishlist,
          url: dealUrl,
        });
      }
    } catch (e) {
      console.warn(`Error processing app ${item.appId}: ${e.message}`);
    }
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
        `🆓 **FREE GAME: ${fg.title}**\nAvailable on ${fg.storeName}. [Claim Now](${fg.url})`
      );
      await supabaseInsert('free_games_seen', [{ app_id: appId, first_seen: now.toISOString() }]);
    }
  } catch (e) {
    console.warn('Free games check failed:', e.message);
  }

  // 7. Insert snapshots
  if (newSnapshots.length > 0) {
    await supabaseInsert('price_snapshots', newSnapshots);
    console.log(`Inserted ${newSnapshots.length} snapshots`);
  }

  // 8. Send deal alerts
  for (const alert of alerts) {
    const embed = {
      title: `🔥 ${alert.title}`,
      description: [
        `**Score:** ${alert.score.toFixed(1)}/10`,
        `**Price:** $${alert.currentPrice.toFixed(2)} (was $${alert.originalPrice.toFixed(2)}, ${alert.discountPct}% off)`,
        `**All-time low:** $${alert.allTimeLow.toFixed(2)}`,
        `**Store:** ${alert.storeName}`,
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
