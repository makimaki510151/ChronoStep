/** Chrono Step — UI / ネット / ローカル進行 */

import { APP_VERSION } from './version.js';
import { PANEL_META, PLAYER_COLORS } from './board.js';
import {
  PHASE,
  applyAction,
  chooseCpuAction,
  createInitialState,
  getLegalActions,
  serializeState,
  waitingPlayerId,
} from './engine.js';
import { createNet } from './net.js';
import { mountBoardCanvas } from './render.js';
import { createAudio } from './audio.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const audio = createAudio();

const STORAGE_NAMES = 'chrono-step-names';

function defaultLocalSeats() {
  return [
    { name: 'プレイヤー1', isCpu: false },
    { name: 'プレイヤー2', isCpu: false },
    { name: '', isCpu: true },
    { name: '', isCpu: true },
  ];
}

function defaultSavedNames() {
  return {
    localSeats: defaultLocalSeats(),
    lobbyName: 'プレイヤー',
    lobbyColor: PLAYER_COLORS[0],
    lastRoomCode: '',
  };
}

function loadSavedNames() {
  try {
    const rawText = localStorage.getItem(STORAGE_NAMES);
    if (!rawText) return defaultSavedNames();
    const raw = JSON.parse(rawText);
    const seats = Array.isArray(raw.localSeats) ? raw.localSeats : null;
    return {
      localSeats: seats
        ? [0, 1, 2, 3].map((i) => ({
          name: typeof seats[i]?.name === 'string' ? seats[i].name.slice(0, 12) : '',
          isCpu: !!seats[i]?.isCpu,
        }))
        : defaultLocalSeats(),
      lobbyName: typeof raw.lobbyName === 'string' && raw.lobbyName.trim()
        ? raw.lobbyName.trim().slice(0, 12)
        : 'プレイヤー',
      lobbyColor: PLAYER_COLORS.includes(raw.lobbyColor) ? raw.lobbyColor : PLAYER_COLORS[0],
      lastRoomCode: typeof raw.lastRoomCode === 'string' ? raw.lastRoomCode.slice(0, 8).toUpperCase() : '',
    };
  } catch {
    return defaultSavedNames();
  }
}

function saveNames(patch = {}) {
  const cur = loadSavedNames();
  const next = { ...cur, ...patch };
  try {
    localStorage.setItem(STORAGE_NAMES, JSON.stringify(next));
  } catch { /* ignore */ }
  return next;
}

const savedNames = loadSavedNames();

const app = {
  mode: null, // 'local' | 'host' | 'guest'
  net: null,
  state: null,
  localSeatId: null,
  lobbyRole: null,
  lobbyColor: savedNames.lobbyColor,
  lobbyPlayers: [],
  cpuSeq: 0,
  myPlayerId: null,
  canvasApi: null,
  cpuTimer: null,
  selectedPanel: null,
  lastLogLen: 0,
  lastWaitingId: null,
  lastRound: null,
};

document.getElementById('app-version-label').textContent = `v${APP_VERSION}`;

function unlockAudio() {
  audio.resume();
}
document.addEventListener('pointerdown', unlockAudio, { once: true });
document.addEventListener('keydown', unlockAudio, { once: true });

function bindVolumeUi() {
  const v = audio.getVolume();
  $('#vol-master').value = v.master;
  $('#vol-bgm').value = v.bgm;
  $('#vol-se').value = v.se;
  $('#btn-mute').textContent = v.muted ? '消' : '音';
  $('#vol-master').oninput = (e) => { unlockAudio(); audio.setMaster(e.target.value); };
  $('#vol-bgm').oninput = (e) => { unlockAudio(); audio.setBgm(e.target.value); };
  $('#vol-se').oninput = (e) => { unlockAudio(); audio.setSe(e.target.value); };
  $('#btn-mute').onclick = () => {
    unlockAudio();
    const muted = audio.toggleMute();
    $('#btn-mute').textContent = muted ? '消' : '音';
    audio.sfx.click();
  };
  $('#btn-vol-expand').onclick = () => {
    unlockAudio();
    $('#vol-dock')?.classList.toggle('vol-collapsed');
    audio.sfx.click();
  };
}
bindVolumeUi();

