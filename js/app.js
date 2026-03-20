/**
 * app.js — Puzzle Creator UI logic
 *
 * Modes:
 *   SETUP  — place / remove pieces on the board freely
 *   RECORD — play moves (anti-chess rules enforced), build solution tree
 *   VIEW   — navigate through a saved puzzle's solution tree
 *
 * Solution tree format (SolutionNode):
 *   {
 *     anyMove: bool,          // true => any legal move accepted at this position
 *     options: [              // valid moves (multiple = multi-path)
 *       { uci, san, next }   // next: SolutionNode | null (null = puzzle ends)
 *     ]
 *   }
 */

"use strict";

// ── Piece image map (CBurnett SVGs) ──────────────────────────────────────
const PIECE_IMGS = {
  wp:'pieces/wP.svg', wn:'pieces/wN.svg', wb:'pieces/wB.svg',
  wr:'pieces/wR.svg', wq:'pieces/wQ.svg', wk:'pieces/wK.svg',
  bp:'pieces/bP.svg', bn:'pieces/bN.svg', bb:'pieces/bB.svg',
  br:'pieces/bR.svg', bq:'pieces/bQ.svg', bk:'pieces/bK.svg'
};

// ── App state ─────────────────────────────────────────────────────────────
const App = {
  mode: 'SETUP',          // 'SETUP' | 'RECORD' | 'VIEW'
  gameState: null,
  setupTurn: AC.WHITE,

  selected: null,
  legalMoves: [],
  lastMove: null,

  paletteColor: 'w',
  palettePiece: 'p',
  paletteEraser: false,

  // Current puzzle
  puzzle: {
    id: '',
    title: '',
    description: '',
    difficulty: 'medium',
    startFEN: '',
    solution: [],           // flat main-line (computed, kept for PGN/compat)
    solutionTree: null,     // SolutionNode root (authoritative)
  },

  // ── RECORD state ──────────────────────────────────────────────────────
  recordingNode: null,          // current SolutionNode being extended
  recordingNodeStack: [],       // parent nodes (parallel to recordingHistory, for undo)
  recordingHistory: [],         // [{uci,san,anyMove}] display in sidebar
  nextMoveIsAny: false,         // flag: next move will be marked anyMove

  // Variation recording
  isAddingVariation: false,
  variationSavedViewHistory: [],
  variationSavedGameFEN: '',

  // ── VIEW state ────────────────────────────────────────────────────────
  viewHistory: [],        // [{node, optionIdx, uci, san, anyMove, fenBefore}]
  viewCurrentNode: null,  // tree node at current position (options = next moves)

  puzzles: [],
};

// ── DOM refs ──────────────────────────────────────────────────────────────
const D = {};
function $(id) { return document.getElementById(id); }

function initDOM() {
  D.board           = $('board');
  D.modeBadge       = $('modeBadge');
  D.statusBar       = $('statusBar');
  D.captureWarn     = $('captureWarn');
  D.fenBox          = $('fenBox');
  D.branchSelector  = $('branchSelector');
  D.branchOptions   = $('branchOptions');

  D.btnNewPuzzle    = $('btnNewPuzzle');
  D.btnStartRecord  = $('btnStartRecord');
  D.btnUndoMove     = $('btnUndoMove');
  D.btnMarkAnyMove  = $('btnMarkAnyMove');
  D.btnStopRecord   = $('btnStopRecord');
  D.btnClearBoard   = $('btnClearBoard');
  D.btnResetStart   = $('btnResetStart');

  D.btnSavePuzzle   = $('btnSavePuzzle');
  D.btnLoadFile     = $('btnLoadFile');
  D.fileInput       = $('fileInput');
  D.btnExportPGN    = $('btnExportPGN');
  D.btnDeletePuzzle = $('btnDeletePuzzle');

  D.puzzleTitle     = $('puzzleTitle');
  D.puzzleDesc      = $('puzzleDesc');
  D.puzzleDiff      = $('puzzleDiff');
  D.puzzleList      = $('puzzleList');
  D.solutionList    = $('solutionList');

  D.turnW           = $('turnW');
  D.turnB           = $('turnB');

  D.btnFirst        = $('btnFirst');
  D.btnPrev         = $('btnPrev');
  D.btnNext         = $('btnNext');
  D.btnLast         = $('btnLast');
  D.btnAddVariation = $('btnAddVariation');

  D.promoModal      = $('promoModal');
  D.toastContainer  = $('toastContainer');
}

