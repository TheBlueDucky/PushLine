/* The authoritative match.
 *
 * The server holds the only real board. Clients send intents; if the rules
 * refuse one, the server says why and nothing changes. This is what makes
 * the currency mean anything -- a modified client cannot move twice, undo a
 * loss, or hand itself a win.
 */

import {
  createGame, applyAction, isOver, finish, other, legalActions
} from "../shared/rules.js";

import { chooseAction } from "../shared/bot.js";

export const CLOCK_START_MS = 180000; /* 3:00 */
export const CLOCK_INCREMENT_MS = 5000;
export const BAN_SECONDS = 30;

let nextId = 1;

export class Match {
  /**
   * @param {object[]} seats two entries: { kind:"human"|"bot", id, name, view, difficulty }
   */
  constructor({ mode = "classic", seats, onEvent, rated = true }) {
    this.id = "m" + (nextId++) + Math.random().toString(36).slice(2, 6);
    this.mode = mode;
    this.rated = rated;
    this.onEvent = onEvent || (() => {});
    this.createdAt = Date.now();

    /* seats[0] plays blue, seats[1] plays red. */
    this.seats = { blue: seats[0], red: seats[1] };

    this.state = createGame({ mode, seed: (Math.random() * 1e9) | 0 });
    this.clock = { blue: CLOCK_START_MS, red: CLOCK_START_MS };
    this.turnStartedAt = null;
    this.timer = null;
    this.finished = false;
    this.moves = [];

    /* Per-player tallies, used for quests and the result screen. */
    this.tally = {
      blue: { kills: 0, chainPushes: 0, usedSlam: false },
      red: { kills: 0, chainPushes: 0, usedSlam: false }
    };
    this.boardClosed = false;

    this.vsBot = seats.some(s => s.kind === "bot");
  }

  seatOf(playerId) {
    if (this.seats.blue && this.seats.blue.id === playerId) return "blue";
    if (this.seats.red && this.seats.red.id === playerId) return "red";
    return null;
  }

  colorToAct() {
    if (this.state.phase === "ban") {
      return this.state.bans.blue === null ? "blue" : "red";
    }
    return this.state.current;
  }

  start() {
    this.beginTurnTimer();
    this.broadcast();
    this.maybeBotMove();
  }

  /* --------------------------------------------------------------- clock */

  beginTurnTimer() {
    this.clearTimer();
    if (this.finished) return;

    this.turnStartedAt = Date.now();

    const color = this.colorToAct();
    const budget = this.state.phase === "ban"
      ? BAN_SECONDS * 1000
      : this.clock[color];

    this.timer = setTimeout(() => this.onTimeout(color), budget + 50);
    if (this.timer.unref) this.timer.unref();
  }

  clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Charge the mover for the time they just used. */
  chargeClock(color) {
    if (this.turnStartedAt === null || this.state.phase === "ban") return;
    const spent = Date.now() - this.turnStartedAt;
    this.clock[color] = Math.max(0, this.clock[color] - spent);
    this.turnStartedAt = Date.now();
  }

  onTimeout(color) {
    if (this.finished) return;

    if (this.state.phase === "ban") {
      /* Someone did not ban in time. Ban for them and carry on -- an idle
       * player should not stop the match from ever starting. */
      const options = legalActions(this.state);
      if (options.length) {
        this.submit(this.seats[color] ? this.seats[color].id : null, options[0], true);
      }
      return;
    }

    this.clock[color] = 0;
    this.end(other(color), "Ran out of time.");
  }

  /* -------------------------------------------------------------- actions */

  /**
   * @returns {{ok:boolean, reason?:string}}
   */
  submit(playerId, action, forced = false) {
    if (this.finished) return { ok: false, reason: "The match is over." };

    const seat = forced ? this.colorToAct() : this.seatOf(playerId);
    if (!seat) return { ok: false, reason: "You are not in this match." };

    /* Resigning is checked before whose turn it is -- the moment you most
     * want to give up is usually while waiting on the other player. */
    if (action && action.type === "resign") {
      this.end(other(seat), "Opponent resigned.");
      return { ok: true };
    }

    if (seat !== this.colorToAct()) return { ok: false, reason: "It is not your turn." };

    const before = this.state;
    const result = applyAction(before, action);
    if (!result.ok) return { ok: false, reason: result.reason };

    this.chargeClock(seat);
    this.state = result.state;
    this.moves.push({ seat, action, at: Date.now() - this.createdAt });

    this.recordEvents(seat, result.events || [], before);

    /* The pie rule: red declined the position, so the players trade seats
     * and it is still red to move -- now played by the other person. */
    if (this.state.swapped) {
      const blue = this.seats.blue;
      this.seats.blue = this.seats.red;
      this.seats.red = blue;
      delete this.state.swapped;
      this.onEvent({ type: "swapped", match: this });
    }

    if (isOver(this.state)) {
      this.end(this.state.winner, this.state.endReason);
      return { ok: true };
    }

    /* An increment is paid when the turn actually changes hands. */
    if (this.state.current !== before.current || before.phase === "ban") {
      if (this.state.phase === "playing" && before.phase !== "ban") {
        this.clock[seat] += CLOCK_INCREMENT_MS;
      }
      this.beginTurnTimer();
    }

    this.broadcast();
    this.maybeBotMove();
    return { ok: true };
  }