function showScreen(id) {
  $$('.screen').forEach((el) => el.classList.toggle('active', el.id === id));
  if (id === 'screen-title') audio.stopBgm();
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function setNetStatus(msg, kind = 'info') {
  const el = $('#net-status');
  if (!el) return;
  el.textContent = msg;
  el.className = kind;
}

/* —— screens —— */
$('#btn-howto').onclick = () => { unlockAudio(); audio.sfx.click(); showScreen('screen-howto'); };
$('#btn-howto-back').onclick = () => { unlockAudio(); audio.sfx.click(); showScreen('screen-title'); };
$('#btn-local').onclick = () => {
  unlockAudio();
  audio.sfx.click();
  app.mode = 'local';
  buildSeatEditors();
  showScreen('screen-setup');
};
$('#btn-setup-back').onclick = () => showScreen('screen-title');
$('#btn-host').onclick = () => openLobby('host');
$('#btn-join').onclick = () => openLobby('guest');
$('#btn-lobby-back').onclick = () => {
  destroyNet();
  showScreen('screen-title');
};
$('#btn-game-exit').onclick = () => exitToTitle();
$('#btn-again').onclick = () => exitToTitle();
$('#btn-reconnect-title').onclick = () => {
  $('#reconnect-overlay').hidden = true;
  exitToTitle();
};
$('#btn-reconnect-now').onclick = async () => {
  try {
    await app.net?.reconnect();
    app.net.sendToHost({ type: 'hello', name: $('#lobby-name').value.trim() || 'プレイヤー', color: app.lobbyColor, version: APP_VERSION });
    $('#reconnect-overlay').hidden = true;
    toast('再接続しました');
  } catch (e) {
    toast(e.message || '再接続に失敗');
  }
};

function exitToTitle() {
  clearTimeout(app.cpuTimer);
  destroyNet();
  app.state = null;
  app.mode = null;
  app.selectedPanel = null;
  audio.stopBgm();
  audio.setBgmMode('normal');
  $('#winner').hidden = true;
  showScreen('screen-title');
}

function destroyNet() {
  try { app.net?.destroy(); } catch (_) { /* ignore */ }
  app.net = null;
}

/* —— local seats —— */
function persistLocalSeatsFromDom() {
  const localSeats = [0, 1, 2, 3].map((i) => ({
    name: $(`#seat-editors input[data-seat="${i}"]`)?.value.trim() || '',
    isCpu: !!$(`#seat-editors input[data-cpu="${i}"]`)?.checked,
  }));
  saveNames({ localSeats });
}

function buildSeatEditors() {
  const root = $('#seat-editors');
  root.innerHTML = '';
  const draft = loadSavedNames().localSeats;
  for (let i = 0; i < 4; i++) {
    const seat = draft[i] || defaultLocalSeats()[i];
    const row = document.createElement('div');
    row.className = 'seat-row';
    const safeName = String(seat.name || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
    row.innerHTML = `
      <span class="seat-swatch" style="background:${PLAYER_COLORS[i]}"></span>
      <input type="text" maxlength="12" data-seat="${i}" value="${safeName}" placeholder="空き" />
      <label><input type="checkbox" data-cpu="${i}" ${seat.isCpu ? 'checked' : ''}/> CPU</label>
    `;
    root.appendChild(row);
  }
  root.querySelectorAll('input[data-seat]').forEach((input) => {
    input.addEventListener('change', persistLocalSeatsFromDom);
    input.addEventListener('blur', persistLocalSeatsFromDom);
  });
  root.querySelectorAll('input[data-cpu]').forEach((input) => {
    input.addEventListener('change', persistLocalSeatsFromDom);
  });
}

$('#btn-start-game').onclick = () => {
  persistLocalSeatsFromDom();
  const seats = [];
  for (let i = 0; i < 4; i++) {
    const name = $(`#seat-editors input[data-seat="${i}"]`).value.trim();
    const cpuChecked = $(`#seat-editors input[data-cpu="${i}"]`).checked;
    if (!name && !cpuChecked) continue;
    const isCpu = cpuChecked || !name;
    seats.push({
      id: `local-${i}`,
      name: name || `CPU${i + 1}`,
      color: PLAYER_COLORS[i],
      isCpu,
    });
  }
  if (seats.length < 2) {
    toast('2人以上必要です');
    return;
  }
  app.mode = 'local';
  app.myPlayerId = seats.find((s) => !s.isCpu)?.id || seats[0].id;
  startGame(seats);
};

/* —— lobby —— */
function persistLobbyIdentity() {
  const lobbyName = $('#lobby-name')?.value.trim() || 'プレイヤー';
  const lastRoomCode = ($('#lobby-room')?.value || '').trim().toUpperCase();
  saveNames({
    lobbyName,
    lobbyColor: app.lobbyColor,
    lastRoomCode,
  });
}

function openLobby(role) {
  app.lobbyRole = role;
  app.mode = role;
  const saved = loadSavedNames();
  app.lobbyColor = saved.lobbyColor;
  $('#lobby-name').value = saved.lobbyName || 'プレイヤー';
  if (role === 'guest' && saved.lastRoomCode) {
    $('#lobby-room').value = saved.lastRoomCode;
  }
  $('#lobby-role').textContent = role === 'host' ? 'ホストとして部屋を作ります' : 'ゲストとして部屋に入ります';
  $('#lobby-host-tools').style.display = role === 'host' ? '' : 'none';
  $('#lobby-room-wrap').style.display = role === 'guest' ? '' : 'none';
  $('#btn-lobby-connect').textContent = role === 'host' ? '部屋作成' : '入室';
  $('#btn-lobby-start').hidden = role !== 'host';
  $('#btn-lobby-dismantle').hidden = true;
  $('#btn-lobby-reconnect').hidden = role !== 'guest';
  $('#lobby-code-display').textContent = '------';
  app.lobbyPlayers = [];
  renderLobbyPlayers();
  buildColorPicker();
  showScreen('screen-lobby');
}

function buildColorPicker() {
  const root = $('#lobby-color-picker');
  root.innerHTML = '';
  PLAYER_COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'color-swatch' + (c === app.lobbyColor ? ' selected' : '');
    b.style.background = c;
    b.onclick = () => {
      app.lobbyColor = c;
      persistLobbyIdentity();
      buildColorPicker();
    };
    root.appendChild(b);
  });
}

