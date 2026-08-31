/* PUSHLINE rules engine.
 *
 * Pure. No DOM, no network, no clock, no randomness beyond an injected seed.
 * The browser imports this file and so does the server, so there is exactly
 * one definition of what a legal move is.
 *
 *   createGame(options)      -> state
 *   legalActions(state)      -> action[]
 *   applyAction(state, a)    -> { ok, state, reason, events }
 *   isOver(state)            -> bool
 *
 * applyAction never mutates the state it is given.
 */

import { MAPS, mapById } from "./maps.js";

export const SIZE = 7;
export const WIN_KILLS = 3;
export const AP_PER_TURN = 2;
export const COST_STEP = 1;
export const COST_DASH = 1;
export const COST_PUSH = 1;
export const COST_SLAM = 2;
export const SLAM_DISTANCE = 2;
export const DRAW_TURNS_WITHOUT_KILL = 60;
export const BAN_POOL_SIZE = 8;

/* The closing board. Without it two careful players simply retreat forever:
 * a defender moves two squares a turn and an attacker needs to spend a turn
 * setting a shove up, so nobody can ever be cornered. From here the outer
 * ring falls away and the fight is forced inward. */
export const SHRINK_FIRST_TURN = 24;
export const SHRINK_EVERY = 8;
export const SHRINK_MAX_RINGS = 3;

export const DIRECTIONS = ["up", "down", "left", "right"];

const DELTA = {
  up: [-1, 0],
  down: [1, 0],
  left: [0, -1],
  right: [0, 1]
};

/* Roles. "standard" is the classic game: every piece identical. */
export const ROLE = {
  STANDARD: "standard",
  RUNNER: "runner",
  BRUISER: "bruiser",
  ANCHOR: "anchor"
};

const ROLE_ROW = [ROLE.RUNNER, ROLE.BRUISER, ROLE.ANCHOR, ROLE.BRUISER, ROLE.RUNNER];

/* --------------------------------------------------------------- helpers */

export function inside(r, c) {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

export function delta(direction) {
  return DELTA[direction] || null;
}

export function isHole(state, r, c) {
  return state.holes.some(h => h.r === r && h.c === c);
}

export function pieceAt(state, r, c) {
  return state.board[r][c];
}

export function findPiece(state, id) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const p = state.board[r][c];
      if (p && p.id === id) return { r, c, piece: p };
    }
  }
  return null;
}

export function piecesOf(state, color) {
  const out = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const p = state.board[r][c];
      if (p && p.color === color) out.push({ r, c, piece: p });
    }
  }
  return out;
}

export function other(color) {
  return color === "blue" ? "red" : "blue";
}

export function clone(state) {
  return JSON.parse(JSON.stringify(state));
}

