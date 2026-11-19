/** Chrono Step — Canvas 盤面描画 */

import { PANEL_META } from './board.js';

const CELL = 56;
const GAP = 8;
const PAD = 36;

function cellOrigin(cell) {
  return {
    x: PAD + cell.col * (CELL + GAP),
    y: PAD + cell.row * (CELL + GAP),
  };
}

export function boardPixelSize(board) {
  let maxC = 0;
  let maxR = 0;
  for (const c of board.cells) {
    maxC = Math.max(maxC, c.col);
    maxR = Math.max(maxR, c.row);
  }
  return {
    w: PAD * 2 + (maxC + 1) * (CELL + GAP) - GAP,
    h: PAD * 2 + (maxR + 1) * (CELL + GAP) - GAP,
  };
}

export function hitTestCell(board, px, py) {
  for (const cell of board.cells) {
    const { x, y } = cellOrigin(cell);
    if (px >= x && px <= x + CELL && py >= y && py <= y + CELL) return cell.id;
  }
  return null;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function drawBoard(ctx, state, opts = {}) {
  const { board } = state;
  const size = boardPixelSize(board);
  const dpr = opts.dpr || 1;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size.w, size.h);

  // 盤面下地
  const grad = ctx.createLinearGradient(0, 0, size.w, size.h);
  grad.addColorStop(0, '#1e3a34');
  grad.addColorStop(1, '#152e2a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size.w, size.h);

  // 薄いグリッド
  ctx.strokeStyle = 'rgba(214, 201, 160, 0.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 12; i++) {
    ctx.beginPath();
    ctx.moveTo(0, i * 48);
    ctx.lineTo(size.w, i * 48);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i * 48, 0);
    ctx.lineTo(i * 48, size.h);
    ctx.stroke();
  }

  const hoverSet = new Set(state.hoverDestinations || []);
  const pathSet = new Set(state.highlightPath || []);

  // 接続線
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(196, 178, 120, 0.35)';
  for (const cell of board.cells) {
    const a = cellOrigin(cell);
    for (const nid of cell.cw) {
      const bCell = board.cells[nid];
      const b = cellOrigin(bCell);
      ctx.beginPath();
      ctx.moveTo(a.x + CELL / 2, a.y + CELL / 2);
      ctx.lineTo(b.x + CELL / 2, b.y + CELL / 2);
      ctx.stroke();
    }
  }

  for (const cell of board.cells) {
    const { x, y } = cellOrigin(cell);
    const panel = state.panelsOnBoard[cell.id];
    const isHover = hoverSet.has(cell.id);
    const onPath = pathSet.has(cell.id);

    // マス本体
    if (cell.kind === 'main') {
      ctx.fillStyle = cell.isStart ? '#2f5c4f' : '#274840';
    } else {
      ctx.fillStyle = '#1f3f4a';
    }
    const isPickTarget = isHover && state.phase === 'move_choice';
    if (onPath) ctx.fillStyle = '#3d6b4f';
    if (isHover) ctx.fillStyle = isPickTarget ? '#d2b15f' : '#c4a35a';

    roundRect(ctx, x, y, CELL, CELL, 4);
    ctx.fill();

    ctx.strokeStyle = isPickTarget
      ? 'rgba(236, 228, 204, 0.95)'
      : cell.isBranch
        ? 'rgba(212, 168, 75, 0.9)'
        : 'rgba(214, 201, 160, 0.28)';
    ctx.lineWidth = isPickTarget ? 2.8 : cell.isBranch ? 2.2 : 1.2;
    ctx.stroke();

    // ラベル
    ctx.fillStyle = isHover ? '#1a1510' : 'rgba(236, 228, 204, 0.7)';
    ctx.font = '600 11px "IBM Plex Sans JP", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(cell.isStart ? 'START' : cell.label, x + 5, y + 4);

    if (panel) {
      const owner = state.players.find((p) => p.id === panel.ownerId);
      const meta = PANEL_META[panel.type];
      ctx.fillStyle = owner?.color || '#aaa';
      roundRect(ctx, x + 8, y + 18, CELL - 16, 28, 3);
      ctx.fill();
      ctx.fillStyle = '#1a1510';
      ctx.font = '700 13px "IBM Plex Sans JP", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(meta?.short || '?', x + CELL / 2, y + 32);
    }

    if (isPickTarget && !panel) {
      ctx.fillStyle = '#1a1510';
      ctx.font = '700 12px "IBM Plex Sans JP", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('着', x + CELL / 2, y + CELL / 2 + 6);
    }
  }

  // プレイヤーコマ
  const byPos = new Map();
  const activeId = opts.activePlayerId || state._uiActiveId || null;
  for (const p of state.players) {
    const list = byPos.get(p.pos) || [];
    list.push(p);
    byPos.set(p.pos, list);
  }

  for (const [pos, list] of byPos) {
    const cell = board.cells[pos];
    if (!cell) continue;
    const { x, y } = cellOrigin(cell);
    list.forEach((p, i) => {
      const ox = x + 14 + (i % 2) * 18;
      const oy = y + 14 + Math.floor(i / 2) * 18;
      const isActive = p.id === activeId && p.alive;
      if (isActive) {
        ctx.beginPath();
        ctx.arc(ox, oy, 13, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(212, 168, 75, 0.55)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(ox, oy, p.alive ? 9 : 7, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alive ? 1 : 0.35;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = isActive ? 'rgba(236, 228, 204, 0.9)' : 'rgba(20, 16, 12, 0.65)';
      ctx.lineWidth = isActive ? 2.5 : 2;
      ctx.stroke();
      if (p.directionOverride === 'ccw') {
        ctx.fillStyle = '#fff';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('↺', ox, oy);
      }
    });
  }
}

function eventToBoardPx(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  const cssW = parseFloat(canvas.style.width) || rect.width;
  const cssH = parseFloat(canvas.style.height) || rect.height;
  return {
    px: ((e.clientX - rect.left) / rect.width) * cssW,
    py: ((e.clientY - rect.top) / rect.height) * cssH,
  };
}

export function mountBoardCanvas(canvas, stateRef, handlers = {}) {
  const onCellClick = typeof handlers === 'function' ? handlers : handlers.onCellClick;
  const onCellHover = typeof handlers === 'function' ? null : handlers.onCellHover;
  const ctx = canvas.getContext('2d');

  function resize() {
    const state = stateRef();
    if (!state) return;
    const size = boardPixelSize(state.board);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(size.w * dpr);
    canvas.height = Math.floor(size.h * dpr);
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    drawBoard(ctx, state, { dpr });
  }

  function redraw() {
    const state = stateRef();
    if (!state) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    drawBoard(ctx, state, { dpr });
  }

  canvas.addEventListener('click', (e) => {
    const state = stateRef();
    if (!state) return;
    const { px, py } = eventToBoardPx(canvas, e);
    const id = hitTestCell(state.board, px, py);
    if (id != null) onCellClick?.(id);
  });

  canvas.addEventListener('mousemove', (e) => {
    const state = stateRef();
    if (!state) return;
    const { px, py } = eventToBoardPx(canvas, e);
    const id = hitTestCell(state.board, px, py);
    onCellHover?.(id);
    const selectable = state.pending?.type === 'move_choice'
      && (state.pending.options || []).some((o) => o.cellId === id);
    canvas.style.cursor = selectable ? 'pointer' : 'default';
  });

  canvas.addEventListener('mouseleave', () => {
    onCellHover?.(null);
    canvas.style.cursor = 'default';
  });

  return { resize, redraw };
}
