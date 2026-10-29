#!/usr/bin/env node
// Add each picked run's link to the real TagPro replay viewer to caps.json:
//   https://tagpro.koalabeast.com/game?replay=<key>&t=<ms>
// key = base64 of (game id hex + followed player's user id hex), "+" written as "_" (the client's hexToBase64).
// The game id is from the replay listing (--fetch CSV), the carrier's user id from the replay's metadata.
//   node tools/add_links.js [--replays DIR] [--fetch CSV]      (find_od_caps.js also calls addLinks)
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const LEAD_MS = 2000; // start this long before the grab, like the page's own viewer
const hexToBase64 = hex => Buffer.from(hex, 'hex').toString('base64').replace(/\+/g, '_');

function addLinks(caps, replays, fetchCsv) {
  const gameId = {};
  for (const line of fs.readFileSync(fetchCsv, 'utf8').split('\n')) {
    const [, uuid, id, status] = line.split(',');
    if (status === 'done' && /^[0-9a-f]{24}$/.test(id)) gameId[uuid] = id;
  }
  for (const c of caps) {
    const id = gameId[c.uuid];
    if (!id) continue;
    let user = '';
    try {
      const text = zlib.gunzipSync(fs.readFileSync(path.join(replays, c.uuid + '.ndjson.gz'))).toString();
      const meta = JSON.parse(text.slice(0, text.indexOf('\n')))[2];
      const p = (meta.players || []).find(p => p.id === Number(c.carrier_id));
      if (p && /^[0-9a-f]{24}$/.test(p.userId || '')) user = p.userId;
    } catch (e) { /* no follow part in the key then */ }
    c.game_id = id;
    c.tagpro_url = `https://tagpro.koalabeast.com/game?replay=${hexToBase64(id + user)}&t=${Math.max(0, c.grab_ms - LEAD_MS)}`;
  }
  return caps;
}
module.exports = { addLinks };
if (require.main !== module) return;

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const HOME = process.env.HOME, file = path.join(__dirname, '..', 'caps.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
addLinks(data.caps, arg('--replays', `${HOME}/tagpro-analytics/data/comp_replays`), arg('--fetch', `${HOME}/tagpro-analytics/data/comp_fetch.csv`));
fs.writeFileSync(file, JSON.stringify(data, null, 1));
console.log(`${data.caps.filter(c => c.tagpro_url).length}/${data.caps.length} runs have a TagPro link`);
