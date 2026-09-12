// itad-shape-check.js — run once, then delete
// Contains an inline API key — do NOT commit this file.

const ITAD_API_KEY = "b5715ecb6338604b88b2d76d1d00cfb194dd76c3";

const itadGameIds = [
  "018d937e-f032-70ba-a4e6-3ac909e3615f", // RESONANCE OF FATE
  "018d937f-5599-70de-b7b0-96f7e67684ff", // Sekiro
  "018d937f-0388-7245-8002-506c2a95321f", // Fear & Hunger
];

const url = `https://api.isthereanydeal.com/games/prices/v3`
  + `?key=${encodeURIComponent(ITAD_API_KEY)}&country=MY`;

fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(itadGameIds),
})
  .then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  })
  .then((data) => {
    for (const game of data) {
      console.log('═══════════════════════════════════════════════');
      console.log('id:', game.id);
      console.log('');
      console.log('historyLow:');
      console.log(JSON.stringify(game.historyLow, null, 2));
      console.log('');
      console.log('deals count:', (game.deals || []).length);
      console.log('');
      console.log('all shops in deals[]:');
      for (const deal of game.deals || []) {
        console.log(
          `  shop.id=${deal.shop?.id} ` +
          `shop.name="${deal.shop?.name}" ` +
          `price=${deal.price?.amount} ${deal.price?.currency} ` +
          `regular=${deal.regular?.amount} ` +
          `cut=${deal.cut}`
        );
      }
    }
  })
  .catch((e) => console.error('Error:', e.message));