// ── Render board ──────────────────────────────────────────────────────────
function renderBoard() {
  const s = App.gameState;
  D.board.innerHTML = '';
  const legalToSet = new Set(App.legalMoves.map(m => m.to));

  for (let vRank = 7; vRank >= 0; vRank--) {
    for (let file = 0; file < 8; file++) {
      const sqIdx  = AC.sq(file, vRank);
      const cell   = document.createElement('div');
      const isLight = (file + vRank) % 2 !== 0;
      cell.className = 'sq ' + (isLight ? 'light' : 'dark');
      cell.dataset.sq = sqIdx;

      if (App.lastMove && (sqIdx === App.lastMove.from || sqIdx === App.lastMove.to))
        cell.classList.add('sq-lastmove');
      if (App.selected === sqIdx)
        cell.classList.add('sq-selected');
      if (legalToSet.has(sqIdx)) {
        cell.classList.add(s.board[sqIdx] ? 'sq-capture' : 'sq-dot');
      }

      const piece = s.board[sqIdx];
      if (piece) {
        const img = document.createElement('img');
        img.className = 'piece-img';
        img.src = PIECE_IMGS[piece.color + piece.type];
        img.alt = piece.color + piece.type;
        cell.appendChild(img);
      }

      if (vRank === 0) {
        const c = document.createElement('span');
        c.className = 'coord file'; c.textContent = AC.FILES[file];
        cell.appendChild(c);
      }
      if (file === 0) {
        const c = document.createElement('span');
        c.className = 'coord rank'; c.textContent = AC.RANKS[vRank];
        cell.appendChild(c);
      }

      cell.addEventListener('click', () => onSquareClick(sqIdx));
      cell.addEventListener('contextmenu', e => { e.preventDefault(); onSquareRightClick(sqIdx); });
      D.board.appendChild(cell);
    }
  }

  if (App.mode === 'RECORD') {
    const caps = AC.generateMoves(s).filter(m => m.captured || m.ep);
    D.captureWarn.classList.toggle('visible', caps.length > 0);
  } else {
    D.captureWarn.classList.remove('visible');
  }

  D.fenBox.textContent = AC.toFEN(s);
}

// ── Square click ──────────────────────────────────────────────────────────
function onSquareClick(sqIdx) {
  if (typeof PGN !== 'undefined' && PGN.scrubbing) return; // read-only while browsing game
  if (App.mode === 'SETUP')  { handleSetupClick(sqIdx); return; }
  if (App.mode === 'RECORD') { handleRecordClick(sqIdx); return; }
  // VIEW: no direct board interaction
}

function onSquareRightClick(sqIdx) {
  if (App.mode === 'SETUP') {
    App.gameState.board[sqIdx] = AC.EMPTY;
    renderBoard();
  }
}

// ── SETUP mode ────────────────────────────────────────────────────────────
function handleSetupClick(sqIdx) {
  if (App.paletteEraser) {
    App.gameState.board[sqIdx] = AC.EMPTY;
  } else {
    App.gameState.board[sqIdx] = { type: App.palettePiece, color: App.paletteColor };
  }
  renderBoard();
}

function selectPalette(color, piece) {
  App.paletteColor  = color;
  App.palettePiece  = piece;
  App.paletteEraser = false;
  updatePaletteUI();
}

function selectEraser() {
  App.paletteEraser = true;
  updatePaletteUI();
}

function updatePaletteUI() {
  document.querySelectorAll('.palette-piece').forEach(el => el.classList.remove('selected'));
  if (App.paletteEraser) {
    $('eraserBtn').classList.add('selected');
  } else {
    const el = document.querySelector(`.palette-piece[data-key="${App.paletteColor + App.palettePiece}"]`);
    if (el) el.classList.add('selected');
  }
}

function setTurn(color) {
  App.setupTurn = color;
  App.gameState.turn = color;
  D.turnW.classList.toggle('active', color === AC.WHITE);
  D.turnB.classList.toggle('active', color === AC.BLACK);
}

// ── RECORD mode ───────────────────────────────────────────────────────────
function handleRecordClick(sqIdx) {
  const s = App.gameState;

  if (App.selected !== null) {
    const move = App.legalMoves.find(m => m.to === sqIdx);
    if (move) {
      if (move.piece === 'p') {
        const promRank = s.turn === AC.WHITE ? 7 : 0;
        if (AC.sqRank(move.to) === promRank) {
          const promMoves = App.legalMoves.filter(m => m.to === sqIdx && m.from === App.selected && m.promotion);
          if (promMoves.length > 1) { showPromoModal(promMoves, s.turn); return; }
        }
      }
      executeMove(move);
      return;
    }
  }

  const piece = s.board[sqIdx];
  if (piece && piece.color === s.turn) {
    App.selected   = sqIdx;
    const allMoves = AC.generateMoves(s);
    App.legalMoves = allMoves.filter(m => m.from === sqIdx);
    const pName = { p:'Pawn',n:'Knight',b:'Bishop',r:'Rook',q:'Queen',k:'King' }[piece.type];
    setStatus(`Selected ${piece.color==='w'?'⬜':'⬛'} ${pName} — ${App.legalMoves.length} legal move(s)`, 'info');
  } else {
    App.selected   = null;
    App.legalMoves = [];
  }
  renderBoard();
}

