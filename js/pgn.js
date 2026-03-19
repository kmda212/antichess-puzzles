/**
 * pgn.js — PGN Game Importer & Scrubber for Anti-Chess Puzzle Creator
 *
 * Parses PGN files (single or multi-game), replays moves using the
 * antichess engine, and lets the user scrub to any position and
 * launch "Start Puzzle from Here" into RECORD mode.
 */

"use strict";

const PGN = {
  games:        [],    // [{ headers:{}, moves:['c4','c6',...] }]
  current:      -1,   // index of active game
  currentPly:   0,    // ply index (0 = start position)
  positions:    [],   // deep-copied game states at each ply
  fens:         [],   // FEN strings at each ply
  appliedMoves: [],   // { from, to } for each ply (null at ply 0)
  scrubbing:    false // true while browsing a game (blocks board setup clicks)
};

// ── PGN Parsing ──────────────────────────────────────────────────────────────

function parsePGNText(text) {
  const games = [];
  // Split on each game block starting with [Event
  const blocks = text.split(/(?=\[Event\s)/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const game = parseSingleGame(block);
    if (game && game.moves.length > 0) games.push(game);
  }
  return games;
}

function parseSingleGame(text) {
  const headers = {};
  const hre = /\[(\w+)\s+"([^"]*)"\]/g;
  let m;
  while ((m = hre.exec(text)) !== null) headers[m[1]] = m[2];

  // Strip comments and variations FIRST (before touching headers),
  // then remove header lines, then tokenize.
  let clean = text
    .replace(/\{[^}]*\}/g, ' ')         // { clock/eval comments }
    .replace(/\([^)]*\)/g, ' ')         // (variations)
    .replace(/\$\d+/g, ' ')             // NAG codes
    .replace(/[!?]/g, ' ')              // annotation symbols
    .replace(/^\[.*\]$/gm, '');         // header lines (safe after stripping {})

  const tokens = clean.split(/\s+/).filter(t => {
    if (!t) return false;
    if (/^\d+\.+$/.test(t)) return false;                      // move numbers
    if (/^(0-1|1-0|1\/2-1\/2|\*)$/.test(t)) return false;     // results
    return true;
  });

  return { headers, moves: tokens };
}

// ── SAN → Engine Move ─────────────────────────────────────────────────────────

