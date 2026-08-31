/* The opponent for when nobody else is online.
 *
 * Alpha-beta over *actions* rather than turns, because a turn is one or two
 * actions and the side to move only flips when the action points run out.
 * Iterative deepening with a wall-clock budget, so the same code gives a
 * weak fast answer and a strong slow one.
 *
 * The branching factor is small -- five pieces times four directions -- so
 * this searches deep enough to punish most human mistakes. */

import {
  SIZE, WIN_KILLS,
  legalActions, applyAction, isOver, piecesOf, isHole,
  inside, delta, other, DIRECTIONS, ROLE
} from "./rules.js";

export const DIFFICULTY = {
  easy:   { timeMs: 40,  maxDepth: 2, blunder: 0.35 },
  normal: { timeMs: 180, maxDepth: 5, blunder: 0.10 },
  hard:   { timeMs: 450, maxDepth: 8, blunder: 0    }
};

const WIN_SCORE = 1e6;

/* ------------------------------------------------------------- evaluation */

/** Score the position from `color`'s point of view. Higher is better. */
export function evaluate(state, color) {
  const foe = other(color);

  if (state.winner === color) return WIN_SCORE;
  if (state.winner === foe) return -WIN_SCORE;
  if (state.winner === "draw") return 0;

  let score = 0;

  /* Kills are the only thing that actually wins. */
  score += (state.destroyed[foe] - state.destroyed[color]) * 1200;

  const mine = piecesOf(state, color);
  const theirs = piecesOf(state, foe);

  score += (mine.length - theirs.length) * 250;

  /* Being next to a hole is dangerous; having an enemy next to one is an
   * opportunity. Weight it by whether the shove is actually available. */
  for (const p of theirs) score += threatValue(state, p, color) * 70;
  for (const p of mine)   score -= threatValue(state, p, foe) * 90;

  /* Mild pull toward the middle: edge pieces have fewer options. */
  for (const p of mine)   score += centrality(p) * 6;
  for (const p of theirs) score -= centrality(p) * 6;

  if (!state.slamUsed[color]) score += 60;
  if (!state.slamUsed[foe])   score -= 60;

  return score;
}

/** How exposed `target` is to being shoved into a hole by `attacker`. */
function threatValue(state, target, attacker) {
  let value = 0;

  for (const dir of DIRECTIONS) {
    const d = delta(dir);
    const hr = target.r + d[0];
    const hc = target.c + d[1];
    if (!inside(hr, hc) || !isHole(state, hr, hc)) continue;

    /* A hole on one side only matters if the attacker can get behind it. */
    const br = target.r - d[0];
    const bc = target.c - d[1];
    if (!inside(br, bc)) continue;

    const behind = state.board[br][bc];
    if (behind && behind.color === attacker) {
      value += behind.role === ROLE.RUNNER ? 1 : 3; /* runners cannot push */
    } else if (!behind && !isHole(state, br, bc)) {
      value += 1; /* reachable next turn */
    }
  }

  return value;
}

function centrality(p) {
  const mid = (SIZE - 1) / 2;
  return 6 - (Math.abs(p.r - mid) + Math.abs(p.c - mid));
}

/* ----------------------------------------------------------------- search */

function orderActions(state, actions) {
  /* Try the loud moves first so alpha-beta prunes more. */
  const rank = a => {
    if (a.type === "slam") return 0;
    if (a.type === "move") return 1;
    if (a.type === "dash") return 2;
    if (a.type === "end") return 4;
    return 3;
  };
  return actions.slice().sort((x, y) => rank(x) - rank(y));
}

function search(state, color, depth, alpha, beta, deadline, counter) {
  if (isOver(state)) return evaluate(state, color);
  if (depth <= 0) return evaluate(state, color);

  if ((counter.n++ & 255) === 0 && Date.now() > deadline) {
    counter.timeout = true;
    return evaluate(state, color);
  }

  const actions = orderActions(state, legalActions(state))
    .filter(a => a.type !== "swap");

  if (!actions.length) return evaluate(state, color);

  const maximizing = state.current === color;
  let best = maximizing ? -Infinity : Infinity;

  for (const action of actions) {
    const result = applyAction(state, action);
    if (!result.ok) continue;

    const value = search(result.state, color, depth - 1, alpha, beta, deadline, counter);

    if (maximizing) {
      if (value > best) best = value;
      if (best > alpha) alpha = best;
    } else {
      if (value < best) best = value;
      if (best < beta) beta = best;
    }

    if (beta <= alpha) break;
    if (counter.timeout) break;
  }

  return best === Infinity || best === -Infinity ? evaluate(state, color) : best;
}

/* ------------------------------------------------------------------ entry */

/**
 * Pick an action for the side to move.
 * Returns null when there is nothing to choose.
 */
export function chooseAction(state, difficulty = "normal", random = Math.random) {
  const settings = DIFFICULTY[difficulty] || DIFFICULTY.normal;

  if (state.phase === "ban") {
    const bans = legalActions(state);
    return bans.length ? bans[Math.floor(random() * bans.length)] : null;
  }

  if (state.phase !== "playing") return null;

  const color = state.current;
  const actions = orderActions(state, legalActions(state))
    .filter(a => a.type !== "swap");

  if (!actions.length) return null;
  if (actions.length === 1) return actions[0];

  /* Deliberate mistakes are how the easier settings stay beatable. */
  if (settings.blunder > 0 && random() < settings.blunder) {
    const pool = actions.filter(a => a.type !== "end");
    if (pool.length) return pool[Math.floor(random() * pool.length)];
  }

  const deadline = Date.now() + settings.timeMs;
  const counter = { n: 0, timeout: false };

  let best = actions[0];

  for (let depth = 1; depth <= settings.maxDepth; depth++) {
    let localBest = null;
    let localScore = -Infinity;
    let alpha = -Infinity;

    for (const action of actions) {
      const result = applyAction(state, action);
      if (!result.ok) continue;

      const score = search(result.state, color, depth - 1, alpha, Infinity, deadline, counter);

      if (score > localScore) {
        localScore = score;
        localBest = action;
      }
      if (score > alpha) alpha = score;
      if (counter.timeout) break;
    }

    /* A depth that ran out of time is not trustworthy -- keep the last one. */
    if (counter.timeout) break;
    if (localBest) best = localBest;
    if (localScore >= WIN_SCORE) break;
  }

  return best;
}

/**
 * Play a whole game between two bots. Used by the balance harness to
 * measure whether moving first is actually an advantage.
 */
export function selfPlay(state, difficulty = "easy", random = Math.random, limit = 3000) {
  let current = state;
  let guard = 0;

  while (!isOver(current) && guard++ < limit) {
    const action = chooseAction(current, difficulty, random);
    if (!action) break;
    const result = applyAction(current, action);
    if (!result.ok) break;
    current = result.state;
  }

  return current;
}
