/** Chrono Step — 24マス本線 + 分岐ショートカット 6×2 */

export const MAIN_COUNT = 24;
export const SHORTCUT_LEN = 6;
export const START_ID = 0;
export const INITIAL_TIME = 100;
export const STOMP_AMOUNT = 5;
export const DRAIN_AMOUNT = 10;
export const BOOST_STEPS = 2;
export const SUDDEN_DEATH_FROM_ROUND = 11;
export const SUDDEN_DEATH_TICK = 5;

export const PANEL_TYPES = ['drain', 'boost', 'reverse', 'lock'];

export const PANEL_META = {
  drain: {
    id: 'drain',
    name: 'ドレイン',
    short: '吸',
    timing: '停止時',
    timingKey: 'stop',
    desc: '停止したプレイヤーのタイムを10減らし、設置者のタイムを10回復する。',
  },
  boost: {
    id: 'boost',
    name: 'ブースト',
    short: '加',
    timing: '通過・停止時',
    timingKey: 'pass-stop',
    desc: '通過または停止すると、追加で2マス強制前進する（追加分のタイムは消費しない）。',
  },
  reverse: {
    id: 'reverse',
    name: 'リバース',
    short: '反',
    timing: '停止時',
    timingKey: 'stop',
    desc: '停止したプレイヤーの次ラウンドの移動が反時計回りになる（1回のみ）。',
  },
  lock: {
    id: 'lock',
    name: 'ロック',
    short: '封',
    timing: '通過時',
    timingKey: 'pass',
    desc: '他プレイヤーが通過しようとすると、残り移動力を失いこのマスで強制停止する。',
  },
};

export const PLAYER_COLORS = ['#c45c4a', '#3a7ca5', '#4a8f6a', '#c9a227'];

/**
 * マス定義を生成する。
 * 本線 0..23（時計回り）、分岐A 24..29（5→…→12）、分岐B 30..35（17→…→0）
 */
export function createBoard() {
  const cells = [];

  for (let i = 0; i < MAIN_COUNT; i++) {
    cells.push({
      id: i,
      kind: 'main',
      label: String(i),
      isStart: i === START_ID,
      isBranch: i === 5 || i === 17,
      cw: [],
      ccw: [],
      col: 0,
      row: 0,
    });
  }

  for (let i = 0; i < SHORTCUT_LEN; i++) {
    cells.push({
      id: 24 + i,
      kind: 'shortcutA',
      label: `A${i + 1}`,
      isStart: false,
      isBranch: false,
      cw: [],
      ccw: [],
      col: 0,
      row: 0,
    });
  }

  for (let i = 0; i < SHORTCUT_LEN; i++) {
    cells.push({
      id: 30 + i,
      kind: 'shortcutB',
      label: `B${i + 1}`,
      isStart: false,
      isBranch: false,
      cw: [],
      ccw: [],
      col: 0,
      row: 0,
    });
  }

  // 本線時計回り
  for (let i = 0; i < MAIN_COUNT; i++) {
    const next = (i + 1) % MAIN_COUNT;
    cells[i].cw.push(next);
  }

  // 分岐A: 5 → 24..29 → 12
  cells[5].cw.push(24);
  for (let i = 0; i < SHORTCUT_LEN - 1; i++) cells[24 + i].cw.push(24 + i + 1);
  cells[29].cw.push(12);

  // 分岐B: 17 → 30..35 → 0
  cells[17].cw.push(30);
  for (let i = 0; i < SHORTCUT_LEN - 1; i++) cells[30 + i].cw.push(30 + i + 1);
  cells[35].cw.push(0);

  // 反時計回りは時計回りの逆辺
  for (const cell of cells) {
    for (const nxt of cell.cw) {
      if (!cells[nxt].ccw.includes(cell.id)) cells[nxt].ccw.push(cell.id);
    }
  }

  layoutCells(cells);
  return { cells, startId: START_ID };
}

/** リング＋内周ショートカットのグリッド配置 */
function layoutCells(cells) {
  // 外周 7x7 の枠。角は共有しながら 24 マスを配置
  const ring = [
    [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], // 0-6 top
    [6, 1], [6, 2], [6, 3], [6, 4], [6, 5],                 // 7-11 right
    [6, 6], [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6], // 12-18 bottom
    [0, 5], [0, 4], [0, 3], [0, 2], [0, 1],                 // 19-23 left
  ];
  for (let i = 0; i < MAIN_COUNT; i++) {
    cells[i].col = ring[i][0];
    cells[i].row = ring[i][1];
  }

  // ショートカットA: 上辺分岐(5)から右内周を下り、下辺(12)へ
  const pathA = [
    [5, 1], [5, 2], [5, 3], [4, 3], [4, 4], [5, 5],
  ];
  for (let i = 0; i < SHORTCUT_LEN; i++) {
    cells[24 + i].col = pathA[i][0];
    cells[24 + i].row = pathA[i][1];
  }

  // ショートカットB: 下辺分岐(17)から左内周を上り、スタート(0)へ
  const pathB = [
    [1, 5], [1, 4], [1, 3], [2, 3], [2, 2], [1, 1],
  ];
  for (let i = 0; i < SHORTCUT_LEN; i++) {
    cells[30 + i].col = pathB[i][0];
    cells[30 + i].row = pathB[i][1];
  }
}

export function nextOptions(board, cellId, direction) {
  const cell = board.cells[cellId];
  if (!cell) return [];
  return direction === 'ccw' ? [...cell.ccw] : [...cell.cw];
}

export function cellById(board, id) {
  return board.cells[id];
}
