/* Build the static half of the game into docs/, which is what GitHub Pages
 * publishes.
 *
 *   node tools/build-pages.js --server https://pushline.fly.dev
 *
 * Pages can only serve files, so this copies the client plus the shared rules
 * modules it imports and stamps the address of the real game server into the
 * page. Without --server the built client talks to whatever host serves it,
 * which is only correct when the Node server is serving the page itself.
 *
 * The peer-to-peer original is copied to docs/legacy/ as well. That one needs
 * no server at all, so it works on Pages exactly as it always did.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(ROOT, "docs");

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const SERVER = argValue("--server", process.env.PUSHLINE_SERVER || "").trim();

if (SERVER && !/^https?:\/\//.test(SERVER)) {
  console.error("--server must start with http:// or https://");
  process.exit(1);
}

if (SERVER.startsWith("http://")) {
  console.warn(
    "\n  Warning: an http:// server will be blocked by the browser once the\n" +
    "  page is served from https://, which is the only way Pages serves it.\n" +
    "  Give the server TLS and use https:// here.\n"
  );
}

/* --------------------------------------------------------------- copying */

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

function copyInto(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

for (const name of fs.readdirSync(path.join(ROOT, "web"))) {
  copyInto(path.join(ROOT, "web", name), path.join(OUT, name));
}

for (const name of fs.readdirSync(path.join(ROOT, "shared"))) {
  copyInto(path.join(ROOT, "shared", name), path.join(OUT, "shared", name));
}

const legacy = path.join(ROOT, "legacy", "index.html");
if (fs.existsSync(legacy)) {
  copyInto(legacy, path.join(OUT, "legacy", "index.html"));
}

/* Pages runs the whole tree through Jekyll otherwise, which quietly drops
 * anything starting with an underscore. */
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");

/* ------------------------------------------------------- stamp the server */

const pagePath = path.join(OUT, "index.html");
let page = fs.readFileSync(pagePath, "utf8");

page = page.replace(
  /<meta name="pushline-server" content="[^"]*">/,
  '<meta name="pushline-server" content="' + SERVER + '">'
);

fs.writeFileSync(pagePath, page, "utf8");

/* -------------------------------------------------------------- report */

const count = list => list.reduce((total, dir) => {
  const full = path.join(OUT, dir);
  return total + (fs.existsSync(full) ? fs.readdirSync(full).length : 0);
}, 0);

console.log("built docs/");
console.log("  client   index.html, app.js, styles.css");
console.log("  rules    shared/ (" + count(["shared"]) + " modules)");
console.log("  original legacy/index.html");
console.log("  server   " + (SERVER || "(same origin as the page)"));

if (!SERVER) {
  console.log(
    "\n  No --server given, so the published page will try to open a socket\n" +
    "  back to github.io and fail. Rebuild with --server <your server url>."
  );
}
