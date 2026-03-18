/**
 * antichess.js — Anti-Chess / Losing Chess engine
 *
 * Rules enforced:
 *  1. Captures are MANDATORY — if any capture exists you must take.
 *  2. If multiple captures are available you may choose which.
 *  3. King has no special status (no check/checkmate concept).
 *  4. Castling is NOT available (standard antichess rule).
 *  5. En passant is supported.
 *  6. Pawns promote (to Q/R/B/N/K — king promotion optional, we allow all).
 *  7. Win condition: lose all pieces OR have no legal moves.
 */

const AC = (() => {

  // ── Constants ──────────────────────────────────────────────────────────────

  const PIECE  = { PAWN:'p', KNIGHT:'n', BISHOP:'b', ROOK:'r', QUEEN:'q', KING:'k' };
  const WHITE  = 'w';
  const BLACK  = 'b';
  const EMPTY  = null;

  const FILES  = ['a','b','c','d','e','f','g','h'];
  const RANKS  = ['1','2','3','4','5','6','7','8'];

  // Square index helpers  (0=a1 … 63=h8)
  const sq  = (file, rank) => rank * 8 + file;   // file 0-7, rank 0-7
  const sqN = (name)       => { const f=FILES.indexOf(name[0]); const r=RANKS.indexOf(name[1]); return r*8+f; };
  const sqFile = i => i % 8;
  const sqRank = i => Math.floor(i / 8);
  const sqName = i => FILES[sqFile(i)] + RANKS[sqRank(i)];

  // ── State ──────────────────────────────────────────────────────────────────

  /**
   * Board state object
   *  board[64]  — each cell: null | { type, color }
   *  turn       — 'w' | 'b'
   *  ep         — en-passant target square index | null
   *  halfmoves  — for FEN output
   *  fullmoves
   *  history    — stack of snapshots for undo
   */
  function createState() {
    return {
      board: Array(64).fill(EMPTY),
      turn: WHITE,
      ep: null,
      halfmoves: 0,
      fullmoves: 1,
      history: []
    };
  }

  function cloneBoard(board) {
    return board.map(c => c ? { ...c } : EMPTY);
  }

  function cloneState(s) {
    return {
      board: cloneBoard(s.board),
      turn: s.turn,
      ep: s.ep,
      halfmoves: s.halfmoves,
      fullmoves: s.fullmoves,
      history: s.history   // shared ref (we push snapshots)
    };
  }

  // ── FEN ───────────────────────────────────────────────────────────────────

  function parseFEN(fen) {
    const s = createState();
    const parts = fen.trim().split(/\s+/);
    const rows  = parts[0].split('/');

    for (let r = 7; r >= 0; r--) {
      let file = 0;
      for (const ch of rows[7 - r]) {
        if (/\d/.test(ch)) { file += parseInt(ch); }
        else {
          const color = ch === ch.toUpperCase() ? WHITE : BLACK;
          s.board[sq(file, r)] = { type: ch.toLowerCase(), color };
          file++;
        }
      }
    }

    s.turn      = (parts[1] || 'w') === 'w' ? WHITE : BLACK;
    // castling skipped (antichess)
    s.ep        = (parts[3] && parts[3] !== '-') ? sqN(parts[3]) : null;
    s.halfmoves = parseInt(parts[4]) || 0;
    s.fullmoves = parseInt(parts[5]) || 1;
    return s;
  }

  function toFEN(s) {
    let rows = [];
    for (let r = 7; r >= 0; r--) {
      let row = ''; let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = s.board[sq(f, r)];
        if (!p) { empty++; }
        else {
          if (empty) { row += empty; empty = 0; }
          row += p.color === WHITE ? p.type.toUpperCase() : p.type;
        }
      }
      if (empty) row += empty;
      rows.push(row);
    }
    const epStr = s.ep !== null ? sqName(s.ep) : '-';
    return `${rows.join('/')} ${s.turn} - ${epStr} ${s.halfmoves} ${s.fullmoves}`;
  }

  // Standard starting position
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1';

  // ── Move generation ───────────────────────────────────────────────────────

  /**
   * Returns array of move objects:
   * { from, to, piece, captured, promotion, ep }
   */
  function generateMoves(s, onlyCaptures = false) {
    const moves = [];
    const opp   = s.turn === WHITE ? BLACK : WHITE;

    for (let from = 0; from < 64; from++) {
      const p = s.board[from];
      if (!p || p.color !== s.turn) continue;

      switch (p.type) {
        case PIECE.PAWN:   addPawnMoves(s, from, opp, moves);   break;
        case PIECE.KNIGHT: addKnightMoves(s, from, opp, moves); break;
        case PIECE.BISHOP: addSlidingMoves(s, from, opp, moves, [[-1,-1],[-1,1],[1,-1],[1,1]]); break;
        case PIECE.ROOK:   addSlidingMoves(s, from, opp, moves, [[-1,0],[1,0],[0,-1],[0,1]]);   break;
        case PIECE.QUEEN:  addSlidingMoves(s, from, opp, moves, [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]]); break;
        case PIECE.KING:   addKingMoves(s, from, opp, moves);   break;
      }
    }

    // Anti-chess: if any capture exists, keep only captures
    const captures = moves.filter(m => m.captured || m.ep);
    return captures.length ? captures : (onlyCaptures ? [] : moves);
  }

  function inBounds(f, r) { return f >= 0 && f < 8 && r >= 0 && r < 8; }

  function addMove(s, from, to, opp, moves, promotion = null) {
    const target = s.board[to];
    if (target && target.color === s.turn) return; // blocked by own piece
    moves.push({
      from, to,
      piece: s.board[from].type,
      captured: target ? target.type : null,
      promotion,
      ep: false
    });
  }

  function addPawnMoves(s, from, opp, moves) {
    const f   = sqFile(from);
    const r   = sqRank(from);
    const dir = s.turn === WHITE ? 1 : -1;
    const startRank = s.turn === WHITE ? 1 : 6;
    const promRank  = s.turn === WHITE ? 7 : 0;

    // Forward (non-capture)
    const r1 = r + dir;
    if (inBounds(f, r1) && !s.board[sq(f, r1)]) {
      const to = sq(f, r1);
      if (r1 === promRank) {
        for (const pt of ['q','r','b','n','k']) {
          moves.push({ from, to, piece: 'p', captured: null, promotion: pt, ep: false });
        }
      } else {
        moves.push({ from, to, piece: 'p', captured: null, promotion: null, ep: false });
        // Double push from start rank
        if (r === startRank) {
          const r2 = r + 2 * dir;
          const to2 = sq(f, r2);
          if (!s.board[to2]) {
            moves.push({ from, to: to2, piece: 'p', captured: null, promotion: null, ep: false });
          }
        }
      }
    }

    // Captures (diagonal)
    for (const df of [-1, 1]) {
      const cf = f + df;
      const cr = r + dir;
      if (!inBounds(cf, cr)) continue;
      const cto = sq(cf, cr);

      // Normal capture
      if (s.board[cto] && s.board[cto].color === opp) {
        if (cr === promRank) {
          for (const pt of ['q','r','b','n','k']) {
            moves.push({ from, to: cto, piece: 'p', captured: s.board[cto].type, promotion: pt, ep: false });
          }
        } else {
          moves.push({ from, to: cto, piece: 'p', captured: s.board[cto].type, promotion: null, ep: false });
        }
      }

      // En passant
      if (s.ep !== null && cto === s.ep) {
        moves.push({ from, to: cto, piece: 'p', captured: 'p', promotion: null, ep: true });
      }
    }
  }

  function addKnightMoves(s, from, opp, moves) {
    const f = sqFile(from), r = sqRank(from);
    const deltas = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
    for (const [df, dr] of deltas) {
      const nf = f + df, nr = r + dr;
      if (inBounds(nf, nr)) addMove(s, from, sq(nf, nr), opp, moves);
    }
  }

  function addSlidingMoves(s, from, opp, moves, dirs) {
    const f = sqFile(from), r = sqRank(from);
    for (const [df, dr] of dirs) {
      let nf = f + df, nr = r + dr;
      while (inBounds(nf, nr)) {
        const to = sq(nf, nr);
        const target = s.board[to];
        if (target) {
          if (target.color === opp) addMove(s, from, to, opp, moves);
          break;
        }
        addMove(s, from, to, opp, moves);
        nf += df; nr += dr;
      }
    }
  }

  function addKingMoves(s, from, opp, moves) {
    const f = sqFile(from), r = sqRank(from);
    const deltas = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
    for (const [df, dr] of deltas) {
      const nf = f + df, nr = r + dr;
      if (inBounds(nf, nr)) addMove(s, from, sq(nf, nr), opp, moves);
    }
  }

  // ── Apply / Undo ──────────────────────────────────────────────────────────

  function applyMove(s, move) {
    // Save snapshot for undo
    s.history.push({
      board: cloneBoard(s.board),
      turn: s.turn,
      ep: s.ep,
      halfmoves: s.halfmoves,
      fullmoves: s.fullmoves
    });

    const piece = s.board[move.from];

    // En passant capture: remove the actual pawn
    if (move.ep) {
      const dir = s.turn === WHITE ? -1 : 1;
      const epPawnSq = move.to + dir * 8;
      s.board[epPawnSq] = EMPTY;
    }

    s.board[move.to]   = move.promotion
      ? { type: move.promotion, color: piece.color }
      : { ...piece };
    s.board[move.from] = EMPTY;

    // Set new en passant square
    s.ep = null;
    if (piece.type === 'p' && Math.abs(move.to - move.from) === 16) {
      s.ep = (move.from + move.to) >> 1;  // midpoint
    }

    s.halfmoves = (move.captured || piece.type === 'p') ? 0 : s.halfmoves + 1;
    if (s.turn === BLACK) s.fullmoves++;
    s.turn = s.turn === WHITE ? BLACK : WHITE;
  }

  function undoMove(s) {
    if (!s.history.length) return false;
    const snap = s.history.pop();
    s.board     = snap.board;
    s.turn      = snap.turn;
    s.ep        = snap.ep;
    s.halfmoves = snap.halfmoves;
    s.fullmoves = snap.fullmoves;
    return true;
  }

  // ── Game-over detection ───────────────────────────────────────────────────

  /**
   * Returns:
   *   { over: false }                 — game ongoing
   *   { over: true, winner, reason }  — game ended
   *
   * Anti-chess win conditions (for the side whose turn it is):
   *   - Current player has no legal moves → they win? (they've lost all or are stuck)
   *     Actually in antichess: player with no legal moves LOSES (they win by LOSING pieces).
   *     Standard antichess: if you have no legal moves you LOSE (opponent wins).
   *     OR the common rule: if you have no pieces / no legal moves you WIN.
   *     We use: no legal moves = that side wins (they've achieved losing all pieces).
   */
  function gameOver(s) {
    const moves = generateMoves(s);

    // Check if current player has any pieces left
    const myPieces = s.board.filter(c => c && c.color === s.turn);
    if (myPieces.length === 0) {
      return { over: true, winner: s.turn, reason: `${s.turn === WHITE ? 'White' : 'Black'} lost all pieces — wins!` };
    }

    if (moves.length === 0) {
      // No legal moves → current player wins (stalemate = win in antichess)
      return { over: true, winner: s.turn, reason: `${s.turn === WHITE ? 'White' : 'Black'} has no legal moves — wins!` };
    }

    return { over: false };
  }

  // ── Move notation (UCI + SAN helpers) ─────────────────────────────────────

  function moveToUCI(move) {
    return sqName(move.from) + sqName(move.to) + (move.promotion || '');
  }

  function uciToMove(uci, s) {
    const from = sqN(uci.slice(0, 2));
    const to   = sqN(uci.slice(2, 4));
    const promotion = uci[4] || null;
    const moves = generateMoves(s);
    return moves.find(m =>
      m.from === from && m.to === to &&
      (!promotion || m.promotion === promotion)
    ) || null;
  }

  /** Simple SAN for display (not full disambiguation) */
  function moveToSAN(s, move) {
    const piece = s.board[move.from];
    const toName = sqName(move.to);
    const prefix = piece.type === 'p' ? '' : piece.type.toUpperCase();
    const sep    = move.captured || move.ep ? 'x' : '';
    const fromHint = piece.type === 'p' && (move.captured || move.ep)
      ? sqName(move.from)[0] : '';
    const prom = move.promotion ? '=' + move.promotion.toUpperCase() : '';
    return `${prefix}${fromHint}${sep}${toName}${prom}`;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    WHITE, BLACK,
    START_FEN,
    createState,
    parseFEN,
    toFEN,
    generateMoves,
    applyMove,
    undoMove,
    gameOver,
    moveToUCI,
    uciToMove,
    moveToSAN,
    sqName,
    sqN,
    sqFile,
    sqRank,
    sq,
    FILES, RANKS,
    PIECE, EMPTY
  };

})();
