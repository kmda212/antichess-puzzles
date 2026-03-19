/**
 * solver.js — Anti-Chess Puzzle Solver
 *
 * Uses the solutionTree (SolutionNode tree) from each puzzle for validation.
 * Falls back to converting legacy flat solution[] to a tree if needed.
 *
 * SolutionNode = { anyMove: bool, options: [{uci, san, next}] }
 */

"use strict";

const PIECE_IMGS = {
  wp:'pieces/wP.svg', wn:'pieces/wN.svg', wb:'pieces/wB.svg',
  wr:'pieces/wR.svg', wq:'pieces/wQ.svg', wk:'pieces/wK.svg',
  bp:'pieces/bP.svg', bn:'pieces/bN.svg', bb:'pieces/bB.svg',
  br:'pieces/bR.svg', bq:'pieces/bQ.svg', bk:'pieces/bK.svg'
};

const STORAGE_KEY = 'antichess_puzzles';

function loadPuzzlesFromStorage() {
  try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : []; }
  catch { return []; }
}

// Load puzzles from the puzzles/ folder (works when hosted over HTTP/HTTPS).
// Falls back gracefully to empty array when opened as a local file://.
async function loadPuzzlesFromFiles() {
  try {
    const idxResp = await fetch('puzzles/index.json');
    if (!idxResp.ok) return [];
    const filenames = await idxResp.json();
    const results = await Promise.all(
      filenames.map(f =>
        fetch(`puzzles/${f}`)
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      )
    );
    return results.filter(Boolean);
  } catch {
    return [];
  }
}

// Merge file puzzles (for hosted/public use) with localStorage puzzles
// (for local creator use). File puzzles take priority; local-only puzzles
// are appended so the creator still works without a server.
async function loadAllPuzzles() {
  const [filePuzzles, storagePuzzles] = await Promise.all([
    loadPuzzlesFromFiles(),
    Promise.resolve(loadPuzzlesFromStorage())
  ]);
  const fileIds = new Set(filePuzzles.map(p => p.id));
  const localOnly = storagePuzzles.filter(p => !fileIds.has(p.id));
  return [...filePuzzles, ...localOnly];
}

// ── Tree utilities (mirrors app.js) ──────────────────────────────────────
function legacyToTree(solution) {
  let node = null;
  for (let i = solution.length - 1; i >= 0; i--) {
    const step = solution[i];
    const isAny = !step.uci;
    node = { anyMove: isAny, options: [{ uci: step.uci || null, san: step.san || '?', next: node }] };
  }
  return node || { anyMove: false, options: [] };
}

function ensureSolutionTree(puzzle) {
  if (!puzzle.solutionTree) puzzle.solutionTree = legacyToTree(puzzle.solution || []);
}

function countMainLineDepth(tree) {
  let d = 0, n = tree;
  while (n && n.options.length > 0) { d++; n = n.options[0].next; }
  return d;
}

function uciMatches(played, expected) {
  // Compare from+to squares; allow any promotion piece if expected has none specified
  if (!played || !expected) return false;
  const pFrom = played.slice(0,2), pTo = played.slice(2,4), pProm = played[4] || null;
  const eFrom = expected.slice(0,2), eTo = expected.slice(2,4), eProm = expected[4] || null;
  return pFrom === eFrom && pTo === eTo && (!eProm || eProm === pProm);
}

// ── App state ─────────────────────────────────────────────────────────────
const Solver = {
  puzzles:      [],
  puzzle:       null,
  gameState:    null,
  currentNode:  null,   // current SolutionNode in tree
  userColor:    null,
  selected:     null,
  legalMoves:   [],
  lastMove:     null,
  locked:       false,
  hintUsed:     false,
  movesPlayed:  0,
  totalMoves:   0,
};

let D = {};
function $(id) { return document.getElementById(id); }

