# NALTP OD caps

Flag carriers' runs from grab to cap, against OD or chased, in NALTP comp games (Season 31 onward, the games with
TagPro replays), for following the carrier's path. Each one opens in the real TagPro replay viewer just
before the grab, showing the whole map.

**Page:** open `index.html` (GitHub Pages: branch `main`, folder `/ (root)`).

## How runs are picked

All by `tools/find_od_caps.js`, no hand picking:

- the run is the carrier's last grab up to their cap, holding the flag the whole time, and lasts 4 to 12 seconds;
- it is against OD, or the carrier is chased and boosts away, or both. OD: 4 seconds before the cap (or at the
  grab, if later) 3 or 4 enemies are alive within 6 tiles of the carrier's own flag, or 2 are and the other 2 are
  dead (waiting to respawn). Chased: an enemy is right behind the carrier (about half a tile between the balls)
  and the carrier uses a boost within 2 seconds;
- the carrier's turning (degrees their direction of travel changes, per second, while moving) is between the
  25th and 75th percentile of runs of that length: no plain straight lines, nothing too zig-zaggy to follow.

`data/all_od_caps.csv` has every run against OD with its measures, `data/od_caps.csv` the ones that pass; 12 of
those, chosen at random with a fixed seed (half against OD, half chased only), are on the page (replays in `replays/`). The numbers are constants
at the top of the script.

```
node tools/find_od_caps.js --replays <folder of <uuid>.ndjson.gz> --games comp_games_replay_era.csv \
  --fetch comp_fetch.csv --extract <tagpro-timeline>/extract.js
```

## Viewer

`viewer/` is the real TagPro game client in replay mode (from BambiTP/tagpro-offline and the replay page
of BambiTP/tagpro-local). `viewer/?replay=<key>&t=<ms>&follow=<player id>` loads `replays/<key>.ndjson.gz`,
waits on a loading cover until it has jumped to `t`, then plays on a tap, showing the whole map (a button switches to following that player). It has a touch
control bar for phones.