/* A tiny deterministic PRNG so a match can be replayed from its seed. */
export function makeRandom(seed) {
  let s = (seed >>> 0) || 1;
  return function random() {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

export function hashSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ---------------------------------------------------------- role queries */

function canPush(piece) {
  return piece.role !== ROLE.RUNNER;
}

function canBePushed(piece) {
  return piece.role !== ROLE.ANCHOR;
}

function maxChain(piece) {
  /* Only bruisers (and classic pieces) shove a whole formation. */
  if (piece.role === ROLE.STANDARD || piece.role === ROLE.BRUISER) return Infinity;
  if (piece.role === ROLE.ANCHOR) return 1;
  return 0;
}

function canSlam(piece) {
  return piece.role === ROLE.STANDARD || piece.role === ROLE.BRUISER;
}

function canDash(piece) {
  return piece.role === ROLE.RUNNER;
}

/* ------------------------------------------------------------ game setup */

export function createGame(options = {}) {
  const mode = options.mode === "roles" ? "roles" : "classic";
  const seed = options.seed === undefined ? 1 : options.seed;
  const random = makeRandom(seed);

  const pool = options.pool || pickPool(random);
  const state = {
    version: 2,
    mode,
    seed,
    phase: options.skipBans ? "playing" : "ban",
    pool,
    bans: { blue: null, red: null },
    mapId: null,
    holes: [],
    board: emptyBoard(),
    current: "blue",
    ap: AP_PER_TURN,
    turn: 1,
    ply: 0,
    destroyed: { blue: 0, red: 0 },
    slamUsed: { blue: false, red: false },
    pieRule: { available: true, used: false },
    turnsSinceKill: 0,
    ring: 0,
    positions: {},
    winner: null,
    endReason: null
  };

  if (options.skipBans) {
    const chosen = options.mapId ? mapById(options.mapId) : mapById(pool[0]);
    startPlay(state, chosen || MAPS[0], random);
  }

  return state;
}

function emptyBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
}

function pickPool(random) {
  const ids = MAPS.map(m => m.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, Math.min(BAN_POOL_SIZE, ids.length));
}

function startPlay(state, map, random) {
  state.mapId = map.id;
  state.holes = map.holes.map(([r, c]) => ({ r, c }));
  state.board = emptyBoard();

  let n = 0;
  const place = (r, c, color, role) => {
    state.board[r][c] = { id: color[0] + (++n), color, role };
  };

  for (let c = 1; c <= 5; c++) {
    const role = state.mode === "roles" ? ROLE_ROW[c - 1] : ROLE.STANDARD;
    place(0, c, "blue", role);
    place(6, c, "red", role);
  }

  state.phase = "playing";
  state.current = "blue";
  state.ap = AP_PER_TURN;
  recordPosition(state);
  return state;
}

/* --------------------------------------------------------------- hashing */

export function positionKey(state) {
  let out = state.current + "|" + state.destroyed.blue + state.destroyed.red + "|";
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const p = state.board[r][c];
      out += p ? (p.color === "blue" ? "B" : "R") + p.role[0] : ".";
    }
  }
  return out;
}

function recordPosition(state) {
  const key = positionKey(state);
  state.positions[key] = (state.positions[key] || 0) + 1;
  return state.positions[key];
}

/* --------------------------------------------------------- legal actions */

export function legalActions(state) {
  if (state.phase === "ban") {
    const banner = state.bans.blue === null ? "blue" : "red";
    return state.pool
      .filter(id => id !== state.bans.blue)
      .map(id => ({ type: "ban", side: banner, mapId: id }));
  }

  if (state.phase !== "playing") return [];

  const out = [];

  if (state.pieRule.available && state.current === "red") {
    out.push({ type: "swap" });
  }

  for (const { piece } of piecesOf(state, state.current)) {
    for (const dir of DIRECTIONS) {
      for (const type of ["move", "dash", "slam"]) {
        const action = { type, pieceId: piece.id, dir };
        if (validate(state, action).ok) out.push(action);
      }
    }
  }

  /* Ending early is always allowed once something has been spent. */
  if (state.ap < AP_PER_TURN) out.push({ type: "end" });

  return out;
}

/* ------------------------------------------------------------- validation
 *
 * validate() answers "is this legal and what would it cost" without
 * touching the board. resolve() does the actual work.
 */

function validate(state, action) {
  if (state.phase !== "playing") {
    return { ok: false, reason: "The game is not running." };
  }

  if (action.type === "end") {
    if (state.ap === AP_PER_TURN) {
      return { ok: false, reason: "You have not done anything yet." };
    }
    return { ok: true, cost: state.ap };
  }

  if (action.type === "swap") {
    if (!state.pieRule.available || state.current !== "red") {
      return { ok: false, reason: "The swap is not available." };
    }
    return { ok: true, cost: 0 };
  }

  const source = findPiece(state, action.pieceId);
  if (!source) return { ok: false, reason: "Piece not found." };
  if (source.piece.color !== state.current) {
    return { ok: false, reason: "That is not your piece." };
  }

  const d = delta(action.dir);
  if (!d) return { ok: false, reason: "Unknown direction." };

  if (action.type === "dash") return validateDash(state, source, d);
  if (action.type === "slam") return validateSlam(state, source, d);
  if (action.type === "move") return validateMove(state, source, d);

  return { ok: false, reason: "Unknown action." };
}

