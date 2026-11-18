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

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const app = {
  mode: null, // 'local' | 'host' | 'guest'
  net: null,
  state: null,
  localSeatId: null,
  lobbyRole: null,
  lobbyColor: PLAYER_COLORS[0],
  lobbyPlayers: [],
  cpuSeq: 0,
  myPlayerId: null,
  canvasApi: null,
  cpuTimer: null,
};

document.getElementById('app-version-label').textContent = `v${APP_VERSION}`;

function showScreen(id) {
  $$('.screen').forEach((el) => el.classList.toggle('active', el.id === id));
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
$('#btn-howto').onclick = () => showScreen('screen-howto');
$('#btn-howto-back').onclick = () => showScreen('screen-title');
$('#btn-local').onclick = () => {
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
  $('#winner').hidden = true;
  showScreen('screen-title');
}

function destroyNet() {
  try { app.net?.destroy(); } catch (_) { /* ignore */ }
  app.net = null;
}

/* —— local seats —— */
function buildSeatEditors() {
  const root = $('#seat-editors');
  root.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const row = document.createElement('div');
    row.className = 'seat-row';
    row.innerHTML = `
      <span class="seat-swatch" style="background:${PLAYER_COLORS[i]}"></span>
      <input type="text" maxlength="12" data-seat="${i}" value="${i === 0 ? 'プレイヤー1' : i === 1 ? 'プレイヤー2' : ''}" placeholder="空き" />
      <label><input type="checkbox" data-cpu="${i}" ${i >= 2 ? 'checked' : ''} ${i < 2 ? '' : ''}/> CPU</label>
    `;
    root.appendChild(row);
  }
}

$('#btn-start-game').onclick = () => {
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
function openLobby(role) {
  app.lobbyRole = role;
  app.mode = role;
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
      buildColorPicker();
    };
    root.appendChild(b);
  });
}

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
    const result = applyAction(app.state, pid, data.action);
    if (!result.ok) {
      app.net.sendTo(from, { type: 'action_reject', error: result.error });
      return;
    }
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
  app.state.log.unshift({ t: Date.now(), text, kind: 'system' });
}

/* —— game —— */
function startGame(seats) {
  app.state = createInitialState({ seats });
  // peerId を反映
  for (const s of seats) {
    const p = app.state.players.find((x) => x.id === s.id);
    if (p) p.peerId = s.peerId || null;
  }
  enterGameScreen();
  scheduleCpu();
}

function enterGameScreen() {
  showScreen('screen-game');
  $('#winner').hidden = true;
  if (!app.canvasApi) {
    app.canvasApi = mountBoardCanvas(
      $('#board'),
      () => app.state,
      (cellId) => {
        const cell = app.state?.board.cells[cellId];
        const panel = app.state?.panelsOnBoard[cellId];
        let text = `マス ${cell?.label ?? cellId}`;
        if (cell?.isStart) text += '（スタート）';
        if (cell?.isBranch) text += '（分岐）';
        if (panel) {
          const owner = app.state.players.find((p) => p.id === panel.ownerId);
          text += ` / ${PANEL_META[panel.type]?.name}（${owner?.name || '?'}）`;
        }
        $('#inspect').textContent = text;
      },
    );
  }
  app.canvasApi.resize();
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
  root.innerHTML = '';
  for (const item of (app.state.log || []).slice(0, 40)) {
    const div = document.createElement('div');
    div.className = `log-item ${item.kind || ''}`;
    div.textContent = item.text;
    root.appendChild(div);
  }
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
    root.innerHTML = '<p class="action-note">空きマスです。パネルを設置できます。</p>';
    const grid = document.createElement('div');
    grid.className = 'panel-pick';
    const me = app.state.players.find((p) => p.id === app.myPlayerId);
    for (const [type, meta] of Object.entries(PANEL_META)) {
      const b = document.createElement('button');
      b.className = 'btn';
      b.disabled = !(me.panels[type] > 0);
      b.textContent = `${meta.name}×${me.panels[type]}`;
      b.title = meta.desc;
      b.onclick = () => sendAction({ type: 'place_panel', panel: type });
      grid.appendChild(b);
    }
    root.appendChild(grid);
    const skip = document.createElement('button');
    skip.className = 'btn ghost';
    skip.textContent = '設置しない';
    skip.onclick = () => sendAction({ type: 'skip_panel' });
    root.appendChild(skip);
    return;
  }

  if (pending?.type === 'panel_refill') {
    root.innerHTML = '<p class="action-note">スタート通過 — パネルを1枚補充</p>';
    const grid = document.createElement('div');
    grid.className = 'panel-pick';
    for (const [type, meta] of Object.entries(PANEL_META)) {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = meta.name;
      b.onclick = () => sendAction({ type: 'refill_panel', panel: type });
      grid.appendChild(b);
    }
    root.appendChild(grid);
    return;
  }

  if (app.state.phase === PHASE.DRAFT) {
    root.innerHTML = '<p class="action-note">上のダイスプールから1つ選んでください。ホバーで到達予想を表示します。</p>';
    return;
  }

  root.innerHTML = '<p class="action-note">待機中…</p>';
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

function sendAction(action) {
  if (!app.state) return;

  if (app.mode === 'guest') {
    if (action.type === 'hover_die' || action.type === 'clear_hover') {
      // ローカル予測
      applyAction(app.state, app.myPlayerId, action);
      app.canvasApi?.redraw();
      app.net?.sendToHost({ type: 'hover', action });
      return;
    }
    app.net?.sendToHost({ type: 'action', action });
    return;
  }

  // local / host
  const actor = waitingPlayerId(app.state) || app.myPlayerId;
  // pending 中は pending のプレイヤー
  const pid = app.state.pending?.playerId || actor;
  const result = applyAction(app.state, pid, action);
  if (!result.ok && action.type !== 'hover_die' && action.type !== 'clear_hover') {
    toast(result.error || '不正な操作');
    return;
  }
  if (action.type === 'hover_die' || action.type === 'clear_hover') {
    app.canvasApi?.redraw();
    return;
  }
  syncState();
  scheduleCpu();
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
    const result = applyAction(app.state, waiting, action);
    if (result.ok) {
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
