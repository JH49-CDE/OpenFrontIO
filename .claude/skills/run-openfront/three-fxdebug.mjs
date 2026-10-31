// Variant of three-debug.mjs for FX / unit look-dev: same command protocol,
// but the solo game is started with options from the environment
// (TD_BOTS, TD_INSTANT=1 instant build, TD_GOLD=1 infinite gold) so units,
// structures and nukes can be built quickly.
//
//   node .claude/skills/run-openfront/three-fxdebug.mjs <cmdDir>
//
// Starts a solo game with the three renderer, spawns, expands, then
// polls <cmdDir> for `*.mjs` command modules. Each module default-exports
// `async (ctx) => any`; ctx = { page, setCamera(x, y, scale), shot(name,
// clip?), settle(frames = 2), state: { tile } }. The result (or error) and
// the page's console output are written to `<name>.out`, and the module is
// renamed to `<name>.done`. A file named `quit` stops the session.
// Frames are pumped manually (three-util.mjs): nothing renders between
// commands, so the sim runs at full speed. Editing files under src/ makes
// Vite reload the page and ends the game: tweak shaders live instead, e.g.
// `material.fragmentShader = …; material.needsUpdate = true`.
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { gotoHome, launch, openSoloModal } from "./driver.mjs";
import {
  attack,
  findExpansionTile,
  findSpawnTile,
  gameState,
  setAttackRatio,
  spawn,
  startSoloGame,
  waitForSpawnPhaseEnd,
  waitForTick,
} from "./game.mjs";
import {
  CONSOLE_NOISE,
  pumpFrames,
  setCamera as setCameraOn,
  useManualFrames,
} from "./three-util.mjs";

const cmdDir = process.argv[2];
if (!cmdDir) throw new Error("usage: three-debug.mjs <cmdDir>");
fs.mkdirSync(cmdDir, { recursive: true });
const out = "/tmp/openfront-run";
fs.mkdirSync(out, { recursive: true });

const { browser, page } = await launch({ rafIntervalMs: 3000 });
const logs = [];
page.on("console", (m) => {
  const t = m.text();
  if (CONSOLE_NOISE.test(t)) return;
  if (m.type() === "error" || m.type() === "warning" || /THREE|Three/.test(t))
    logs.push(`[${m.type()}] ${t.slice(0, 2000)}`);
});
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

const setCamera = (x, y, scale) => setCameraOn(page, x, y, scale);
const settle = (n = 2) => pumpFrames(page, n);
const shot = async (name, clip) => {
  const file = `${out}/${name}.png`;
  await page.screenshot({ path: file, clip });
  return file;
};

await gotoHome(page);
await page.evaluate(() => localStorage.setItem("openfront.renderer", "three"));
await gotoHome(page);
await openSoloModal(page);
await startSoloGame(page, {
  bots: Number(process.env.TD_BOTS ?? 50),
  instantBuild: process.env.TD_INSTANT === "1",
  infiniteGold: process.env.TD_GOLD === "1",
});
await useManualFrames(page);
const tile = await spawn(page, await findSpawnTile(page));
await waitForSpawnPhaseEnd(page);
await setAttackRatio(page, 0.5);
for (let i = 0; i < 2; i++) {
  const before = await gameState(page);
  const target = await findExpansionTile(page, tile);
  if (!target) break;
  await attack(page, target.x, target.y);
  try {
    await waitForTick(page, before.ticks + 30, 60_000);
  } catch {
    console.log("tick wait timed out", JSON.stringify(await gameState(page)));
  }
}
const state = { tile };
fs.writeFileSync(path.join(cmdDir, "READY"), JSON.stringify(tile));
console.log("READY", JSON.stringify(tile));

let n = 0;
for (;;) {
  if (fs.existsSync(path.join(cmdDir, "quit"))) break;
  const files = fs
    .readdirSync(cmdDir)
    .filter((f) => f.endsWith(".mjs"))
    .sort();
  if (files.length === 0) {
    await new Promise((r) => setTimeout(r, 500));
    continue;
  }
  const f = files[0];
  const full = path.join(cmdDir, f);
  const base = full.slice(0, -4);
  let result;
  logs.length = 0;
  try {
    const mod = await import(`${pathToFileURL(full).href}?n=${n++}`);
    result = await mod.default({ page, setCamera, shot, settle, state });
  } catch (e) {
    result = { error: String(e?.stack ?? e) };
  }
  fs.writeFileSync(
    `${base}.out`,
    JSON.stringify({ result, logs: logs.slice(0, 80) }, null, 2),
  );
  fs.renameSync(full, `${base}.done`);
}
await browser.close();