$('#lobby-name')?.addEventListener('change', persistLobbyIdentity);
$('#lobby-name')?.addEventListener('blur', persistLobbyIdentity);
$('#lobby-room')?.addEventListener('change', persistLobbyIdentity);
$('#lobby-room')?.addEventListener('blur', persistLobbyIdentity);

function renderLobbyPlayers() {
  const root = $('#lobby-players');
  root.innerHTML = '';
  for (const p of app.lobbyPlayers) {
    const row = document.createElement('div');
    row.className = 'lobby-player';
    row.innerHTML = `<span class="player-dot" style="background:${p.color}"></span><span>${p.name}${p.isCpu ? ' (CPU)' : ''}</span>`;
    root.appendChild(row);
  }
}

$('#btn-lobby-connect').onclick = async () => {
  const name = $('#lobby-name').value.trim() || 'プレイヤー';
  persistLobbyIdentity();
  try {
    destroyNet();
    if (app.lobbyRole === 'host') {
      app.net = createNet({
        role: 'host',
        onStatus: ({ msg, kind }) => setNetStatus(msg, kind),
        onEvent: onHostNetEvent,
      });
      const { roomCode } = await app.net.start();
      $('#lobby-code-display').textContent = roomCode;
      $('#btn-lobby-dismantle').hidden = false;
      app.lobbyPlayers = [{
        id: 'host',
        name,
        color: app.lobbyColor,
        peerId: app.net.peerId,
        isCpu: false,
      }];
      renderLobbyPlayers();
      toast(`部屋 ${roomCode}`);
    } else {
      const code = $('#lobby-room').value.trim().toUpperCase();
      if (!code) {
        toast('部屋コードを入力');
        return;
      }
      app.net = createNet({
        role: 'guest',
        roomCode: code,
        onStatus: ({ msg, kind }) => setNetStatus(msg, kind),
        onEvent: onGuestNetEvent,
      });
      await app.net.start();
      app.net.sendToHost({
        type: 'hello',
        name,
        color: app.lobbyColor,
        version: APP_VERSION,
      });
    }
  } catch (e) {
    setNetStatus(e.message || String(e), 'error');
    toast('接続に失敗しました');
  }
};

$('#btn-copy-code').onclick = async () => {
  const code = $('#lobby-code-display').textContent;
  try {
    await navigator.clipboard.writeText(code);
    toast('コピーしました');
  } catch (_) {
    toast(code);
  }
};

$('#btn-add-cpu').onclick = () => {
  if (app.lobbyRole !== 'host') return;
  if (app.lobbyPlayers.length >= 4) {
    toast('最大4人');
    return;
  }
  app.cpuSeq += 1;
  const used = new Set(app.lobbyPlayers.map((p) => p.color));
  const color = PLAYER_COLORS.find((c) => !used.has(c)) || PLAYER_COLORS[0];
  app.lobbyPlayers.push({
    id: `cpu-${app.cpuSeq}`,
    name: `CPU${app.cpuSeq}`,
    color,
    peerId: null,
    isCpu: true,
  });
  renderLobbyPlayers();
  broadcastLobby();
};

