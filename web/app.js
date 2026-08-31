/* PUSHLINE client.
 *
 * The server owns the board. This file renders what it is told and sends
 * intents back. It imports the same rules module the server runs, but only
 * ever to decide what to highlight -- never to decide what is legal.
 */

import {
  SIZE, AP_PER_TURN, WIN_KILLS, SHRINK_FIRST_TURN, SHRINK_EVERY,
  legalActions, findPiece, isHole, delta, inside, ROLE, nextShrinkTurn
} from "./shared/rules.js";

import { puzzleState, puzzleApply } from "./shared/puzzle.js";
import { itemById } from "./shared/catalog.js";

const $ = id => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/* ------------------------------------------------------------------ state */

const app = {
  socket: null,
  connected: false,
  token: localStorage.getItem("pushline.token") || "",
  profile: null,
  catalog: [],
  slots: [],
  slotLabels: {},
  featured: [],
  maps: [],
  mode: localStorage.getItem("pushline.mode") || "classic",
  view: null,         /* current match view from the server */
  selected: null,     /* selected piece id */
  slamArmed: false,
  screen: "home",
  shopSlot: "skin",
  puzzle: null,       /* { def, state, actions, solved } */
  clockTimer: null,
  reconnectDelay: 800
};

/* ------------------------------------------------------------- connection */

/**
 * Where the game server lives.
 *
 * Same origin by default, which is what happens when the Node server is
 * serving this page itself. When the client is hosted somewhere static --
 * GitHub Pages, a CDN -- point it at the server with the meta tag in
 * index.html, or set window.PUSHLINE_SERVER before this script runs.
 *
 * A page served over https can only open a wss:// socket, so a remote
 * server has to have TLS. Browsers block the mixed-content case outright.
 */
export function serverUrl() {
  const meta = document.querySelector('meta[name="pushline-server"]');
  const configured = (window.PUSHLINE_SERVER || (meta && meta.content) || "").trim();

  if (configured) {
    return configured.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/+$/, "");
  }

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return protocol + "//" + location.host;
}

function connect() {
  const socket = new WebSocket(serverUrl());
  app.socket = socket;

  socket.onopen = () => {
    app.connected = true;
    app.reconnectDelay = 800;
    $("connDot").className = "conn good";
    $("connDot").title = "Connected";
    send("hello", { token: app.token });
  };

  socket.onmessage = event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (_) { return; }
    const handler = handlers[msg.type];
    if (handler) handler(msg);
  };

  socket.onclose = () => {
    app.connected = false;
    $("connDot").className = "conn bad";
    $("connDot").title = "Reconnecting";
    setTimeout(connect, app.reconnectDelay);
    app.reconnectDelay = Math.min(8000, app.reconnectDelay * 1.7);
  };

  socket.onerror = () => { /* close follows */ };
}

function send(type, payload = {}) {
  if (!app.socket || app.socket.readyState !== WebSocket.OPEN) {
    return toast("Not connected yet.");
  }
  app.socket.send(JSON.stringify({ type, ...payload }));
}

/* ---------------------------------------------------------------- screens */

function show(name) {
  app.screen = name;
  for (const section of document.querySelectorAll(".screen")) {
    section.classList.toggle("active", section.id === "screen-" + name);
  }
}

let toastTimer = null;
function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 2200);
}

/* -------------------------------------------------------------- cosmetics */

function loadoutOf(side) {
  const source = side === "me"
    ? (app.profile && app.profile.loadout)
    : (app.view && app.view.opponent && app.view.opponent.loadout);
  return source || {};
}

function applyTheme() {
  const board = (app.profile && app.profile.loadout && app.profile.loadout.board)
    || "board.neon";
  document.body.dataset.board = board;

  const skin = (app.profile && app.profile.loadout && app.profile.loadout.skin)
    || "skin.orb";
  const fx = (app.profile && app.profile.loadout && app.profile.loadout.destroyFx)
    || "fx.shatter";

  document.body.className = "skin-" + skin.split(".")[1] + " fx-" + fx.split(".")[1];
}