function executeMove(move) {
  const s   = App.gameState;
  const san = AC.moveToSAN(s, move);
  const uci = AC.moveToUCI(move);

  // Consume the any-move flag: mark the CURRENT recording node as anyMove
  const isAny = App.nextMoveIsAny;
  App.nextMoveIsAny = false;
  D.btnMarkAnyMove.classList.remove('active-toggle');

  // Build the next tree node and append to current
  const currentNode = App.recordingNode;
  if (isAny) currentNode.anyMove = true;

  const nextNode = { anyMove: false, options: [] };
  currentNode.options.push({ uci, san, next: nextNode });

  // Push parent onto undo stack and advance
  App.recordingNodeStack.push(currentNode);
  App.recordingNode = nextNode;
  App.recordingHistory.push({ uci, san, anyMove: isAny });

  AC.applyMove(s, move);

  App.lastMove   = { from: move.from, to: move.to };
  App.selected   = null;
  App.legalMoves = [];

  renderBoard();
  renderSolutionList();
  checkGameOver();
}

function checkGameOver() {
  const result = AC.gameOver(App.gameState);
  if (result.over) {
    setStatus(`🏁 Game over: ${result.reason}`, 'ok');
    toast(result.reason, 'success');
  } else {
    const turn = App.gameState.turn === AC.WHITE ? 'White' : 'Black';
    const caps = AC.generateMoves(App.gameState).filter(m => m.captured || m.ep);
    setStatus(caps.length ? `${turn} to move — ⚠️ Must capture!` : `${turn} to move`, caps.length ? 'warn' : 'info');
  }
}

// ── VIEW mode ─────────────────────────────────────────────────────────────
function viewForward(optionIdx) {
  const node = App.viewCurrentNode;
  if (!node || node.options.length === 0) return;
  if (optionIdx === undefined) optionIdx = 0;
  const opt = node.options[optionIdx];
  if (!opt) return;

  const fenBefore = AC.toFEN(App.gameState);

  let appliedFrom = null, appliedTo = null;
  if (opt.uci) {
    const m = AC.uciToMove(opt.uci, App.gameState);
    if (m) {
      AC.applyMove(App.gameState, m);
      appliedFrom = m.from; appliedTo = m.to;
    }
  }

  App.lastMove = (appliedFrom !== null) ? { from: appliedFrom, to: appliedTo } : null;
  App.viewHistory.push({ node, optionIdx, uci: opt.uci, san: opt.san, anyMove: node.anyMove, fenBefore });
  App.viewCurrentNode = opt.next;

  renderBoard();
  renderSolutionList();
  updateViewStatus();
}

function viewBackward() {
  if (!App.viewHistory.length) return;
  const entry = App.viewHistory.pop();
  App.viewCurrentNode = entry.node;
  App.gameState = AC.parseFEN(entry.fenBefore);

  if (App.viewHistory.length > 0) {
    const prev = App.viewHistory[App.viewHistory.length - 1];
    if (prev.uci) {
      App.lastMove = { from: AC.sqN(prev.uci.slice(0,2)), to: AC.sqN(prev.uci.slice(2,4)) };
    } else {
      App.lastMove = null;
    }
  } else {
    App.lastMove = null;
  }

  renderBoard();
  renderSolutionList();
  updateViewStatus();
}

function viewFirst() {
  App.viewHistory = [];
  App.viewCurrentNode = App.puzzle.solutionTree;
  App.gameState = AC.parseFEN(App.puzzle.startFEN);
  App.lastMove = null;
  D.branchSelector.style.display = 'none';
  renderBoard();
  renderSolutionList();
  setStatus('Start position', 'info');
}

function viewLast() {
  while (App.viewCurrentNode && App.viewCurrentNode.options.length > 0) {
    viewForward(0);
  }
}

function viewNavigate(dir) {
  if (dir === 'first') { viewFirst(); return; }
  if (dir === 'prev')  { viewBackward(); return; }
  if (dir === 'last')  { viewLast(); return; }

  // 'next'
  if (!App.viewCurrentNode || App.viewCurrentNode.options.length === 0) return;
  if (App.viewCurrentNode.options.length === 1) {
    viewForward(0);
  } else {
    // Show branch selector in sidebar (already rendered by renderSolutionList)
    renderSolutionList();
    setStatus(`⑂ ${App.viewCurrentNode.options.length} paths available — select one below`, 'warn');
  }
}

