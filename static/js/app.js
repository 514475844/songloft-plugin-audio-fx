(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var sp = window.SongloftPlugin || {};
  var player = sp.player || null;
  var host = sp.host || null;

  var state = {
    cap: false,          // 宿主支持 player.audioEffects
    playbackId: null,
    supported: {},
    selected: { equalizer: null, reverb: null, stereoWidth: null },
    playing: false,
    busy: false,
  };

  // ---------- 工具 ----------
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }

  function setStatus(kind, text) {
    $('stDot').className = 'dot ' + kind;
    $('stText').textContent = text;
  }

  var API = location.origin + '/api/v1/jsplugin/audio-fx';
  function getToken() {
    if (sp.getAuthToken) { try { var t = sp.getAuthToken(); if (t) return t; } catch (e) {} }
    try {
      var a = JSON.parse(localStorage.getItem('songloft-auth') || '{}');
      if (a.accessToken) return a.accessToken;
    } catch (e) {}
    return '';
  }
  function api(path, options) {
    options = options || {};
    var url = API + path + (path.indexOf('?') < 0 ? '?' : '&') + 'access_token=' + encodeURIComponent(getToken());
    var init = { method: options.method || 'GET', headers: { 'Accept': 'application/json' } };
    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    return fetch(url, init).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t.slice(0, 120)); });
      return r.json();
    });
  }

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---------- 能力检测 ----------
  function detect() {
    if (!player || !player.getAudioEffects || !host || !host.getInfo) {
      setStatus('err', '当前客户端不支持宿主音效');
      $('sessionCard').classList.add('disabled');
      return Promise.resolve(false);
    }
    return host.getInfo().then(function (info) {
      var caps = (info && info.capabilities) || [];
      state.cap = caps.indexOf('player.audioEffects') >= 0;
      if (state.cap) {
        setStatus('ok', '已连接 ' + (info.platform || '') + ' ' + (info.version || ''));
        return true;
      }
      setStatus('err', '客户端版本过旧，无音效能力');
      $('sessionCard').classList.add('disabled');
      return false;
    }).catch(function () {
      setStatus('err', '宿主桥接不可用');
      $('sessionCard').classList.add('disabled');
      return false;
    });
  }

  // ---------- 会话 ----------
  function refreshSession() {
    if (!state.cap) return Promise.resolve();
    return player.getAudioEffects().then(function (r) {
      r = r || {};
      var had = !!state.playbackId;
      state.playbackId = r.playbackId || null;
      state.supported = r.supported || {};
      if (r.applied) {
        state.selected.equalizer = (r.applied.equalizer && r.applied.equalizer.preset) || null;
        state.selected.reverb = (r.applied.reverb && r.applied.reverb.preset) || null;
        state.selected.stereoWidth = (r.applied.stereoWidth && r.applied.stereoWidth.preset) || null;
      } else if (had && state.playbackId) {
        // 会话还在但音效被宿主清掉（如手动切了宿主EQ）——不猜，重置UI为关
        state.selected.equalizer = state.selected.reverb = state.selected.stereoWidth = null;
      }
      renderFx();
    }).catch(function () { /* 未播放时可能报错，忽略 */ });
  }

  // 播放刚启动时 supported 可能未就绪，轮询补齐
  function waitSupported(times) {
    times = times || 8;
    var need = !state.supported.reverb && !state.supported.stereoWidth && !state.supported.equalizer;
    if (!need || times <= 0) return Promise.resolve();
    return delay(600).then(refreshSession).then(function () { return waitSupported(times - 1); });
  }

  function startPlaylist(id) {
    if (!player.playPlaylistById) { toast('当前客户端不支持插件发起播放'); return; }
    state.busy = true;
    player.playPlaylistById(Number(id)).then(function () {
      return delay(800);
    }).then(refreshSession).then(waitSupported).then(function () {
      if (!state.playbackId) toast('未获得音效会话，请确认客户端在播放');
      else { $('fxCard').classList.remove('disabled'); toast('会话已建立，可应用音效'); }
    }).catch(function (e) {
      toast('启动播放失败：' + (e && e.message || e));
    }).finally(function () { state.busy = false; });
  }

  // ---------- 应用音效 ----------
  function buildEffects() {
    var eff = {};
    if (state.selected.equalizer) eff.equalizer = { preset: state.selected.equalizer };
    if (state.selected.reverb) eff.reverb = { preset: state.selected.reverb };
    if (state.selected.stereoWidth) eff.stereoWidth = { preset: state.selected.stereoWidth };
    return eff;
  }

  function applyFx() {
    if (!state.playbackId) { toast('还没有播放会话，先点「播放此歌单」'); return Promise.resolve(); }
    var eff = buildEffects();
    var keys = Object.keys(eff);
    var p;
    if (!keys.length) {
      p = player.clearAudioEffects({ playbackId: state.playbackId }).then(function () {
        toast('已关闭全部插件音效');
      });
    } else {
      p = player.applyAudioEffects({ playbackId: state.playbackId, effects: eff }).then(function () {
        toast('音效已应用');
      });
    }
    return p.catch(function (e) {
      toast('应用失败：' + (e && e.message || String(e)));
      return refreshSession(); // 失败保留上一组，回读真实状态
    }).then(savePrefs);
  }

  function toggle(kind, value) {
    if (state.busy) return;
    state.selected[kind] = state.selected[kind] === value ? null : value;
    renderFx();
    applyFx();
  }

  // ---------- 渲染 ----------
  var LABELS = {
    reverb: { room: '房间', hall: '音乐厅' },
    stereoWidth: { subtle: '轻微', wide: '宽阔' },
  };

  function renderChips(containerId, presets, kind) {
    var box = $(containerId);
    if (!presets || !presets.length) {
      box.innerHTML = '<span class="hint">当前输出不支持该效果</span>';
      return;
    }
    box.innerHTML = '';
    presets.forEach(function (v) {
      var b = document.createElement('button');
      b.className = 'chip' + (state.selected[kind] === v ? ' on' : '');
      b.textContent = LABELS[kind] && LABELS[kind][v] ? LABELS[kind][v] : v;
      b.onclick = function () { toggle(kind, v); };
      box.appendChild(b);
    });
  }

  function renderFx() {
    var any = !!state.playbackId;
    $('fxCard').classList.toggle('disabled', !any);
    renderChips('chReverb', (state.supported.reverb || {}).presets, 'reverb');
    renderChips('chWidth', (state.supported.stereoWidth || {}).presets, 'stereoWidth');
    renderChips('chEq', (state.supported.equalizer || {}).presets, 'equalizer');
  }

  function renderNow(song, isPlaying) {
    state.playing = !!isPlaying;
    $('nowPlaying').textContent = song
      ? ((isPlaying ? '正在播放：' : '已暂停：') + (song.artist ? song.artist + ' - ' : '') + (song.title || ''))
      : (isPlaying ? '正在播放' : '未在播放');
  }

  // ---------- 偏好 ----------
  function savePrefs() {
    var p = state.selected;
    try { localStorage.setItem('audiofx_prefs', JSON.stringify(p)); } catch (e) {}
    api('/api/prefs', { method: 'POST', body: { prefs: p } }).catch(function () {});
  }

  function loadPrefs() {
    var raw = null;
    try { raw = localStorage.getItem('audiofx_prefs'); } catch (e) {}
    if (raw) { try { state.selected = JSON.parse(raw); } catch (e) {} return; }
    api('/api/prefs').then(function (d) {
      if (d && d.prefs) {
        state.selected = d.prefs;
        renderFx();
      }
    }).catch(function () {});
  }

  // ---------- 事件 ----------
  function bind() {
    $('btnStart').onclick = function () {
      var v = $('plSel').value;
      if (!v) { toast('先选一个歌单'); return; }
      startPlaylist(v);
    };
    $('btnClear').onclick = function () {
      state.selected.equalizer = state.selected.reverb = state.selected.stereoWidth = null;
      renderFx();
      applyFx();
    };
    if (player.onStateChange) {
      player.onStateChange(function (s) {
        s = s || {};
        renderNow(s.current_song, s.is_playing);
        // 播放中但还没拿到会话（如宿主重启）：补取一次
        if (s.is_playing && !state.playbackId) {
          refreshSession().then(waitSupported);
        }
      });
    }
  }

  // ---------- 启动 ----------
  function boot() {
    loadPrefs();
    detect().then(function (ok) {
      if (!ok) return;
      bind();
      renderFx();
      // 拉歌单
      api('/api/playlists').then(function (d) {
        var sel = $('plSel');
        sel.innerHTML = '<option value="">选择歌单…</option>';
        (d.items || []).forEach(function (p) {
          var o = document.createElement('option');
          o.value = p.id;
          o.textContent = p.name + '（' + p.count + '首）';
          sel.appendChild(o);
        });
      }).catch(function (e) { toast('歌单加载失败：' + e.message); });
      // 若已有本插件会话（页面刷新），直接恢复
      return player.getState ? player.getState().then(function (s) {
        if (s && s.current_song) renderNow(s.current_song, s.is_playing);
        return refreshSession();
      }).catch(function () {}) : refreshSession();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