function titleOf(view) {
  if (!view || !view.loadout) return "";
  const item = itemById(view.loadout.title);
  return item && item.id !== "title.none" ? item.name : "";
}

/* ------------------------------------------------------------------ board */

const ROLE_MARK = {
  [ROLE.RUNNER]: "R",
  [ROLE.BRUISER]: "B",
  [ROLE.ANCHOR]: "A"
};

/**
 * Render a rules state into a grid element.
 * `options.interactive` decides whether cells respond to clicks.
 */
function renderBoard(host, state, options = {}) {
  const { you = null, onCell = null, selected = null, live = false } = options;

  host.innerHTML = "";
  if (!state || !state.board) return;

  /* Work out what the selected piece could do, straight from the rules. */
  const hints = { reach: new Set(), push: new Set(), dash: new Set() };

  if (selected && live) {
    const source = findPiece(state, selected);
    if (source) {
      for (const action of legalActions(state)) {
        if (action.pieceId !== selected) continue;
        const d = delta(action.dir);
        if (!d) continue;

        if (action.type === "dash") {
          hints.dash.add(key(source.r + d[0] * 2, source.c + d[1] * 2));
        } else if (action.type === "move" || action.type === "slam") {
          const tr = source.r + d[0];
          const tc = source.c + d[1];
          if (state.board[tr] && state.board[tr][tc]) hints.push.add(key(tr, tc));
          else hints.reach.add(key(tr, tc));
        }
      }
    }
  }

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cell = el("div", "cell");
      const at = key(r, c);

      if (isHole(state, r, c)) cell.classList.add("hole");
      if (hints.reach.has(at) || hints.dash.has(at)) cell.classList.add("reachable");
      if (hints.push.has(at)) cell.classList.add("pushable");

      const piece = state.board[r][c];
      if (piece) {
        if (piece.id === selected) cell.classList.add("selected");

        const visual = el("div", "piece " + piece.color);
        if (piece.id === selected) visual.classList.add("sel");

        if (state.mode === "roles" && ROLE_MARK[piece.role]) {
          visual.appendChild(el("span", "role", ROLE_MARK[piece.role]));
        }
        cell.appendChild(visual);
      }

      if (onCell) cell.onclick = () => onCell(r, c);
      host.appendChild(cell);
    }
  }
}

const key = (r, c) => r + "," + c;

/* ------------------------------------------------------------------- game */

function renderMatch() {
  const view = app.view;
  if (!view) return;

  const state = view.state;

  if (state.phase === "ban") {
    renderBan(view);
    show("ban");
    return;
  }

  show("game");

  renderBoard($("board"), state, {
    you: view.you,
    selected: app.selected,
    live: view.yourTurn,
    onCell: onBoardClick
  });

  renderStrip($("stripTop"), view, otherColor(view.you));
  renderStrip($("stripBottom"), view, view.you);

  const yours = view.yourTurn;
  $("turnLabel").textContent = view.state.phase === "finished"
    ? "GAME OVER"
    : yours ? "YOUR TURN" : "OPPONENT";

  const pips = $("apPips");
  pips.innerHTML = "";
  for (let i = 0; i < AP_PER_TURN; i++) {
    const pip = el("i");
    if (yours && i < state.ap) pip.classList.add("on");
    pips.appendChild(pip);
  }

  $("turnHint").textContent = hintFor(view);
  const map = app.maps.find(m => m.id === state.mapId);
  $("mapLine").textContent = (map ? map.name : "—") +
    " · turn " + state.turn + " · " + (state.mode === "roles" ? "Roles" : "Classic");

  const due = nextShrinkTurn(state);
  $("shrinkInfo").innerHTML = due === null
    ? "The board is as small as it gets."
    : "Ring " + (state.ring + 1) + " falls on <b>turn " + due + "</b>" +
      (state.turn >= due - 3 ? " — move." : ".");

  const swapAvailable = state.pieRule && state.pieRule.available &&
    view.yourTurn && state.current === "red";
  $("btnSwap").hidden = !swapAvailable;

  updateControls();
}

