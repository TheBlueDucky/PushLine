/* PUSHLINE server.
 *
 * Static files over HTTP, everything else over one WebSocket. No WebRTC, no
 * TURN, no NAT problems, and the rules run here rather than on a player's
 * machine.
 *
 *   node server/server.js [--port 8080] [--data ./data/pushline.json]
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

import { Store } from "./store.js";
import { Match } from "./match.js";
import {
  newProfile, cleanName, ensureDaily, applyMatchResult, applyPuzzleSolved,
  shopFor, buy, equip, privateView, publicView, dayNumber, weekNumber
} from "./economy.js";

import { generateDaily, verifySolution } from "../shared/puzzle.js";
import { ITEMS, SLOTS, SLOT_LABEL, weeklyRotation } from "../shared/catalog.js";
import { MAPS } from "../shared/maps.js";
import {
  AP_PER_TURN, WIN_KILLS, SHRINK_FIRST_TURN, SHRINK_EVERY, SIZE
} from "../shared/rules.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const PORT = Number(argValue("--port", process.env.PORT || 8080));
const DATA_FILE = path.resolve(ROOT, argValue("--data", "data/pushline.json"));

const store = new Store(DATA_FILE);

/* -------------------------------------------------------- static serving */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const SERVE_DIRS = {
  "/shared/": path.join(ROOT, "shared"),
  "/": path.join(ROOT, "web")
};

function resolveStatic(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]);
  if (clean.includes("..")) return null;

  for (const [prefix, dir] of Object.entries(SERVE_DIRS)) {
    if (prefix !== "/" && clean.startsWith(prefix)) {
      return path.join(dir, clean.slice(prefix.length));
    }
  }

  const name = clean === "/" ? "index.html" : clean.replace(/^\//, "");
  return path.join(SERVE_DIRS["/"], name);
}

const httpServer = http.createServer((request, response) => {
  const file = resolveStatic(request.url || "/");

  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-cache"
  });
  fs.createReadStream(file).pipe(response);
});

/* ------------------------------------------------------------- the world */

const wss = new WebSocketServer({ server: httpServer });

let connectionCounter = 0;
const connections = new Map();   /* connId -> conn */
const matches = new Map();       /* matchId -> Match */
const rooms = new Map();         /* code -> { code, mode, hostId } */
const queues = new Map();        /* mode -> connId[] */
const rematchWanted = new Map(); /* matchId -> Set(connId) */

function send(conn, type, payload = {}) {
  if (!conn || conn.socket.readyState !== conn.socket.OPEN) return;
  try {
    conn.socket.send(JSON.stringify({ type, ...payload }));
  } catch (error) {
    console.error("[send]", error.message);
  }
}

function fail(conn, message) {
  send(conn, "toast", { message });
}

/* --------------------------------------------------------------- puzzles */

function puzzleForToday() {
  const day = dayNumber();
  const cached = store.puzzle(day);
  if (cached) return cached;

  const started = Date.now();
  const def = generateDaily(day);
  console.log("[puzzle] built day " + day + " in " + (Date.now() - started) + "ms");
  return store.putPuzzle(day, def);
}

/** Strip the answer before the puzzle goes anywhere near a browser. */
function shippablePuzzle(def) {
  const { solutionLength, ...rest } = def;
  return rest;
}

/* ------------------------------------------------------------ room codes */

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeCode() {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return rooms.has(code) ? makeCode() : code;
}

/* ------------------------------------------------------------ match glue */

function connectionsInMatch(match) {
  return ["blue", "red"]
    .map(color => match.seats[color])
    .filter(seat => seat && seat.kind === "human")
    .map(seat => connections.get(seat.id))
    .filter(Boolean);
}

function pushMatchState(match) {
  for (const color of ["blue", "red"]) {
    const seat = match.seats[color];
    if (!seat || seat.kind !== "human") continue;
    const conn = connections.get(seat.id);
    if (conn) send(conn, "match", { view: match.view(color) });
  }
}

