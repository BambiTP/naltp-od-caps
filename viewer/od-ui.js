// Loading cover, touch controls and camera for the TagPro replay page.
// Address: ?replay=<key>&t=<ms to start at>&follow=<player id>&title=<text>&tagpro=<link to the real TagPro viewer>
// The cover stays up (sound off) until the replay is downloaded, the page's images are loaded and the
// client has jumped to t; then it pauses there and waits for a tap on Play (which also lets phones play sound).
//
// Whole map: the zoom is worked out from the canvas's actual size on screen (minus the control bar), so the map
// just fits. The client's own whole-map zoom gets this wrong on phones, and its "overview" mode darkens the screen.
(function () {
  var q = new URLSearchParams(location.search);
  var start = Number(q.get('t')) || 0, follow = Number(q.get('follow')) || 0, title = q.get('title') || '';
  var tagproUrl = q.get('tagpro') || '';
  var $id = function (id) { return document.getElementById(id); };
  var cover = $id('od-loading'), status = $id('od-loading-status'), playButton = $id('od-play-button');
  var bar = $id('od-bar'), toggle = $id('od-bar-toggle'), playPause = $id('od-playpause-button');
  var viewButton = $id('od-view-button'), speedSelect = $id('od-speed-select');
  $id('od-loading-title').textContent = title;
  $id('od-bar-info').textContent = title;
  if (/^https:\/\/tagpro\.koalabeast\.com\//.test(tagproUrl)) {
    ['od-tagpro-link', 'od-loading-tagpro-link'].forEach(function (id) { $id(id).href = tagproUrl; $id(id).hidden = false; });
  }

  // camera: 'map' = whole map, 'follow' = follow the carrier at normal zoom
  var camera = 'map', zoomBy = 1, wantedSound = null, ready = false;

  // the client draws the map scaled by resizeScaleFactor / zoom inside a canvas vpWidth x vpHeight on screen
  function wholeMapZoom() {
    var m = tagpro.map, r = tagpro.renderer;
    if (!m || !r || !r.vpWidth || !r.vpHeight) return 1;
    var barHeight = bar.hidden ? 0 : bar.offsetHeight; // the map is centred, so leave the bar's height at both ends
    var w = r.vpWidth, h = Math.max(100, r.vpHeight - 2 * barHeight), f = r.resizeScaleFactor || 1;
    return Math.max(40 * m.length * f / w, 40 * m[0].length * f / h) * 1.02;
  }
  // put the camera where it should be; run often, because the client changes these on its own events
  function applyCamera() {
    var v = tagpro.viewport;
    if (camera === 'map') {
      v.followPlayer = false;
      v.centerLock = true;
      tagpro.zoom = wholeMapZoom() * zoomBy;
    } else {
      v.followPlayer = true;
      v.centerLock = false;
      tagpro.zoom = zoomBy;
      if (follow && tagpro.playerId !== follow && tagpro.players[follow] && tagpro.replayFollowPlayer) tagpro.replayFollowPlayer(follow);
    }
    v.overview = false;
    tagpro.zooming = 0;
    viewButton.textContent = camera === 'map' ? 'Follow carrier' : 'Whole map';
  }

  function seekBar() { return $id('replaySeekBar'); }
  // the client seeks when the seek bar is released (mouseup), to the bar's value
  function seekTo(ms) {
    var s = seekBar();
    if (!s) return;
    s.value = ms;
    window.jQuery(s).trigger('mouseup');
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
    applyCamera();
    var at = Number((seekBar() || {}).value) || 0;
    // the client only jumps when the target is 2+ seconds ahead of where playback is
    var jumps = start && start - (t.replayData && t.replayData.minTS || 0) >= 2500;
    if (jumps && at < start - 1000) { status.textContent = 'Jumping to the grab...'; return; }
    if (t.replayPlayer.seeking || document.readyState !== 'complete') { status.textContent = 'Loading images and sounds...'; return; }
    clearInterval(poll);
    if (!t.replayPaused) t.replayActions.playpause();
    t.sound = false;
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
    cover.style.display = 'none';
    bar.hidden = false;
    toggle.hidden = false;
    applyCamera();
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
  viewButton.addEventListener('click', function () { camera = camera === 'map' ? 'follow' : 'map'; zoomBy = 1; applyCamera(); });
  $id('od-zoomin-button').addEventListener('click', function () { zoomBy = Math.max(0.3, zoomBy / 1.25); applyCamera(); });
  $id('od-zoomout-button').addEventListener('click', function () { zoomBy = Math.min(4, zoomBy * 1.25); applyCamera(); });
  toggle.addEventListener('click', function () { bar.hidden = !bar.hidden; });

  // keep the camera, play / pause button and speed list right (the client and keyboard keys change them too)
  setInterval(function () {
    if (!ready) return;
    applyCamera();
    playPause.innerHTML = tagpro.replayPaused ? '&#9654;' : '&#10074;&#10074;';
    if (Number(speedSelect.value) !== tagpro.replaySpeed) speedSelect.value = String(tagpro.replaySpeed);
  }, 250);
})();