function otherColor(color) {
  return color === "blue" ? "red" : "blue";
}

function renderStrip(host, view, color) {
  host.innerHTML = "";

  const isMe = color === view.you;
  const who = isMe ? view.me : view.opponent;
  const state = view.state;

  const pill = el("div", "pill" + (state.current === color && state.phase === "playing" ? " turn" : ""));

  const dot = el("span", "dotc");
  dot.style.background = color === "blue" ? "var(--blue)" : "var(--red)";
  pill.appendChild(dot);

  pill.appendChild(el("span", "nm", (who && who.name) || (isMe ? "You" : "Opponent")));

  const title = titleOf(who);
  if (title) pill.appendChild(el("span", "ttl", title));

  host.appendChild(pill);

  /* Pieces this side has lost, out of the three that end it. */
  const kills = el("div", "kills");
  for (let i = 0; i < WIN_KILLS; i++) {
    const mark = el("i");
    if (i < state.destroyed[color]) mark.classList.add("on");
    kills.appendChild(mark);
  }
  host.appendChild(kills);

  const clock = el("div", "clock", formatClock(view.clock[color]));
  if (view.clock[color] < 30000) clock.classList.add("low");
  host.appendChild(clock);
}

function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes + ":" + String(seconds).padStart(2, "0");
}

function hintFor(view) {
  const state = view.state;
  if (state.phase === "finished") return state.endReason || "";
  if (!view.yourTurn) return "Waiting for your opponent.";
  if (app.slamArmed) return "SLAM armed — pick a direction.";
  if (!app.selected) return "Select one of your pieces.";
  return "Move, or click an enemy to shove it. " + state.ap + " left.";
}

function updateControls() {
  const view = app.view;
  const state = view && view.state;
  const active = Boolean(view && view.yourTurn && state.phase === "playing");

  const options = active ? legalActions(state) : [];
  const forPiece = options.filter(a => a.pieceId === app.selected);

  for (const button of document.querySelectorAll("#screen-game .dir[data-dir]")) {
    const dir = button.dataset.dir;
    if (dir === "end") {
      button.disabled = !active || !options.some(a => a.type === "end");
      continue;
    }
    button.disabled = !active || !app.selected ||
      !forPiece.some(a => a.dir === dir && (app.slamArmed ? a.type === "slam" : a.type !== "slam"));
  }

  const canSlam = active && app.selected && forPiece.some(a => a.type === "slam");
  const slamButton = $("btnSlam");
  if (!canSlam) app.slamArmed = false;
  slamButton.disabled = !canSlam;
  slamButton.classList.toggle("armed", app.slamArmed);
  slamButton.textContent = app.slamArmed ? "⚡ SLAM ARMED" : "⚡ SLAM";

  $("slamNote").textContent = state && state.slamUsed && state.slamUsed[view.you]
    ? "Already used this game."
    : "Two squares. Costs both points. Once per game.";
}

function onBoardClick(r, c) {
  const view = app.view;
  if (!view || !view.yourTurn || view.state.phase !== "playing") {
    return toast("Not your turn.");
  }

  const state = view.state;
  const piece = state.board[r][c];

  /* Your own piece: select it. */
  if (piece && piece.color === view.you) {
    app.selected = piece.id;
    renderMatch();
    return;
  }

  if (!app.selected) return;

  const source = findPiece(state, app.selected);
  if (!source) { app.selected = null; renderMatch(); return; }

  const dr = r - source.r;
  const dc = c - source.c;
  const dir = directionOf(dr, dc);

  if (!dir) { app.selected = null; renderMatch(); return; }

  const distance = Math.abs(dr) + Math.abs(dc);

  if (distance === 1) {
    play(app.slamArmed ? "slam" : "move", dir);
  } else if (distance === 2 && (dr === 0 || dc === 0)) {
    play("dash", dir);
  }
}