function validateDash(state, source, d) {
  if (!canDash(source.piece)) {
    return { ok: false, reason: "Only Runners can dash." };
  }
  if (state.ap < COST_DASH) {
    return { ok: false, reason: "Not enough action points." };
  }

  for (let step = 1; step <= 2; step++) {
    const r = source.r + d[0] * step;
    const c = source.c + d[1] * step;
    if (!inside(r, c)) return { ok: false, reason: "The board edge is there." };
    if (isHole(state, r, c)) return { ok: false, reason: "A hole is in the way." };
    if (state.board[r][c]) return { ok: false, reason: "The lane is blocked." };
  }

  return { ok: true, cost: COST_DASH, kind: "dash" };
}

function validateMove(state, source, d) {
  const tr = source.r + d[0];
  const tc = source.c + d[1];

  if (!inside(tr, tc)) return { ok: false, reason: "The board edge is there." };

  const target = state.board[tr][tc];

  if (!target) {
    if (isHole(state, tr, tc)) {
      return { ok: false, reason: "You cannot walk into a hole." };
    }
    if (state.ap < COST_STEP) {
      return { ok: false, reason: "Not enough action points." };
    }
    return { ok: true, cost: COST_STEP, kind: "step" };
  }

  if (target.color === source.piece.color) {
    return { ok: false, reason: "Your own piece is blocking you." };
  }

  const chain = collectChain(state, source, d);
  const check = validatePush(state, source, d, chain, 1);
  if (!check.ok) return check;

  if (state.ap < COST_PUSH) {
    return { ok: false, reason: "A push costs 2 action points." };
  }
  return { ok: true, cost: COST_PUSH, kind: "push", chain };
}

function validateSlam(state, source, d) {
  if (!canSlam(source.piece)) {
    return { ok: false, reason: "This piece cannot slam." };
  }
  if (state.slamUsed[source.piece.color]) {
    return { ok: false, reason: "You already used SLAM." };
  }
  if (state.ap < COST_SLAM) {
    return { ok: false, reason: "A slam costs 2 action points." };
  }

  const chain = collectChain(state, source, d);
  const check = validatePush(state, source, d, chain, SLAM_DISTANCE);
  if (!check.ok) return check;

  return { ok: true, cost: COST_SLAM, kind: "slam", chain };
}

function collectChain(state, source, d) {
  const chain = [];
  let r = source.r + d[0];
  let c = source.c + d[1];

  while (inside(r, c)) {
    const p = state.board[r][c];
    if (!p || p.color === source.piece.color) break;
    chain.push({ r, c, piece: p });
    r += d[0];
    c += d[1];
  }
  return chain;
}

function validatePush(state, source, d, chain, distance) {
  if (!canPush(source.piece)) {
    return { ok: false, reason: "Runners cannot push." };
  }
  if (!chain.length) {
    return { ok: false, reason: "There is nothing to push." };
  }
  if (chain.length > maxChain(source.piece)) {
    return {
      ok: false,
      reason: "This piece can only push " + maxChain(source.piece) + " at a time."
    };
  }
  if (chain.some(item => !canBePushed(item.piece))) {
    return { ok: false, reason: "An Anchor cannot be pushed." };
  }

  const front = chain[chain.length - 1];

  for (let step = 1; step <= distance; step++) {
    const nr = front.r + d[0] * step;
    const nc = front.c + d[1] * step;

    if (!inside(nr, nc)) return { ok: false, reason: "There is not enough room." };

    /* A hole short of the landing square stops the whole shove. */
    if (step < distance && isHole(state, nr, nc)) {
      return { ok: false, reason: "A hole blocks the push." };
    }

    const occupant = state.board[nr][nc];
    const inChain = chain.some(item => item.r === nr && item.c === nc);

    if (occupant && !inChain && !isHole(state, nr, nc)) {
      return { ok: false, reason: "The chain is blocked." };
    }
  }

  return { ok: true };
}

/* ----------------------------------------------------------- apply action */