function viewNavigateToDepth(depth) {
  // Navigate to the position after move at index `depth` in viewHistory
  const keepHistory = App.viewHistory.slice(0, depth + 1);

  App.gameState = AC.parseFEN(App.puzzle.startFEN);
  App.lastMove  = null;

  for (let i = 0; i <= depth; i++) {
    const entry = keepHistory[i];
    if (entry.uci) {
      const m = AC.uciToMove(entry.uci, App.gameState);
      if (m) {
        AC.applyMove(App.gameState, m);
        App.lastMove = { from: m.from, to: m.to };
      }
    }
  }

  App.viewHistory = keepHistory;
  const last = keepHistory[depth];
  App.viewCurrentNode = last.node.options[last.optionIdx]?.next || null;

  renderBoard();
  renderSolutionList();
  updateViewStatus();
}

function updateViewStatus() {
  const node = App.viewCurrentNode;
  if (!node || node.options.length === 0) { setStatus('✓ End of solution', 'ok'); return; }
  if (node.anyMove) { setStatus('⚡ Any legal move is valid here', 'info'); return; }
  if (node.options.length > 1) {
    setStatus(`⑂ ${node.options.length} valid paths — choose one below`, 'warn');
  } else {
    setStatus(`Step ${App.viewHistory.length + 1}: ${node.options[0].san}`, 'info');
  }
}

// ── Add variation (VIEW → RECORD) ─────────────────────────────────────────
function actionAddVariation() {
  if (App.mode !== 'VIEW' || !App.viewCurrentNode) return;

  App.isAddingVariation = true;
  App.variationSavedViewHistory = App.viewHistory.map(e => ({ ...e }));
  App.variationSavedGameFEN = AC.toFEN(App.gameState);

  App.recordingNode      = App.viewCurrentNode;   // fork here
  App.recordingNodeStack = [];
  App.recordingHistory   = [];
  App.nextMoveIsAny      = false;

  App.mode = 'RECORD';
  D.modeBadge.className = 'mode-badge mode-record';
  D.modeBadge.textContent = '⏺ Recording Variation';

  updateButtonStates();
  renderBoard();
  renderSolutionList();
  setStatus('⑂ Recording variation — play an alternative move from this position', 'warn');
  toast('Recording variation — play your alternative moves', 'info');
}

// ── Promotion modal ───────────────────────────────────────────────────────
let _pendingPromMoves = [];

function showPromoModal(moves, color) {
  _pendingPromMoves = moves;
  const choices = D.promoModal.querySelector('.promo-choices');
  choices.innerHTML = '';
  const pieces = moves.map(m => m.promotion).filter((v,i,a) => a.indexOf(v)===i);
  pieces.forEach(pt => {
    const btn = document.createElement('span');
    btn.className = 'promo-choice';
    const img = document.createElement('img');
    img.src = PIECE_IMGS[color + pt];
    img.style.cssText = 'width:52px;height:52px;pointer-events:none';
    btn.appendChild(img);
    btn.title = pt.toUpperCase();
    btn.addEventListener('click', () => { const move = _pendingPromMoves.find(m => m.promotion === pt); hidePromoModal(); executeMove(move); });
    choices.appendChild(btn);
  });
  D.promoModal.classList.add('visible');
}

function hidePromoModal() {
  D.promoModal.classList.remove('visible');
  _pendingPromMoves = [];
}

// ── Solution list ─────────────────────────────────────────────────────────
function renderSolutionList() {
  D.solutionList.innerHTML = '';
  D.branchSelector.style.display = 'none';

  // Determine source of moves to display
  let history;
  if (App.mode === 'RECORD' || App.mode === 'SETUP') {
    history = App.recordingHistory.map((e, i) => ({
      uci: e.uci, san: e.san, anyMove: e.anyMove, branchCount: 1, idx: i
    }));
  } else {
    // VIEW mode: show current path from viewHistory
    history = App.viewHistory.map((e, i) => ({
      uci: e.uci, san: e.san, anyMove: e.anyMove,
      branchCount: e.node.options.length, idx: i
    }));
  }

  history.forEach(entry => {
    const li = document.createElement('li');
    const moveNo = Math.floor(entry.idx / 2) + 1;
    const isWhite = entry.idx % 2 === 0;

    const sanHtml = entry.anyMove || !entry.uci
      ? '<span class="sol-anymove">(any move)</span>'
      : `<span class="move-san">${entry.san}</span>`;

    const badgeHtml = entry.branchCount > 1
      ? `<span class="sol-badge" title="${entry.branchCount} paths">⑂${entry.branchCount}</span>`
      : '';

    li.innerHTML = `
      <span class="move-num">${isWhite ? moveNo + '.' : ''}</span>
      ${sanHtml}
      ${badgeHtml}
      <span class="move-side">${isWhite ? '⬜' : '⬛'}</span>`;

    if (App.mode === 'VIEW') {
      li.classList.add('clickable');
      li.addEventListener('click', () => viewNavigateToDepth(entry.idx));
    }
    D.solutionList.appendChild(li);
  });

  // Branch selector when multiple options exist at current node (VIEW mode only)
  if (App.mode === 'VIEW' && App.viewCurrentNode && App.viewCurrentNode.options.length > 1) {
    D.branchSelector.style.display = 'block';
    D.branchOptions.innerHTML = '';
    App.viewCurrentNode.options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = 'branch-option';
      btn.textContent = opt.uci ? opt.san : '(any move)';
      btn.addEventListener('click', () => { D.branchSelector.style.display = 'none'; viewForward(i); });
      D.branchOptions.appendChild(btn);
    });
  }

  // Terminal indicator
  if (App.mode === 'VIEW' && App.viewCurrentNode && App.viewCurrentNode.options.length === 0) {
    const li = document.createElement('li');
    li.innerHTML = '<span style="color:var(--accent);font-size:0.78rem">✓ End of solution</span>';
    D.solutionList.appendChild(li);
  }

  D.solutionList.scrollTop = D.solutionList.scrollHeight;
}