function directionOf(dr, dc) {
  if (dr !== 0 && dc !== 0) return null;
  if (dr < 0) return "up";
  if (dr > 0) return "down";
  if (dc < 0) return "left";
  if (dc > 0) return "right";
  return null;
}

/** Send an action, trying the sensible fallback for a plain direction press. */
function play(type, dir) {
  const view = app.view;
  if (!view || !view.yourTurn) return toast("Not your turn.");
  if (!app.selected) return toast("Select a piece first.");

  const options = legalActions(view.state)
    .filter(a => a.pieceId === app.selected && a.dir === dir);

  let chosen = options.find(a => a.type === type);

  /* A direction press should just do the obvious thing: step if you can,
   * dash if that is the only way that piece moves. */
  if (!chosen && type === "move") chosen = options.find(a => a.type === "dash");

  if (!chosen) {
    return toast(app.slamArmed ? "No slam that way." : "You cannot go that way.");
  }

  app.slamArmed = false;
  send("action", { action: chosen });
}

/* -------------------------------------------------------------------- ban */

function renderBan(view) {
  const state = view.state;
  const mineIsNext = (state.bans.blue === null ? "blue" : "red") === view.you;

  $("banTitle").textContent = mineIsNext ? "Ban one map" : "Opponent is banning";
  $("banNote").textContent = mineIsNext
    ? "Both players ban one. The board is drawn from what is left."
    : "Yours is in. Waiting for theirs.";

  const grid = $("mapGrid");
  grid.innerHTML = "";

  for (const id of state.pool) {
    const map = app.maps.find(m => m.id === id);
    if (!map) continue;

    const banned = state.bans.blue === id || state.bans.red === id;
    const card = el("div", "mapCard" + (banned ? " banned" : ""));

    const mini = el("div", "mapMini");
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const square = el("i");
        if (map.holes.some(h => h[0] === r && h[1] === c)) square.classList.add("h");
        mini.appendChild(square);
      }
    }

    card.appendChild(mini);
    card.appendChild(el("div", "mapName", banned ? "BANNED" : map.name));

    if (!banned && mineIsNext) {
      card.onclick = () => send("action", { action: { type: "ban", mapId: id } });
    }
    grid.appendChild(card);
  }
}

/* ----------------------------------------------------------------- puzzle */

function startPuzzle(def, alreadySolved) {
  app.puzzle = {
    def,
    state: puzzleState(def),
    actions: [],
    selected: null,
    slamArmed: false,
    solved: Boolean(alreadySolved),
    submitted: false
  };
  show("puzzle");
  renderPuzzle();
}

function renderPuzzle() {
  const puzzle = app.puzzle;
  if (!puzzle) return;

  renderBoard($("puzzleBoard"), puzzle.state, {
    selected: puzzle.selected,
    live: true,
    onCell: onPuzzleClick
  });

  const goal = puzzle.def.goal;
  $("puzzleGoal").textContent =
    "Destroy " + goal.kills + " in " + goal.actions + " moves";
  $("puzzleUsed").textContent =
    "Used " + puzzle.actions.length + " · destroyed " + puzzle.state.destroyed.red;

  const done = puzzle.state.destroyed.red >= goal.kills;
  const spent = puzzle.actions.length >= goal.actions;

  $("puzzleFeedback").textContent = puzzle.solved
    ? "Solved. Come back tomorrow."
    : done ? "Solved — checking with the server..."
    : spent ? "Out of moves. Reset and try another line."
    : "Red never moves. Find the line.";

  const slamButton = $("btnPuzzleSlam");
  slamButton.classList.toggle("armed", puzzle.slamArmed);
  slamButton.textContent = puzzle.slamArmed ? "⚡ SLAM ARMED" : "⚡ SLAM";

  if (done && !puzzle.submitted) {
    puzzle.submitted = true;
    send("puzzleSubmit", { actions: puzzle.actions });
  }
}

