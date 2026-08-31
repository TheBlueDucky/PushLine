import test from "node:test";
import assert from "node:assert/strict";

import {
  SIZE, AP_PER_TURN, WIN_KILLS, SHRINK_FIRST_TURN,
  createGame, applyAction, legalActions, findPiece, piecesOf,
  positionKey, isOver, ROLE
} from "../shared/rules.js";

import { MAPS, isMirrored } from "../shared/maps.js";

/* ---------------------------------------------------------------- helpers */

/** A bare board so a rule can be tested in isolation. */
function staged({ holes = [], pieces = [], mode = "classic", current = "blue" } = {}) {
  const state = createGame({ mode, seed: 7, skipBans: true });
  state.board = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  state.holes = holes.map(([r, c]) => ({ r, c }));
  state.current = current;
  state.ap = AP_PER_TURN;
  state.destroyed = { blue: 0, red: 0 };
  state.slamUsed = { blue: false, red: false };
  state.pieRule = { available: false, used: false };
  state.positions = {};
  state.turn = 5;

  for (const [r, c, color, role = ROLE.STANDARD, id] of pieces) {
    state.board[r][c] = { id: id || color[0] + r + c, color, role };
  }
  return state;
}

const move = (s, pieceId, dir) => applyAction(s, { type: "move", pieceId, dir });
const slam = (s, pieceId, dir) => applyAction(s, { type: "slam", pieceId, dir });
const dash = (s, pieceId, dir) => applyAction(s, { type: "dash", pieceId, dir });

/* ------------------------------------------------------------------ maps */

test("every shipped map is fair top to bottom", () => {
  for (const map of MAPS) {
    assert.ok(isMirrored(map.holes), map.id + " is not mirrored");
  }
});

test("no map puts a hole on a spawn row", () => {
  for (const map of MAPS) {
    for (const [r] of map.holes) {
      assert.ok(r !== 0 && r !== SIZE - 1, map.id + " has a hole on a spawn row");
    }
  }
});

test("map ids are unique", () => {
  const ids = MAPS.map(m => m.id);
  assert.equal(new Set(ids).size, ids.length);
});

/* ------------------------------------------------------------ basic moves */

test("a step into an empty square costs one action point", () => {
  const s = staged({ pieces: [[3, 3, "blue"]] });
  const r = move(s, "b33", "down");
  assert.ok(r.ok);
  assert.equal(r.state.board[4][3].id, "b33");
  assert.equal(r.state.board[3][3], null);
  assert.equal(r.state.ap, AP_PER_TURN - 1);
  assert.equal(r.state.current, "blue", "still your turn with 1 AP left");
});

test("two steps end the turn", () => {
  const s = staged({ pieces: [[3, 3, "blue"], [6, 6, "red"]] });
  const a = move(s, "b33", "down");
  const b = move(a.state, "b33", "down");
  assert.ok(b.ok);
  assert.equal(b.state.current, "red");
  assert.equal(b.state.ap, AP_PER_TURN);
});

test("you cannot walk into a hole", () => {
  const s = staged({ holes: [[4, 3]], pieces: [[3, 3, "blue"]] });
  const r = move(s, "b33", "down");
  assert.equal(r.ok, false);
  assert.match(r.reason, /hole/i);
});

test("your own piece blocks you", () => {
  const s = staged({ pieces: [[3, 3, "blue"], [4, 3, "blue", ROLE.STANDARD, "friend"]] });
  const r = move(s, "b33", "down");
  assert.equal(r.ok, false);
  assert.match(r.reason, /own piece/i);
});

test("the board edge blocks you", () => {
  const s = staged({ pieces: [[0, 3, "blue"]] });
  const r = move(s, "b03", "up");
  assert.equal(r.ok, false);
  assert.match(r.reason, /edge/i);
});

test("moving an opponent piece is refused", () => {
  const s = staged({ pieces: [[3, 3, "red"]] });
  const r = move(s, "r33", "up");
  assert.equal(r.ok, false);
  assert.match(r.reason, /not your piece/i);
});

/* ----------------------------------------------------------------- pushes */

test("a push shifts the enemy and costs one action point", () => {
  const s = staged({ pieces: [[3, 2, "blue"], [3, 3, "red"]] });
  const r = move(s, "b32", "right");
  assert.ok(r.ok);
  assert.equal(r.state.board[3][4].color, "red");
  assert.equal(r.state.board[3][3].color, "blue");
  assert.equal(r.state.board[3][2], null);
  assert.equal(r.state.ap, AP_PER_TURN - 1);
  assert.equal(r.state.current, "blue", "one point left, still your turn");
});

