// 유튜브 BGM 호스트 페이지의 플레이어 제어 스크립트(웹판).
// ⚠ 별도 파일인 이유: 웹판 문서에 붙는 콘텐츠 보안 정책이 script-src 'self' 라 인라인 스크립트는 실행되지 않는다.
//    yt.html 안에 다시 인라인으로 옮기면 브라우저가 실행을 차단해 유튜브 BGM 이 통째로 죽는다.
// ⚠ 설치판 짝: src/main/index.ts 의 YT_HOST_HTML 인라인 스크립트와 같은 내용 — 한쪽을 고치면 함께 갱신할 것.
;(function () {
  // 페이드 인/아웃은 호스트 안에서 처리(로컬 볼륨 램프 — postMessage 스팸 없음). 파일 BGM 과 동일 길이.
  var FADE_IN = 450,
    FADE_OUT = 3200
  var player = null,
    ready = false
  var want = { id: null, playing: false, volume: 10, muted: false, loop: true }
  var level = 0,
    timer = null // level: 페이드 레벨 0..1 (실제 볼륨 = want.volume × level)
  function post(m) {
    try {
      parent.postMessage(Object.assign({ __yt: 1 }, m), '*')
    } catch (e) {}
  }
  function applyVol() {
    if (!player || !ready) return
    try {
      var v = Math.round((want.volume | 0) * level)
      if (v < 0) v = 0
      if (v > 100) v = 100
      player.setVolume(v)
      if (want.muted) player.mute()
      else player.unMute()
    } catch (e) {}
  }
  function clearFade() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
  function ramp(target, ms, done) {
    clearFade()
    var start = level,
      t0 = Date.now()
    timer = setInterval(function () {
      var k = ms <= 0 ? 1 : Math.min(1, (Date.now() - t0) / ms)
      level = start + (target - start) * k
      applyVol()
      if (k >= 1) {
        clearFade()
        level = target
        applyVol()
        if (done) done()
      }
    }, 40)
  }
  function doPlay() {
    if (!player || !ready) return
    try {
      if (want.muted) player.mute()
      else player.unMute()
      player.playVideo()
    } catch (e) {}
    ramp(1, FADE_IN)
  }
  function doPause() {
    if (!player || !ready) return
    ramp(0, FADE_OUT, function () {
      try {
        player.pauseVideo()
      } catch (e) {}
    })
  }
  function onCmd(m) {
    if (m.type === 'load') {
      want.id = m.id
      if (player && ready) {
        if (player.__id !== m.id) {
          player.__id = m.id
          player.loadVideoById(m.id)
        } else if (m.restart) {
          try {
            player.seekTo(0, true)
          } catch (e) {}
        }
      }
    } else if (m.type === 'play') {
      want.playing = true
      doPlay()
    } else if (m.type === 'pause') {
      want.playing = false
      doPause()
    } else if (m.type === 'volume') {
      want.volume = m.v
      applyVol()
    } else if (m.type === 'mute') {
      want.muted = !!m.on
      applyVol()
    } else if (m.type === 'loop') {
      want.loop = !!m.on
    }
  }
  window.addEventListener('message', function (e) {
    var m = e.data
    if (m && m.__ytcmd) onCmd(m)
  })
  window.onYouTubeIframeAPIReady = function () {
    player = new YT.Player('p', {
      width: '320',
      height: '180',
      host: 'https://www.youtube-nocookie.com',
      playerVars: {
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        modestbranding: 1,
        playsinline: 1,
        rel: 0,
        enablejsapi: 1,
        origin: location.origin
      },
      events: {
        onReady: function () {
          ready = true
          applyVol()
          post({ type: 'ready' })
          if (want.id) {
            player.__id = want.id
            try {
              player.loadVideoById(want.id)
            } catch (e) {}
          }
          if (want.playing) doPlay()
          setTimeout(function () {
            if (ready && want.playing && !want.muted) {
              try {
                player.unMute()
              } catch (e) {}
            }
          }, 700)
        },
        onStateChange: function (e) {
          post({ type: 'state', data: e.data })
          if (e.data === 1 && !want.muted) {
            try {
              player.unMute()
            } catch (e) {}
          }
          if (e.data === 0 && want.loop) {
            try {
              player.seekTo(0, true)
              player.playVideo()
            } catch (e) {}
          }
        },
        onError: function (e) {
          post({ type: 'error', code: e.data })
        }
      }
    })
  }
  var s = document.createElement('script')
  s.src = 'https://www.youtube.com/iframe_api'
  s.onerror = function () {
    post({ type: 'apierror' })
  }
  document.head.appendChild(s)
})()