function onPuzzleClick(r, c) {
  const puzzle = app.puzzle;
  if (!puzzle || puzzle.solved) return;

  const piece = puzzle.state.board[r][c];
  if (piece && piece.color === "blue") {
    puzzle.selected = piece.id;
    return renderPuzzle();
  }
  if (!puzzle.selected) return;

  const source = findPiece(puzzle.state, puzzle.selected);
  if (!source) { puzzle.selected = null; return renderPuzzle(); }

  const dr = r - source.r;
  const dc = c - source.c;
  const dir = directionOf(dr, dc);
  if (!dir) { puzzle.selected = null; return renderPuzzle(); }

  const distance = Math.abs(dr) + Math.abs(dc);
  if (distance === 1) puzzlePlay(puzzle.slamArmed ? "slam" : "move", dir);
  else if (distance === 2) puzzlePlay("dash", dir);
}

function puzzlePlay(type, dir) {
  const puzzle = app.puzzle;
  if (!puzzle || !puzzle.selected || puzzle.solved) return;
  if (puzzle.actions.length >= puzzle.def.goal.actions) {
    return toast("Out of moves — reset to try again.");
  }

  const options = legalActions(puzzle.state)
    .filter(a => a.pieceId === puzzle.selected && a.dir === dir);

  let chosen = options.find(a => a.type === type);
  if (!chosen && type === "move") chosen = options.find(a => a.type === "dash");
  if (!chosen) return toast("You cannot go that way.");

  const result = puzzleApply(puzzle.state, chosen);
  if (!result.ok) return toast(result.reason);

  puzzle.state = result.state;
  puzzle.actions.push(chosen);
  puzzle.slamArmed = false;
  renderPuzzle();
}

/* ------------------------------------------------------------------- shop */

function renderShop(items) {
  const tabs = $("shopTabs");
  tabs.innerHTML = "";

  for (const slot of app.slots) {
    const tab = el("button", "tab" + (slot === app.shopSlot ? " active" : ""),
      (app.slotLabels[slot] || slot).toUpperCase());
    tab.onclick = () => { app.shopSlot = slot; renderShop(items); };
    tabs.appendChild(tab);
  }

  const grid = $("itemGrid");
  grid.innerHTML = "";

  for (const item of items.filter(i => i.slot === app.shopSlot)) {
    const card = el("div", "item" + (item.featured ? " featured" : ""));

    if (item.featured) card.appendChild(el("div", "tagline", "FEATURED THIS WEEK"));
    card.appendChild(el("div", "nm", item.name));
    card.appendChild(previewFor(item));
    card.appendChild(el("div", "bl", item.blurb || ""));

    const equipped = app.profile && app.profile.loadout[item.slot] === item.id;

    if (!item.owned) {
      const price = el("div", "price", "⚡ " + item.price);
      card.appendChild(price);
      const buy = el("button", "btn wide", "UNLOCK");
      buy.disabled = !app.profile || app.profile.bolts < item.price;
      buy.onclick = () => send("buy", { itemId: item.id });
      card.appendChild(buy);
    } else if (equipped) {
      card.appendChild(el("div", "owned", "EQUIPPED"));
    } else {
      const use = el("button", "btn wide", "EQUIP");
      use.onclick = () => send("equip", { slot: item.slot, itemId: item.id });
      card.appendChild(use);
    }

    grid.appendChild(card);
  }
}

