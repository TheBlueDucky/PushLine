/* Bolts, levels, quests and the shop.
 *
 * Everything here runs on the server and only ever reacts to matches the
 * server itself simulated. The client cannot add a Bolt, and nothing that
 * can be bought changes a rule.
 */

import {
  ITEMS, DEFAULT_LOADOUT, SLOTS, itemById, freeItemIds,
  weeklyRotation, weekNumber, dayNumber
} from "../shared/catalog.js";

export const REWARDS = {
  win: 25,
  loss: 8,
  draw: 12,
  firstWinOfDay: 50,
  puzzle: 40,
  botWin: 10,      /* less than a real opponent, so farming the bot is dull */
  botLoss: 4,
  botDraw: 5
};

export const XP = {
  win: 60,
  loss: 25,
  draw: 35,
  puzzle: 30
};

/* Quests are picked from here, three a day, deterministically. */
export const QUEST_TYPES = [
  { id: "win2",     goal: 2, reward: 60, text: "Win 2 matches" },
  { id: "play3",    goal: 3, reward: 30, text: "Play 3 matches" },
  { id: "destroy4", goal: 4, reward: 40, text: "Destroy 4 enemy pieces" },
  { id: "slam1",    goal: 1, reward: 30, text: "Win a match after using SLAM" },
  { id: "chain2",   goal: 2, reward: 40, text: "Push a chain of 2 or more, twice" },
  { id: "puzzle1",  goal: 1, reward: 40, text: "Solve the daily puzzle" },
  { id: "collapse", goal: 1, reward: 35, text: "Finish a match after the board closes" }
];

export function levelFromXp(xp) {
  /* Each level costs a little more than the last. */
  let level = 1;
  let need = 120;
  let left = xp;
  while (left >= need && level < 99) {
    left -= need;
    level++;
    need = Math.round(need * 1.15);
  }
  return { level, into: left, need };
}

export function newProfile(token, name) {
  return {
    token,
    id: "p" + Math.random().toString(36).slice(2, 10),
    name: name || randomName(),
    created: Date.now(),
    bolts: 150,
    xp: 0,
    level: 1,
    wins: 0,
    losses: 0,
    draws: 0,
    played: 0,
    streak: 0,
    owned: freeItemIds(),
    loadout: { ...DEFAULT_LOADOUT },
    daily: null
  };
}

const NAME_PARTS_A = ["Quick", "Iron", "Pale", "Blunt", "Hollow", "Bright", "Grim", "Still"];
const NAME_PARTS_B = ["Anchor", "Runner", "Chain", "Edge", "Shove", "Gap", "Line", "Drop"];

export function randomName() {
  const a = NAME_PARTS_A[Math.floor(Math.random() * NAME_PARTS_A.length)];
  const b = NAME_PARTS_B[Math.floor(Math.random() * NAME_PARTS_B.length)];
  return a + b + Math.floor(Math.random() * 90 + 10);
}

export function cleanName(raw) {
  const text = String(raw || "").replace(/[^\w \-]/g, "").trim().slice(0, 16);
  return text.length >= 2 ? text : null;
}

/* ----------------------------------------------------------------- dailies */

export function ensureDaily(profile, day = dayNumber()) {
  if (profile.daily && profile.daily.day === day) return profile.daily;

  /* A new day: three quests chosen from the day number so everyone gets
   * the same set, and yesterday's progress is gone. */
  const picked = [];
  let cursor = day % QUEST_TYPES.length;
  while (picked.length < 3) {
    const quest = QUEST_TYPES[cursor % QUEST_TYPES.length];
    if (!picked.some(q => q.id === quest.id)) {
      picked.push({ ...quest, progress: 0, claimed: false });
    }
    cursor += 2;
  }

  profile.daily = {
    day,
    firstWinClaimed: false,
    puzzleSolved: false,
    quests: picked
  };
  return profile.daily;
}

function bumpQuest(profile, id, amount = 1, log = []) {
  const daily = ensureDaily(profile);
  const quest = daily.quests.find(q => q.id === id);
  if (!quest || quest.claimed) return;

  quest.progress = Math.min(quest.goal, quest.progress + amount);
  if (quest.progress >= quest.goal && !quest.claimed) {
    quest.claimed = true;
    profile.bolts += quest.reward;
    log.push({ kind: "quest", text: quest.text, bolts: quest.reward });
  }
}

/* ---------------------------------------------------------- match rewards */

/**
 * Fold a finished match into a profile. `summary` is produced by the match
 * runtime, never by the client.
 */