// ── Puzzle list ───────────────────────────────────────────────────────────
function renderPuzzleList() {
  D.puzzleList.innerHTML = '';
  if (!App.puzzles.length) {
    D.puzzleList.innerHTML = '<li style="color:var(--muted);font-size:0.78rem;padding:8px">No puzzles yet. Create one!</li>';
    return;
  }
  App.puzzles.forEach((p, i) => {
    const depth = p.solutionTree ? countMainLineDepth(p.solutionTree) : (p.solution || []).length;
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="p-title">${p.title || 'Untitled Puzzle'}</div>
      <div class="p-meta">${p.difficulty || '—'} · ${depth} moves main line</div>`;
    li.addEventListener('click', () => loadPuzzleIntoViewer(i));
    D.puzzleList.appendChild(li);
  });
}

// ── Mode switching ────────────────────────────────────────────────────────
function switchMode(mode) {
  App.mode     = mode;
  App.selected = null;
  App.legalMoves = [];

  D.modeBadge.className = 'mode-badge';
  if (mode === 'SETUP')  { D.modeBadge.className += ' mode-setup';  D.modeBadge.textContent = '⚙ Setup Mode'; }
  if (mode === 'RECORD') { D.modeBadge.className += ' mode-record'; D.modeBadge.textContent = '⏺ Recording'; }
  if (mode === 'VIEW')   { D.modeBadge.className += ' mode-view';   D.modeBadge.textContent = '▶ View Mode'; }

  $('viewNav').style.display = mode === 'VIEW' ? 'block' : 'none';
  updateButtonStates();
  renderBoard();
}

function updateButtonStates() {
  const mode = App.mode;
  D.btnNewPuzzle.disabled    = false;
  D.btnStartRecord.disabled  = mode !== 'SETUP';
  D.btnUndoMove.disabled     = mode !== 'RECORD' || App.recordingHistory.length === 0;
  D.btnMarkAnyMove.disabled  = mode !== 'RECORD';
  D.btnStopRecord.disabled   = mode !== 'RECORD';
  D.btnClearBoard.disabled   = mode !== 'SETUP';
  D.btnResetStart.disabled   = mode !== 'SETUP';
}

// ── Actions ───────────────────────────────────────────────────────────────
function actionNewPuzzle() {
  const rootNode = { anyMove: false, options: [] };
  App.puzzle = {
    id: 'puzzle_' + Date.now(),
    title: '',
    description: '',
    difficulty: 'medium',
    startFEN: '',
    solution: [],
    solutionTree: rootNode,
  };
  App.gameState          = AC.parseFEN('8/8/8/8/8/8/8/8 w - - 0 1');
  App.gameState.board    = Array(64).fill(AC.EMPTY);  // always start clean
  App.gameState.history  = [];
  App.setupTurn          = AC.WHITE;
  App.lastMove           = null;
  App.recordingNode      = rootNode;
  App.recordingNodeStack = [];
  App.recordingHistory   = [];

  D.puzzleTitle.value = '';
  D.puzzleDesc.value  = '';
  D.puzzleDiff.value  = 'medium';
  D.solutionList.innerHTML = '';

  setTurn(AC.WHITE);
  switchMode('SETUP');
  setStatus('New puzzle started. Place pieces, then click "Start Recording".', 'info');
  toast('New puzzle created', 'info');
}

function actionStartRecord() {
  const pieces = App.gameState.board.filter(Boolean);
  if (pieces.length < 2) { toast('Place at least 2 pieces before recording!', 'error'); return; }

  App.gameState.turn    = App.setupTurn;
  App.gameState.history = [];

  const rootNode = { anyMove: false, options: [] };
  App.puzzle.startFEN    = AC.toFEN(App.gameState);
  App.puzzle.solution    = [];
  App.puzzle.solutionTree = rootNode;

  App.lastMove           = null;
  App.recordingNode      = rootNode;
  App.recordingNodeStack = [];
  App.recordingHistory   = [];
  App.nextMoveIsAny      = false;

  D.solutionList.innerHTML = '';
  switchMode('RECORD');
  checkGameOver();
  toast('Recording started! Play the solution.', 'info');
}

function actionMarkAnyMove() {
  App.nextMoveIsAny = !App.nextMoveIsAny;
  D.btnMarkAnyMove.classList.toggle('active-toggle', App.nextMoveIsAny);
  if (App.nextMoveIsAny) {
    setStatus('⚡ Any Move mode: play a representative move — solver will accept any legal move at this step', 'warn');
    toast('Next move marked as "Any Move"', 'info');
  } else {
    setStatus('Any Move mode cancelled', 'info');
  }
}

function actionUndoMove() {
  if (!App.recordingHistory.length) return;

  AC.undoMove(App.gameState);
  App.recordingHistory.pop();
  const parentNode = App.recordingNodeStack.pop();
  parentNode.options.pop();
  App.recordingNode = parentNode;

  App.nextMoveIsAny = false;
  D.btnMarkAnyMove.classList.remove('active-toggle');
  App.lastMove   = null;
  App.selected   = null;
  App.legalMoves = [];

  if (App.recordingHistory.length > 0) {
    const last = App.recordingHistory[App.recordingHistory.length - 1];
    if (last.uci) App.lastMove = { from: AC.sqN(last.uci.slice(0,2)), to: AC.sqN(last.uci.slice(2,4)) };
  }

  updateButtonStates();
  renderBoard();
  renderSolutionList();
  checkGameOver();
  toast('Move undone', 'info');
}

function actionStopRecord() {
  if (!App.recordingHistory.length) { toast('No moves recorded yet!', 'error'); return; }

  // Sync flat solution from tree
  App.puzzle.solution = buildFlatSolution(App.puzzle.solutionTree);

  if (App.isAddingVariation) {
    // Return to VIEW mode
    App.isAddingVariation = false;
    App.viewHistory = App.variationSavedViewHistory;

    // Restore board to view position
    App.gameState = AC.parseFEN(App.puzzle.startFEN);
    App.lastMove  = null;
    for (const e of App.viewHistory) {
      if (e.uci) {
        const m = AC.uciToMove(e.uci, App.gameState);
        if (m) { AC.applyMove(App.gameState, m); App.lastMove = { from: m.from, to: m.to }; }
      }
    }
    // Re-derive viewCurrentNode from history
    App.viewCurrentNode = computeViewCurrentNode();
    App.variationSavedViewHistory = [];

    App.mode = 'VIEW'; // set mode before switchMode to avoid re-init
    switchMode('VIEW');
    renderSolutionList();
    setStatus('Variation added! ⑂ Use ▶ or select below to explore paths.', 'ok');
    toast('Variation saved!', 'success');
    return;
  }

  // Enter VIEW mode so user can review the solution and add variations
  App.gameState = AC.parseFEN(App.puzzle.startFEN);
  App.lastMove  = null;
  App.viewHistory       = [];
  App.viewCurrentNode   = App.puzzle.solutionTree;

  switchMode('VIEW');
  renderSolutionList();
  setStatus('Recording stopped. Review solution below — use ⊕ to add variations.', 'info');
  toast('Recording stopped', 'info');
}

function computeViewCurrentNode() {
  let node = App.puzzle.solutionTree;
  for (const entry of App.viewHistory) {
    if (!node || !node.options[entry.optionIdx]) return node;
    node = node.options[entry.optionIdx].next;
  }
  return node;
}

function actionClearBoard() {
  App.gameState.board = Array(64).fill(AC.EMPTY);
  App.lastMove = null;
  renderBoard();
}

function actionResetToStart() {
  App.gameState = AC.parseFEN(AC.START_FEN);
  App.lastMove  = null;
  setTurn(AC.WHITE);
  renderBoard();
}

function actionSavePuzzle() {
  const title = D.puzzleTitle.value.trim() || 'Untitled Puzzle';
  if (!App.puzzle.startFEN) { toast('Start a puzzle first', 'error'); return; }
  if (!App.puzzle.solutionTree || countMainLineDepth(App.puzzle.solutionTree) === 0) {
    toast('Record at least one move before saving!', 'error'); return;
  }

  App.puzzle.title       = title;
  App.puzzle.description = D.puzzleDesc.value.trim();
  App.puzzle.difficulty  = D.puzzleDiff.value;
  App.puzzle.solution    = buildFlatSolution(App.puzzle.solutionTree);

  const idx = App.puzzles.findIndex(p => p.id === App.puzzle.id);
  if (idx >= 0) App.puzzles[idx] = JSON.parse(JSON.stringify(App.puzzle));
  else           App.puzzles.push(JSON.parse(JSON.stringify(App.puzzle)));

  savePuzzlesToStorage();
  renderPuzzleList();
  downloadPuzzleAsFile(JSON.parse(JSON.stringify(App.puzzle)));
  toast(`Puzzle "${title}" saved & downloaded!`, 'success');
}

function actionLoadFile() { D.fileInput.click(); }

function actionFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = evt => {
    try {
      let data = JSON.parse(evt.target.result);
      if (Array.isArray(data)) App.puzzles = data;
      else if (data.puzzles)   App.puzzles = data.puzzles;
      else if (data.id)        App.puzzles.push(data);
      App.puzzles.forEach(ensureSolutionTree);
      savePuzzlesToStorage();
      renderPuzzleList();
      toast(`Loaded ${App.puzzles.length} puzzle(s)`, 'success');
    } catch { toast('Invalid JSON file', 'error'); }
  };
  reader.readAsText(file);
  e.target.value = '';
}

function actionExportPGN() {
  if (!App.puzzle.startFEN || !App.puzzle.solution.length) { toast('Nothing to export', 'error'); return; }
  downloadText(buildPGN(App.puzzle), (App.puzzle.title || 'puzzle') + '.pgn');
  toast('PGN exported!', 'success');
}

function actionExportAllJSON() {
  if (!App.puzzles.length) { toast('No puzzles to export', 'error'); return; }
  downloadText(JSON.stringify(App.puzzles, null, 2), 'antichess_puzzles.json');
  toast('All puzzles exported as JSON!', 'success');
}

function actionDeletePuzzle() {
  const title = App.puzzle.title || App.puzzle.id;
  const idx   = App.puzzles.findIndex(p => p.id === App.puzzle.id);
  if (idx < 0) { toast('No puzzle selected to delete', 'error'); return; }
  if (!confirm(`Delete puzzle "${title}"?`)) return;
  App.puzzles.splice(idx, 1);
  savePuzzlesToStorage();
  renderPuzzleList();
  toast(`Deleted "${title}"`, 'info');
}

// ── Load puzzle into viewer ───────────────────────────────────────────────
function loadPuzzleIntoViewer(idx) {
  const p = App.puzzles[idx];
  ensureSolutionTree(p);

  App.puzzle = JSON.parse(JSON.stringify(p));
  ensureSolutionTree(App.puzzle);

  App.viewHistory     = [];
  App.viewCurrentNode = App.puzzle.solutionTree;
  App.gameState       = AC.parseFEN(p.startFEN);
  App.lastMove        = null;
  App.isAddingVariation = false;

  D.puzzleTitle.value = p.title       || '';
  D.puzzleDesc.value  = p.description || '';
  D.puzzleDiff.value  = p.difficulty  || 'medium';

  document.querySelectorAll('#puzzleList li').forEach((el, i) =>
    el.classList.toggle('active', i === idx));

  renderSolutionList();
  switchMode('VIEW');
  const depth = countMainLineDepth(App.puzzle.solutionTree);
  setStatus(`Loaded: "${p.title}" — ${depth} moves (main line). Use ◀ ▶ to navigate.`, 'info');
  toast(`Loaded puzzle: "${p.title}"`, 'info');
}

// ── PGN builder ───────────────────────────────────────────────────────────
function buildPGN(puzzle) {
  const lines = [
    `[Event "Anti-Chess Puzzle"]`,
    `[Site "local"]`,
    `[Date "${new Date().toISOString().slice(0,10).replace(/-/g,'.')}"]`,
    `[Round "-"]`, `[White "Puzzle"]`, `[Black "?"]`, `[Result "*"]`,
    `[SetUp "1"]`, `[FEN "${puzzle.startFEN}"]`,
    `[Variant "Antichess"]`, `[PuzzleTitle "${puzzle.title}"]`,
    `[Difficulty "${puzzle.difficulty}"]`, ``,
  ];
  let moveText = '';
  (puzzle.solution || []).forEach((m, i) => {
    if (i % 2 === 0) moveText += `${Math.floor(i/2)+1}. `;
    moveText += (m.san || m.uci || '?') + ' ';
  });
  lines.push(moveText.trim() + ' *');
  return lines.join('\n');
}

// ── Tree utilities ────────────────────────────────────────────────────────

/** Convert flat solution array (legacy format) to a single-path SolutionNode tree */
function legacyToTree(solution) {
  let node = null;  // terminal
  for (let i = solution.length - 1; i >= 0; i--) {
    const step = solution[i];
    const isAny = !step.uci;
    node = {
      anyMove: isAny,
      options: [{ uci: step.uci || null, san: step.san || '?', next: node }],
    };
  }
  return node || { anyMove: false, options: [] };
}

/** Ensure puzzle has a solutionTree (create from solution if missing) */
function ensureSolutionTree(puzzle) {
  if (!puzzle.solutionTree) {
    puzzle.solutionTree = legacyToTree(puzzle.solution || []);
  }
}

/** Build flat solution array from tree's main line (first option at each node) */
function buildFlatSolution(tree) {
  if (!tree) return [];
  const solution = [];
  let node = tree;
  let gs   = AC.parseFEN(App.puzzle.startFEN);
  while (node && node.options.length > 0) {
    const opt = node.options[0];
    if (!opt.uci) {
      solution.push({ uci: null, san: '(any)', fenAfter: null });
    } else {
      const m = AC.uciToMove(opt.uci, gs);
      if (m) AC.applyMove(gs, m);
      solution.push({ uci: opt.uci, san: opt.san, fenAfter: AC.toFEN(gs) });
    }
    node = opt.next;
  }
  return solution;
}

/** Count depth of main line (first-option path) through tree */
function countMainLineDepth(tree) {
  let depth = 0, node = tree;
  while (node && node.options.length > 0) { depth++; node = node.options[0].next; }
  return depth;
}

// ── Storage ───────────────────────────────────────────────────────────────
const STORAGE_KEY = 'antichess_puzzles';

function savePuzzlesToStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(App.puzzles));
}

function loadPuzzlesFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      App.puzzles = JSON.parse(raw);
      App.puzzles.forEach(ensureSolutionTree);
    }
  } catch { App.puzzles = []; }
}

/** Download the given puzzle as its own <id>.json file */
function downloadPuzzleAsFile(puzzle) {
  const filename = (puzzle.id || ('puzzle_' + Date.now())) + '.json';
  downloadText(JSON.stringify(puzzle, null, 2), filename);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function setStatus(msg, type = 'info') {
  D.statusBar.textContent = msg;
  D.statusBar.className   = 'status-bar ' + type;
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className   = `toast ${type}`;
  el.textContent = msg;
  D.toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function downloadText(text, filename) {
  const a    = document.createElement('a');
  a.href     = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
  a.download = filename;
  a.click();
}

// ── Init ──────────────────────────────────────────────────────────────────
function init() {
  initDOM();
  loadPuzzlesFromStorage();

  App.gameState = AC.parseFEN('8/8/8/8/8/8/8/8 w - - 0 1');
  App.gameState.board   = Array(64).fill(AC.EMPTY);
  App.gameState.history = [];

  const rootNode = { anyMove: false, options: [] };
  App.puzzle.solutionTree = rootNode;
  App.recordingNode = rootNode;

  D.btnNewPuzzle   .addEventListener('click', actionNewPuzzle);
  D.btnStartRecord .addEventListener('click', actionStartRecord);
  D.btnUndoMove    .addEventListener('click', actionUndoMove);
  D.btnMarkAnyMove .addEventListener('click', actionMarkAnyMove);
  D.btnStopRecord  .addEventListener('click', actionStopRecord);
  D.btnClearBoard  .addEventListener('click', actionClearBoard);
  D.btnResetStart  .addEventListener('click', actionResetToStart);
  D.btnSavePuzzle  .addEventListener('click', actionSavePuzzle);
  D.btnLoadFile    .addEventListener('click', actionLoadFile);
  D.fileInput      .addEventListener('change', actionFileSelected);
  D.btnExportPGN   .addEventListener('click', actionExportPGN);
  D.btnDeletePuzzle.addEventListener('click', actionDeletePuzzle);
  D.btnAddVariation.addEventListener('click', actionAddVariation);
  $('btnExportJSON').addEventListener('click', actionExportAllJSON);

  D.btnFirst.addEventListener('click', () => viewNavigate('first'));
  D.btnPrev .addEventListener('click', () => viewNavigate('prev'));
  D.btnNext .addEventListener('click', () => viewNavigate('next'));
  D.btnLast .addEventListener('click', () => viewNavigate('last'));

  D.turnW.addEventListener('click', () => setTurn(AC.WHITE));
  D.turnB.addEventListener('click', () => setTurn(AC.BLACK));

  D.promoModal.addEventListener('click', e => { if (e.target === D.promoModal) hidePromoModal(); });

  document.querySelectorAll('.palette-piece').forEach(el => {
    if (el.id === 'eraserBtn') el.addEventListener('click', selectEraser);
    else el.addEventListener('click', () => selectPalette(el.dataset.color, el.dataset.piece));
  });

  switchMode('SETUP');
  setTurn(AC.WHITE);
  renderPuzzleList();
  setStatus('Welcome! Click "New Puzzle" to begin, or load a saved puzzle.', 'info');
  if (typeof initPGN === 'function') initPGN();
}

document.addEventListener('DOMContentLoaded', init);