$('#btn-lobby-dismantle').onclick = () => {
  destroyNet();
  app.lobbyPlayers = [];
  renderLobbyPlayers();
  $('#lobby-code-display').textContent = '------';
  $('#btn-lobby-dismantle').hidden = true;
  setNetStatus('部屋を解体しました', 'warn');
};

$('#btn-lobby-reconnect').onclick = async () => {
  try {
    await app.net?.reconnect();
    app.net.sendToHost({
      type: 'hello',
      name: $('#lobby-name').value.trim() || 'プレイヤー',
      color: app.lobbyColor,
      version: APP_VERSION,
    });
  } catch (e) {
    toast(e.message || '再接続失敗');
  }
};

$('#btn-lobby-start').onclick = () => {
  if (app.lobbyRole !== 'host') return;
  if (app.lobbyPlayers.length < 2) {
    toast('2人以上必要です');
    return;
  }
  const seats = app.lobbyPlayers.map((p, i) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    isCpu: !!p.isCpu,
    peerId: p.peerId,
  }));
  app.myPlayerId = 'host';
  startGame(seats);
  app.net?.broadcast({ type: 'game_start', seats, state: serializeState(app.state) });
};

function broadcastLobby() {
  app.net?.broadcast({ type: 'lobby_sync', players: app.lobbyPlayers, version: APP_VERSION });
}

function onHostNetEvent({ from, data }) {
  if (!data?.type) return;
  if (data.type === 'hello') {
    if (data.version && data.version !== APP_VERSION) {
      app.net.sendTo(from, { type: 'reject', reason: `バージョン不一致 (host ${APP_VERSION} / guest ${data.version})` });
      return;
    }
    const existing = app.lobbyPlayers.find((p) => p.name === data.name && !p.isCpu);
    if (existing) {
      existing.peerId = from;
      existing.color = data.color || existing.color;
    } else if (app.lobbyPlayers.length < 4) {
      app.lobbyPlayers.push({
        id: from,
        name: data.name || 'ゲスト',
        color: data.color || PLAYER_COLORS[app.lobbyPlayers.length % PLAYER_COLORS.length],
        peerId: from,
        isCpu: false,
      });
    } else {
      app.net.sendTo(from, { type: 'reject', reason: '満員です' });
      return;
    }
    renderLobbyPlayers();
    broadcastLobby();
    if (app.state) {
      app.net.sendTo(from, { type: 'state', state: serializeState(app.state), yourId: from });
    }
    return;
  }
  if (data.type === 'peer_left') {
    // 切断者はロビーから外さず、ゲーム中はCPU化
    if (app.state) {
      const p = app.state.players.find((x) => x.peerId === data.peerId || x.id === data.peerId);
      if (p && p.alive) {
        p.isCpu = true;
        pushUiLog(`${p.name} 切断 → CPU化`);
        scheduleCpu();
        syncState();
      }
    }
    return;
  }
  if (data.type === 'action' && app.state) {
    const pid = resolvePeerPlayerId(from);
    if (!pid) return;
    const prev = serializeState(app.state);
    const result = applyAction(app.state, pid, data.action);
    if (!result.ok) {
      app.net.sendTo(from, { type: 'action_reject', error: result.error });
      return;
    }
    if (data.action?.type === 'pick_die') {
      const dieVal = prev.dicePool.find((d) => d.id === data.action.dieId)?.value;
      playActionSfx({ ...data.action, value: dieVal }, prev, app.state);
    } else {
      playActionSfx(data.action, prev, app.state);
    }
    reactToStateChange(prev);
    syncState();
    scheduleCpu();
    return;
  }
  if (data.type === 'hover' && app.state) {
    const pid = resolvePeerPlayerId(from);
    if (!pid) return;
    applyAction(app.state, pid, data.action);
    // ホバーはホスト画面のみ更新（通信量抑制でゲストへは送らない）
    app.canvasApi?.redraw();
  }
}

function resolvePeerPlayerId(peerId) {
  if (!app.state) return null;
  const p = app.state.players.find((x) => x.peerId === peerId || x.id === peerId);
  return p?.id || null;
}