test("stepping in and then shoving is a legal turn", () => {
  const s = staged({ pieces: [[3, 1, "blue"], [3, 3, "red"]] });
  const stepped = move(s, "b31", "right");
  assert.ok(stepped.ok);
  assert.equal(stepped.state.ap, 1);

  const pushed = move(stepped.state, "b31", "right");
  assert.ok(pushed.ok, "the second point pays for the push");
  assert.equal(pushed.state.board[3][4].color, "red");
  assert.equal(pushed.state.current, "red", "out of points, turn over");
});

test("a slam needs both action points", () => {
  const s = staged({ pieces: [[3, 1, "blue"], [3, 3, "red"]] });
  const stepped = move(s, "b31", "right");
  const slammed = slam(stepped.state, "b31", "right");
  assert.equal(slammed.ok, false);
  assert.match(slammed.reason, /2 action points/i);
});

test("a whole chain moves together", () => {
  const s = staged({
    pieces: [[3, 1, "blue"], [3, 2, "red", ROLE.STANDARD, "r1"],
             [3, 3, "red", ROLE.STANDARD, "r2"]]
  });
  const r = move(s, "b31", "right");
  assert.ok(r.ok);
  assert.equal(r.state.board[3][3].id, "r1");
  assert.equal(r.state.board[3][4].id, "r2");
  assert.equal(r.state.board[3][2].color, "blue");
});

test("a chain with no room does not move", () => {
  const s = staged({
    pieces: [[3, 4, "blue"], [3, 5, "red", ROLE.STANDARD, "r1"],
             [3, 6, "red", ROLE.STANDARD, "r2"]]
  });
  const r = move(s, "b34", "right");
  assert.equal(r.ok, false);
  assert.match(r.reason, /not enough room/i);
});

test("a friendly piece behind the chain blocks the push", () => {
  const s = staged({
    pieces: [[3, 2, "blue"], [3, 3, "red"],
             [3, 4, "blue", ROLE.STANDARD, "wall"]]
  });
  const r = move(s, "b32", "right");
  assert.equal(r.ok, false);
  assert.match(r.reason, /blocked/i);
});

test("pushing an enemy into a hole destroys it", () => {
  const s = staged({ holes: [[3, 4]], pieces: [[3, 2, "blue"], [3, 3, "red"]] });
  const r = move(s, "b32", "right");
  assert.ok(r.ok);
  assert.equal(r.state.board[3][4], null, "the hole stays empty");
  assert.equal(r.state.destroyed.red, 1);
  assert.equal(r.state.board[3][3].color, "blue");
});

test("the third kill ends the game", () => {
  const s = staged({ holes: [[3, 4]], pieces: [[3, 2, "blue"], [3, 3, "red"]] });
  s.destroyed.red = WIN_KILLS - 1;
  const r = move(s, "b32", "right");
  assert.ok(r.ok);
  assert.ok(isOver(r.state));
  assert.equal(r.state.winner, "blue");
});

/* ------------------------------------------------------------------ slam */

test("a slam shoves a chain two squares, once per game", () => {
  const s = staged({
    pieces: [[3, 1, "blue"], [3, 2, "red", ROLE.STANDARD, "r1"],
             [3, 3, "red", ROLE.STANDARD, "r2"]]
  });
  const r = slam(s, "b31", "right");
  assert.ok(r.ok);
  assert.equal(r.state.board[3][4].id, "r1");
  assert.equal(r.state.board[3][5].id, "r2");
  assert.equal(r.state.slamUsed.blue, true);

  const again = staged({ pieces: [[3, 1, "blue"], [3, 2, "red"]] });
  again.slamUsed.blue = true;
  const second = slam(again, "b31", "right");
  assert.equal(second.ok, false);
  assert.match(second.reason, /already used/i);
});

test("a hole partway through blocks a slam", () => {
  const s = staged({ holes: [[3, 4]], pieces: [[3, 2, "blue"], [3, 3, "red"]] });
  const r = slam(s, "b32", "right");
  assert.equal(r.ok, false);
  assert.match(r.reason, /hole blocks/i);
});

/* ------------------------------------------------------------------ roles */

test("a runner dashes two squares for one action point", () => {
  const s = staged({ mode: "roles", pieces: [[3, 1, "blue", ROLE.RUNNER]] });
  const r = dash(s, "b31", "right");
  assert.ok(r.ok);
  assert.equal(r.state.board[3][3].id, "b31");
  assert.equal(r.state.ap, AP_PER_TURN - 1);
});

test("a runner cannot push", () => {
  const s = staged({
    mode: "roles",
    pieces: [[3, 2, "blue", ROLE.RUNNER], [3, 3, "red"]]
  });
  const r = move(s, "b32", "right");
  assert.equal(r.ok, false);
  assert.match(r.reason, /runners cannot push/i);
});

