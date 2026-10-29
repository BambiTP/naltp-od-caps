#!/usr/bin/env node
// Find NALTP flag runs for following: from the carrier's grab to their cap against OD, picked by rules (no hand picking).
//   node tools/find_od_caps.js [--jobs N] [--replays DIR] [--games CSV] [--fetch CSV] [--extract extract.js]
// --jobs N reads the replays in N processes at once (outputs are rewritten every minute as results come in).
// Writes data/all_od_caps.csv (every run against OD, with its measures), data/od_caps.csv (the runs that pass)
// and caps.json + replays/ (the picked ones, for the page).
//
// A run is the carrier's last grab up to their cap, holding the flag the whole time. It passes when:
//   - it lasts MIN_RUN_S to MAX_RUN_S seconds (long enough to follow, short enough to remember),
//   - it is against OD or the carrier gets chased and boosts away (either or both):
//     OD: OD_CHECK_MS before the cap (or at the grab, if that is later) enemies guarding the carrier's own flag
//       (alive, within OD_RADIUS tiles of it) number 3 or 4, or 2 with the other 2 dead (waiting to respawn);
//     chased: an enemy is right behind the carrier (centres within CHASE_DIST tiles, so about half a tile
//       between the balls, on the side away from where the carrier is heading) and the carrier uses a boost
//       within ESCAPE_MS after that,
//   - nobody who was chasing the carrier gets ahead of them (closer to the carrier's flag, within 4 tiles of them),
//   - the carrier never goes backwards more than MAX_BACKTRACK tiles (straight-line distance to their flag growing
//     past the closest they had been),
//   - its turning per second is in the middle of all such runs (between the TURN_LOW and TURN_HIGH
//     percentiles): not a plain straight line, not too zig-zaggy to follow. Turning = how many degrees the
//     carrier's direction of travel changes between snapshots, added up, counted only while moving at
//     least MIN_SPEED tiles a second. Jukes (full left/right or up/down reversals) are listed too.
// Positions are the replay's snapshots (about 4 a second per player).
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const MIN_RUN_S = 4, MAX_RUN_S = 12, OD_CHECK_MS = 4000, OD_RADIUS = 6, MIN_SPEED = 1,
  CHASE_DIST = 1.5, ESCAPE_MS = 2000, MAX_BACKTRACK = 3, OVERTAKE_NEAR = 4,
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
let found = [];
let done = 0, skipped = 0;
const JOBS = Number(arg('--jobs', 1)), SHARD = process.env.SHARD == null ? null : Number(process.env.SHARD);
const shardFile = k => path.join(ROOT, 'data', `shard_${k}.json`);
const saveShard = () => fs.writeFileSync(shardFile(SHARD), JSON.stringify({ done, skipped, found }));
if (JOBS > 1 && SHARD == null) { runJobs(); return; }
for (const [gi, g] of games.entries()) {
  if (SHARD != null && gi % Number(process.env.SHARDS) !== SHARD) continue;
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
    const isOd = od >= 3 || (od === 2 && dead === 2);
    const run = (track[cap.player] || []).filter(p => p.ms >= grab.ms && p.ms <= cap.ms);
    if (run.length < 2) continue;
    // chased: an enemy right behind the carrier, then the carrier boosts within ESCAPE_MS
    const enemies = Object.keys(teamOf).filter(n => teamOf[n] !== team);
    const chasedAt = [], chasers = new Set();
    let closest = Infinity, overtaken = '', backtrack = 0, nearest = Infinity;
    for (const p of run) {
      const toFlag = dist(centre(p), flag);
      nearest = Math.min(nearest, toFlag);
      backtrack = Math.max(backtrack, toFlag - nearest);
      for (const n of enemies) {
        const e = at(n, p.ms);
        if (!e || e.alive !== 'yes' || p.ms - e.ms > 300) continue;
        const dx = e.x - p.x, dy = e.y - p.y, d = Math.hypot(dx, dy);
        // a chaser who gets ahead: closer to the carrier's flag than the carrier, while still near them
        if (chasers.has(n) && d <= OVERTAKE_NEAR && dist(centre(e), flag) < toFlag - 0.5) overtaken = n;
        if (Math.hypot(p.vx, p.vy) < MIN_SPEED) continue;
        if (d <= CHASE_DIST && dx * p.vx + dy * p.vy < 0) { chasedAt.push(p.ms); chasers.add(n); closest = Math.min(closest, d); }
      }
    }
    const boosts = t.events.filter(e => e.player === cap.player && / boost used$|^boost used$/.test(e.event) && e.ms >= grab.ms && e.ms <= cap.ms);
    const escapes = boosts.filter(b => chasedAt.some(c => b.ms >= c && b.ms - c <= ESCAPE_MS)).length;
    const isChased = escapes > 0;
    if (!isOd && !isChased) continue;
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
      od, dead, kind: [isOd ? (od >= 3 ? `${od} OD` : '2 OD + 2 respawning') : '', isChased ? 'chased, boosts away' : ''].filter(Boolean).join(' + '),
      chased: isChased ? 'yes' : '', overtaken_by: overtaken, backtrack_tiles: backtrack.toFixed(1), closest_gap_tiles: closest === Infinity ? '' : (closest - 1).toFixed(2), boosts: boosts.length, escape_boosts: escapes,
      turn_deg_per_s: (turn / runS).toFixed(1), jukes, jukes_per_s: (jukes / runS).toFixed(2), key_presses_per_s: (keys / runS).toFixed(2),
      path_tiles: len.toFixed(1), straight_tiles: dist(centre(run[0]), flag).toFixed(1),
      route_w: (Math.max(...xs) - Math.min(...xs) + 1).toFixed(1), route_h: (Math.max(...ys) - Math.min(...ys) + 1).toFixed(1),
      route_cx: ((Math.max(...xs) + Math.min(...xs)) / 2).toFixed(1), route_cy: ((Math.max(...ys) + Math.min(...ys)) / 2).toFixed(1),
    });
  }
  ++done;
  if (SHARD != null) { if (done % 25 === 0) saveShard(); }
  else if (done % 250 === 0) { console.log(`${done}/${games.length} games, ${found.length} runs so far`); writeOutputs(); }
}
if (SHARD != null) { saveShard(); return; }
writeOutputs();