function finishMatch(match) {
  for (const color of ["blue", "red"]) {
    const seat = match.seats[color];
    if (!seat || seat.kind !== "human") continue;

    const conn = connections.get(seat.id);
    if (!conn) continue;

    const summary = match.summaryFor(color);
    let rewards = { log: [] };

    if (conn.profile) {
      rewards = applyMatchResult(conn.profile, summary);
      store.putProfile(conn.token, conn.profile);
    }

    send(conn, "over", {
      view: match.view(color),
      summary,
      rewards: rewards.log,
      profile: conn.profile ? privateView(conn.profile) : null
    });
  }

  /* Keep the match around briefly so a rematch can find the seats. */
  setTimeout(() => {
    matches.delete(match.id);
    rematchWanted.delete(match.id);
  }, 120000).unref?.();
}

function startMatch(mode, seatA, seatB, rated = true) {
  const match = new Match({
    mode,
    rated,
    seats: [seatA, seatB],
    onEvent: event => {
      if (event.type === "state" || event.type === "swapped") {
        pushMatchState(event.match);
      } else if (event.type === "over") {
        finishMatch(event.match);
      }
    }
  });

  matches.set(match.id, match);

  for (const conn of connectionsInMatch(match)) {
    conn.matchId = match.id;
    leaveQueue(conn);
  }

  match.start();
  return match;
}

function seatFor(conn) {
  return {
    kind: "human",
    id: conn.id,
    name: conn.profile ? conn.profile.name : "Player",
    view: conn.profile ? publicView(conn.profile) : { name: "Player", level: 1 }
  };
}

function botSeat(difficulty) {
  const names = { easy: "Bot (easy)", normal: "Bot (normal)", hard: "Bot (hard)" };
  return {
    kind: "bot",
    id: "bot-" + Math.random().toString(36).slice(2, 8),
    difficulty,
    name: names[difficulty] || "Bot",
    view: {
      id: "bot",
      name: names[difficulty] || "Bot",
      level: 0,
      bot: true,
      loadout: { skin: "skin.hexcore", frame: "frame.plain", title: "title.none" }
    }
  };
}

/* ------------------------------------------------------------ matchmaking */

function leaveQueue(conn) {
  if (!conn.queuedMode) return;
  const list = queues.get(conn.queuedMode);
  if (list) {
    const at = list.indexOf(conn.id);
    if (at >= 0) list.splice(at, 1);
  }
  conn.queuedMode = null;
}

function joinQueue(conn, mode) {
  leaveQueue(conn);

  if (!queues.has(mode)) queues.set(mode, []);
  const list = queues.get(mode);

  /* Somebody already waiting? Pair them up. */
  while (list.length) {
    const otherId = list.shift();
    const other = connections.get(otherId);
    if (!other || other.matchId) continue;
    other.queuedMode = null;

    /* Coin flip for who moves first. The pie rule handles the rest. */
    const seats = Math.random() < 0.5
      ? [seatFor(other), seatFor(conn)]
      : [seatFor(conn), seatFor(other)];

    startMatch(mode, seats[0], seats[1]);
    return;
  }

  list.push(conn.id);
  conn.queuedMode = mode;
  send(conn, "queued", { mode, waiting: list.length });
}

/* -------------------------------------------------------------- handlers */