function previewFor(item) {
  const box = el("div", "preview");

  if (item.slot === "skin") {
    const wrap = el("div", "skin-" + item.id.split(".")[1]);
    wrap.style.display = "flex";
    wrap.style.gap = "9px";
    const blue = el("div", "piece blue");
    const red = el("div", "piece red");
    blue.style.width = red.style.width = "34px";
    blue.style.height = red.style.height = "34px";
    wrap.append(blue, red);
    box.appendChild(wrap);
  } else if (item.slot === "board") {
    const probe = document.createElement("div");
    probe.dataset.board = item.id;
    probe.style.display = "none";
    document.body.appendChild(probe);
    for (const token of ["--cell", "--hole", "--blue", "--red"]) {
      const swatch = el("div", "swatch");
      swatch.style.background = getComputedStyle(probe).getPropertyValue(token) || "#333";
      box.appendChild(swatch);
    }
    probe.remove();
  } else {
    box.appendChild(el("div", "small", item.name));
  }

  return box;
}

/* ------------------------------------------------------------------- home */

function renderHome() {
  const profile = app.profile;
  if (!profile) return;

  $("wallet").hidden = false;
  $("who").hidden = false;
  $("walletBolts").textContent = profile.bolts;
  $("whoName").textContent = profile.name;
  $("whoLevel").textContent = "LV " + profile.level;

  if (document.activeElement !== $("nameInput")) $("nameInput").value = profile.name;

  $("homeStats").innerHTML =
    "<span><b>" + profile.wins + "</b> wins</span>" +
    "<span><b>" + profile.losses + "</b> losses</span>" +
    "<span><b>" + profile.draws + "</b> draws</span>" +
    "<span><b>" + profile.streak + "</b> streak</span>";

  const pct = profile.levelNeed
    ? Math.min(100, Math.round((profile.levelInto / profile.levelNeed) * 100))
    : 0;
  $("xpFill").style.width = pct + "%";
  $("xpText").textContent =
    "Level " + profile.level + " · " + profile.levelInto + " / " + profile.levelNeed + " XP";

  const quests = $("questList");
  quests.innerHTML = "";
  const daily = profile.daily;

  if (daily) {
    for (const quest of daily.quests) {
      const row = el("div", "quest" + (quest.claimed ? " done" : ""));
      const top = el("div", "questTop");
      top.appendChild(el("span", null, quest.text));
      top.appendChild(el("span", null, (quest.claimed ? "✓ " : "") + "⚡" + quest.reward));
      row.appendChild(top);

      const bar = el("div", "questBar");
      const fill = el("i");
      fill.style.width = Math.round((quest.progress / quest.goal) * 100) + "%";
      bar.appendChild(fill);
      row.appendChild(bar);
      quests.appendChild(row);
    }

    $("puzzleState").textContent = daily.puzzleSolved
      ? "Solved today"
      : "One position, one par";
  }

  for (const button of document.querySelectorAll("#modePick .mode")) {
    button.classList.toggle("active", button.dataset.mode === app.mode);
  }

  applyTheme();
}

function renderLeaderboard(rows) {
  const list = $("leaderList");
  list.innerHTML = "";

  if (!rows || !rows.length) {
    list.appendChild(el("li", null, "Nobody has played yet."));
    return;
  }

  for (const row of rows) {
    const item = el("li");
    item.appendChild(el("b", null, row.name));
    const title = itemById(row.title);
    if (title && title.id !== "title.none") {
      item.append(" ", el("span", "t", title.name));
    }
    item.append(" — " + row.wins + "W");
    list.appendChild(item);
  }
}

/* --------------------------------------------------------------- messages */

