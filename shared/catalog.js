/* Cosmetics.
 *
 * Every item here is paint. Nothing in this file may ever touch a rule --
 * no extra action points, no longer clock, no wider push. The client reads
 * `slot` and `id` and turns them into CSS classes; the server only cares
 * about price and ownership.
 */

export const SLOTS = ["skin", "board", "destroyFx", "slamFx", "title", "frame"];

export const SLOT_LABEL = {
  skin: "Piece skin",
  board: "Board",
  destroyFx: "Destruction",
  slamFx: "Slam",
  title: "Title",
  frame: "Frame"
};

/* price 0 = owned by everyone from the start. */
export const ITEMS = [
  /* ---- piece skins ---- */
  { id: "skin.orb",       slot: "skin", name: "Orb",        price: 0,    blurb: "The original glow." },
  { id: "skin.hexcore",   slot: "skin", name: "Hexcore",    price: 450,  blurb: "Faceted, machined, cold." },
  { id: "skin.runestone", slot: "skin", name: "Runestone",  price: 600,  blurb: "Carved and faintly lit." },
  { id: "skin.glass",     slot: "skin", name: "Glasswork",  price: 750,  blurb: "You can see the board through it." },
  { id: "skin.magma",     slot: "skin", name: "Magma",      price: 900,  blurb: "Cooling crust over a hot centre." },
  { id: "skin.circuit",   slot: "skin", name: "Circuit",    price: 1200, blurb: "Traces that pulse on your turn." },

  /* ---- boards ---- */
  { id: "board.neon",      slot: "board", name: "Neon",      price: 0,    blurb: "Default midnight blue." },
  { id: "board.royal",     slot: "board", name: "Royal",     price: 0,    blurb: "Deep violet and gold." },
  { id: "board.ice",       slot: "board", name: "Ice",       price: 0,    blurb: "Pale, cold, high contrast." },
  { id: "board.void",      slot: "board", name: "Void",      price: 500,  blurb: "Near black. The holes disappear." },
  { id: "board.blueprint", slot: "board", name: "Blueprint", price: 700,  blurb: "Drafting paper and cyan ink." },
  { id: "board.sunset",    slot: "board", name: "Sunset",    price: 850,  blurb: "Warm dusk over the grid." },

  /* ---- destruction ---- */
  { id: "fx.shatter",  slot: "destroyFx", name: "Shatter",  price: 0,   blurb: "Clean break." },
  { id: "fx.implode",  slot: "destroyFx", name: "Implode",  price: 400, blurb: "Pulled inward, then gone." },
  { id: "fx.dissolve", slot: "destroyFx", name: "Dissolve",  price: 550, blurb: "Comes apart into dust." },

  /* ---- slam ---- */
  { id: "slam.shock",    slot: "slamFx", name: "Shockwave", price: 0,   blurb: "A ring across the board." },
  { id: "slam.fracture", slot: "slamFx", name: "Fracture",  price: 500, blurb: "The grid cracks along the line." },
  { id: "slam.pulse",    slot: "slamFx", name: "Pulse",     price: 650, blurb: "Three quick beats of light." },

  /* ---- titles ---- */
  { id: "title.none",         slot: "title", name: "No title",     price: 0,    blurb: "Just your name." },
  { id: "title.chainbreaker", slot: "title", name: "Chainbreaker", price: 300,  blurb: "" },
  { id: "title.holecrafter",  slot: "title", name: "Holecrafter",  price: 300,  blurb: "" },
  { id: "title.anchor",       slot: "title", name: "Anchor",       price: 450,  blurb: "" },
  { id: "title.undefeated",   slot: "title", name: "Undefeated",   price: 1000, blurb: "" },

  /* ---- frames ---- */
  { id: "frame.plain",  slot: "frame", name: "Plain",  price: 0,   blurb: "" },
  { id: "frame.brass",  slot: "frame", name: "Brass",  price: 400, blurb: "" },
  { id: "frame.signal", slot: "frame", name: "Signal", price: 800, blurb: "" }
];

export const DEFAULT_LOADOUT = {
  skin: "skin.orb",
  board: "board.neon",
  destroyFx: "fx.shatter",
  slamFx: "slam.shock",
  title: "title.none",
  frame: "frame.plain"
};

export function itemById(id) {
  return ITEMS.find(i => i.id === id) || null;
}

export function freeItemIds() {
  return ITEMS.filter(i => i.price === 0).map(i => i.id);
}

/**
 * Four paid items are featured each week. Deterministic from the week
 * number, so every player sees the same shop and it changes on a schedule
 * rather than whenever someone reloads.
 */
export function weeklyRotation(weekNumber, size = 4) {
  const paid = ITEMS.filter(i => i.price > 0).map(i => i.id).sort();
  if (!paid.length) return [];

  const picked = [];
  let cursor = (weekNumber * 7919) % paid.length;

  while (picked.length < Math.min(size, paid.length)) {
    const id = paid[cursor % paid.length];
    if (!picked.includes(id)) picked.push(id);
    cursor += 3;
  }
  return picked;
}

/** ISO-ish week number. Only needs to be stable, not calendar-perfect. */
export function weekNumber(date = new Date()) {
  return Math.floor(Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()
  ) / (7 * 24 * 3600 * 1000));
}

export function dayNumber(date = new Date()) {
  return Math.floor(Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()
  ) / (24 * 3600 * 1000));
}
