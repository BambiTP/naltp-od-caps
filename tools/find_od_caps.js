#!/usr/bin/env node
// Find NALTP caps scored against OD and pick a few for the page, all by the rules below (no hand picking).
//   node tools/find_od_caps.js [--replays DIR] [--games CSV] [--fetch CSV] [--extract extract.js]
// Writes data/od_caps.csv (every cap that passes) and caps.json + replays/ (the picked ones, for the page).
//
// A cap passes when, WINDOW_MS before the cap:
//   - the carrier already holds the flag (so the whole run into the flag is theirs),
//   - enemies guarding the carrier's own flag (alive, within OD_RADIUS tiles of it) number 3 or 4,
//     or 2 with the other 2 dead (waiting to respawn),
//   - and the carrier's path over the window is not a straight line: path length / straight-line
//     distance from window start to cap is at least MIN_ZIGZAG.
// Positions are the replay's snapshots (about 4 a second per player).
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const WINDOW_MS = 4000, OD_RADIUS = 6, MIN_ZIGZAG = 1.3, PICK = 12, SEED = 20261028;

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const HOME = process.env.HOME;
const REPLAYS = arg('--replays', `${HOME}/tagpro-analytics/data/comp_replays`);
const GAMES = arg('--games', `${HOME}/tagpro-analytics/data/comp_games_replay_era.csv`);
const FETCH = arg('--fetch', `${HOME}/tagpro-analytics/data/comp_fetch.csv`);
const { extract } = require(arg('--extract', `${HOME}/tagpro-timeline/extract.js`));
const ROOT = path.join(__dirname, '..');

function readCsv(file) {
  const rows = [], text = fs.readFileSync(file, 'utf8');
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter(r => r.length === head.length).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// match id -> uuid of each downloaded replay, and match id -> the game's row in the comp list
const uuidOf = {};
for (const r of readCsv(FETCH)) if (r.status === 'done') uuidOf[r.match_id] = r.uuid;
const games = readCsv(GAMES).filter(g => g.tagpro_eu_match && uuidOf[String(parseInt(g.tagpro_eu_match))]).slice(0, Number(process.env.LIMIT) || Infinity);

// tiles[x][y]; 3 = red flag, 4 = blue flag (x.1 when taken)
function flagSpots(file) {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString();
  const line = text.split('\n').find(l => l.includes('"map"'));
  const tiles = JSON.parse(line)[2].tiles, spots = { 1: [], 2: [] };
  tiles.forEach((col, x) => col.forEach((v, y) => {
    const b = Math.floor(Number(v));
    if (b === 3 || b === 4) spots[b - 2].push([x + 0.5, y + 0.5]);
  }));
  return spots;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const found = [];
let done = 0, skipped = 0;
for (const g of games) {
  const uuid = uuidOf[String(parseInt(g.tagpro_eu_match))];
  const file = path.join(REPLAYS, uuid + '.ndjson.gz');
  if (!fs.existsSync(file)) { skipped++; continue; }
  let t, spots;
  try { t = extract(file); spots = flagSpots(file); } catch (e) { skipped++; continue; }
  if (spots[1].length !== 1 || spots[2].length !== 1) { skipped++; continue; } // one flag per team only
  const teamOf = {}, idOf = {}, track = {};
  for (const e of t.events) if (e.player && e.team) teamOf[e.player] = e.team === 'red' ? 1 : 2;
  for (const p of t.positions) (track[p.player] ??= []).push(p);
  for (const pl of t.meta.players || []) idOf[pl.displayName] = pl.id;
  // a player's snapshot at or before ms (null if none, or older than 5 s = left the game)
  const at = (name, ms) => {
    const a = track[name] || [];
    let lo = 0, hi = a.length - 1, best = null;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].ms <= ms) { best = a[m]; lo = m + 1; } else hi = m - 1; }
    return best && ms - best.ms <= 5000 ? best : null;
  };
  const centre = p => [p.x + 0.5, p.y + 0.5];

  for (const cap of t.events.filter(e => e.event === 'cap' && e.team)) {
    const team = cap.team === 'red' ? 1 : 2, flag = spots[team][0], from = cap.ms - WINDOW_MS;
    const start = at(cap.player, from);
    if (!start || !start.flag || start.alive !== 'yes') continue;
    let od = 0, dead = 0;
    const enemies = Object.keys(teamOf).filter(n => teamOf[n] !== team);
    for (const n of enemies) {
      const s = at(n, from);
      if (!s) continue;
      if (s.alive !== 'yes') dead++;
      else if (dist(centre(s), flag) <= OD_RADIUS) od++;
    }
    if (!(od >= 3 || (od === 2 && dead === 2))) continue;
    const runs = (track[cap.player] || []).filter(p => p.ms >= from && p.ms <= cap.ms);
    const pts = [centre(start), ...runs.map(centre), flag];
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
    const straight = dist(pts[0], flag);
    const zigzag = straight > 0.5 ? len / straight : Infinity;
    if (zigzag < MIN_ZIGZAG) continue;
    found.push({
      season: g.season, league: g.league, week: g.week, game: g.game, team_a: g.team_a, team_b: g.team_b,
      map: g.map, played_utc: g.played_utc, tagpro_eu_match: String(parseInt(g.tagpro_eu_match)), uuid,
      cap_team: cap.team, carrier: cap.player, carrier_id: idOf[cap.player] ?? '', game_clock_s: cap.seconds,
      cap_ms: cap.ms, od, dead, kind: od >= 3 ? `${od} OD` : '2 OD + 2 respawning',
      zigzag: zigzag === Infinity ? 'inf' : zigzag.toFixed(2), path_tiles: len.toFixed(1), straight_tiles: straight.toFixed(1),
    });
  }
  if (++done % 250 === 0) console.log(`${done}/${games.length} games, ${found.length} caps so far`);
}
console.log(`${done} games read, ${skipped} skipped, ${found.length} caps pass`);

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
const cols = Object.keys(found[0] || {});
const cell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
fs.writeFileSync(path.join(ROOT, 'data', 'od_caps.csv'),
  [cols.join(','), ...found.map(r => cols.map(c => cell(r[c])).join(','))].join('\n') + '\n');

// pick PICK caps at random with a fixed seed (same pick every run on the same data)
let s = SEED;
const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
const pool = found.slice(), picked = [];
while (picked.length < PICK && pool.length) picked.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
picked.sort((a, b) => a.played_utc.localeCompare(b.played_utc) || a.cap_ms - b.cap_ms);

fs.mkdirSync(path.join(ROOT, 'replays'), { recursive: true });
for (const c of picked) {
  c.key = c.uuid.replace(/-/g, '').slice(0, 16); // the viewer's replay key (it keeps the first 16 characters)
  fs.copyFileSync(path.join(REPLAYS, c.uuid + '.ndjson.gz'), path.join(ROOT, 'replays', c.key + '.ndjson.gz'));
}
fs.writeFileSync(path.join(ROOT, 'caps.json'), JSON.stringify({
  rules: { window_s: WINDOW_MS / 1000, od_radius_tiles: OD_RADIUS, min_zigzag: MIN_ZIGZAG, picked: PICK, seed: SEED,
    games_read: done, caps_passing: found.length },
  caps: picked,
}, null, 1));
console.log(`picked ${picked.length}`);