const handlers = {
  welcome(msg) {
    app.token = msg.token;
    localStorage.setItem("pushline.token", msg.token);
    app.profile = msg.profile;
    app.catalog = msg.catalog;
    app.slots = msg.slots;
    app.slotLabels = msg.slotLabels;
    app.featured = msg.featured;
    app.maps = msg.maps;

    renderHome();
    renderLeaderboard(msg.leaderboard);
    if (app.screen === "home") show("home");
  },

  profile(msg) {
    app.profile = msg.profile;
    renderHome();
    if (app.screen === "shop") send("shop");
  },

  shop(msg) {
    app.profile = msg.profile;
    renderShop(msg.items);
    show("shop");
  },

  queued(msg) {
    $("waitEyebrow").textContent = "SEARCHING";
    $("roomCode").textContent = "· · ·";
    $("waitNote").textContent = "Looking for an opponent. Practice against the bot if nobody shows.";
    $("btnCopy").hidden = true;
    show("wait");
  },

  unqueued() { show("home"); },

  room(msg) {
    $("waitEyebrow").textContent = "ROOM CODE";
    $("roomCode").textContent = msg.code;
    $("waitNote").textContent = "Send this to whoever you want to play.";
    $("btnCopy").hidden = false;
    $("btnCopy").dataset.code = msg.code;
    show("wait");
  },

  roomClosed() { show("home"); },

  match(msg) {
    const previous = app.view;
    app.view = msg.view;

    /* A fresh match, or the board changed under us: drop the selection. */
    if (!previous || previous.matchId !== msg.view.matchId) {
      app.selected = null;
      app.slamArmed = false;
      $("resultOverlay").classList.remove("show");
    }
    if (previous && previous.state && previous.state.current !== msg.view.state.current) {
      app.selected = null;
      app.slamArmed = false;
    }

    renderMatch();
    startClockTicker();
  },

  over(msg) {
    app.view = msg.view;
    if (msg.profile) { app.profile = msg.profile; renderHome(); }

    renderMatch();
    stopClockTicker();

    const summary = msg.summary;
    const won = summary.result === "win";
    const drew = summary.result === "draw";

    $("resultIcon").textContent = won ? "◆" : drew ? "=" : "×";
    $("resultTitle").textContent = won ? "YOU WIN" : drew ? "DRAW" : "YOU LOSE";
    $("resultReason").textContent = summary.reason || "";

    const list = $("rewardList");
    list.innerHTML = "";
    for (const entry of msg.rewards || []) {
      const row = el("div", "reward");
      row.appendChild(el("span", null, entry.text));
      row.appendChild(el("b", null, "⚡" + entry.bolts));
      list.appendChild(row);
    }

    $("btnRematch").disabled = false;
    $("btnRematch").textContent = "REMATCH";
    $("resultOverlay").classList.add("show");
  },

  puzzle(msg) { startPuzzle(msg.puzzle, msg.solved); },

  puzzleResult(msg) {
    const puzzle = app.puzzle;
    if (!puzzle) return;

    if (!msg.solved) {
      puzzle.submitted = false;
      $("puzzleFeedback").textContent = msg.reason || "Not solved.";
      return;
    }

    puzzle.solved = true;
    if (msg.profile) { app.profile = msg.profile; renderHome(); }

    $("puzzleFeedback").textContent = msg.already
      ? "Solved — you already claimed today's Bolts."
      : "Solved. Bolts added.";
    toast(msg.already ? "Already solved today." : "Puzzle solved.");
  },

  leaderboard(msg) { renderLeaderboard(msg.rows); },

  home() {
    app.view = null;
    stopClockTicker();
    $("resultOverlay").classList.remove("show");
    show("home");
  },

  toast(msg) { toast(msg.message); }
};

/* ----------------------------------------------------------- clock ticker */

function startClockTicker() {
  stopClockTicker();
  app.clockTimer = setInterval(() => {
    const view = app.view;
    if (!view || view.state.phase !== "playing") return;

    const ticking = view.state.current;
    view.clock[ticking] = Math.max(0, view.clock[ticking] - 250);

    if (app.screen === "game") {
      renderStrip($("stripTop"), view, otherColor(view.you));
      renderStrip($("stripBottom"), view, view.you);
    }
  }, 250);
}

function stopClockTicker() {
  if (app.clockTimer) clearInterval(app.clockTimer);
  app.clockTimer = null;
}

/* ------------------------------------------------------------------ wiring */

$("btnQuick").onclick = () => send("queue", { mode: app.mode });
$("btnBot").onclick = () =>
  send("bot", { mode: app.mode, difficulty: $("botLevel").value });
