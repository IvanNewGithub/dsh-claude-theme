#!/usr/bin/env node
/**
 * Round-trip check for the QR the status payload embeds.
 *
 * The plugin no longer ships a hand-written encoder: `uqr` renders the SVG on
 * the host and the client inlines it. What still needs proving is the seam --
 * that the SVG string `renderSVG` produces actually scans, because a QR that
 * renders but does not decode is invisible until someone points a phone at it.
 *
 * So: render the payload, strip the SVG back to a bitmap, ask `zbarimg` what
 * it reads. The input is the shape of the real URL (length matters -- version
 * selection depends on it).
 *
 * Needs `zbarimg` and `python3-Pillow` on PATH.
 */
/* The plugin installs as a symlink into the profile, so `uqr` lives in the
 * profile's node_modules, not next to the repo checkout. Resolve it from the
 * installed location so this test runs from the repo too. */
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
const profileRequire = createRequire(join(homedir(), ".dsh/profiles/web/package.json"));
const { renderSVG } = profileRequire("uqr");
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const CASES = [
  "http://192.168.10.102:3080/?token=bCZj6KjAFtPabcQ2XwrKtvIsbs8z1BBROu6S9y3OhJQ",
  "http://10.0.0.5:8080/?token=short",
  "http://[fd00::1]:3080/?token=ZoNMKPpXYMwJXLaS-BJ4M-ihsZ7RSiduHapQul5ZFGE",
];

function svgToModules(svg) {
  /* uqr draws the dark modules as one <path> of "M<x>,<y>h<s>v<s>h-<s>z" runs,
   * where <s> is the module pitch and the viewBox is (modules + 2*border)^2.
   * Parse those runs back to module coordinates. */
  const path = /<path[^>]*d="([^"]+)"/.exec(svg)?.[1] ?? "";
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  const total = vb ? Number(vb[1]) : 0;
  const runRe = /M([\d.]+),([\d.]+)h([\d.]+)v([\d.]+)/g;
  const modules = [];
  let m, pitch = Infinity;
  while ((m = runRe.exec(path)) !== null) {
    const s = Number(m[3]);
    if (s > 0) pitch = Math.min(pitch, s);
  }
  runRe.lastIndex = 0;
  while ((m = runRe.exec(path)) !== null) {
    const x = Math.round(Number(m[1]) / pitch);
    const y = Math.round(Number(m[2]) / pitch);
    const w = Math.max(1, Math.round(Number(m[3]) / pitch));
    const h = Math.max(1, Math.round(Number(m[4]) / pitch));
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++)
        modules.push([x + dx, y + dy]);
  }
  return { modules, n: Math.round(total / pitch) };
}

const dir = mkdtempSync(join(tmpdir(), "lan-qr-"));
let failed = 0;
try {
  for (const text of CASES) {
    const svg = renderSVG(text, { ecc: "M", border: 2 });
    const { modules, n } = svgToModules(svg);

    const py = `
from PIL import Image
import sys, json
n = ${n}
mods = json.loads(${JSON.stringify(JSON.stringify(modules))})
sc, q = 10, 4
img = Image.new("L", ((n + 2*q) * sc, (n + 2*q) * sc), 255)
px = img.load()
for x, y in mods:
    for dy in range(sc):
        for dx in range(sc):
            px[(x + q) * sc + dx, (y + q) * sc + dy] = 0
img.save(${JSON.stringify(join(dir, "qr.png"))})
`;
    execFileSync("python3", ["-c", py], { stdio: "pipe" });
    const decoded = execFileSync("zbarimg", ["-q", "--raw", join(dir, "qr.png")], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const ok = decoded === text;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${text.slice(0, 46)}…`);
    if (!ok) console.log(`      decoded: ${decoded.slice(0, 60)}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`verify-qr: ${CASES.length - failed}/${CASES.length} passed`);
process.exit(failed ? 1 : 0);