function onGuestNetEvent({ data }) {
  if (!data?.type) return;
  if (data.type === 'reject') {
    toast(data.reason || '入室拒否');
    return;
  }
  if (data.type === 'lobby_sync') {
    app.lobbyPlayers = data.players || [];
    renderLobbyPlayers();
    return;
  }
  if (data.type === 'game_start') {
    app.state = data.state;
    app.myPlayerId = app.net.peerId;
    // seats の peerId から自分を特定
    const me = app.state.players.find((p) => p.peerId === app.net.peerId || p.id === app.net.peerId);
    if (me) app.myPlayerId = me.id;
    enterGameScreen();
    return;
  }
  if (data.type === 'state') {
    app.state = data.state;
    if (data.yourId) {
      const me = app.state.players.find((p) => p.peerId === data.yourId || p.id === data.yourId);
      if (me) app.myPlayerId = me.id;
    }
    if (!$('#screen-game').classList.contains('active')) enterGameScreen();
    else renderAll();
    return;
  }
  if (data.type === 'host_left') {
    $('#reconnect-overlay').hidden = false;
  }
}

function syncState() {
  renderAll();
  if (app.mode === 'host' && app.net) {
    app.net.broadcast({ type: 'state', state: serializeState(app.state) });
  }
}

function pushUiLog(text) {
  if (!app.state) return;
  app.state.log.push({ t: Date.now(), text, kind: 'system' });
}

function setInspect(cellId) {
  const el = $('#inspect');
  if (!app.state || cellId == null) {
    el.innerHTML = 'マスをタップして詳細';
    return;
  }
  const cell = app.state.board.cells[cellId];
  const panel = app.state.panelsOnBoard[cellId];
  const occupants = app.state.players.filter((p) => p.pos === cellId);
  const tags = [];
  if (cell?.isStart) tags.push('スタート');
  if (cell?.isBranch) tags.push('分岐');
  if (cell?.kind?.startsWith('shortcut')) tags.push('ショートカット');

  let html = `<div class="inspect-title">マス ${cell?.label ?? cellId}</div>`;
  if (tags.length) html += `<div class="inspect-meta">${tags.join(' · ')}</div>`;
  if (occupants.length) {
    html += `<div class="inspect-meta">コマ: ${occupants.map((p) => p.name).join(', ')}</div>`;
  }
  if (panel) {
    const meta = PANEL_META[panel.type];
    const owner = app.state.players.find((p) => p.id === panel.ownerId);
    html += `<div class="inspect-title">${meta?.name || panel.type}</div>`;
    html += `<div class="inspect-meta">設置者: ${owner?.name || '?'} · 発動: ${meta?.timing || '—'}</div>`;
    html += `<div class="inspect-desc">${meta?.desc || ''}</div>`;
  } else {
    html += `<div class="inspect-desc">ノーマルマス（効果なし）。停止時にパネルを設置できる。</div>`;
  }
  el.innerHTML = html;
}

/* —— game —— */
function startGame(seats) {
  app.state = createInitialState({ seats });
  app.selectedPanel = null;
  app.lastLogLen = 0;
  app.lastWaitingId = null;
  app.lastRound = null;
  // peerId を反映
  for (const s of seats) {
    const p = app.state.players.find((x) => x.id === s.id);
    if (p) p.peerId = s.peerId || null;
  }
  unlockAudio();
  audio.startBgm();
  audio.setBgmMode('normal');
  audio.sfx.round();
  enterGameScreen();
  scheduleCpu();
}

function enterGameScreen() {
  showScreen('screen-game');
  $('#winner').hidden = true;
  unlockAudio();
  audio.startBgm();
  if (!app.canvasApi) {
    app.canvasApi = mountBoardCanvas(
      $('#board'),
      () => app.state,
      (cellId) => setInspect(cellId),
    );
  }
  app.canvasApi.resize();
  setInspect(null);
  renderAll();
}

function renderAll() {
  if (!app.state) return;
  renderPlayers();
  renderDice();
  renderLog();
  renderAction();
  renderTop();
  app.canvasApi?.redraw();
  maybeShowWinner();
}

function renderTop() {
  $('#round-chip').textContent = `R${app.state.round}`;
  const phaseLabels = {
    [PHASE.DICE]: 'ダイス',
    [PHASE.DRAFT]: 'ドラフト',
    [PHASE.MOVE_CHOICE]: '経路選択',
    [PHASE.PANEL_PLACE]: 'パネル設置',
    [PHASE.PANEL_REFILL]: 'パネル補充',
    [PHASE.ROUND_END]: 'ラウンド終了',
    [PHASE.GAME_OVER]: '終了',
  };
  $('#phase-chip').textContent = phaseLabels[app.state.phase] || app.state.phase;
}