const handlers = {
  hello(conn, msg) {
    const token = typeof msg.token === "string" && msg.token.length >= 8
      ? msg.token.slice(0, 64)
      : crypto.randomUUID();

    let profile = store.profile(token);
    if (!profile) {
      profile = newProfile(token, cleanName(msg.name));
      store.putProfile(token, profile);
    }

    /* Older saves may predate a slot or a free item. */
    for (const slot of SLOTS) {
      if (!profile.loadout[slot]) {
        const fallback = ITEMS.find(i => i.slot === slot && i.price === 0);
        if (fallback) profile.loadout[slot] = fallback.id;
      }
    }
    for (const item of ITEMS) {
      if (item.price === 0 && !profile.owned.includes(item.id)) {
        profile.owned.push(item.id);
      }
    }

    ensureDaily(profile);
    store.putProfile(token, profile);

    conn.token = token;
    conn.profile = profile;

    send(conn, "welcome", {
      token,
      profile: privateView(profile),
      catalog: ITEMS,
      slots: SLOTS,
      slotLabels: SLOT_LABEL,
      featured: weeklyRotation(weekNumber()),
      maps: MAPS,
      leaderboard: store.leaderboard(),
      rules: {
        size: SIZE,
        ap: AP_PER_TURN,
        winKills: WIN_KILLS,
        shrinkFirstTurn: SHRINK_FIRST_TURN,
        shrinkEvery: SHRINK_EVERY
      },
      online: connections.size
    });
  },

  name(conn, msg) {
    if (!conn.profile) return;
    const name = cleanName(msg.name);
    if (!name) return fail(conn, "Names are 2 to 16 letters, numbers, spaces or dashes.");

    conn.profile.name = name;
    store.putProfile(conn.token, conn.profile);
    send(conn, "profile", { profile: privateView(conn.profile) });
  },

  queue(conn, msg) {
    if (conn.matchId) return fail(conn, "You are already in a match.");
    joinQueue(conn, msg.mode === "roles" ? "roles" : "classic");
  },

  unqueue(conn) {
    leaveQueue(conn);
    send(conn, "unqueued", {});
  },

  bot(conn, msg) {
    if (conn.matchId) return fail(conn, "You are already in a match.");
    leaveQueue(conn);

    const difficulty = ["easy", "normal", "hard"].includes(msg.difficulty)
      ? msg.difficulty
      : "normal";
    const mode = msg.mode === "roles" ? "roles" : "classic";

    /* The human takes blue half the time, so practice covers both seats. */
    const seats = Math.random() < 0.5
      ? [seatFor(conn), botSeat(difficulty)]
      : [botSeat(difficulty), seatFor(conn)];

    startMatch(mode, seats[0], seats[1], false);
  },

  create(conn, msg) {
    if (conn.matchId) return fail(conn, "You are already in a match.");
    leaveQueue(conn);

    if (conn.roomCode) rooms.delete(conn.roomCode);

    const code = makeCode();
    rooms.set(code, {
      code,
      mode: msg.mode === "roles" ? "roles" : "classic",
      hostId: conn.id
    });
    conn.roomCode = code;

    send(conn, "room", { code, mode: rooms.get(code).mode });
  },

  join(conn, msg) {
    if (conn.matchId) return fail(conn, "You are already in a match.");

    const code = String(msg.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const room = rooms.get(code);
    if (!room) return fail(conn, "No room with that code.");
    if (room.hostId === conn.id) return fail(conn, "That is your own room.");

    const host = connections.get(room.hostId);
    if (!host || host.matchId) {
      rooms.delete(code);
      return fail(conn, "That room is no longer open.");
    }

    rooms.delete(code);
    host.roomCode = null;
    leaveQueue(conn);

    const seats = Math.random() < 0.5
      ? [seatFor(host), seatFor(conn)]
      : [seatFor(conn), seatFor(host)];

    startMatch(room.mode, seats[0], seats[1]);
  },

  cancelRoom(conn) {
    if (conn.roomCode) {
      rooms.delete(conn.roomCode);
      conn.roomCode = null;
    }
    send(conn, "roomClosed", {});
  },

  action(conn, msg) {
    const match = matches.get(conn.matchId);
    if (!match) return fail(conn, "You are not in a match.");

    const result = match.submit(conn.id, msg.action);
    if (!result.ok) {
      /* Say why, then re-send the truth so the board cannot drift. */
      fail(conn, result.reason);
      const seat = match.seatOf(conn.id);
      if (seat) send(conn, "match", { view: match.view(seat) });
    }
  },

  rematch(conn) {
    const match = matches.get(conn.matchId);
    if (!match || !match.finished) return fail(conn, "Nothing to rematch yet.");

    if (match.vsBot) {
      const human = match.seatOf(conn.id);
      const bot = match.seats[human === "blue" ? "red" : "blue"];
      conn.matchId = null;
      startMatch(match.mode, botSeat(bot.difficulty), seatFor(conn), false);
      return;
    }

    if (!rematchWanted.has(match.id)) rematchWanted.set(match.id, new Set());
    const wanted = rematchWanted.get(match.id);
    wanted.add(conn.id);

    const others = connectionsInMatch(match).filter(c => c.id !== conn.id);
    if (!others.length) return fail(conn, "Your opponent has left.");

    if (others.every(c => wanted.has(c.id))) {
      /* Colours swap so the first-move seat alternates. */
      const blue = match.seats.blue;
      const red = match.seats.red;
      for (const c of connectionsInMatch(match)) c.matchId = null;
      rematchWanted.delete(match.id);
      startMatch(match.mode, refreshSeat(red), refreshSeat(blue));
    } else {
      for (const c of others) send(c, "toast", { message: "Opponent wants a rematch." });
      send(conn, "toast", { message: "Waiting for your opponent..." });
    }
  },

  leave(conn) {
    exitMatch(conn, "Opponent left the match.");
    send(conn, "home", {});
  },

  resign(conn) {
    const match = matches.get(conn.matchId);
    if (!match || match.finished) return fail(conn, "No match to resign.");

    const result = match.submit(conn.id, { type: "resign" });
    if (!result.ok) fail(conn, result.reason);
  },

  shop(conn) {
    if (!conn.profile) return;
    send(conn, "shop", {
      items: shopFor(conn.profile),
      profile: privateView(conn.profile)
    });
  },

  buy(conn, msg) {
    if (!conn.profile) return;
    const result = buy(conn.profile, msg.itemId);
    if (!result.ok) return fail(conn, result.reason);

    store.putProfile(conn.token, conn.profile);
    send(conn, "profile", { profile: privateView(conn.profile) });
    send(conn, "toast", { message: result.item.name + " unlocked." });
  },

  equip(conn, msg) {
    if (!conn.profile) return;
    const result = equip(conn.profile, msg.slot, msg.itemId);
    if (!result.ok) return fail(conn, result.reason);

    store.putProfile(conn.token, conn.profile);
    send(conn, "profile", { profile: privateView(conn.profile) });
  },

  puzzle(conn) {
    if (!conn.profile) return;
    const def = puzzleForToday();
    ensureDaily(conn.profile);
    send(conn, "puzzle", {
      puzzle: shippablePuzzle(def),
      solved: conn.profile.daily.puzzleSolved
    });
  },

  puzzleSubmit(conn, msg) {
    if (!conn.profile) return;

    const def = puzzleForToday();
    const check = verifySolution(def, Array.isArray(msg.actions) ? msg.actions : []);

    if (!check.solved) {
      return send(conn, "puzzleResult", { solved: false, reason: check.reason });
    }

    const reward = applyPuzzleSolved(conn.profile);
    store.putProfile(conn.token, conn.profile);

    send(conn, "puzzleResult", {
      solved: true,
      already: reward.already,
      rewards: reward.log,
      profile: privateView(conn.profile)
    });
  },

  leaderboard(conn) {
    send(conn, "leaderboard", { rows: store.leaderboard() });
  },

  ping(conn) {
    send(conn, "pong", { online: connections.size });
  }
};

function refreshSeat(seat) {
  if (!seat || seat.kind !== "human") return seat;
  const conn = connections.get(seat.id);
  return conn ? seatFor(conn) : seat;
}

function exitMatch(conn, message) {
  const match = matches.get(conn.matchId);
  conn.matchId = null;
  if (!match) return;

  if (!match.finished) {
    const seat = match.seatOf(conn.id);
    if (seat) {
      match.end(seat === "blue" ? "red" : "blue", message);
    }
  }

  for (const other of connectionsInMatch(match)) {
    if (other.id !== conn.id) send(other, "toast", { message });
  }
}

/* ------------------------------------------------------------ connections */

wss.on("connection", socket => {
  const conn = {
    id: "c" + (++connectionCounter),
    socket,
    token: null,
    profile: null,
    matchId: null,
    queuedMode: null,
    roomCode: null
  };
  connections.set(conn.id, conn);

  socket.on("message", raw => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (error) {
      return fail(conn, "Bad message.");
    }

    const handler = handlers[msg && msg.type];
    if (!handler) return;

    try {
      handler(conn, msg);
    } catch (error) {
      console.error("[handler " + msg.type + "]", error);
      fail(conn, "Something went wrong on the server.");
    }
  });

  socket.on("close", () => {
    leaveQueue(conn);
    if (conn.roomCode) rooms.delete(conn.roomCode);
    exitMatch(conn, "Opponent disconnected.");
    connections.delete(conn.id);
  });

  socket.on("error", () => { /* close will follow */ });
});

/* ------------------------------------------------------------------ boot */

httpServer.listen(PORT, () => {
  console.log("PUSHLINE listening on http://localhost:" + PORT);
  console.log("  data: " + DATA_FILE);

  /* Warm today's puzzle off the critical path -- generating one takes a
   * couple of seconds and nobody should wait for it mid-request. */
  setTimeout(() => {
    try {
      puzzleForToday();
    } catch (error) {
      console.error("[puzzle] warm failed:", error.message);
    }
  }, 50).unref?.();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log("\nsaving...");
    store.flush();
    process.exit(0);
  });
}