test("an anchor cannot be pushed", () => {
  const s = staged({
    mode: "roles",
    pieces: [[3, 2, "blue", ROLE.BRUISER], [3, 3, "red", ROLE.ANCHOR]]
  });
  const r = move(s, "b32", "right");
  assert.equal(r.ok, false);
  assert.match(r.reason, /anchor/i);
});

test("an anchor only shoves one piece", () => {
  const s = staged({
    mode: "roles",
    pieces: [[3, 1, "blue", ROLE.ANCHOR],
             [3, 2, "red", ROLE.RUNNER, "r1"],
             [3, 3, "red", ROLE.RUNNER, "r2"]]
  });
  const two = move(s, "b31", "right");
  assert.equal(two.ok, false);
  assert.match(two.reason, /only push 1/i);

  const single = staged({
    mode: "roles",
    pieces: [[3, 1, "blue", ROLE.ANCHOR], [3, 2, "red", ROLE.RUNNER, "r1"]]
  });
  assert.ok(move(single, "b31", "right").ok);
});

test("roles mode deals the same five roles to both sides", () => {
  const state = createGame({ mode: "roles", seed: 3, skipBans: true });
  const roles = color =>
    piecesOf(state, color)
      .sort((a, b) => a.c - b.c)
      .map(p => p.piece.role);
  assert.deepEqual(roles("blue"), roles("red"));
  assert.deepEqual(roles("blue"),
    [ROLE.RUNNER, ROLE.BRUISER, ROLE.ANCHOR, ROLE.BRUISER, ROLE.RUNNER]);
});

/* -------------------------------------------------------------- pie rule */

/** Applies an action and fails loudly if the rules refused it. */
function step(state, action) {
  const result = applyAction(state, action);
  assert.ok(result.ok, "expected legal: " + JSON.stringify(action) + " -- " + result.reason);
  return result.state;
}

/* "pillars" keeps column 3 clear from row 1 to row 2, so these tests can
 * move a known piece a known distance. */
function openingGame(mode = "classic") {
  return createGame({ seed: 11, mode, skipBans: true, mapId: "pillars" });
}

test("red may swap sides after blue's first turn, and only then", () => {
  let state = openingGame();
  const first = piecesOf(state, "blue")[2].piece.id; /* the piece on column 3 */

  state = step(state, { type: "move", pieceId: first, dir: "down" });
  state = step(state, { type: "end" });
  assert.equal(state.current, "red");
  assert.ok(legalActions(state).some(a => a.type === "swap"));

  const swapped = applyAction(state, { type: "swap" });
  assert.ok(swapped.ok);
  assert.equal(swapped.state.swapped, true);
  assert.equal(swapped.state.current, "red", "red still has to move");
  assert.equal(swapped.state.pieRule.available, false);
  assert.equal(legalActions(swapped.state).some(a => a.type === "swap"), false);
});

test("the swap is gone once red has played", () => {
  let state = openingGame();
  const blue = piecesOf(state, "blue")[2].piece.id;
  const red = piecesOf(state, "red")[2].piece.id;

  state = step(state, { type: "move", pieceId: blue, dir: "down" });
  state = step(state, { type: "end" });
  state = step(state, { type: "move", pieceId: red, dir: "up" });
  assert.equal(state.pieRule.available, false);
});

/* ----------------------------------------------------------------- draws */

test("threefold repetition is a draw", () => {
  let state = createGame({ seed: 5, skipBans: true });
  const blue = piecesOf(state, "blue")[1].piece.id;
  const red = piecesOf(state, "red")[1].piece.id;

  /* Shuffle both pieces down and back until the position repeats. */
  for (let i = 0; i < 12 && !isOver(state); i++) {
    const dirBlue = i % 2 === 0 ? "down" : "up";
    const dirRed = i % 2 === 0 ? "up" : "down";
    state = applyAction(state, { type: "move", pieceId: blue, dir: dirBlue }).state;
    state = applyAction(state, { type: "end" }).state;
    if (isOver(state)) break;
    state = applyAction(state, { type: "move", pieceId: red, dir: dirRed }).state;
    state = applyAction(state, { type: "end" }).state;
  }

  assert.ok(isOver(state), "the shuffle should have ended in a draw");
  assert.equal(state.winner, "draw");
  assert.match(state.endReason, /repetition/i);
});

/* ------------------------------------------------------------- ban phase */