// parent of --jobs: start one process per shard, merge their results every minute and at the end
function runJobs() {
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  const { spawn } = require('child_process');
  let running = JOBS;
  const merge = () => {
    found = []; done = 0; skipped = 0;
    for (let k = 0; k < JOBS; k++) {
      if (!fs.existsSync(shardFile(k))) continue;
      try { const d = JSON.parse(fs.readFileSync(shardFile(k), 'utf8')); found.push(...d.found); done += d.done; skipped += d.skipped; } catch (e) { /* being written */ }
    }
    found.sort((a, b) => a.played_utc.localeCompare(b.played_utc) || a.cap_ms - b.cap_ms);
    console.log(`${done}/${games.length} games`);
    if (found.length) writeOutputs();
  };
  for (let k = 0; k < JOBS; k++) {
    if (fs.existsSync(shardFile(k))) fs.unlinkSync(shardFile(k));
    spawn(process.execPath, process.argv.slice(1), { env: { ...process.env, SHARD: k, SHARDS: JOBS }, stdio: 'inherit' })
      .on('exit', () => { if (--running === 0) { clearInterval(timer); merge(); for (let j = 0; j < JOBS; j++) fs.rmSync(shardFile(j), { force: true }); } });
  }
  const timer = setInterval(merge, 60000);
}

function writeOutputs() {
const cell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
const writeCsv = (name, rows) => {
  const cols = Object.keys(found[0] || {});
  fs.writeFileSync(path.join(ROOT, 'data', name), [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n') + '\n');
};
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
writeCsv('all_od_caps.csv', found);

// turning band: percentiles of turning per second over the runs of the right length
const timed = found.filter(r => r.run_s >= MIN_RUN_S && r.run_s <= MAX_RUN_S && !r.overtaken_by && Number(r.backtrack_tiles) <= MAX_BACKTRACK);
const rates = timed.map(r => Number(r.turn_deg_per_s)).sort((a, b) => a - b);
const pct = p => rates.length ? rates[Math.min(rates.length - 1, Math.floor(p / 100 * rates.length))] : 0;
const turnMin = pct(TURN_LOW), turnMax = pct(TURN_HIGH);
const passing = timed.filter(r => Number(r.turn_deg_per_s) >= turnMin && Number(r.turn_deg_per_s) <= turnMax);
writeCsv('od_caps.csv', passing);
console.log(`${done} games read, ${skipped} skipped, ${found.length} runs against OD or chased, ${timed.length} of the right length with no overtaking or big backtrack, ` +
  `${passing.length} turning ${turnMin}-${turnMax} degrees a second`);

// pick PICK runs at random with a fixed seed (same pick every run on the same data)
let s = SEED; // restarts each time, so a partial run picks the same way as a full one
const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
// half from runs against OD (chased or not), half from chased-only runs, so neither swamps the other
const picked = [];
for (const pool of [passing.filter(r => r.od >= 3 || (r.od === 2 && r.dead === 2)), passing.filter(r => !(r.od >= 3 || (r.od === 2 && r.dead === 2)))]) {
  const want = picked.length + PICK / 2;
  while (picked.length < want && pool.length) picked.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
}
picked.sort((a, b) => a.played_utc.localeCompare(b.played_utc) || a.grab_ms - b.grab_ms);

fs.rmSync(path.join(ROOT, 'replays'), { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'replays'), { recursive: true });
for (const c of picked) {
  c.key = c.uuid.replace(/-/g, '').slice(0, 16); // the viewer's replay key (it keeps the first 16 characters)
  fs.copyFileSync(path.join(REPLAYS, c.uuid + '.ndjson.gz'), path.join(ROOT, 'replays', c.key + '.ndjson.gz'));
}
require('./add_links').addLinks(picked, REPLAYS, FETCH); // links to the real TagPro replay viewer
fs.writeFileSync(path.join(ROOT, 'caps.json'), JSON.stringify({
  rules: { min_run_s: MIN_RUN_S, max_run_s: MAX_RUN_S, od_check_s: OD_CHECK_MS / 1000, od_radius_tiles: OD_RADIUS,
    chase_dist_tiles: CHASE_DIST, escape_s: ESCAPE_MS / 1000, max_backtrack_tiles: MAX_BACKTRACK, overtake_near_tiles: OVERTAKE_NEAR,
    min_speed: MIN_SPEED, turn_low_pct: TURN_LOW, turn_high_pct: TURN_HIGH, turn_min: turnMin, turn_max: turnMax,
    picked: PICK, seed: SEED, games_read: done, runs_found: found.length, runs_right_length: timed.length,
    runs_passing: passing.length },
  caps: picked,
}, null, 1));
console.log(`picked ${picked.length}`);
}
