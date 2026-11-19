/** Chrono Step — 画面演出（手番・タイム変化・イベント） */

export function createFx() {
  const turnEl = () => document.getElementById('turn-banner');
  const flashEl = () => document.getElementById('event-flash');
  const layerEl = () => document.getElementById('time-fx-layer');

  let turnTimer = null;
  let flashTimer = null;

  function showTurnBanner({ name, color, mine }) {
    const el = turnEl();
    if (!el) return;
    el.hidden = false;
    el.classList.toggle('mine', !!mine);
    el.classList.remove('show');
    // reflow for retrigger
    void el.offsetWidth;
    el.innerHTML = `
      <span class="tb-kicker">${mine ? 'YOUR MOVE' : 'TURN'}</span>
      <span class="tb-name" style="--p:${color || '#c4a35a'}">${name || 'プレイヤー'}</span>
      <span class="tb-sub">${mine ? '公開情報を読んで一手を決める' : '相手の選択を観察せよ'}</span>
    `;
    el.classList.add('show');
    clearTimeout(turnTimer);
    turnTimer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => { el.hidden = true; }, 320);
    }, mine ? 1600 : 1200);
  }

  function flashEvent({ title, detail, kind = 'info', icon = '◆' }) {
    const el = flashEl();
    if (!el) return;
    el.hidden = false;
    el.dataset.kind = kind;
    el.classList.remove('show');
    void el.offsetWidth;
    el.innerHTML = `
      <div class="ef-card">
        <div class="ef-icon">${icon}</div>
        <div class="ef-title">${title}</div>
        ${detail ? `<div class="ef-detail">${detail}</div>` : ''}
      </div>
    `;
    el.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => { el.hidden = true; }, 280);
    }, 1400);
  }

  function floatTime({ amount, color, label, x, y }) {
    const layer = layerEl();
    if (!layer || !amount) return;
    const node = document.createElement('div');
    const gain = amount > 0;
    node.className = `time-float ${gain ? 'gain' : 'loss'}`;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.style.setProperty('--p', color || (gain ? '#5f9e7a' : '#c45c4a'));
    node.innerHTML = `<strong>${gain ? '+' : ''}${amount}</strong>${label ? `<span>${label}</span>` : ''}`;
    layer.appendChild(node);
    requestAnimationFrame(() => node.classList.add('go'));
    setTimeout(() => node.remove(), 1200);
  }

  function pulseScreen(kind = 'pick') {
    const root = document.getElementById('screen-game');
    if (!root) return;
    root.classList.remove('pulse-pick', 'pulse-danger', 'pulse-ok');
    void root.offsetWidth;
    root.classList.add(`pulse-${kind}`);
    setTimeout(() => root.classList.remove(`pulse-${kind}`), 420);
  }

  return {
    showTurnBanner,
    flashEvent,
    floatTime,
    pulseScreen,
  };
}

export function assessDestinations(state, playerId, previews) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player || !previews?.length) {
    return { cost: 0, dangers: [], opportunities: [], labels: [], worst: null, best: null };
  }

  const uniq = [];
  const seen = new Set();
  for (const p of previews) {
    if (seen.has(p.cellId)) continue;
    seen.add(p.cellId);
    uniq.push(p);
  }

  const dangers = [];
  const opportunities = [];
  const labels = [];

  for (const u of uniq) {
    const cell = state.board.cells[u.cellId];
    const label = cell?.isStart ? 'START' : (cell?.label ?? String(u.cellId));
    labels.push(label);
    const panel = state.panelsOnBoard[u.cellId];
    if (panel?.type === 'drain' && panel.ownerId !== playerId) {
      dangers.push(`ドレイン(${label})`);
    }
    if (panel?.type === 'lock' && panel.ownerId !== playerId) {
      dangers.push(`ロック手前停止(${label})`);
    }
    if (!panel) opportunities.push(`設置可(${label})`);
    if (panel?.type === 'drain' && panel.ownerId === playerId) {
      opportunities.push(`自ドレイン回収(${label})`);
    }
    if (u.eliminated || u.timeLeft <= 0) dangers.push('タイム切れ危険');
  }

  const cost = Math.max(0, player.time - Math.max(...uniq.map((u) => u.timeLeft)));
  const worst = uniq.reduce((a, b) => (a.timeLeft <= b.timeLeft ? a : b));
  const best = uniq.reduce((a, b) => (a.timeLeft >= b.timeLeft ? a : b));

  return {
    cost,
    dangers: [...new Set(dangers)],
    opportunities: [...new Set(opportunities)],
    labels,
    worst,
    best,
    branch: uniq.length > 1,
  };
}
