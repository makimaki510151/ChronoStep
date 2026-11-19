import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBoard, nextOptions, panelLabel, cellLabel } from '../js/board.js';
import {
  PHASE,
  applyAction,
  createInitialState,
  previewDestinations,
  waitingPlayerId,
} from '../js/engine.js';

describe('board', () => {
  it('has 36 cells with ring and two shortcuts', () => {
    const board = createBoard();
    assert.equal(board.cells.length, 36);
    assert.equal(board.startId, 0);
    assert.ok(board.cells[5].cw.includes(6));
    assert.ok(board.cells[5].cw.includes(24));
    assert.ok(board.cells[29].cw.includes(12));
    assert.ok(board.cells[17].cw.includes(30));
    assert.ok(board.cells[35].cw.includes(0));
  });

  it('ccw reverses cw edges', () => {
    const board = createBoard();
    for (const cell of board.cells) {
      for (const n of cell.cw) {
        assert.ok(board.cells[n].ccw.includes(cell.id), `${n} should ccw to ${cell.id}`);
      }
    }
  });

  it('branch offers two options clockwise', () => {
    const board = createBoard();
    assert.deepEqual(nextOptions(board, 5, 'cw').sort((a, b) => a - b), [6, 24]);
  });

  it('panelLabel returns Japanese names', () => {
    assert.equal(panelLabel('drain'), 'ドレイン');
    assert.equal(panelLabel('boost'), 'ブースト');
    assert.equal(panelLabel('reverse'), 'リバース');
    assert.equal(panelLabel('lock'), 'ロック');
  });

  it('cellLabel uses board labels', () => {
    const board = createBoard();
    assert.equal(cellLabel(board, 0), 'START');
    assert.equal(cellLabel(board, 2), board.cells[2].label);
  });
});