function initDOM() {
  D.puzzleSelect   = $('puzzleSelect');
  D.loadBtn        = $('loadBtn');
  D.board          = $('board');
  D.statusBar      = $('statusBar');
  D.fenBox         = $('fenBox');
  D.progressFill   = $('progressFill');
  D.progressLabel  = $('progressLabel');
  D.moveList       = $('moveList');
  D.btnReset       = $('btnReset');
  D.btnHint        = $('btnHint');
  D.successOverlay = $('successOverlay');
  D.successTitle   = $('successTitle');
  D.successDetail  = $('successDetail');
  D.btnPlayAgain   = $('btnPlayAgain');
  D.btnNextPuzzle  = $('btnNextPuzzle');
  D.puzzleTitle    = $('puzzleTitle');
  D.puzzleDiff     = $('puzzleDiff');
  D.puzzleDesc     = $('puzzleDesc');
  D.puzzleMoves    = $('puzzleMoves');
  D.errorFlash     = $('errorFlash');
  D.promoModal     = $('promoModal');
  D.toastContainer = $('toastContainer');
  D.captureWarn    = $('captureWarn');
}

// ── Populate dropdown ─────────────────────────────────────────────────────
function populateDropdown() {
  D.puzzleSelect.innerHTML = '<option value="">— Select a puzzle —</option>';
  Solver.puzzles.forEach((p, i) => {
    ensureSolutionTree(p);
    const depth = countMainLineDepth(p.solutionTree);
    const opt   = document.createElement('option');
    opt.value   = i;
    opt.textContent = `${p.title || 'Untitled'} (${p.difficulty || '?'}, ${depth} moves)`;
    D.puzzleSelect.appendChild(opt);
  });
}

// ── Load puzzle ───────────────────────────────────────────────────────────
function loadPuzzle(idx) {
  const p = Solver.puzzles[idx];
  if (!p) return;
  ensureSolutionTree(p);

  Solver.puzzle       = p;
  Solver.gameState    = AC.parseFEN(p.startFEN);
  Solver.currentNode  = p.solutionTree;
  Solver.userColor    = Solver.gameState.turn;
  Solver.selected     = null;
  Solver.legalMoves   = [];
  Solver.lastMove     = null;
  Solver.locked       = false;
  Solver.hintUsed     = false;
  Solver.movesPlayed  = 0;
  Solver.totalMoves   = countMainLineDepth(p.solutionTree);

  D.puzzleTitle.textContent = p.title || 'Untitled Puzzle';
  D.puzzleDiff.textContent  = (p.difficulty || 'unknown')[0].toUpperCase() + (p.difficulty || 'unknown').slice(1);
  D.puzzleDesc.textContent  = p.description || '—';
  D.puzzleMoves.textContent = Solver.totalMoves + ' moves';

  D.successOverlay.classList.remove('visible');
  D.errorFlash.classList.remove('visible');
  D.captureWarn.classList.remove('visible');

  renderMoveList();
  updateProgress();
  renderBoard();

  if (Solver.currentNode.anyMove) {
    setStatus(`⚡ Any move is valid — play anything!`, 'info');
  } else {
    setStatus(`Your turn as ${Solver.userColor === 'w' ? '⬜ White' : '⬛ Black'}. Find the winning move!`, 'info');
  }
  checkCaptureWarning();
}