function sanToMove(san, state) {
  const clean = san.replace(/[+#]/g, '').trim();
  const legal = AC.generateMoves(state);
  for (const mv of legal) {
    try {
      const msan = AC.moveToSAN(state, mv);
      if (msan && msan.replace(/[+#]/g, '') === clean) return mv;
    } catch (_) { /* skip */ }
  }
  return null;
}

// ── Game Loading ──────────────────────────────────────────────────────────────

function pgnLoadGame(idx) {
  if (idx < 0 || idx >= PGN.games.length) return;
  PGN.current    = idx;
  PGN.scrubbing  = true;

  const game     = PGN.games[idx];
  const startFEN = game.headers['FEN'] || AC.START_FEN;
  let state      = AC.parseFEN(startFEN);
  state.history  = [];

  const positions    = [deepCopy(state)];
  const fens         = [AC.toFEN(state)];
  const appliedMoves = [null];

  let failedAt = -1;
  for (let i = 0; i < game.moves.length; i++) {
    const san = game.moves[i];
    const mv  = sanToMove(san, state);
    if (!mv) { console.warn(`PGN: unresolved move "${san}" at ply ${i + 1}`); failedAt = i; break; }
    appliedMoves.push({ from: mv.from, to: mv.to });
    AC.applyMove(state, mv);
    positions.push(deepCopy(state));
    fens.push(AC.toFEN(state));
  }

  PGN.positions    = positions;
  PGN.fens         = fens;
  PGN.appliedMoves = appliedMoves;

  pgnGoToMove(0);
  pgnRenderGameList();
  pgnRenderScrubberHeader();
  pgnShowScrubber(true);

  const g    = game.headers;
  const info = `${g.White || '?'} vs ${g.Black || '?'}`;
  const msg  = failedAt >= 0
    ? `⚠ Loaded ${positions.length - 1} of ${game.moves.length} moves (stopped at unresolved move)`
    : `Game: ${info} · ${positions.length - 1} moves · ${g.Result || ''}`;
  setStatus(msg, failedAt >= 0 ? 'warn' : 'info');
}

// ── Ply Navigation ────────────────────────────────────────────────────────────

function pgnGoToMove(ply) {
  if (ply < 0) ply = 0;
  if (ply >= PGN.positions.length) ply = PGN.positions.length - 1;
  PGN.currentPly = ply;

  App.gameState = deepCopy(PGN.positions[ply]);
  App.lastMove  = PGN.appliedMoves[ply] || null;
  App.selected  = null;
  App.legalMoves = [];

  renderBoard();
  pgnRenderMoveBar();
  pgnUpdateButtons();
}

function pgnNextMove()  { pgnGoToMove(PGN.currentPly + 1); }
function pgnPrevMove()  { pgnGoToMove(PGN.currentPly - 1); }
function pgnFirstMove() { pgnGoToMove(0); }
function pgnLastMove()  { pgnGoToMove(PGN.positions.length - 1); }
function pgnNextGame()  { if (PGN.current < PGN.games.length - 1) pgnLoadGame(PGN.current + 1); }
function pgnPrevGame()  { if (PGN.current > 0) pgnLoadGame(PGN.current - 1); }

// ── Start Puzzle from Current Position ────────────────────────────────────────

function pgnStartPuzzleHere() {
  const state = deepCopy(PGN.positions[PGN.currentPly]);
  const fen   = PGN.fens[PGN.currentPly];

  const rootNode = { anyMove: false, options: [] };
  App.puzzle = {
    id: 'puzzle_' + Date.now(),
    title: '',
    description: '',
    difficulty: 'medium',
    startFEN: fen,
    solution: [],
    solutionTree: rootNode,
  };
  App.gameState          = state;
  App.gameState.history  = [];
  App.setupTurn          = state.turn;
  App.lastMove           = null;
  App.recordingNode      = rootNode;
  App.recordingNodeStack = [];
  App.recordingHistory   = [];
  App.nextMoveIsAny      = false;

  D.puzzleTitle.value      = '';
  D.puzzleDesc.value       = '';
  D.puzzleDiff.value       = 'medium';
  D.solutionList.innerHTML = '';

  PGN.scrubbing = false;
  pgnShowScrubber(false);

  setTurn(state.turn);
  switchMode('RECORD');
  checkGameOver();
  toast(`Puzzle started from move ${PGN.currentPly}! Record the solution.`, 'info');
  setStatus(`⏺ Recording — ${state.turn === AC.WHITE ? '⬜ White' : '⬛ Black'} to move`, 'info');
}

// ── Return to Game (after puzzle is done) ─────────────────────────────────────

function pgnReturnToGame() {
  if (PGN.current < 0 || !PGN.games.length) return;
  PGN.scrubbing = true;
  App.gameState = deepCopy(PGN.positions[PGN.currentPly]);
  App.lastMove  = PGN.appliedMoves[PGN.currentPly] || null;
  App.selected  = null;
  renderBoard();
  pgnShowScrubber(true);
  switchMode('SETUP');   // neutral display mode while scrubbing
  pgnUpdateButtons();
  setStatus('Back to game — continue scrubbing or start another puzzle.', 'info');
}

// ── UI Rendering ──────────────────────────────────────────────────────────────

function pgnRenderGameList() {
  const list = document.getElementById('pgnGameList');
  if (!list) return;
  list.style.display = 'block';
  list.innerHTML = '';
  PGN.games.forEach((g, i) => {
    const w   = g.headers.White || '?';
    const b   = g.headers.Black || '?';
    const res = g.headers.Result || '';
    const dt  = (g.headers.Date || '').replace(/\.\?+/g, '');
    const div = document.createElement('div');
    div.className = 'pgn-game-item' + (i === PGN.current ? ' pgn-active' : '');
    div.innerHTML =
      `<span class="pgn-gnum">#${i + 1}</span>` +
      `<span class="pgn-players">${w} vs ${b}</span>` +
      `<span class="pgn-meta">${g.moves.length}mv · ${res} · ${dt}</span>`;
    div.addEventListener('click', () => pgnLoadGame(i));
    list.appendChild(div);
  });
}

function pgnRenderScrubberHeader() {
  const el = document.getElementById('scrubGameInfo');
  if (!el) return;
  const g = PGN.games[PGN.current];
  el.textContent = `Game ${PGN.current + 1}/${PGN.games.length} · ${g.headers.White || '?'} vs ${g.headers.Black || '?'}`;
}

function pgnRenderMoveBar() {
  const bar = document.getElementById('scrubMoveBar');
  if (!bar) return;
  bar.innerHTML = '';
  const game = PGN.games[PGN.current];
  if (!game) return;
  game.moves.forEach((san, i) => {
    const ply = i + 1;
    if (i % 2 === 0) {
      const num = document.createElement('span');
      num.className = 'scr-num';
      num.textContent = `${Math.floor(i / 2) + 1}.`;
      bar.appendChild(num);
    }
    const btn = document.createElement('span');
    btn.className = 'scr-move' + (ply === PGN.currentPly ? ' scr-active' : '');
    btn.textContent = san;
    btn.addEventListener('click', () => pgnGoToMove(ply));
    bar.appendChild(btn);
  });
  // Scroll active move into view
  const active = bar.querySelector('.scr-active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function pgnUpdateButtons() {
  const ply = PGN.currentPly;
  const max = PGN.positions.length - 1;
  const set = (id, dis) => { const el = document.getElementById(id); if (el) el.disabled = dis; };
  set('scrubFirst',    ply === 0);
  set('scrubPrev',     ply === 0);
  set('scrubNext',     ply >= max);
  set('scrubLast',     ply >= max);
  set('scrubPrevGame', PGN.current <= 0);
  set('scrubNextGame', PGN.current >= PGN.games.length - 1);
  const counter = document.getElementById('scrubMoveCounter');
  if (counter) counter.textContent = `Move ${ply} / ${max}`;
}

function pgnShowScrubber(show) {
  const el = document.getElementById('gameScrubber');
  if (el) el.style.display = show ? 'block' : 'none';
  const ret = document.getElementById('btnReturnToGame');
  if (ret) ret.style.display = (!show && PGN.games.length > 0) ? 'inline-flex' : 'none';
}

// ── Init ──────────────────────────────────────────────────────────────────────

function initPGN() {
  const wire = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };

  // File loading
  wire('btnLoadPGNFiles',  () => document.getElementById('pgnFileInput').click());
  wire('btnLoadPGNFolder', () => document.getElementById('pgnFolderInput').click());

  const handleFiles = async files => {
    const pgns = files.filter(f => f.name.toLowerCase().endsWith('.pgn'));
    if (!pgns.length) { toast('No .pgn files found', 'error'); return; }
    PGN.games = [];
    for (const f of pgns) {
      const text   = await f.text();
      const parsed = parsePGNText(text);
      PGN.games.push(...parsed);
    }
    if (!PGN.games.length) { toast('No valid games found in PGN files', 'error'); return; }
    pgnRenderGameList();
    pgnLoadGame(0);
    toast(`Loaded ${PGN.games.length} game(s) from ${pgns.length} file(s)`, 'success');
  };

  const fileInput   = document.getElementById('pgnFileInput');
  const folderInput = document.getElementById('pgnFolderInput');
  if (fileInput)   fileInput.addEventListener('change',   e => { handleFiles(Array.from(e.target.files)); e.target.value = ''; });
  if (folderInput) folderInput.addEventListener('change', e => { handleFiles(Array.from(e.target.files)); e.target.value = ''; });

  // Scrubber controls
  wire('scrubFirst',          pgnFirstMove);
  wire('scrubPrev',           pgnPrevMove);
  wire('scrubNext',           pgnNextMove);
  wire('scrubLast',           pgnLastMove);
  wire('scrubPrevGame',       pgnPrevGame);
  wire('scrubNextGame',       pgnNextGame);
  wire('btnStartPuzzleHere',  pgnStartPuzzleHere);
  wire('btnReturnToGame',     pgnReturnToGame);

  // Keyboard navigation (arrow keys while scrubber is visible)
  document.addEventListener('keydown', e => {
    const scrubber = document.getElementById('gameScrubber');
    if (!scrubber || scrubber.style.display === 'none') return;
    if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); pgnNextMove(); }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); pgnPrevMove(); }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }
