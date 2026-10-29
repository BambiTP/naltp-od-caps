#!/usr/bin/env node
// Find NALTP flag runs for following: from the carrier's grab to their cap against OD, picked by rules (no hand picking).
//   node tools/find_od_caps.js [--replays DIR] [--games CSV] [--fetch CSV] [--extract extract.js]
// Writes data/all_od_caps.csv (every run against OD, with its measures), data/od_caps.csv (the runs that pass)
// and caps.json + replays/ (the picked ones, for the page).
//
// A run is the carrier's last grab up to their cap, holding the flag the whole time. It passes when:
//   - it lasts MIN_RUN_S to MAX_RUN_S seconds (long enough to follow, short enough to remember),
//   - OD_CHECK_MS before the cap (or at the grab, if that is later) enemies guarding the carrier's own flag
//     (alive, within OD_RADIUS tiles of it) number 3 or 4, or 2 with the other 2 dead (waiting to respawn),
//   - its turning per second is in the middle of all such runs (between the TURN_LOW and TURN_HIGH
//     percentiles): not a plain straight line, not too zig-zaggy to follow. Turning = how many degrees the
//     carrier's direction of travel changes between snapshots, added up, counted only while moving at
//     least MIN_SPEED tiles a second. Jukes (full left/right or up/down reversals) are listed too.
// Positions are the replay's snapshots (about 4 a second per player).
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const MIN_RUN_S = 4, MAX_RUN_S = 12, OD_CHECK_MS = 4000, OD_RADIUS = 6, MIN_SPEED = 1,
  TURN_LOW = 25, TURN_HIGH = 75, PICK = 12, SEED = 20261028;

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
    const team = cap.team === 'red' ? 1 : 2, flag = spots[team][0];
    // the carrier's own last grab before the cap, with no pop of theirs in between
    let grab = null;
    for (const e of t.events) {
      if (e.ms > cap.ms) break;
      if (e.player !== cap.player) continue;
      if (e.event === 'grab') grab = e;
      else if (e.event === 'pop' || e.event === 'cap' && e !== cap) grab = null;
    }
    if (!grab) continue;
    const runS = (cap.ms - grab.ms) / 1000;
    const from = Math.max(grab.ms, cap.ms - OD_CHECK_MS);
    let od = 0, dead = 0;
    for (const n of Object.keys(teamOf).filter(n => teamOf[n] !== team)) {
      const s = at(n, from);
      if (!s) continue;
      if (s.alive !== 'yes') dead++;
      else if (dist(centre(s), flag) <= OD_RADIUS) od++;
    }
    if (!(od >= 3 || (od === 2 && dead === 2))) continue;
    const run = (track[cap.player] || []).filter(p => p.ms >= grab.ms && p.ms <= cap.ms);
    if (run.length < 2) continue;
    let jukes = 0, len = 0, turn = 0;
    const moving = p => Math.hypot(p.vx, p.vy) >= MIN_SPEED;
    for (let i = 1; i < run.length; i++) {
      const a = run[i - 1], b = run[i];
      len += dist(centre(a), centre(b));
      if (!moving(a) || !moving(b)) continue;
      let d = Math.atan2(b.vy, b.vx) - Math.atan2(a.vy, a.vx);
      d = Math.abs(((d + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      turn += d * 180 / Math.PI;
      for (const k of ['vx', 'vy'])
        if (Math.abs(a[k]) >= MIN_SPEED && Math.abs(b[k]) >= MIN_SPEED && Math.sign(a[k]) !== Math.sign(b[k])) jukes++;
    }
    const xs = run.map(p => p.x + 0.5), ys = run.map(p => p.y + 0.5);
    const keys = t.keypresses.filter(k => k.player === cap.player && k.action === 'pressed' && k.ms >= grab.ms && k.ms <= cap.ms).length;
    found.push({
      season: g.season, league: g.league, week: g.week, game: g.game, team_a: g.team_a, team_b: g.team_b,
      map: g.map, played_utc: g.played_utc, tagpro_eu_match: String(parseInt(g.tagpro_eu_match)), uuid,
      cap_team: cap.team, carrier: cap.player, carrier_id: idOf[cap.player] ?? '',
      grab_clock_s: grab.seconds, grab_ms: grab.ms, cap_ms: cap.ms, run_s: runS.toFixed(2),
      od, dead, kind: od >= 3 ? `${od} OD` : '2 OD + 2 respawning',
      turn_deg_per_s: (turn / runS).toFixed(1), jukes, jukes_per_s: (jukes / runS).toFixed(2), key_presses_per_s: (keys / runS).toFixed(2),
      path_tiles: len.toFixed(1), straight_tiles: dist(centre(run[0]), flag).toFixed(1),
      route_w: (Math.max(...xs) - Math.min(...xs) + 1).toFixed(1), route_h: (Math.max(...ys) - Math.min(...ys) + 1).toFixed(1),
      route_cx: ((Math.max(...xs) + Math.min(...xs)) / 2).toFixed(1), route_cy: ((Math.max(...ys) + Math.min(...ys)) / 2).toFixed(1),
    });
  }
  if (++done % 250 === 0) console.log(`${done}/${games.length} games, ${found.length} caps so far`);
}
const cell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
const writeCsv = (name, rows) => {
  const cols = Object.keys(found[0] || {});
  fs.writeFileSync(path.join(ROOT, 'data', name), [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n') + '\n');
};
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
writeCsv('all_od_caps.csv', found);

// turning band: percentiles of turning per second over the runs of the right length
const timed = found.filter(r => r.run_s >= MIN_RUN_S && r.run_s <= MAX_RUN_S);
const rates = timed.map(r => Number(r.turn_deg_per_s)).sort((a, b) => a - b);
const pct = p => rates.length ? rates[Math.min(rates.length - 1, Math.floor(p / 100 * rates.length))] : 0;
const turnMin = pct(TURN_LOW), turnMax = pct(TURN_HIGH);
const passing = timed.filter(r => Number(r.turn_deg_per_s) >= turnMin && Number(r.turn_deg_per_s) <= turnMax);
writeCsv('od_caps.csv', passing);
console.log(`${done} games read, ${skipped} skipped, ${found.length} runs against OD, ${timed.length} of the right length, ` +
  `${passing.length} turning ${turnMin}-${turnMax} degrees a second`);

// pick PICK caps at random with a fixed seed (same pick every run on the same data)
let s = SEED;
const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
const pool = passing.slice(), picked = [];
while (picked.length < PICK && pool.length) picked.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
picked.sort((a, b) => a.played_utc.localeCompare(b.played_utc) || a.grab_ms - b.grab_ms);

fs.mkdirSync(path.join(ROOT, 'replays'), { recursive: true });
for (const c of picked) {
  c.key = c.uuid.replace(/-/g, '').slice(0, 16); // the viewer's replay key (it keeps the first 16 characters)
  fs.copyFileSync(path.join(REPLAYS, c.uuid + '.ndjson.gz'), path.join(ROOT, 'replays', c.key + '.ndjson.gz'));
}
fs.writeFileSync(path.join(ROOT, 'caps.json'), JSON.stringify({
  rules: { min_run_s: MIN_RUN_S, max_run_s: MAX_RUN_S, od_check_s: OD_CHECK_MS / 1000, od_radius_tiles: OD_RADIUS,
    min_speed: MIN_SPEED, turn_low_pct: TURN_LOW, turn_high_pct: TURN_HIGH, turn_min: turnMin, turn_max: turnMax,
    picked: PICK, seed: SEED, games_read: done, runs_against_od: found.length, runs_right_length: timed.length,
    runs_passing: passing.length },
  caps: picked,
}, null, 1));
console.log(`picked ${picked.length}`);
