// Smoke test for the opt-in Three.js map renderer (src/client/render/three).
//
//   node .claude/skills/run-openfront/three-smoke.mjs
//
// Enables the renderer through localStorage, starts a 50-bot solo game, checks
// that ThreeMapRenderer (not MapRenderer) is mounted with its picking
// projector, spawns through the projector, then zooms in to the tilted view
// and checks that picking round-trips. Screenshots:
//   /tmp/openfront-run/three-core.png       (top-down, spawn phase)
//   /tmp/openfront-run/three-core-spawned.png
//   /tmp/openfront-run/three-core-tilt.png  (zoomed in, tilted)
import fs from "fs";
import { gotoHome, launch, openSoloModal } from "./driver.mjs";
import {
  findSpawnTile,
  gameState,
  spawn,
  startSoloGame,
  waitForSpawnPhaseEnd,
  waitForTick,
} from "./game.mjs";
import { collectConsole, pumpFrames, useManualFrames } from "./three-util.mjs";

const out = "/tmp/openfront-run";
fs.mkdirSync(out, { recursive: true });
const RAF_MS = 3000;

const shot = async (page, name) => {
  // A whole-map frame takes ~25-35 s under SwiftShader since lot 3 (the map
  // edge apron and the close-up relief shading): Playwright's default 30 s
  // screenshot timeout is too tight.
  await page.screenshot({ path: `${out}/${name}.png`, timeout: 120_000 });
  const kb = Math.round(fs.statSync(`${out}/${name}.png`).size / 1024);
  console.log(`screenshot ${out}/${name}.png (${kb} KB)`);
};

const { browser, page } = await launch({ rafIntervalMs: RAF_MS });
const consoleErrors = collectConsole(page);

try {
  console.log("1. enable the three renderer (localStorage) + reload");
  await gotoHome(page);
  await page.evaluate(() =>
    localStorage.setItem("openfront.renderer", "three"),
  );
  await gotoHome(page);
  await openSoloModal(page);

  console.log("2. starting solo game (50 bots)…");
  await startSoloGame(page, { bots: 50 });
  const info = await page.evaluate(() => {
    const view = window.__webglView;
    const th = document.querySelector("build-menu")?.transformHandler;
    return {
      view: view?.constructor?.name,
      overlayRoot: document.getElementById("three-map-overlay") !== null,
      projector: th?.projector != null,
      heightField: view?.heightField
        ? {
            step: view.heightField.step,
            cols: view.heightField.cols,
            rows: view.heightField.rows,
            min: view.heightField.minHeight,
            max: view.heightField.maxHeight,
          }
        : null,
      post: view?.post != null,
    };
  });
  console.log("   view:", JSON.stringify(info));
  if (info.view !== "ThreeMapRenderer") {
    throw new Error(`expected ThreeMapRenderer, got ${info.view}`);
  }
  if (!info.projector) throw new Error("TransformHandler has no projector");
  // Frames cost seconds under SwiftShader: pump them only for screenshots.
  await useManualFrames(page);
  const start = await gameState(page);
  console.log("   game ready:", JSON.stringify(start));
  await waitForTick(page, start.ticks + 10);
  await pumpFrames(page);
  await shot(page, "three-core");

  console.log("3. spawning (picking through the projector)…");
  const tile = await spawn(page, await findSpawnTile(page));
  console.log(`   spawned at (${tile.x},${tile.y})`);
  await waitForSpawnPhaseEnd(page);
  await pumpFrames(page);
  await shot(page, "three-core-spawned");

  console.log("4. zoom in (tilted view) + picking round trip…");
  const tilt = await page.evaluate(
    ([x, y]) => {
      const th = document.querySelector("build-menu").transformHandler;
      th.clearTarget();
      const W = th.game.width();
      const H = th.game.height();
      const r = th.boundingRect();
      th.scale = 14;
      // Inverse of ClientGameRunner's centre formula: put (x, y) mid-canvas.
      th.offsetX = x - W / 2 - (r.width - W) / (2 * th.scale);
      th.offsetY = y - H / 2 - (r.height - H) / (2 * th.scale);
      const errors = [];
      for (const [dx, dy] of [
        [0, 0],
        [-20, -12],
        [25, 10],
        [-8, 18],
      ]) {
        const wx = x + dx + 0.5;
        const wy = y + dy + 0.5;
        const s = th.worldToScreenCoordinates({ x: wx, y: wy });
        const back = th.screenToWorldCoordinatesFloat(s.x, s.y);
        errors.push(Math.hypot(back.x - wx, back.y - wy));
      }
      return { errors };
    },
    [tile.x, tile.y],
  );
  // The rig's tilt is updated by the next rendered frame.
  await pumpFrames(page);
  tilt.tilt = await page.evaluate(() => window.__webglView.rig.tilt);
  console.log("   tilt (rad):", tilt.tilt, "pick errors:", tilt.errors);
  if (!(tilt.tilt > 0.5)) throw new Error("expected a tilted camera");
  // A hidden point (behind a hill) may legitimately pick something nearer.
  if (tilt.errors.filter((e) => e > 0.05).length > 1) {
    throw new Error("picking under tilt does not round-trip");
  }
  await shot(page, "three-core-tilt");

  console.log("   final:", JSON.stringify(await gameState(page)));
  console.log("THREE SMOKE OK");
} finally {
  console.log(`console errors (${consoleErrors.length}):`);
  for (const e of consoleErrors.slice(0, 40)) console.log("  ", e);
  await browser.close();
}