export function applyAction(state, action) {
  if (state.phase === "ban") return applyBan(state, action);

  const check = validate(state, action);
  if (!check.ok) return { ok: false, reason: check.reason, state };

  const next = clone(state);
  const events = [];
  const mover = state.current;

  if (action.type === "swap") {
    /* The pie rule. The board is untouched and red is still to move -- what
     * changes is which human sits in which seat, and that belongs to the
     * match layer. It reads `swapped` and trades the seats over. */
    next.pieRule = { available: false, used: true };
    next.swapped = true;
    events.push({ type: "swap" });
    return { ok: true, state: next, events };
  }

  if (action.type === "end") {
    if (mover === "red") next.pieRule.available = false;
    endTurn(next, events);
    return { ok: true, state: next, events };
  }

  const source = findPiece(next, action.pieceId);
  const d = delta(action.dir);

  if (check.kind === "step" || check.kind === "dash") {
    const distance = check.kind === "dash" ? 2 : 1;
    next.board[source.r][source.c] = null;
    next.board[source.r + d[0] * distance][source.c + d[1] * distance] = source.piece;
    events.push({ type: check.kind, pieceId: source.piece.id, dir: action.dir });
  } else {
    const distance = check.kind === "slam" ? SLAM_DISTANCE : 1;
    const chain = collectChain(next, source, d);

    for (const item of chain) next.board[item.r][item.c] = null;

    let killed = 0;
    for (const item of chain) {
      const nr = item.r + d[0] * distance;
      const nc = item.c + d[1] * distance;
      if (isHole(next, nr, nc)) {
        next.destroyed[item.piece.color]++;
        killed++;
        events.push({ type: "destroy", at: { r: nr, c: nc }, color: item.piece.color });
      } else {
        next.board[nr][nc] = item.piece;
      }
    }

    next.board[source.r][source.c] = null;
    next.board[source.r + d[0]][source.c + d[1]] = source.piece;

    if (check.kind === "slam") next.slamUsed[source.piece.color] = true;
    if (killed) next.turnsSinceKill = -1; /* reset below when the turn flips */

    events.push({
      type: check.kind,
      pieceId: source.piece.id,
      dir: action.dir,
      killed
    });
  }

  /* Once red has actually played, the offer is gone. */
  if (mover === "red") next.pieRule.available = false;
  next.ap -= check.cost;
  next.ply++;

  if (resolveWin(next, events)) return { ok: true, state: next, events };

  if (next.ap <= 0 || !hasAffordableAction(next)) {
    endTurn(next, events);
  }

  return { ok: true, state: next, events };
}

function applyBan(state, action) {
  if (action.type !== "ban") {
    return { ok: false, reason: "Bans first.", state };
  }
  const side = state.bans.blue === null ? "blue" : "red";
  if (action.side && action.side !== side) {
    return { ok: false, reason: "It is not your ban." };
  }
  if (!state.pool.includes(action.mapId)) {
    return { ok: false, reason: "That map is not in the pool." };
  }
  if (state.bans.blue === action.mapId) {
    return { ok: false, reason: "That map is already banned." };
  }

  const next = clone(state);
  next.bans[side] = action.mapId;

  if (next.bans.blue !== null && next.bans.red !== null) {
    const left = next.pool.filter(
      id => id !== next.bans.blue && id !== next.bans.red
    );
    const random = makeRandom(next.seed + next.pool.length);
    const chosen = left[Math.floor(random() * left.length)] || next.pool[0];
    startPlay(next, mapById(chosen), random);
    return { ok: true, state: next, events: [{ type: "start", mapId: chosen }] };
  }

  return { ok: true, state: next, events: [{ type: "ban", side, mapId: action.mapId }] };
}

/** True when the side to move can still afford something. */
function hasAffordableAction(state) {
  for (const { piece } of piecesOf(state, state.current)) {
    for (const dir of DIRECTIONS) {
      for (const type of ["move", "dash", "slam"]) {
        if (validate(state, { type, pieceId: piece.id, dir }).ok) return true;
      }
    }
  }
  return false;
}

