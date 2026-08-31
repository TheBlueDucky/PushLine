/* Persistence.
 *
 * A JSON file with debounced atomic writes. That is genuinely enough for a
 * turn-based game with a few thousand players -- the whole dataset is a few
 * hundred kilobytes and every read is already in memory. Swap this module
 * for SQLite or Postgres when it stops being enough; nothing outside it
 * knows how the data is stored.
 */

import fs from "node:fs";
import path from "node:path";

const SAVE_DELAY_MS = 1500;

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { profiles: {}, puzzles: {}, meta: { created: Date.now() } };
    this.timer = null;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, "utf8");
        const parsed = JSON.parse(raw);
        this.data = { profiles: {}, puzzles: {}, meta: {}, ...parsed };
        return;
      }
    } catch (error) {
      /* A corrupt save must not stop the server. Keep the bad file so it
       * can be looked at, and carry on with an empty one. */
      console.error("[store] could not read save, starting fresh:", error.message);
      try {
        fs.renameSync(this.file, this.file + ".broken-" + Date.now());
      } catch (_) { /* nothing to rename */ }
    }

    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.saveNow();
  }

  /** Ask for a save soon. Repeated calls collapse into one write. */
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveNow();
    }, SAVE_DELAY_MS);
    if (this.timer.unref) this.timer.unref();
  }

  saveNow() {
    const temp = this.file + ".tmp";
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(this.data), "utf8");
      fs.renameSync(temp, this.file);
    } catch (error) {
      console.error("[store] save failed:", error.message);
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.saveNow();
  }

  profile(token) {
    return this.data.profiles[token] || null;
  }

  putProfile(token, profile) {
    this.data.profiles[token] = profile;
    this.save();
    return profile;
  }

  puzzle(day) {
    return this.data.puzzles[String(day)] || null;
  }

  putPuzzle(day, def) {
    this.data.puzzles[String(day)] = def;

    /* Keep a fortnight of dailies, not a lifetime. */
    const keys = Object.keys(this.data.puzzles).sort((a, b) => Number(a) - Number(b));
    while (keys.length > 14) delete this.data.puzzles[keys.shift()];

    this.save();
    return def;
  }

  /** Highest levels first. Used for the tiny leaderboard on the home screen. */
  leaderboard(limit = 10) {
    return Object.values(this.data.profiles)
      .filter(p => p.played > 0)
      .sort((a, b) => (b.wins - a.wins) || (b.xp - a.xp))
      .slice(0, limit)
      .map(p => ({
        name: p.name,
        title: p.loadout && p.loadout.title,
        frame: p.loadout && p.loadout.frame,
        wins: p.wins,
        level: p.level
      }));
  }
}