describe('engine basics', () => {
  it('starts with dice pool of survivors+1', () => {
    const state = createInitialState({
      seats: [
        { id: 'a', name: 'A', isCpu: true },
        { id: 'b', name: 'B', isCpu: true },
      ],
    });
    assert.equal(state.phase, PHASE.DRAFT);
    assert.equal(state.dicePool.length, 3);
    assert.equal(state.players[0].time, 100);
  });

  it('picking a die moves and spends time', () => {
    const state = createInitialState({
      seats: [
        { id: 'a', name: 'A', isCpu: false },
        { id: 'b', name: 'B', isCpu: true },
      ],
    });
    // force dice
    state.dicePool = [
      { id: 'd1', value: 3 },
      { id: 'd2', value: 1 },
      { id: 'd3', value: 2 },
    ];
    const actor = waitingPlayerId(state);
    const before = state.players.find((p) => p.id === actor);
    const timeBefore = before.time;
    const posBefore = before.pos;
    const res = applyAction(state, actor, { type: 'pick_die', dieId: 'd1' });
    assert.equal(res.ok, true);
    // may be in panel place
    assert.equal(before.pos, (posBefore + 3) % 24);
    assert.equal(before.time, timeBefore - 3);
  });

  it('drain steals time on stop', () => {
    const state = createInitialState({
      seats: [
        { id: 'a', name: 'A', isCpu: false },
        { id: 'b', name: 'B', isCpu: false },
      ],
    });
    state.panelsOnBoard[3] = { type: 'drain', ownerId: 'b' };
    state.dicePool = [
      { id: 'd1', value: 3 },
      { id: 'd2', value: 1 },
      { id: 'd3', value: 2 },
    ];
    state.turnOrder = ['a', 'b'];
    state.turnIndex = 0;
    const a = state.players.find((p) => p.id === 'a');
    const b = state.players.find((p) => p.id === 'b');
    const ta = a.time;
    const tb = b.time;
    applyAction(state, 'a', { type: 'pick_die', dieId: 'd1' });
    assert.equal(a.pos, 3);
    assert.equal(a.time, ta - 3 - 10);
    assert.equal(b.time, tb + 10);
  });

  it('lock stops other players passing', () => {
    const state = createInitialState({
      seats: [
        { id: 'a', name: 'A', isCpu: false },
        { id: 'b', name: 'B', isCpu: false },
      ],
    });
    state.panelsOnBoard[2] = { type: 'lock', ownerId: 'b' };
    const previews = previewDestinations(state, 'a', 5);
    // all paths should stop at 2 if they would pass through 2
    for (const p of previews) {
      if (p.path.includes(2) && p.path.indexOf(2) < p.path.length - 1) {
        assert.fail('should not continue past lock');
      }
    }
    const stopped = previews.filter((p) => p.cellId === 2);
    assert.ok(stopped.length >= 1);
  });

  it('stomp transfers time', () => {
    const state = createInitialState({
      seats: [
        { id: 'a', name: 'A', isCpu: false },
        { id: 'b', name: 'B', isCpu: false },
      ],
    });
    const a = state.players.find((p) => p.id === 'a');
    const b = state.players.find((p) => p.id === 'b');
    b.pos = 4;
    state.dicePool = [
      { id: 'd1', value: 4 },
      { id: 'd2', value: 1 },
      { id: 'd3', value: 2 },
    ];
    state.turnOrder = ['a', 'b'];
    state.turnIndex = 0;
    const ta = a.time;
    const tb = b.time;
    applyAction(state, 'a', { type: 'pick_die', dieId: 'd1' });
    // move 4 + stomp +5 / other -5
    assert.equal(a.pos, 4);
    assert.equal(a.time, ta - 4 + 5);
    assert.equal(b.time, tb - 5);
  });

  it('can place panel on empty cell', () => {
    const state = createInitialState({
      seats: [
        { id: 'a', name: 'A', isCpu: false },
        { id: 'b', name: 'B', isCpu: true },
      ],
    });
    state.dicePool = [
      { id: 'd1', value: 2 },
      { id: 'd2', value: 1 },
      { id: 'd3', value: 3 },
    ];
    applyAction(state, 'a', { type: 'pick_die', dieId: 'd1' });
    assert.equal(state.phase, PHASE.PANEL_PLACE);
    const res = applyAction(state, 'a', { type: 'place_panel', panel: 'drain' });
    assert.equal(res.ok, true);
    assert.equal(state.panelsOnBoard[2].type, 'drain');
    assert.equal(state.players[0].panels.drain, 1);
    const placeLog = state.log.map((l) => l.text).find((t) => t.includes('設置'));
    assert.ok(placeLog?.includes('ドレイン'), `expected JP panel name in log, got: ${placeLog}`);
    assert.ok(!placeLog?.includes('drain'), `raw panel id must not appear: ${placeLog}`);
  });

  it('boost adds free steps in preview', () => {
    const state = createInitialState({
      seats: [
        { id: 'a', name: 'A', isCpu: false },
        { id: 'b', name: 'B', isCpu: false },
      ],
    });
    state.panelsOnBoard[2] = { type: 'boost', ownerId: 'b' };
    const previews = previewDestinations(state, 'a', 2);
    // 2歩でマス2に着き、さらに+2 → マス4
    assert.ok(previews.some((p) => p.cellId === 4 && p.path.length === 4));
  });

  it('choose_path accepts cellId', () => {
    const state = createInitialState({
      seats: [
        { id: 'a', name: 'A', isCpu: false },
        { id: 'b', name: 'B', isCpu: false },
      ],
    });
    // マス5から分岐（出目で到達できる位置へ先に移動）
    const a = state.players.find((p) => p.id === 'a');
    a.pos = 5;
    state.dicePool = [
      { id: 'd1', value: 1 },
      { id: 'd2', value: 2 },
      { id: 'd3', value: 3 },
    ];
    state.turnOrder = ['a', 'b'];
    state.turnIndex = 0;
    applyAction(state, 'a', { type: 'pick_die', dieId: 'd1' });
    assert.equal(state.phase, PHASE.MOVE_CHOICE);
    const shortcut = state.pending.options.find((o) => o.cellId === 24);
    assert.ok(shortcut);
    const res = applyAction(state, 'a', { type: 'choose_path', cellId: 24 });
    assert.equal(res.ok, true);
    assert.equal(a.pos, 24);
  });

  it('reverse sets next-move override on stop', () => {
    const state = createInitialState({
      seats: [
        { id: 'a', name: 'A', isCpu: false },
        { id: 'b', name: 'B', isCpu: false },
      ],
    });
    state.panelsOnBoard[3] = { type: 'reverse', ownerId: 'b' };
    state.dicePool = [
      { id: 'd1', value: 3 },
      { id: 'd2', value: 1 },
      { id: 'd3', value: 2 },
    ];
    state.turnOrder = ['a', 'b'];
    state.turnIndex = 0;
    applyAction(state, 'a', { type: 'pick_die', dieId: 'd1' });
    const a = state.players.find((p) => p.id === 'a');
    assert.equal(a.directionOverride, 'ccw');
  });
});