function endTurn(state, events) {
  if (resolveWin(state, events)) return;

  state.turnsSinceKill = state.turnsSinceKill < 0 ? 0 : state.turnsSinceKill + 1;
  state.current = other(state.current);
  state.ap = AP_PER_TURN;
  state.turn++;

  /* The swap is only ever on the table for red's very first turn. */
  if (state.turn > 2) state.pieRule.available = false;

  collapseIfDue(state, events);
  if (resolveWin(state, events)) return;

  const seen = recordPosition(state);

  if (seen >= 3) {
    state.phase = "finished";
    state.winner = "draw";
    state.endReason = "Threefold repetition.";
    events.push({ type: "draw", reason: state.endReason });
    return;
  }

  if (state.turnsSinceKill >= DRAW_TURNS_WITHOUT_KILL) {
    state.phase = "finished";
    state.winner = "draw";
    state.endReason = DRAW_TURNS_WITHOUT_KILL + " turns with nothing destroyed.";
    events.push({ type: "draw", reason: state.endReason });
    return;
  }

  /* Stalemate: a side with no legal action at all loses the game. It cannot
   * happen with the current rules, but silence here would be a hang. */
  if (!hasAffordableAction(state)) {
    state.phase = "finished";
    state.winner = other(state.current);
    state.endReason = "No legal moves.";
    events.push({ type: "win", winner: state.winner, reason: state.endReason });
  }
}

/** Ring 0 is the border, ring 1 the square inside it, and so on. */
export function ringOf(r, c) {
  return Math.min(r, SIZE - 1 - r, c, SIZE - 1 - c);
}

export function nextShrinkTurn(state) {
  const ring = state.ring || 0;
  if (ring >= SHRINK_MAX_RINGS) return null;
  return SHRINK_FIRST_TURN + ring * SHRINK_EVERY;
}

function collapseIfDue(state, events) {
  const due = nextShrinkTurn(state);
  if (due === null || state.turn < due) return;

  const ring = state.ring || 0;
  const swallowed = [];

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (ringOf(r, c) !== ring) continue;

      if (!isHole(state, r, c)) state.holes.push({ r, c });

      const piece = state.board[r][c];
      if (piece) {
        state.board[r][c] = null;
        state.destroyed[piece.color]++;
        swallowed.push({ r, c, color: piece.color });
      }
    }
  }

  state.ring = ring + 1;
  state.positions = {}; /* the board is a different shape now */
  events.push({ type: "collapse", ring, swallowed });
}

function resolveWin(state, events) {
  /* A collapsing ring can take both sides past the line at once. */
  if (state.destroyed.red >= WIN_KILLS && state.destroyed.blue >= WIN_KILLS) {
    state.phase = "finished";
    if (state.destroyed.blue === state.destroyed.red) {
      state.winner = "draw";
      state.endReason = "Both sides collapsed together.";
      events.push({ type: "draw", reason: state.endReason });
    } else {
      state.winner = state.destroyed.blue < state.destroyed.red ? "blue" : "red";
      state.endReason = "Fewer pieces lost when the board closed.";
      events.push({ type: "win", winner: state.winner, reason: state.endReason });
    }
    return true;
  }

  if (state.destroyed.red >= WIN_KILLS) {
    state.phase = "finished";
    state.winner = "blue";
    state.endReason = "Destroyed three red pieces.";
    events.push({ type: "win", winner: "blue", reason: state.endReason });
    return true;
  }
  if (state.destroyed.blue >= WIN_KILLS) {
    state.phase = "finished";
    state.winner = "red";
    state.endReason = "Destroyed three blue pieces.";
    events.push({ type: "win", winner: "red", reason: state.endReason });
    return true;
  }
  return false;
}

/** Ends a match from outside the rules -- a resignation or a flagged clock. */
export function finish(state, winner, reason) {
  const next = clone(state);
  next.phase = "finished";
  next.winner = winner;
  next.endReason = reason;
  return next;
}

export function isOver(state) {
  return state.phase === "finished";
}

export { validate as validateAction };
