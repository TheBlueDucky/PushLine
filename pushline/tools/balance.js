/* Balance harness.
 *
 *   node tools/balance.js [games] [difficulty] [mode]
 *
 * Plays bot against bot and reports how often blue wins. Blue always moves
 * first, so anything far from an even split means the opening is worth
 * something and the pie rule is earning its keep.
 */

import { createGame, applyAction, isOver, makeRandom } from "../shared/rules.js";
import { chooseAction } from "../shared/bot.js";

const games = Number(process.argv[2] || 50);
const difficulty = process.argv[3] || "easy";
const mode = process.argv[4] || "classic";

const tally = { blue: 0, red: 0, draw: 0 };
const reasons = new Map();
let totalTurns = 0;
const started = Date.now();

for (let i = 0; i < games; i++) {
  const random = makeRandom(i * 2654435761 + 1);
  let state = createGame({ seed: i + 1, mode, skipBans: true });

  let guard = 0;
  while (!isOver(state) && guard++ < 2000) {
    const action = chooseAction(state, difficulty, random);
    if (!action) break;
    const result = applyAction(state, action);
    if (!result.ok) break;
    state = result.state;
  }

  tally[state.winner || "draw"]++;
  totalTurns += state.turn;
  const reason = state.endReason || "unfinished";
  reasons.set(reason, (reasons.get(reason) || 0) + 1);

  process.stdout.write(
    "\r" + (i + 1) + "/" + games +
    "  blue " + tally.blue + "  red " + tally.red + "  draw " + tally.draw + "   "
  );
}

const decisive = tally.blue + tally.red;
const blueRate = decisive ? (tally.blue / decisive) * 100 : 0;

console.log("\n");
console.log("games        " + games + "  (" + difficulty + ", " + mode + ")");
console.log("blue wins    " + tally.blue);
console.log("red wins     " + tally.red);
console.log("draws        " + tally.draw);
console.log("blue share   " + blueRate.toFixed(1) + "% of decisive games");
console.log("avg turns    " + (totalTurns / games).toFixed(1));
console.log("seconds      " + ((Date.now() - started) / 1000).toFixed(1));
console.log("");
for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
  console.log("  " + String(count).padStart(4) + "  " + reason);
}