test("both players ban before the board exists", () => {
  let state = createGame({ seed: 21 });
  assert.equal(state.phase, "ban");
  assert.equal(state.pool.length, 8);

  const blueBan = state.pool[0];
  state = applyAction(state, { type: "ban", side: "blue", mapId: blueBan }).state;
  assert.equal(state.phase, "ban");

  const redBan = state.pool[1];
  const done = applyAction(state, { type: "ban", side: "red", mapId: redBan });
  assert.ok(done.ok);
  assert.equal(done.state.phase, "playing");
  assert.notEqual(done.state.mapId, blueBan);
  assert.notEqual(done.state.mapId, redBan);
  assert.equal(piecesOf(done.state, "blue").length, 5);
  assert.equal(piecesOf(done.state, "red").length, 5);
});

test("you cannot ban the map your opponent already banned", () => {
  let state = createGame({ seed: 21 });
  const first = state.pool[0];
  state = applyAction(state, { type: "ban", side: "blue", mapId: first }).state;
  const clash = applyAction(state, { type: "ban", side: "red", mapId: first });
  assert.equal(clash.ok, false);
});

/* -------------------------------------------------------- closing board */

test("the outer ring falls away and takes whatever is standing on it", () => {
  let state = createGame({ seed: 4, skipBans: true, mapId: "pillars" });
  state.turn = SHRINK_FIRST_TURN - 1;
  state.current = "blue";
  state.ap = AP_PER_TURN;

  const before = piecesOf(state, "blue").length + piecesOf(state, "red").length;
  assert.equal(before, 10);
  assert.equal(state.ring, 0);

  /* Spend a turn so the shrink check runs on the way out. */
  const blue = piecesOf(state, "blue")[2].piece.id;
  state = step(state, { type: "move", pieceId: blue, dir: "down" });
  state = step(state, { type: "end" });

  assert.equal(state.turn, SHRINK_FIRST_TURN);
  assert.equal(state.ring, 1, "one ring has collapsed");

  for (let c = 0; c < SIZE; c++) {
    assert.equal(state.board[0][c], null, "row 0 is gone");
    assert.equal(state.board[SIZE - 1][c], null, "row 6 is gone");
  }

  const after = piecesOf(state, "blue").length + piecesOf(state, "red").length;
  const lost = state.destroyed.blue + state.destroyed.red;
  assert.equal(after + lost, 10, "swallowed pieces are counted, not lost");
});

test("a closing board always finishes the game", () => {
  for (let seed = 1; seed <= 12; seed++) {
    let state = createGame({ seed, skipBans: true });
    let guard = 0;

    /* Both sides sit still and pass. Nothing can happen except the board. */
    while (!isOver(state) && guard++ < 600) {
      const actions = legalActions(state).filter(a => a.type !== "swap");
      const action = actions.find(a => a.type === "end") || actions[0];
      const result = applyAction(state, action);
      if (!result.ok) break;
      state = result.state;
    }

    assert.ok(isOver(state), "seed " + seed + " stalled forever");
  }
});

/* ------------------------------------------------------------ invariants */

test("applyAction never mutates the state it was given", () => {
  const s = staged({ pieces: [[3, 3, "blue"]] });
  const before = JSON.stringify(s);
  move(s, "b33", "down");
  assert.equal(JSON.stringify(s), before);
});

test("a full random game always terminates and stays consistent", () => {
  for (let game = 0; game < 40; game++) {
    let state = createGame({ seed: game + 1, mode: game % 2 ? "roles" : "classic" });

    let guard = 0;
    while (!isOver(state) && guard++ < 4000) {
      const actions = legalActions(state);
      assert.ok(actions.length > 0, "a live game always offers an action");
      const action = actions[(game * 7 + guard * 13) % actions.length];
      const result = applyAction(state, action);
      assert.ok(result.ok, "legalActions offered an illegal action: " + result.reason);
      state = result.state;

      /* Nothing is on the board until both bans are in. */
      if (state.phase === "ban") continue;

      /* No square ever holds two pieces, and ids stay unique. */
      const ids = new Set();
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          const p = state.board[r][c];
          if (!p) continue;
          assert.equal(ids.has(p.id), false, "duplicate piece id " + p.id);
          ids.add(p.id);
        }
      }

      /* Pieces are never left standing in a hole. */
      for (const hole of state.holes) {
        assert.equal(state.board[hole.r][hole.c], null, "a piece is sitting in a hole");
      }

      /* Nothing appears from nowhere. */
      const alive = piecesOf(state, "blue").length + piecesOf(state, "red").length;
      assert.equal(alive + state.destroyed.blue + state.destroyed.red, 10);
    }

    assert.ok(isOver(state), "game " + game + " never finished");
    assert.ok(["blue", "red", "draw"].includes(state.winner));
  }
});

test("position keys distinguish whose turn it is", () => {
  const a = staged({ pieces: [[3, 3, "blue"]], current: "blue" });
  const b = staged({ pieces: [[3, 3, "blue"]], current: "red" });
  assert.notEqual(positionKey(a), positionKey(b));
});
