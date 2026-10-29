// Loading cover, touch controls and follow / whole-map view for the TagPro replay page.
// Address: ?replay=<key>&t=<ms to start at>&follow=<player id>&title=<text shown while loading>
//   &route=<width>,<height> (tiles the carrier's run covers: phones start zoomed to fit it)
// The cover stays up (sound off) until the replay is downloaded, the page's images are loaded and the
// client has jumped to t; then it pauses there and waits for a tap on Play (which also lets phones play sound).
(function () {
  var q = new URLSearchParams(location.search);
  var start = Number(q.get('t')) || 0, follow = Number(q.get('follow')) || 0, title = q.get('title') || '';
  var route = (q.get('route') || '').split(',').map(Number), touch = window.matchMedia('(pointer: coarse)').matches;
  var $id = function (id) { return document.getElementById(id); };
  var cover = $id('od-loading'), status = $id('od-loading-status'), playButton = $id('od-play-button');
  var bar = $id('od-bar'), toggle = $id('od-bar-toggle'), playPause = $id('od-playpause-button');
  var viewButton = $id('od-view-button'), speedSelect = $id('od-speed-select');
  $id('od-loading-title').textContent = title;
  $id('od-bar-info').textContent = title;

  var wantedSound = null, wholeMap = false, ready = false;

  function seekBar() { return $id('replaySeekBar'); }
  // the client seeks when the seek bar is released (mouseup), to the bar's value
  function seekTo(ms) {
    var s = seekBar();
    if (!s) return;
    s.value = ms;
    window.jQuery(s).trigger('mouseup');
  }
  // at zoom 1 the view is 32 x 20 tiles on any screen (the client scales the picture to fit the window)
  function fitZoom() {
    var m = tagpro.map;
    return m ? Math.max(1, m.length / 32, m[0].length / 20) : 1;
  }
  function routeZoom() {
    if (!(route[0] > 0 && route[1] > 0)) return 1;
    return Math.min(fitZoom(), Math.max(0.6, route[0] / 32, route[1] / 20));
  }
  function setView(whole) {
    wholeMap = whole;
    tagpro.viewport.followPlayer = !whole;
    tagpro.viewport.centerLock = whole;
    tagpro.zoom = whole ? fitZoom() : touch ? routeZoom() : 1;
    if (!whole && follow && tagpro.replayFollowPlayer) tagpro.replayFollowPlayer(follow);
    viewButton.textContent = whole ? 'Follow carrier' : 'Whole map';
  }

  var waited = 0;
  var poll = setInterval(function () {
    waited += 200;
    var t = window.tagpro;
    if (!t || !t.socket || !t.replayActions || !t.replayPlayer || !t.replayPlayer.player || !t.map) {
      if (waited > 20000) status.textContent = 'Still loading the replay (it is a few megabytes)...';
      return;
    }
    if (wantedSound === null) { wantedSound = t.sound; t.sound = false; } // quiet while it jumps ahead
    var at = Number((seekBar() || {}).value) || 0;
    // the client only jumps when the target is 2+ seconds ahead of where playback is
    var jumps = start && start - (t.replayData && t.replayData.minTS || 0) >= 2500;
    if (jumps && at < start - 1000) { status.textContent = 'Jumping to the cap...'; return; }
    if (t.replayPlayer.seeking || document.readyState !== 'complete') { status.textContent = 'Loading images and sounds...'; return; }
    clearInterval(poll);
    if (!t.replayPaused) t.replayActions.playpause();
    t.sound = false;
    if (follow && t.replayFollowPlayer) t.replayFollowPlayer(follow);
    if (touch) t.zoom = routeZoom();
    ready = true;
    status.textContent = 'Ready.';
    playButton.hidden = false;
    playButton.focus();
  }, 200);

  // phones only play sounds started from a tap: start every sound once, muted, inside this tap
  function unlockSounds() {
    document.querySelectorAll('audio').forEach(function (a) {
      a.muted = true;
      var p = a.play();
      if (p && p.then) p.then(function () { a.pause(); a.currentTime = 0; a.muted = false; }, function () { a.muted = false; });
      else a.muted = false;
    });
  }

  playButton.addEventListener('click', function () {
    if (!ready) return;
    unlockSounds();
    tagpro.sound = wantedSound;
    cover.hidden = true;
    cover.style.display = 'none';
    bar.hidden = false;
    toggle.hidden = false;
    if (tagpro.replayPaused) tagpro.replayActions.playpause();
  });

  var act = function (name) { return function () { if (ready) tagpro.replayActions[name](); }; };
  $id('od-back10-button').addEventListener('click', act('back'));
  $id('od-back2-button').addEventListener('click', act('backsmall'));
  $id('od-forward2-button').addEventListener('click', act('forwardsmall'));
  $id('od-forward10-button').addEventListener('click', act('forward'));
  playPause.addEventListener('click', act('playpause'));
  $id('od-cap-button').addEventListener('click', function () { if (ready && start) seekTo(start); });
  speedSelect.addEventListener('change', function () {
    var v = Number(speedSelect.value);
    var link = Array.prototype.find.call(document.querySelectorAll('a[data-replay-speed]'),
      function (a) { return Number(a.getAttribute('data-replay-speed')) === v; });
    if (link) window.jQuery(link).trigger('click');
  });
  viewButton.addEventListener('click', function () { if (ready) setView(!wholeMap); });
  $id('od-zoomin-button').addEventListener('click', function () { if (ready) tagpro.zoom = Math.max(0.5, tagpro.zoom / 1.25); });
  $id('od-zoomout-button').addEventListener('click', function () { if (ready) tagpro.zoom = Math.min(6, tagpro.zoom * 1.25); });
  toggle.addEventListener('click', function () { bar.hidden = !bar.hidden; });

  // keep the play / pause button and speed list in step with the client (keyboard keys change them too)
  setInterval(function () {
    if (!ready) return;
    playPause.innerHTML = tagpro.replayPaused ? '&#9654;' : '&#10074;&#10074;';
    if (Number(speedSelect.value) !== tagpro.replaySpeed) speedSelect.value = String(tagpro.replaySpeed);
    if (wholeMap) tagpro.viewport.centerLock = true;
  }, 250);
})();