function renderPlayers() {
  const root = $('#players-panel');
  root.innerHTML = '';
  const waiting = waitingPlayerId(app.state);
  app.state.players.forEach((p) => {
    const order = app.state.turnOrder.indexOf(p.id);
    const card = document.createElement('div');
    card.className = 'player-card'
      + (p.id === waiting ? ' active' : '')
      + (p.alive ? '' : ' dead');
    const pct = Math.max(0, Math.min(100, p.time));
    const panels = Object.entries(p.panels)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${PANEL_META[k].short}${n}`)
      .join(' ') || '手札なし';
    card.innerHTML = `
      <div class="player-card-head">
        <span class="player-dot" style="background:${p.color}"></span>
        <span>${p.name}${p.isCpu ? ' ·CPU' : ''}${p.id === app.myPlayerId ? ' ·あなた' : ''}</span>
        ${order >= 0 ? `<span class="order-badge">${order + 1}番手</span>` : ''}
      </div>
      <div class="time-row"><span>タイム</span><span class="time-value">${p.time}</span></div>
      <div class="time-gauge"><span style="width:${pct}%"></span></div>
      <div class="panel-count">${panels}${p.directionOverride ? ' ·↺' : ''}</div>
    `;
    root.appendChild(card);
  });
}

function renderDice() {
  const root = $('#dice-pool');
  root.innerHTML = '';
  const waiting = waitingPlayerId(app.state);
  const canPick = app.state.phase === PHASE.DRAFT
    && waiting === app.myPlayerId
    && canControl(app.myPlayerId);

  for (const die of app.state.dicePool) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'die';
    btn.textContent = die.value;
    btn.disabled = !canPick;
    btn.onmouseenter = () => {
      if (!canPick) {
        // 観戦ホバーも自分視点で予測
        localApply({ type: 'hover_die', dieId: die.id }, app.myPlayerId || waiting);
        return;
      }
      sendAction({ type: 'hover_die', dieId: die.id });
    };
    btn.onmouseleave = () => {
      if (!canPick) {
        localApply({ type: 'clear_hover' }, app.myPlayerId || waiting);
        return;
      }
      sendAction({ type: 'clear_hover' });
    };
    btn.onclick = () => {
      if (!canPick) return;
      sendAction({ type: 'pick_die', dieId: die.id });
    };
    root.appendChild(btn);
  }

  const hint = $('#dice-hint');
  if (app.state.phase === PHASE.GAME_OVER) hint.textContent = '試合終了';
  else if (waiting) {
    const p = app.state.players.find((x) => x.id === waiting);
    hint.textContent = `${p?.name || '?'} の手番`;
  } else hint.textContent = '';
}

function renderLog() {
  const root = $('#log');
  const items = app.state.log || [];
  const grew = items.length > app.lastLogLen;
  app.lastLogLen = items.length;
  root.innerHTML = '';
  // 古い→新しい（上から下）
  for (const item of items.slice(-50)) {
    const div = document.createElement('div');
    div.className = `log-item ${item.kind || ''}`;
    div.textContent = item.text;
    root.appendChild(div);
  }
  if (grew) root.scrollTop = root.scrollHeight;
}

function renderAction() {
  const root = $('#action-panel');
  root.innerHTML = '';
  const dock = $('#choice-dock');
  dock.hidden = true;
  dock.innerHTML = '';

  if (!app.state || app.state.phase === PHASE.GAME_OVER) {
    root.innerHTML = '<p class="action-note">試合終了</p>';
    return;
  }

  const waiting = waitingPlayerId(app.state);
  const pending = app.state.pending;
  const mine = waiting === app.myPlayerId && canControl(app.myPlayerId);

  if (!mine) {
    const p = app.state.players.find((x) => x.id === waiting);
    root.innerHTML = `<p class="action-note">${p?.name || '誰か'} の入力待ち</p>`;
    return;
  }

  if (pending?.type === 'move_choice') {
    root.innerHTML = '<p class="action-note">分岐があります。到達マスを選んでください。</p>';
    dock.hidden = false;
    dock.innerHTML = '<div class="choice-title">経路選択</div>';
    pending.options.forEach((opt, i) => {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = `マス ${app.state.board.cells[opt.cellId]?.label ?? opt.cellId}（${opt.path.length}歩）`;
      b.onmouseenter = () => {
        app.state.highlightPath = opt.path;
        app.state.hoverDestinations = [opt.cellId];
        app.canvasApi?.redraw();
      };
      b.onclick = () => sendAction({ type: 'choose_path', optionIndex: i });
      dock.appendChild(b);
    });
    return;
  }

  if (pending?.type === 'panel_place') {
    renderPanelChooser(root, {
      note: '空きマスです。パネルを選んで設置できます。',
      me: app.state.players.find((p) => p.id === app.myPlayerId),
      requireStock: true,
      confirmLabel: 'このパネルを設置',
      onConfirm: (type) => sendAction({ type: 'place_panel', panel: type }),
      allowSkip: true,
    });
    return;
  }

  if (pending?.type === 'panel_refill') {
    renderPanelChooser(root, {
      note: 'スタート通過 — 補充するパネルを選んでください。',
      requireStock: false,
      confirmLabel: 'このパネルを補充',
      onConfirm: (type) => sendAction({ type: 'refill_panel', panel: type }),
      allowSkip: false,
    });
    return;
  }

  if (app.state.phase === PHASE.DRAFT) {
    root.innerHTML = '<p class="action-note">上のダイスプールから1つ選んでください。ホバーで到達予想を表示します。</p>';
    return;
  }

  root.innerHTML = '<p class="action-note">待機中…</p>';
}

function renderPanelChooser(root, {
  note,
  me = null,
  requireStock = false,
  confirmLabel,
  onConfirm,
  allowSkip = false,
}) {
  root.innerHTML = `<p class="action-note">${note}</p>`;
  const available = Object.keys(PANEL_META).filter((type) => {
    if (!requireStock) return true;
    return (me?.panels?.[type] || 0) > 0;
  });
  if (!app.selectedPanel || !available.includes(app.selectedPanel)) {
    app.selectedPanel = available[0] || null;
  }

  const grid = document.createElement('div');
  grid.className = 'panel-pick';
  for (const [type, meta] of Object.entries(PANEL_META)) {
    const stock = me?.panels?.[type];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn' + (app.selectedPanel === type ? ' selected' : '');
    b.disabled = requireStock && !(stock > 0);
    b.textContent = requireStock ? `${meta.name}×${stock}` : meta.name;
    b.onclick = () => {
      unlockAudio();
      audio.sfx.click();
      app.selectedPanel = type;
      renderAction();
    };
    grid.appendChild(b);
  }
  root.appendChild(grid);

  const desc = document.createElement('div');
  desc.className = 'panel-desc';
  const meta = app.selectedPanel ? PANEL_META[app.selectedPanel] : null;
  if (meta) {
    desc.innerHTML = `<strong>${meta.name}</strong><div class="timing">発動: ${meta.timing}</div>${meta.desc}`;
  } else {
    desc.textContent = 'パネルを選択してください。';
  }
  root.appendChild(desc);

  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'btn primary';
  confirm.textContent = confirmLabel;
  confirm.disabled = !app.selectedPanel;
  confirm.onclick = () => {
    if (!app.selectedPanel) return;
    const type = app.selectedPanel;
    app.selectedPanel = null;
    onConfirm(type);
  };
  root.appendChild(confirm);

  if (allowSkip) {
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'btn ghost';
    skip.textContent = '設置しない';
    skip.onclick = () => {
      app.selectedPanel = null;
      sendAction({ type: 'skip_panel' });
    };
    root.appendChild(skip);
  }
}

function canControl(playerId) {
  if (app.mode === 'local') {
    const p = app.state?.players.find((x) => x.id === playerId);
    return p && !p.isCpu;
  }
  if (app.mode === 'host') {
    const p = app.state?.players.find((x) => x.id === playerId);
    // ホストは自分の席とCPUを操作
    if (!p) return false;
    if (p.isCpu) return true;
    return p.id === 'host' || p.peerId === app.net?.peerId;
  }
  if (app.mode === 'guest') {
    return playerId === app.myPlayerId;
  }
  return false;
}

function localApply(action, asPlayerId) {
  if (!app.state) return;
  applyAction(app.state, asPlayerId, action);
  app.canvasApi?.redraw();
  if (action.type !== 'hover_die' && action.type !== 'clear_hover') renderAll();
  else {
    // ハイライトのみ
  }
}

function playActionSfx(action, prevState, nextState) {
  if (!action) return;
  if (action.type === 'pick_die') {
    audio.sfx.pickDie(action.value || 3);
    return;
  }
  if (action.type === 'choose_path') {
    audio.sfx.fork();
    return;
  }
  if (action.type === 'place_panel') {
    audio.sfx.place();
    const fn = audio.sfx[action.panel];
    if (typeof fn === 'function') setTimeout(() => fn.call(audio.sfx), 80);
    return;
  }
  if (action.type === 'refill_panel') {
    audio.sfx.place();
    return;
  }
  if (action.type === 'skip_panel') {
    audio.sfx.click();
  }

  // ログ差分から効果音
  if (prevState && nextState) {
    const added = (nextState.log || []).slice((prevState.log || []).length);
    for (const item of added) {
      const t = item.text || '';
      if (t.includes('踏みつけ')) audio.sfx.stomp();
      else if (t.includes('ドレイン')) audio.sfx.drain();
      else if (t.includes('ブースト')) audio.sfx.boost();
      else if (t.includes('リバース')) audio.sfx.reverse();
      else if (t.includes('ロック')) audio.sfx.lock();
      else if (t.includes('脱落')) audio.sfx.eliminate();
      else if (t.includes('サドンデス')) {
        audio.setBgmMode('sudden');
        audio.sfx.sudden();
      }
    }
  }
}

function sendAction(action) {
  if (!app.state) return;
  unlockAudio();

  if (app.mode === 'guest') {
    if (action.type === 'hover_die' || action.type === 'clear_hover') {
      // ローカル予測
      applyAction(app.state, app.myPlayerId, action);
      app.canvasApi?.redraw();
      app.net?.sendToHost({ type: 'hover', action });
      return;
    }
    if (action.type === 'pick_die') {
      const die = app.state.dicePool.find((d) => d.id === action.dieId);
      playActionSfx({ ...action, value: die?.value });
    } else {
      playActionSfx(action);
    }
    app.net?.sendToHost({ type: 'action', action });
    return;
  }

  // local / host
  const actor = waitingPlayerId(app.state) || app.myPlayerId;
  const pid = app.state.pending?.playerId || actor;
  const prev = serializeState(app.state);
  const result = applyAction(app.state, pid, action);
  if (!result.ok && action.type !== 'hover_die' && action.type !== 'clear_hover') {
    toast(result.error || '不正な操作');
    return;
  }
  if (action.type === 'hover_die' || action.type === 'clear_hover') {
    app.canvasApi?.redraw();
    return;
  }
  if (action.type === 'pick_die') {
    const dieVal = prev.dicePool.find((d) => d.id === action.dieId)?.value;
    playActionSfx({ ...action, value: dieVal }, prev, app.state);
  } else {
    playActionSfx(action, prev, app.state);
  }
  reactToStateChange(prev);
  syncState();
  scheduleCpu();
}

function reactToStateChange(prev) {
  if (!app.state) return;
  if (app.state.round >= 11) audio.setBgmMode('sudden');
  const waiting = waitingPlayerId(app.state);
  if (waiting && waiting !== app.lastWaitingId && waiting === app.myPlayerId && canControl(waiting)) {
    audio.sfx.yourTurn();
  }
  app.lastWaitingId = waiting;
  if (prev && app.state.round !== prev.round) audio.sfx.round();
}

function scheduleCpu() {
  clearTimeout(app.cpuTimer);
  if (!app.state || app.state.phase === PHASE.GAME_OVER) return;
  if (app.mode === 'guest') return;

  const waiting = waitingPlayerId(app.state);
  if (!waiting) return;
  const p = app.state.players.find((x) => x.id === waiting);
  if (!p?.isCpu) return;

  app.cpuTimer = setTimeout(() => {
    const action = chooseCpuAction(app.state, waiting);
    if (!action) return;
    const prev = serializeState(app.state);
    const result = applyAction(app.state, waiting, action);
    if (result.ok) {
      if (action.type === 'pick_die') {
        const dieVal = prev.dicePool.find((d) => d.id === action.dieId)?.value;
        playActionSfx({ ...action, value: dieVal }, prev, app.state);
      } else {
        playActionSfx(action, prev, app.state);
      }
      reactToStateChange(prev);
      syncState();
      scheduleCpu();
    }
  }, 550);
}

function maybeShowWinner() {
  if (app.state?.phase !== PHASE.GAME_OVER) {
    $('#winner').hidden = true;
    return;
  }
  const w = app.state.players.find((p) => p.id === app.state.winnerId);
  $('#winner-name').textContent = w ? `${w.name} の勝利` : '引き分け';
  $('#winner-sub').textContent = `ラウンド ${app.state.round} で決着`;
  if ($('#winner').hidden) {
    audio.stopBgm();
    audio.sfx.win();
  }
  $('#winner').hidden = false;
}

window.addEventListener('resize', () => app.canvasApi?.resize());

// ローカルホットシート: 手番の人間を操作対象にする
setInterval(() => {
  if (app.mode === 'local' && app.state && app.state.phase !== PHASE.GAME_OVER) {
    const waiting = waitingPlayerId(app.state);
    const p = app.state.players.find((x) => x.id === waiting);
    if (p && !p.isCpu && app.myPlayerId !== p.id) {
      app.myPlayerId = p.id;
      renderAll();
    }
  }
}, 200);
