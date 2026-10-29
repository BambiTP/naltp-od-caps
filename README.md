# NALTP OD caps

Caps from NALTP comp games (Season 31 onward, the games with TagPro replays) scored against OD,
with each one opening in the real TagPro replay viewer a few seconds before the cap.

**Page:** open `index.html` (GitHub Pages: branch `main`, folder `/ (root)`).

## How caps are picked

All by `tools/find_od_caps.js`, no hand picking. Checked 4 seconds before the cap:

- the carrier already has the flag,
- 3 or 4 enemies are alive within 6 tiles of the carrier's own flag, or 2 are and the other 2 are dead
  (waiting to respawn),
- the carrier's path into the flag is at least 1.3 times the straight-line distance, so plain straight
  runs are left out.

Every cap that passes is in `data/od_caps.csv`; 12 of them, chosen at random with a fixed seed, are on the
page (their replays are in `replays/`). The numbers are constants at the top of the script.

```
node tools/find_od_caps.js --replays <folder of <uuid>.ndjson.gz> --games comp_games_replay_era.csv \
  --fetch comp_fetch.csv --extract <tagpro-timeline>/extract.js
```

## Viewer

`viewer/` is the real TagPro game client in replay mode (from BambiTP/tagpro-offline and the replay page
of BambiTP/tagpro-local). `viewer/?replay=<key>&t=<ms>&follow=<player id>` loads `replays/<key>.ndjson.gz`,
starts at `t` and follows that player.