// ── Board rendering ───────────────────────────────────────────────────────
function renderBoard() {
  const s = Solver.gameState;
  D.board.innerHTML = '';
  const legalToSet = new Set(Solver.legalMoves.map(m => m.to));

  for (let vRank = 7; vRank >= 0; vRank--) {
    for (let file = 0; file < 8; file++) {
      const sqIdx  = AC.sq(file, vRank);
      const isLight = (file + vRank) % 2 !== 0;
      const cell   = document.createElement('div');
      cell.className = 'sq ' + (isLight ? 'light' : 'dark');
      cell.dataset.sq = sqIdx;

      if (Solver.lastMove && (sqIdx === Solver.lastMove.from || sqIdx === Solver.lastMove.to))
        cell.classList.add('sq-lastmove');
      if (Solver.selected === sqIdx)
        cell.classList.add('sq-selected');
      if (legalToSet.has(sqIdx))
        cell.classList.add(s.board[sqIdx] ? 'sq-capture' : 'sq-dot');

      const piece = s.board[sqIdx];
      if (piece) {
        const img  = document.createElement('img');
        img.className = 'piece-img';
        img.src       = PIECE_IMGS[piece.color + piece.type];
        img.alt       = piece.color + piece.type;
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
      D.board.appendChild(cell);
    }
  }

  D.fenBox.textContent = AC.toFEN(s);
}

// ── Square click ──────────────────────────────────────────────────────────
function onSquareClick(sqIdx) {
  if (Solver.locked || !Solver.puzzle) return;
  const node = Solver.currentNode;
  if (!node) return;

  // If no moves left in tree, puzzle is over
  if (!node.anyMove && node.options.length === 0) return;

  const s = Solver.gameState;
  if (s.turn !== Solver.userColor) return;

  if (Solver.selected !== null) {
    const move = Solver.legalMoves.find(m => m.to === sqIdx);
    if (move) {
      // Promotion?
      if (move.piece === 'p') {
        const promRank = s.turn === AC.WHITE ? 7 : 0;
        if (AC.sqRank(move.to) === promRank) {
          const pms = Solver.legalMoves.filter(m => m.to === sqIdx && m.from === Solver.selected && m.promotion);
          if (pms.length > 1) { showPromoModal(pms, s.turn); return; }
        }
      }
      attemptUserMove(move);
      return;
    }
  }

  // Select piece
  const piece = s.board[sqIdx];
  if (piece && piece.color === Solver.userColor) {
    Solver.selected   = sqIdx;
    Solver.legalMoves = AC.generateMoves(s).filter(m => m.from === sqIdx);
    renderBoard();
  } else {
    Solver.selected   = null;
    Solver.legalMoves = [];
    renderBoard();
  }
}

// ── Validate and apply user move ──────────────────────────────────────────
function attemptUserMove(move) {
  const node      = Solver.currentNode;
  const playedUCI = AC.moveToUCI(move);

  // ── Any-move node: accept anything ──────────────────────────────────────
  if (node.anyMove) {
    applyAndRecord(move, 'user');
    Solver.movesPlayed++;

    const next = node.options.length > 0 ? node.options[0].next : null;
    Solver.currentNode = next;

    if (!next || next.options.length === 0) { finishPuzzle(); return; }

    Solver.locked = true;
    setTimeout(() => autoPlayOpponent(), 650);
    return;
  }

  // ── Multi-path: check against all valid options ──────────────────────────
  const matched = node.options.find(opt => opt.uci && uciMatches(playedUCI, opt.uci));

  if (!matched) {
    showError('Wrong move! Try again.');
    Solver.selected   = null;
    Solver.legalMoves = [];
    renderBoard();
    return;
  }

  applyAndRecord(move, 'user');
  Solver.movesPlayed++;
  Solver.currentNode = matched.next;

  if (!Solver.currentNode || Solver.currentNode.options.length === 0) {
    finishPuzzle(); return;
  }

  Solver.locked = true;
  setTimeout(() => autoPlayOpponent(), 650);
}

// ── Auto-play opponent ────────────────────────────────────────────────────
function autoPlayOpponent() {
  const node = Solver.currentNode;
  if (!node) { Solver.locked = false; return; }

  let move, nextNode;

  if (node.anyMove) {
    // Opponent can play any legal move — use the stored representative if available
    const opt = node.options[0];
    if (opt && opt.uci) {
      move = AC.uciToMove(opt.uci, Solver.gameState);
    }
    // Fallback: pick first legal move
    if (!move) {
      const legal = AC.generateMoves(Solver.gameState);
      if (!legal.length) { finishPuzzle(); Solver.locked = false; return; }
      move = legal[0];
    }
    nextNode = opt ? opt.next : null;
  } else {
    if (node.options.length === 0) { finishPuzzle(); Solver.locked = false; return; }
    // For multi-option opponent nodes: pick first (deterministic)
    const opt = node.options[0];
    move = AC.uciToMove(opt.uci, Solver.gameState);
    nextNode = opt.next;
  }

  if (!move) { Solver.locked = false; return; }

  applyAndRecord(move, 'auto');
  Solver.movesPlayed++;
  Solver.currentNode = nextNode;
  Solver.locked = false;

  if (!Solver.currentNode || Solver.currentNode.options.length === 0) {
    finishPuzzle(); return;
  }

  if (Solver.currentNode.anyMove) {
    setStatus(`⚡ Your turn — any legal move is valid here!`, 'info');
  } else {
    setStatus(`Your turn as ${Solver.userColor === 'w' ? '⬜ White' : '⬛ Black'}. Find the next move!`, 'info');
  }
  checkCaptureWarning();
}

// ── Apply move + record ───────────────────────────────────────────────────
function applyAndRecord(move, by) {
  const s   = Solver.gameState;
  const san = AC.moveToSAN(s, move);

  AC.applyMove(s, move);

  Solver.lastMove   = { from: move.from, to: move.to };
  Solver.selected   = null;
  Solver.legalMoves = [];

  addMoveToList(san, by, Solver.movesPlayed);
  updateProgress();
  renderBoard();

  setStatus(
    by === 'auto'
      ? `Computer played ${san}. Your turn!`
      : `Good move: ${san}. Waiting for opponent...`,
    'ok'
  );
}

// ── Move list ─────────────────────────────────────────────────────────────
function renderMoveList() { D.moveList.innerHTML = ''; }

function addMoveToList(san, by, stepIdx) {
  const li    = document.createElement('li');
  const moveNo  = Math.floor(stepIdx / 2) + 1;
  const isWhite = stepIdx % 2 === 0;
  li.className  = by === 'user' ? 'move-user' : 'move-auto';
  li.innerHTML  = `
    <span class="mv-num">${isWhite ? moveNo + '.' : ''}</span>
    <span class="mv-san">${san}</span>
    <span class="mv-tag">${by === 'user' ? '🙋' : '🤖'}</span>`;
  D.moveList.appendChild(li);
  D.moveList.scrollTop = D.moveList.scrollHeight;
}

// ── Progress bar ──────────────────────────────────────────────────────────
function updateProgress() {
  const done  = Solver.movesPlayed;
  const total = Solver.totalMoves || 1;
  const pct   = Math.min(100, Math.round((done / total) * 100));
  D.progressFill.style.width  = pct + '%';
  D.progressLabel.textContent = `${done} / ${total} moves`;
}

// ── Capture warning ───────────────────────────────────────────────────────
function checkCaptureWarning() {
  if (!Solver.gameState) return;
  const caps = AC.generateMoves(Solver.gameState).filter(m => m.captured || m.ep);
  D.captureWarn.classList.toggle('visible', caps.length > 0 && Solver.gameState.turn === Solver.userColor);
}

// ── Success overlay ───────────────────────────────────────────────────────
function finishPuzzle() {
  setStatus('Congratulations! Puzzle complete.', 'ok');
  D.captureWarn.classList.remove('visible');
  setTimeout(() => {
    const hint = Solver.hintUsed ? ' (hint used)' : '';
    D.successTitle.textContent  = '🎉 Puzzle Solved!';
    D.successDetail.textContent = `You completed "${Solver.puzzle.title || 'Puzzle'}" in ${Solver.movesPlayed} moves${hint}.`;
    D.successOverlay.classList.add('visible');
  }, 1200);
}

// ── Error flash ───────────────────────────────────────────────────────────
function showError(msg) {
  D.errorFlash.textContent = '❌ ' + msg;
  D.errorFlash.classList.add('visible');
  D.board.classList.add('board-shake');
  setTimeout(() => {
    D.errorFlash.classList.remove('visible');
    D.board.classList.remove('board-shake');
  }, 1800);
}

// ── Hint ──────────────────────────────────────────────────────────────────
function showHint() {
  if (!Solver.puzzle || Solver.locked) return;
  const node = Solver.currentNode;
  if (!node) return;

  Solver.hintUsed = true;

  if (node.anyMove) {
    setStatus('⚡ Hint: Any legal move is valid here!', 'warn');
    toast('Any legal move is accepted', 'info');
    return;
  }
  if (node.options.length === 0) return;

  const opt      = node.options[0];
  if (!opt.uci) { setStatus('⚡ Hint: Any move wins!', 'warn'); return; }

  const fromSq   = AC.sqN(opt.uci.slice(0, 2));
  const toSq     = AC.sqN(opt.uci.slice(2, 4));
  const fromName = opt.uci.slice(0, 2).toUpperCase();
  const toName   = opt.uci.slice(2, 4).toUpperCase();

  Solver.selected   = fromSq;
  Solver.legalMoves = AC.generateMoves(Solver.gameState).filter(m => m.from === fromSq);
  renderBoard();

  const targetEl = D.board.querySelector(`[data-sq="${toSq}"]`);
  if (targetEl) {
    targetEl.classList.add('hint-flash');
    setTimeout(() => targetEl.classList.remove('hint-flash'), 1200);
  }

  const multiMsg = node.options.length > 1 ? ` (one of ${node.options.length} valid moves)` : '';
  setStatus(`💡 Hint: move from ${fromName} to ${toName}${multiMsg}`, 'warn');
  toast(`Hint: ${fromName} → ${toName}${multiMsg}`, 'warn');
}

// ── Reset / Next ──────────────────────────────────────────────────────────
function resetPuzzle() {
  if (!Solver.puzzle) return;
  D.successOverlay.classList.remove('visible');
  const idx = Solver.puzzles.findIndex(p => p.id === Solver.puzzle.id);
  if (idx >= 0) loadPuzzle(idx);
}

function nextPuzzle() {
  const cur  = Solver.puzzles.findIndex(p => p.id === Solver.puzzle?.id);
  const next = (cur + 1) % Solver.puzzles.length;
  D.puzzleSelect.value = next;
  loadPuzzle(next);
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
    btn.addEventListener('click', () => {
      const move = _pendingPromMoves.find(m => m.promotion === pt);
      hidePromoModal();
      if (move) attemptUserMove(move);
    });
    choices.appendChild(btn);
  });
  D.promoModal.classList.add('visible');
}
function hidePromoModal() { D.promoModal.classList.remove('visible'); _pendingPromMoves = []; }

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

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
  initDOM();
  Solver.puzzles = await loadAllPuzzles();
  Solver.puzzles.forEach(ensureSolutionTree);
  populateDropdown();

  D.loadBtn.addEventListener('click', () => {
    const idx = parseInt(D.puzzleSelect.value);
    if (!isNaN(idx) && Solver.puzzles[idx]) loadPuzzle(idx);
    else toast('Please select a puzzle first', 'warn');
  });

  D.puzzleSelect.addEventListener('change', () => {
    const idx = parseInt(D.puzzleSelect.value);
    if (!isNaN(idx) && Solver.puzzles[idx]) loadPuzzle(idx);
  });

  D.btnReset.addEventListener('click', resetPuzzle);
  D.btnHint.addEventListener('click', showHint);
  D.btnPlayAgain.addEventListener('click', resetPuzzle);
  D.btnNextPuzzle.addEventListener('click', nextPuzzle);
  D.promoModal.addEventListener('click', e => { if (e.target === D.promoModal) hidePromoModal(); });

  if (Solver.puzzles.length === 0) {
    setStatus('No puzzles found. Create puzzles in the Puzzle Creator first!', 'warn');
  } else {
    setStatus(`${Solver.puzzles.length} puzzle(s) loaded. Select one to begin!`, 'info');
  }

  Solver.gameState = AC.parseFEN(AC.START_FEN);
  renderBoard();
}

document.addEventListener('DOMContentLoaded', init);
