/* Hole layouts.
 *
 * Blue spawns on row 0 and red on row 6, so a layout is only fair if it
 * mirrors across the middle row: for every hole (r,c) there must be a hole
 * at (6-r,c). Every map here passes that test, and the test itself ships in
 * the suite so an unfair map can never be added by accident.
 *
 * Holes never sit on row 0 or row 6 -- pieces spawn there. */

export const MAPS = [
  { id: "crossroads", name: "Crossroads",
    holes: [[2,1],[2,5],[3,3],[4,1],[4,5]] },

  { id: "spine", name: "Spine",
    holes: [[1,3],[2,5],[3,1],[4,5],[5,3]] },

  { id: "cross", name: "Cross",
    holes: [[2,3],[3,1],[3,3],[3,5],[4,3]] },

  { id: "pillars", name: "Pillars",
    holes: [[1,1],[1,5],[3,3],[5,1],[5,5]] },

  { id: "channel", name: "Channel",
    holes: [[2,2],[2,4],[3,3],[4,2],[4,4]] },

  { id: "wings", name: "Wings",
    holes: [[1,2],[1,4],[3,3],[5,2],[5,4]] },

  { id: "narrows", name: "Narrows",
    holes: [[2,3],[3,0],[3,3],[3,6],[4,3]] },

  { id: "ladder", name: "Ladder",
    holes: [[1,3],[3,1],[3,3],[3,5],[5,3]] }
];

export function mapById(id) {
  return MAPS.find(m => m.id === id) || null;
}

/** True when a layout is identical after a top-to-bottom flip. */
export function isMirrored(holes, size = 7) {
  const key = list =>
    list.map(([r, c]) => r + "," + c).sort().join(" ");
  return key(holes) === key(holes.map(([r, c]) => [size - 1 - r, c]));
}