$("btnCreate").onclick = () => send("create", { mode: app.mode });
$("btnPuzzle").onclick = () => send("puzzle");

$("btnJoin").onclick = () => {
  const code = $("roomInput").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 6) return toast("Room codes are six characters.");
  send("join", { code });
};

$("roomInput").oninput = event => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
};
$("roomInput").onkeydown = event => { if (event.key === "Enter") $("btnJoin").click(); };

$("btnName").onclick = () => send("name", { name: $("nameInput").value });
$("nameInput").onkeydown = event => { if (event.key === "Enter") $("btnName").click(); };

for (const button of document.querySelectorAll("#modePick .mode")) {
  button.onclick = () => {
    app.mode = button.dataset.mode;
    localStorage.setItem("pushline.mode", app.mode);
    renderHome();
  };
}

$("btnCancelWait").onclick = () => {
  send("unqueue");
  send("cancelRoom");
  show("home");
};

$("btnCopy").onclick = async () => {
  const code = $("btnCopy").dataset.code || "";
  try {
    await navigator.clipboard.writeText(code);
    toast("Copied " + code);
  } catch (_) {
    toast("Room code: " + code);
  }
};

for (const button of document.querySelectorAll("#screen-game .dir[data-dir]")) {
  button.onclick = () => {
    const dir = button.dataset.dir;
    if (dir === "end") return send("action", { action: { type: "end" } });
    play(app.slamArmed ? "slam" : "move", dir);
  };
}

$("btnSlam").onclick = () => {
  app.slamArmed = !app.slamArmed;
  updateControls();
  renderMatch();
};

$("btnSwap").onclick = () => send("action", { action: { type: "swap" } });

$("btnResign").onclick = () => {
  if (confirm("Resign this match?")) send("resign");
};

$("btnRematch").onclick = () => {
  $("btnRematch").disabled = true;
  $("btnRematch").textContent = "WAITING...";
  send("rematch");
};

$("btnHome").onclick = () => {
  $("resultOverlay").classList.remove("show");
  send("leave");
};

$("navShop").onclick = () => send("shop");
$("navLocker").onclick = () => { app.shopSlot = "skin"; send("shop"); };
$("btnShopHome").onclick = () => show("home");

for (const button of document.querySelectorAll("#screen-puzzle .dir.pz")) {
  button.onclick = () =>
    puzzlePlay(app.puzzle && app.puzzle.slamArmed ? "slam" : "move", button.dataset.dir);
}

$("btnPuzzleSlam").onclick = () => {
  if (!app.puzzle) return;
  app.puzzle.slamArmed = !app.puzzle.slamArmed;
  renderPuzzle();
};

$("btnPuzzleReset").onclick = () => {
  if (app.puzzle) startPuzzle(app.puzzle.def, app.puzzle.solved);
};

$("btnPuzzleHome").onclick = () => { app.puzzle = null; show("home"); };

/* Keyboard, but only while a board is on screen and no field has focus. */
document.addEventListener("keydown", event => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

  const KEYS = {
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
    w: "up", a: "left", s: "down", d: "right",
    W: "up", A: "left", S: "down", D: "right"
  };

  if (app.screen === "game") {
    if (event.key === "e" || event.key === "E") { $("btnSlam").click(); return; }
    if (event.key === " ") { event.preventDefault(); $("btnEndTurn").click(); return; }
    if (KEYS[event.key]) {
      event.preventDefault();
      play(app.slamArmed ? "slam" : "move", KEYS[event.key]);
    }
    return;
  }

  if (app.screen === "puzzle") {
    if (event.key === "e" || event.key === "E") { $("btnPuzzleSlam").click(); return; }
    if (KEYS[event.key]) {
      event.preventDefault();
      puzzlePlay(app.puzzle && app.puzzle.slamArmed ? "slam" : "move", KEYS[event.key]);
    }
  }
});

setInterval(() => { if (app.connected) send("ping"); }, 25000);

applyTheme();
show("home");
connect();