  recordEvents(seat, events, before) {
    for (const event of events) {
      if (event.type === "collapse") {
        this.boardClosed = true;
      }
      if (event.type === "destroy") {
        /* Credit the mover, not the owner of the piece. */
        if (event.color !== seat) this.tally[seat].kills++;
      }
      if (event.type === "slam") {
        this.tally[seat].usedSlam = true;
      }
      if ((event.type === "move" || event.type === "slam") && event.killed !== undefined) {
        const chain = chainLength(before, event);
        if (chain >= 2) this.tally[seat].chainPushes++;
      }
    }
  }

  /* ------------------------------------------------------------------ bot */

  maybeBotMove() {
    if (this.finished) return;

    const color = this.colorToAct();
    const seat = this.seats[color];
    if (!seat || seat.kind !== "bot") return;

    const think = this.state.phase === "ban" ? 300 : 350 + Math.random() * 450;

    const timer = setTimeout(() => {
      if (this.finished) return;
      if (this.colorToAct() !== color) return;

      const action = chooseAction(this.state, seat.difficulty || "normal");
      if (!action) {
        this.end(other(color), "The bot had no move.");
        return;
      }
      this.submit(seat.id, action);
    }, think);

    if (timer.unref) timer.unref();
  }

  /* ------------------------------------------------------------------ end */

  end(winner, reason) {
    if (this.finished) return;
    this.finished = true;
    this.clearTimer();
    this.state = finish(this.state, winner, reason);
    this.onEvent({ type: "over", match: this });
  }

  /** What one seat is told about the match. */
  view(color) {
    const foe = other(color);
    const seat = this.seats[color];
    const foeSeat = this.seats[foe];

    /* Show the live clock, not the value from the last action. */
    const clock = { ...this.clock };
    const ticking = this.colorToAct();
    if (!this.finished && this.state.phase === "playing" && this.turnStartedAt) {
      clock[ticking] = Math.max(0, clock[ticking] - (Date.now() - this.turnStartedAt));
    }

    return {
      matchId: this.id,
      mode: this.mode,
      you: color,
      rated: this.rated,
      vsBot: this.vsBot,
      state: this.state,
      clock,
      banSeconds: BAN_SECONDS,
      yourTurn: !this.finished && this.colorToAct() === color,
      me: seat ? seat.view : null,
      opponent: foeSeat ? foeSeat.view : null,
      tally: this.tally
    };
  }

  broadcast() {
    this.onEvent({ type: "state", match: this });
  }

  /** Per-seat summary for the economy. */
  summaryFor(color) {
    const winner = this.state.winner;
    const result = winner === "draw" || !winner
      ? "draw"
      : winner === color ? "win" : "loss";

    return {
      result,
      vsBot: this.vsBot,
      rated: this.rated,
      kills: this.tally[color].kills,
      chainPushes: this.tally[color].chainPushes,
      usedSlam: this.tally[color].usedSlam,
      boardClosed: this.boardClosed,
      reason: this.state.endReason,
      winner
    };
  }
}

/** How many pieces a push event actually shifted. */
function chainLength(before, event) {
  if (!event.pieceId || !event.dir) return 0;

  const DELTAS = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };
  const d = DELTAS[event.dir];
  if (!d) return 0;

  let found = null;
  for (let r = 0; r < before.board.length && !found; r++) {
    for (let c = 0; c < before.board.length; c++) {
      const p = before.board[r][c];
      if (p && p.id === event.pieceId) { found = { r, c, color: p.color }; break; }
    }
  }
  if (!found) return 0;

  let count = 0;
  let r = found.r + d[0];
  let c = found.c + d[1];
  while (r >= 0 && r < before.board.length && c >= 0 && c < before.board.length) {
    const p = before.board[r][c];
    if (!p || p.color === found.color) break;
    count++;
    r += d[0];
    c += d[1];
  }
  return count;
}
