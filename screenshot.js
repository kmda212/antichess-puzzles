/**
 * screenshot.js
 * Takes step-by-step screenshots of the puzzle creator UI using Puppeteer.
 * Simulates: new puzzle → place pieces → record moves → save puzzle → load & view.
 */

const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');

const HTML_PATH = path.resolve(__dirname, 'index.html');
const OUT_DIR   = path.resolve(__dirname, 'docs', 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

const URL = 'file:///' + HTML_PATH.replace(/\\/g, '/');

async function shot(page, name, label) {
  const dest = path.join(OUT_DIR, name);
  await page.screenshot({ path: dest, fullPage: false });
  console.log(`  ✓ ${label} → ${name}`);
  return name;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1440, height: 860 },
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  console.log('Loading app...');
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(800);

  // ── STEP 1: Initial state ──────────────────────────────────────────────
  await shot(page, '01_initial.png', 'Step 1 - Initial state');

  // ── STEP 2: Click "New Puzzle" ─────────────────────────────────────────
  await page.click('#btnNewPuzzle');
  await sleep(400);
  await shot(page, '02_new_puzzle.png', 'Step 2 - New Puzzle clicked');

  // ── STEP 3: Clear board and set up a simple position ──────────────────
  await page.click('#btnClearBoard');
  await sleep(300);
  await shot(page, '03_cleared_board.png', 'Step 3 - Board cleared');

  // Helper: click a board square by algebraic name
  async function clickSquare(sqName) {
    const idx = await page.evaluate((name) => {
      const files = ['a','b','c','d','e','f','g','h'];
      const ranks = ['1','2','3','4','5','6','7','8'];
      const f = files.indexOf(name[0]);
      const r = ranks.indexOf(name[1]);
      return r * 8 + f;
    }, sqName);
    const sq = await page.$(`[data-sq="${idx}"]`);
    if (sq) await sq.click();
    await sleep(150);
  }

  // Helper: select a palette piece
  async function selectPalette(key) {
    const el = await page.$(`[data-key="${key}"]`);
    if (el) await el.click();
    await sleep(100);
  }

  // ── STEP 4: Place pieces — simple 3-piece anti-chess position ─────────
  // White: Queen on d1, Pawn on e2
  // Black: King on e8, Pawn on d7

  await selectPalette('wq'); await clickSquare('d1');
  await selectPalette('wp'); await clickSquare('e2');
  await selectPalette('bk'); await clickSquare('e8');
  await selectPalette('bp'); await clickSquare('d7');
  await sleep(300);
  await shot(page, '04_pieces_placed.png', 'Step 4 - Pieces placed');

  // ── STEP 5: Select "White to move" and highlight turn selector ─────────
  await page.click('#turnW');
  await sleep(200);
  await shot(page, '05_turn_selected.png', 'Step 5 - White to move selected');

  // ── STEP 6: Fill in puzzle details ────────────────────────────────────
  await page.click('#puzzleTitle');
  await page.type('#puzzleTitle', 'White forces piece loss in 2');
  await page.click('#puzzleDesc');
  await page.type('#puzzleDesc', 'White must give up the queen. Anti-chess: first to lose all pieces wins!');
  await page.select('#puzzleDiff', 'easy');
  await sleep(200);
  await shot(page, '06_details_filled.png', 'Step 6 - Puzzle details filled in');

  // ── STEP 7: Click "Start Recording" ───────────────────────────────────
  await page.click('#btnStartRecord');
  await sleep(500);
  await shot(page, '07_recording_started.png', 'Step 7 - Recording started');

  // ── STEP 8: Select a piece (white queen on d1) — shows legal moves ─────
  await clickSquare('d1');
  await sleep(300);
  await shot(page, '08_piece_selected.png', 'Step 8 - Piece selected (legal moves shown)');

  // ── STEP 9: Make move Qd7 (captures black pawn) ───────────────────────
  await clickSquare('d7');
  await sleep(400);
  await shot(page, '09_move_1_played.png', 'Step 9 - Move 1: Qxd7 (capture)');

  // ── STEP 10: Black plays Ke7 (only move, must move king) — wait for user
  // In antichess, after Qxd7 black may have Ke7 available
  // Let's click e8 (black king) then e7
  await clickSquare('e8');
  await sleep(300);
  await shot(page, '10_black_selects.png', 'Step 10 - Black selects king');

  await clickSquare('e7');
  await sleep(400);
  await shot(page, '11_move_2_played.png', 'Step 11 - Move 2 played');

  // ── STEP 11: White captures on e7 with the queen (Qxe7) ──────────────
  await clickSquare('d7');
  await sleep(300);
  await clickSquare('e7');
  await sleep(400);
  await shot(page, '12_move_3_played.png', 'Step 12 - Move 3 played');

  // Also record one more move from e2 pawn if possible
  await clickSquare('e2');
  await sleep(300);
  await shot(page, '13_solution_recorded.png', 'Step 13 - Solution list showing moves');

  // Deselect
  await page.keyboard.press('Escape');
  await sleep(200);

  // ── STEP 12: Click "Stop Recording" ───────────────────────────────────
  await page.click('#btnStopRecord');
  await sleep(400);
  await shot(page, '14_recording_stopped.png', 'Step 14 - Recording stopped');

  // ── STEP 13: Save the puzzle ──────────────────────────────────────────
  await page.click('#btnSavePuzzle');
  await sleep(600);
  await shot(page, '15_puzzle_saved.png', 'Step 15 - Puzzle saved (toast + list updated)');

  // ── STEP 14: Load puzzle from list (view mode) ────────────────────────
  const firstItem = await page.$('#puzzleList li');
  if (firstItem) {
    await firstItem.click();
    await sleep(500);
    await shot(page, '16_puzzle_loaded.png', 'Step 16 - Puzzle loaded in View Mode');
  }

  // ── STEP 15: Navigate solution steps ─────────────────────────────────
  await page.click('#btnNext');
  await sleep(400);
  await shot(page, '17_step_navigate.png', 'Step 17 - Step through solution with Next');

  await page.click('#btnNext');
  await sleep(400);
  await shot(page, '18_step_2.png', 'Step 18 - Second move highlighted');

  await page.click('#btnFirst');
  await sleep(400);
  await shot(page, '19_back_to_start.png', 'Step 19 - Back to start position');

  await browser.close();
  console.log('\nAll screenshots saved to:', OUT_DIR);
})();
