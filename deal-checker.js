const https = require('https');
const http = require('http');

const {
  STEAM_API_KEY,
  STEAM_ID,
  DISCORD_WEBHOOK_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
} = process.env;

const DEAL_SCORE_THRESHOLD = 0.5;
const NOTIFICATION_COOLDOWN_HOURS = 24;

// ─── HTTP Helper ───────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
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

// ─── Supabase Helper ───────────────────────────────────────────
async function supabaseQuery(table, { select = '*', where = '' } = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${table}${where ? `?${where}` : ''}`;
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY,
        'Prefer': 'return=representation',
      },
    }, (res) => {
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

// ─── Steam Store Price (Malaysia) ──────────────────────────────
async function getGamePrice(appId) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=my`;
  const data = await fetchJson(url);
  const entry = data?.[appId];
  if (!entry || !entry.data || !entry.data.name) return null;

  const priceOverview = entry.data.price_overview;
  const basePrice = entry.data.price;

  let currentPrice, originalPrice, discountPct;

  if (priceOverview) {
    // Game is ON SALE — price_overview has string values in local currency
    currentPrice = parseFloat(priceOverview.final);
    originalPrice = parseFloat(priceOverview.initial);
    discountPct = parseInt(priceOverview.discount_percent) || 0;
  } else if (basePrice) {
    // Game is NOT on sale — price has integer values in cents
    currentPrice = basePrice.final / 100;
    originalPrice = basePrice.initial / 100;
    discountPct = basePrice.discount_percent || 0;
  } else {
    // Free game or no price data
    return null;
  }

  if (isNaN(currentPrice) || currentPrice <= 0) return null;

  return {
    title: entry.data.name,
    cheapest: currentPrice,
    originalPrice: originalPrice,
    discountPct: discountPct,
    isOnSale: discountPct > 0,
    storeName: 'Steam',
    url: `https://store.steampowered.com/app/${appId}`,
  };
}

// ─── Free Games (stub) ─────────────────────────────────────────
async function getFreeGames() {
  return [];
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

  const newSnapshots = [];
  const alerts = [];

  // 4. Check each game
  for (const item of wishlist) {
    if (purchasedSet.has(item.appId)) continue;

    try {
      const game = await getGamePrice(item.appId);
      if (!game) continue;

      const currentPrice = game.cheapest;
      const originalPrice = game.originalPrice;
      const discountPct = game.discountPct;
      const allTimeLow = currentPrice;
      const daysOnWishlist = Math.floor((now - new Date(item.addedAt)) / 86400000);

      // Inline score calculation (no separate function)
      const priceFactor = (1 - currentPrice / allTimeLow) * 7;
      const discountFactor = (1 - currentPrice / originalPrice) * 2;
      const patienceFactor = Math.min(daysOnWishlist / 365, 1) * 1;
      const score = Math.max(0, Math.min(10, priceFactor + discountFactor + patienceFactor));

      // Log every game so we can see what's happening
      console.log(`  ${game.title}: score=${score.toFixed(2)} [pf=${priceFactor.toFixed(2)}, df=${discountFactor.toFixed(2)}, pt=${patienceFactor.toFixed(2)}] price=${currentPrice} orig=${originalPrice} disc=${discountPct}%`);

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

      if (score >= DEAL_SCORE_THRESHOLD && !inCooldown) {
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

    await new Promise((r) => setTimeout(r, 1000));
  }

  // 5. Check free games
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
    await sendDiscordAlert(`Deal Score ${alert.score.toFixed(2)}`, [embed]);
    await supabaseInsert('last_notified', [{ app_id: alert.appId, last_notification: now.toISOString() }]);
  }

  console.log(`Done. ${alerts.length} deal alert(s) sent.`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});   
