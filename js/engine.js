/** Chrono Step — ホスト権威のゲーム状態エンジン */

import {
  BOOST_STEPS,
  DRAIN_AMOUNT,
  INITIAL_TIME,
  PANEL_TYPES,
  PLAYER_COLORS,
  START_ID,
  STOMP_AMOUNT,
  SUDDEN_DEATH_FROM_ROUND,
  SUDDEN_DEATH_TICK,
  createBoard,
  nextOptions,
} from './board.js';

export const PHASE = {
  DICE: 'dice',
  DRAFT: 'draft',
  MOVE_CHOICE: 'move_choice',
  PANEL_PLACE: 'panel_place',
  PANEL_REFILL: 'panel_refill',
  ROUND_END: 'round_end',
  GAME_OVER: 'game_over',
};

function emptyPanels() {
  return { drain: 2, boost: 2, reverse: 2, lock: 2 };
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function rollDie() {
  return 1 + Math.floor(Math.random() * 6);
}

function pushLog(state, text, kind = 'info') {
  state.log.unshift({ t: Date.now(), text, kind });
  if (state.log.length > 80) state.log.length = 80;
}

function alivePlayers(state) {
  return state.players.filter((p) => p.alive);
}

function playerById(state, id) {
  return state.players.find((p) => p.id === id);
}

function currentActor(state) {
  if (state.turnOrder.length === 0) return null;
  const id = state.turnOrder[state.turnIndex];
  return playerById(state, id);
}

function panelsRemaining(player) {
  return PANEL_TYPES.reduce((s, k) => s + (player.panels[k] || 0), 0);
}

export function createInitialState({ seats, seedLog } = {}) {
  const board = createBoard();
  const players = (seats || []).map((seat, i) => ({
    id: seat.id ?? `p${i}`,
    name: seat.name || `P${i + 1}`,
    color: seat.color || PLAYER_COLORS[i % PLAYER_COLORS.length],
    isCpu: !!seat.isCpu,
    peerId: seat.peerId || null,
    alive: true,
    time: INITIAL_TIME,
    pos: START_ID,
    panels: emptyPanels(),
    directionOverride: null, // 'ccw' | null
    laps: 0,
  }));

  const state = {
    version: 1,
    board,
    players,
    panelsOnBoard: {}, // cellId -> { type, ownerId }
    dicePool: [],
    turnOrder: players.map((p) => p.id),
    turnIndex: 0,
    round: 1,
    phase: PHASE.DICE,
    pending: null,
    winnerId: null,
    log: [],
    highlightPath: [],
    highlightCell: null,
  };

  if (seedLog !== false) {
    pushLog(state, `ゲーム開始 — ${players.length}人、タイム${INITIAL_TIME}`, 'system');
  }
  beginDicePhase(state);
  return state;
}

export function serializeState(state) {
  return clone(state);
}

export function hydrateState(raw) {
  return clone(raw);
}

function beginDicePhase(state) {
  const alive = alivePlayers(state);
  if (alive.length <= 1) {
    finishGame(state, alive[0]?.id ?? null);
    return;
  }

  const count = alive.length + 1;
  state.dicePool = Array.from({ length: count }, (_, i) => ({
    id: `d${state.round}-${i}-${Math.random().toString(36).slice(2, 7)}`,
    value: rollDie(),
  }));
  state.phase = PHASE.DRAFT;
  state.pending = null;
  state.highlightPath = [];
  state.highlightCell = null;
  // 生存者だけで手番順を再構成（脱落者を除く）
  state.turnOrder = state.turnOrder.filter((id) => playerById(state, id)?.alive);
  state.turnIndex = 0;
  pushLog(state, `ラウンド ${state.round} — ダイス ${state.dicePool.map((d) => d.value).join(', ')}`, 'round');
}

function finishGame(state, winnerId) {
  state.phase = PHASE.GAME_OVER;
  state.winnerId = winnerId;
  state.pending = null;
  const w = winnerId ? playerById(state, winnerId) : null;
  pushLog(state, w ? `${w.name} の勝利` : '勝者なし', 'win');
}

function eliminate(state, player, reason) {
  if (!player.alive) return;
  player.alive = false;
  player.time = Math.min(player.time, 0);
  pushLog(state, `${player.name} 脱落（${reason}）`, 'danger');
  const alive = alivePlayers(state);
  if (alive.length <= 1) {
    finishGame(state, alive[0]?.id ?? null);
  }
}

function applyTimeDelta(state, player, delta, reason) {
  if (!player.alive) return;
  player.time += delta;
  if (delta !== 0) {
    const sign = delta > 0 ? '+' : '';
    pushLog(state, `${player.name} タイム${sign}${delta}${reason ? `（${reason}）` : ''}`, delta > 0 ? 'ok' : 'warn');
  }
  if (player.time <= 0) {
    eliminate(state, player, reason || 'タイム切れ');
  }
}

function directionFor(player) {
  return player.directionOverride === 'ccw' ? 'ccw' : 'cw';
}

/**
 * 出目ぶんの到達候補を列挙（分岐で分岐する）。
 * boost / lock はシミュレーションに含める。
 */
export function previewDestinations(state, playerId, steps) {
  const player = playerById(state, playerId);
  if (!player?.alive) return [];
  const dir = directionFor(player);
  const results = [];

  function walk(pos, remaining, path, timeLeft, freeBoostQueue) {
    if (remaining <= 0 && freeBoostQueue <= 0) {
      results.push({ cellId: pos, path: [...path], timeLeft });
      return;
    }

    const useFree = remaining <= 0 && freeBoostQueue > 0;
    const options = nextOptions(state.board, pos, dir);
    if (options.length === 0) {
      results.push({ cellId: pos, path: [...path], timeLeft });
      return;
    }

    for (const next of options) {
      const panel = state.panelsOnBoard[next];
      let nextRemaining = remaining;
      let nextFree = freeBoostQueue;
      let nextTime = timeLeft;
      const nextPath = [...path, next];

      if (useFree) {
        nextFree -= 1;
      } else {
        nextRemaining -= 1;
        nextTime -= 1;
      }

      if (nextTime <= 0) {
        results.push({ cellId: next, path: nextPath, timeLeft: nextTime, eliminated: true });
        continue;
      }

      // ロック: 他者設置かつ通過（まだ移動力が残る）時に強制停止
      const isPassAttempt = nextRemaining > 0 || nextFree > 0;
      if (
        isPassAttempt &&
        panel?.type === 'lock' &&
        panel.ownerId !== player.id
      ) {
        // 強制停止 → 残り移動力消滅。停止扱いなのでその後のブースト停止効果は別処理
        let stopFree = 0;
        if (panelStopBoost(state, next)) stopFree = BOOST_STEPS;
        if (stopFree > 0) {
          walk(next, 0, nextPath, nextTime, stopFree);
        } else {
          results.push({ cellId: next, path: nextPath, timeLeft: nextTime, locked: true });
        }
        continue;
      }

      // ブースト通過／停止
      if (panel?.type === 'boost') {
        nextFree += BOOST_STEPS;
      }

      walk(next, nextRemaining, nextPath, nextTime, nextFree);
    }
  }

  walk(player.pos, steps, [], player.time, 0);

  // 同一セルは代表1つ（最初）
  const seen = new Set();
  return results.filter((r) => {
    const key = `${r.cellId}:${r.path.join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function panelStopBoost(state, cellId) {
  return state.panelsOnBoard[cellId]?.type === 'boost';
}

function uniqueDestCells(previews) {
  const map = new Map();
  for (const p of previews) {
    if (!map.has(p.cellId)) map.set(p.cellId, p);
  }
  return [...map.values()];
}

/** ダイス選択後、分岐がなければ即移動。あれば選択待ち */
function afterDicePicked(state, player, dieValue) {
  const previews = previewDestinations(state, player.id, dieValue);
  const uniq = uniqueDestCells(previews);

  if (uniq.length === 0) {
    pushLog(state, `${player.name} は移動できない`, 'warn');
    advanceAfterAction(state);
    return;
  }

  if (uniq.length === 1) {
    executeMove(state, player, uniq[0].path, dieValue);
    return;
  }

  state.phase = PHASE.MOVE_CHOICE;
  state.pending = {
    type: 'move_choice',
    playerId: player.id,
    dieValue,
    options: uniq.map((u) => ({
      cellId: u.cellId,
      path: u.path,
    })),
  };
  state.highlightPath = [];
  state.highlightCell = null;
}

function executeMove(state, player, path, dieValue) {
  // リバースは移動開始時に消費（経路計算は選択前に済んでいる）
  if (player.directionOverride) {
    pushLog(state, `${player.name} は反時計回りで移動`, 'info');
    player.directionOverride = null;
  }

  let remaining = dieValue;
  let freeBoost = 0;

  for (let i = 0; i < path.length; i++) {
    const next = path[i];
    const from = player.pos;

    if (remaining > 0) {
      remaining -= 1;
      applyTimeDelta(state, player, -1, '移動');
      if (!player.alive) {
        player.pos = next;
        return afterMoveSettled(state, player);
      }
    } else if (freeBoost > 0) {
      freeBoost -= 1;
    } else {
      break;
    }

    const crossedStart = next === START_ID && from !== START_ID;
    player.pos = next;

    if (crossedStart) {
      player.laps += 1;
      maybeOfferRefill(state, player);
    }

    const panel = state.panelsOnBoard[next];
    const stillMoving = remaining > 0 || freeBoost > 0;

    if (stillMoving && panel?.type === 'lock' && panel.ownerId !== player.id) {
      pushLog(state, `${player.name} がロックで停止`, 'warn');
      remaining = 0;
      freeBoost = 0;
      break;
    }

    if (panel?.type === 'boost') {
      freeBoost += BOOST_STEPS;
      pushLog(state, `${player.name} がブーストで加速`, 'info');
    }

    if (remaining <= 0 && freeBoost <= 0) break;
  }

  afterMoveSettled(state, player);
}

function maybeOfferRefill(state, player) {
  if (panelsRemaining(player) > 0) return;
  // 補充フェイズは移動解決後に割り込む
  state._refillQueue = state._refillQueue || [];
  if (!state._refillQueue.includes(player.id)) state._refillQueue.push(player.id);
}

function afterMoveSettled(state, player) {
  if (!player.alive) {
    advanceAfterAction(state);
    return;
  }

  // 踏みつけ
  for (const other of state.players) {
    if (!other.alive || other.id === player.id) continue;
    if (other.pos === player.pos) {
      applyTimeDelta(state, other, -STOMP_AMOUNT, '踏みつけ');
      if (player.alive) applyTimeDelta(state, player, STOMP_AMOUNT, '踏みつけ');
      pushLog(state, `${player.name} が ${other.name} を踏みつけ`, 'warn');
    }
  }

  if (!player.alive) {
    advanceAfterAction(state);
    return;
  }

  // 停止パネル効果
  applyStopPanel(state, player);

  if (!player.alive) {
    advanceAfterAction(state);
    return;
  }

  // パネル設置 or 補充
  const cellPanel = state.panelsOnBoard[player.pos];
  if (!cellPanel && panelsRemaining(player) > 0) {
    state.phase = PHASE.PANEL_PLACE;
    state.pending = {
      type: 'panel_place',
      playerId: player.id,
      cellId: player.pos,
    };
    return;
  }

  continueAfterPanelStep(state, player);
}

function applyStopPanel(state, player) {
  const panel = state.panelsOnBoard[player.pos];
  if (!panel) return;

  if (panel.type === 'drain') {
    const owner = playerById(state, panel.ownerId);
    applyTimeDelta(state, player, -DRAIN_AMOUNT, 'ドレイン');
    if (owner?.alive) applyTimeDelta(state, owner, DRAIN_AMOUNT, 'ドレイン回収');
  } else if (panel.type === 'reverse') {
    player.directionOverride = 'ccw';
    pushLog(state, `${player.name} にリバース付与`, 'info');
  } else if (panel.type === 'boost') {
    // 停止時ブーストは移動中に処理済み。ここに来た時点で追加分は消化後。
  }
  // lock は通過時のみ
}

function continueAfterPanelStep(state, player) {
  if (state._refillQueue?.includes(player.id) && panelsRemaining(player) === 0) {
    state.phase = PHASE.PANEL_REFILL;
    state.pending = { type: 'panel_refill', playerId: player.id };
    return;
  }
  advanceAfterAction(state);
}

function advanceAfterAction(state) {
  if (state.phase === PHASE.GAME_OVER) return;

  // 補充キュー掃除
  if (state._refillQueue) {
    state._refillQueue = state._refillQueue.filter((id) => {
      const p = playerById(state, id);
      return p?.alive && panelsRemaining(p) === 0;
    });
  }

  const alive = alivePlayers(state);
  if (alive.length <= 1) {
    finishGame(state, alive[0]?.id ?? null);
    return;
  }

  // 次のドラフト手番
  const survivorsInOrder = state.turnOrder.filter((id) => playerById(state, id)?.alive);
  state.turnOrder = survivorsInOrder;

  // いまの手番を消化したので次へ。ダイスが生存者数ぶん取られたらラウンド終了
  const taken = (alive.length + 1) - state.dicePool.length;
  if (taken >= alive.length || state.dicePool.length <= 1) {
    // 残り1個破棄
    if (state.dicePool.length > 0) {
      const discarded = state.dicePool.map((d) => d.value).join(', ');
      pushLog(state, `余りダイス破棄: ${discarded}`, 'info');
      state.dicePool = [];
    }
    endRound(state);
    return;
  }

  state.turnIndex = (state.turnIndex + 1) % state.turnOrder.length;
  state.phase = PHASE.DRAFT;
  state.pending = null;
  state.highlightPath = [];
  state.highlightCell = null;
}

function endRound(state) {
  // 11ラウンド目以降の終了時にサドンデス
  if (state.round >= SUDDEN_DEATH_FROM_ROUND) {
    pushLog(state, `サドンデス — 全員タイム−${SUDDEN_DEATH_TICK}`, 'danger');
    for (const p of alivePlayers(state)) {
      applyTimeDelta(state, p, -SUDDEN_DEATH_TICK, 'サドンデス');
    }
    const alive = alivePlayers(state);
    if (alive.length <= 1) {
      finishGame(state, alive[0]?.id ?? null);
      return;
    }
  }

  // 手番順ローテーション（2番手が次の1番手）
  if (state.turnOrder.length > 1) {
    state.turnOrder = [...state.turnOrder.slice(1), state.turnOrder[0]];
  }
  state.turnIndex = 0;
  state.round += 1;
  state.pending = null;
  beginDicePhase(state);
}

/** —— アクション API —— */

export function getLegalActions(state, actorId) {
  if (state.phase === PHASE.GAME_OVER) return [];
  const actor = currentActor(state);
  if (!actor || actor.id !== actorId) {
    // 補充・設置・分岐は pending のプレイヤー
    if (state.pending && state.pending.playerId === actorId) {
      return actionsForPending(state);
    }
    return [];
  }
  if (state.pending && state.pending.playerId === actorId) {
    return actionsForPending(state);
  }
  if (state.phase === PHASE.DRAFT) {
    return state.dicePool.map((d) => ({ type: 'pick_die', dieId: d.id, value: d.value }));
  }
  return [];
}

function actionsForPending(state) {
  const p = state.pending;
  if (!p) return [];
  if (p.type === 'move_choice') {
    return p.options.map((o, i) => ({ type: 'choose_path', optionIndex: i, cellId: o.cellId, path: o.path }));
  }
  if (p.type === 'panel_place') {
    const pl = playerById(state, p.playerId);
    return PANEL_TYPES.filter((t) => pl.panels[t] > 0).map((t) => ({ type: 'place_panel', panel: t }));
  }
  if (p.type === 'panel_refill') {
    return PANEL_TYPES.map((t) => ({ type: 'refill_panel', panel: t }));
  }
  return [];
}

export function applyAction(state, actorId, action) {
  if (state.phase === PHASE.GAME_OVER) return { ok: false, error: 'ゲーム終了' };

  const pending = state.pending;
  if (pending && pending.playerId !== actorId) {
    return { ok: false, error: '他プレイヤーの選択待ち' };
  }

  if (action.type === 'pick_die') {
    if (state.phase !== PHASE.DRAFT) return { ok: false, error: 'ドラフト中ではない' };
    const actor = currentActor(state);
    if (!actor || actor.id !== actorId) return { ok: false, error: '手番ではない' };
    const idx = state.dicePool.findIndex((d) => d.id === action.dieId);
    if (idx < 0) return { ok: false, error: 'ダイスがない' };
    const [die] = state.dicePool.splice(idx, 1);
    pushLog(state, `${actor.name} がダイス ${die.value} を選択`, 'info');
    afterDicePicked(state, actor, die.value);
    return { ok: true };
  }

  if (action.type === 'choose_path') {
    if (pending?.type !== 'move_choice') return { ok: false, error: '経路選択中ではない' };
    const opt = pending.options[action.optionIndex];
    if (!opt) return { ok: false, error: '不正な経路' };
    const player = playerById(state, actorId);
    state.pending = null;
    executeMove(state, player, opt.path, pending.dieValue);
    return { ok: true };
  }

  if (action.type === 'place_panel') {
    if (pending?.type !== 'panel_place') return { ok: false, error: '設置フェイズではない' };
    const player = playerById(state, actorId);
    const panel = action.panel;
    if (!PANEL_TYPES.includes(panel) || player.panels[panel] <= 0) {
      return { ok: false, error: 'パネルがない' };
    }
    if (state.panelsOnBoard[pending.cellId]) {
      return { ok: false, error: 'すでにパネルがある' };
    }
    player.panels[panel] -= 1;
    state.panelsOnBoard[pending.cellId] = { type: panel, ownerId: player.id };
    pushLog(state, `${player.name} がマス${pending.cellId}に${panel}を設置`, 'ok');
    state.pending = null;
    continueAfterPanelStep(state, player);
    return { ok: true };
  }

  if (action.type === 'skip_panel') {
    if (pending?.type !== 'panel_place') return { ok: false, error: '設置フェイズではない' };
    const player = playerById(state, actorId);
    state.pending = null;
    pushLog(state, `${player.name} はパネルを設置しなかった`, 'info');
    continueAfterPanelStep(state, player);
    return { ok: true };
  }

  if (action.type === 'refill_panel') {
    if (pending?.type !== 'panel_refill') return { ok: false, error: '補充フェイズではない' };
    const player = playerById(state, actorId);
    const panel = action.panel;
    if (!PANEL_TYPES.includes(panel)) return { ok: false, error: '不正なパネル' };
    player.panels[panel] += 1;
    pushLog(state, `${player.name} が${panel}を1枚補充`, 'ok');
    if (state._refillQueue) {
      state._refillQueue = state._refillQueue.filter((id) => id !== player.id);
    }
    state.pending = null;
    advanceAfterAction(state);
    return { ok: true };
  }

  if (action.type === 'hover_die') {
    const player = playerById(state, actorId) || currentActor(state);
    if (!player) return { ok: true };
    const die = state.dicePool.find((d) => d.id === action.dieId);
    if (!die) {
      state.highlightPath = [];
      state.highlightCell = null;
      return { ok: true };
    }
    const previews = previewDestinations(state, player.id, die.value);
    const uniq = uniqueDestCells(previews);
    state.highlightPath = uniq.flatMap((u) => u.path);
    state.highlightCell = uniq.length === 1 ? uniq[0].cellId : null;
    state.hoverDestinations = uniq.map((u) => u.cellId);
    return { ok: true };
  }

  if (action.type === 'clear_hover') {
    state.highlightPath = [];
    state.highlightCell = null;
    state.hoverDestinations = [];
    return { ok: true };
  }

  return { ok: false, error: '未知のアクション' };
}

/** CPU: 単純ヒューリスティック */
export function chooseCpuAction(state, playerId) {
  const actions = getLegalActions(state, playerId);
  if (actions.length === 0) return null;

  if (actions[0].type === 'pick_die') {
    // 自分のタイムを残しつつ、敵ドレインを踏まない出目を優先
    const player = playerById(state, playerId);
    let best = actions[0];
    let bestScore = -Infinity;
    for (const a of actions) {
      const previews = previewDestinations(state, playerId, a.value);
      const uniq = uniqueDestCells(previews);
      let score = 0;
      for (const u of uniq) {
        const panel = state.panelsOnBoard[u.cellId];
        if (panel?.type === 'drain' && panel.ownerId !== playerId) score -= 12;
        if (panel?.type === 'drain' && panel.ownerId === playerId) score += 1;
        if (!panel) score += 3; // 設置機会
        if (u.timeLeft < 15) score -= 5;
        score += Math.min(a.value, 4) * 0.2;
      }
      // 高出目でタイムが減りすぎないよう抑制
      score -= Math.max(0, a.value - (player.time / 20));
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    return best;
  }

  if (actions[0].type === 'choose_path') {
    const player = playerById(state, playerId);
    let best = actions[0];
    let bestScore = -Infinity;
    for (const a of actions) {
      let score = 0;
      const panel = state.panelsOnBoard[a.cellId];
      if (panel?.type === 'drain' && panel.ownerId !== playerId) score -= 20;
      if (!panel && panelsRemaining(player) > 0) score += 8;
      if (panel?.type === 'boost') score += 2;
      score -= a.path.length * 0.1;
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    return best;
  }

  if (actions[0].type === 'place_panel') {
    // ドレイン優先、なければロック、ブースト、リバース
    const prefer = ['drain', 'lock', 'boost', 'reverse'];
    for (const t of prefer) {
      const hit = actions.find((a) => a.panel === t);
      if (hit) return hit;
    }
    return actions[0];
  }

  if (actions[0].type === 'refill_panel') {
    return actions.find((a) => a.panel === 'drain') || actions[0];
  }

  return actions[0];
}

export function isActorCpu(state, playerId) {
  return !!playerById(state, playerId)?.isCpu;
}

export function waitingPlayerId(state) {
  if (state.phase === PHASE.GAME_OVER) return null;
  if (state.pending?.playerId) return state.pending.playerId;
  if (state.phase === PHASE.DRAFT) return currentActor(state)?.id ?? null;
  return null;
}