export function applyMatchResult(profile, summary) {
  ensureDaily(profile);

  const log = [];
  const vsBot = Boolean(summary.vsBot);
  const result = summary.result; /* "win" | "loss" | "draw" */

  let bolts;
  let xp;
  if (result === "win") {
    bolts = vsBot ? REWARDS.botWin : REWARDS.win;
    xp = XP.win;
    profile.wins++;
    profile.streak = Math.max(0, profile.streak) + 1;
  } else if (result === "loss") {
    bolts = vsBot ? REWARDS.botLoss : REWARDS.loss;
    xp = XP.loss;
    profile.losses++;
    profile.streak = 0;
  } else {
    bolts = vsBot ? REWARDS.botDraw : REWARDS.draw;
    xp = XP.draw;
    profile.draws++;
  }

  profile.played++;
  log.push({ kind: result, text: labelFor(result, vsBot), bolts });

  /* The reason to come back tomorrow. Only real opponents count. */
  if (result === "win" && !vsBot && !profile.daily.firstWinClaimed) {
    profile.daily.firstWinClaimed = true;
    bolts += REWARDS.firstWinOfDay;
    log.push({ kind: "daily", text: "First win of the day", bolts: REWARDS.firstWinOfDay });
  }

  profile.bolts += bolts;
  profile.xp += xp;
  profile.level = levelFromXp(profile.xp).level;

  bumpQuest(profile, "play3", 1, log);
  if (result === "win") bumpQuest(profile, "win2", 1, log);
  if (summary.kills) bumpQuest(profile, "destroy4", summary.kills, log);
  if (summary.chainPushes) bumpQuest(profile, "chain2", summary.chainPushes, log);
  if (result === "win" && summary.usedSlam) bumpQuest(profile, "slam1", 1, log);
  if (summary.boardClosed) bumpQuest(profile, "collapse", 1, log);

  return { log, xp };
}

function labelFor(result, vsBot) {
  const who = vsBot ? " (practice)" : "";
  if (result === "win") return "Victory" + who;
  if (result === "loss") return "Defeat" + who;
  return "Draw" + who;
}

export function applyPuzzleSolved(profile) {
  const daily = ensureDaily(profile);
  if (daily.puzzleSolved) {
    return { log: [], already: true };
  }

  daily.puzzleSolved = true;
  profile.bolts += REWARDS.puzzle;
  profile.xp += XP.puzzle;
  profile.level = levelFromXp(profile.xp).level;

  const log = [{ kind: "puzzle", text: "Daily puzzle solved", bolts: REWARDS.puzzle }];
  bumpQuest(profile, "puzzle1", 1, log);
  return { log, already: false };
}

/* -------------------------------------------------------------------- shop */

export function shopFor(profile, week = weekNumber()) {
  const featured = weeklyRotation(week);
  return ITEMS.map(item => ({
    ...item,
    owned: profile.owned.includes(item.id),
    featured: featured.includes(item.id)
  }));
}

export function buy(profile, itemId) {
  const item = itemById(itemId);
  if (!item) return { ok: false, reason: "No such item." };
  if (profile.owned.includes(itemId)) return { ok: false, reason: "You already own that." };
  if (item.price > profile.bolts) {
    return { ok: false, reason: "That costs " + item.price + " Bolts." };
  }

  profile.bolts -= item.price;
  profile.owned.push(itemId);
  return { ok: true, item };
}

export function equip(profile, slot, itemId) {
  if (!SLOTS.includes(slot)) return { ok: false, reason: "Unknown slot." };

  const item = itemById(itemId);
  if (!item || item.slot !== slot) return { ok: false, reason: "That does not go there." };
  if (!profile.owned.includes(itemId)) return { ok: false, reason: "You do not own that." };

  profile.loadout[slot] = itemId;
  return { ok: true };
}

/* --------------------------------------------------------------- shipping */

/** What the owner of a profile is allowed to see. */
export function privateView(profile) {
  const progress = levelFromXp(profile.xp);
  return {
    id: profile.id,
    name: profile.name,
    bolts: profile.bolts,
    xp: profile.xp,
    level: progress.level,
    levelInto: progress.into,
    levelNeed: progress.need,
    wins: profile.wins,
    losses: profile.losses,
    draws: profile.draws,
    played: profile.played,
    streak: profile.streak,
    owned: profile.owned.slice(),
    loadout: { ...profile.loadout },
    daily: profile.daily
  };
}

/** What an opponent is allowed to see. */
export function publicView(profile) {
  return {
    id: profile.id,
    name: profile.name,
    level: levelFromXp(profile.xp).level,
    loadout: { ...profile.loadout }
  };
}

export { dayNumber, weekNumber };
