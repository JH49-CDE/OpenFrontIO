// Visual check of the opt-in Three.js map renderer at four zoom levels, plus
// a picking-under-tilt attack test.
//
//   node .claude/skills/run-openfront/three-shots.mjs
//
// Enables the renderer through localStorage, starts a 50-bot solo game,
// spawns, waits for the spawn phase to end and expands twice. Then:
//   /tmp/openfront-run/three-far.png      scale 0.8, top-down, whole continent
//   /tmp/openfront-run/three-default.png  scale 1.8 (TransformHandler default)
//   /tmp/openfront-run/three-near.png     scale 8 near the player (tilted)
//   /tmp/openfront-run/three-closest.png  scale 16 (max tilt) on a coastline
// and, at scale 8, clicks an unowned tile next to the player's border with
// game.mjs's clickWorld (worldToScreenCoordinates -> projector) and asserts
// that the territory grows. Prints page console errors / warnings at the end.
// Once the game runs, frames are pumped manually (three-util.mjs).
import fs from "fs";
import { gotoHome, launch, openSoloModal } from "./driver.mjs";
import {
  attack,
  clickWorld,
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
  collectConsole,
  frameCost,
  pumpFrames,
  setCamera,
  useManualFrames,
  viewStats,
} from "./three-util.mjs";

const out = "/tmp/openfront-run";
fs.mkdirSync(out, { recursive: true });
const RAF_MS = 3000;

const shot = async (page, name) => {
  await page.screenshot({ path: `${out}/${name}.png` });
  const kb = Math.round(fs.statSync(`${out}/${name}.png`).size / 1024);
  console.log(`   screenshot ${out}/${name}.png (${kb} KB)`);
};

/** A shoreline land tile near (x, y), searched in growing square rings. */
/**
 * Unowned land tiles 4-adjacent to the local player's territory and on
 * screen (clear of the HUD), nearest to the canvas centre first: clicking
 * one always starts an attack, however crowded the map has become.
 */
const findBorderTargets = (page, max = 5) =>
  page.evaluate((n) => {
    const bm = document.querySelector("build-menu");
    const g = bm.game;
    const th = bm.transformHandler;
    const me = g.myPlayer().smallID();
    const c = th.screenCenter();
    const out = [];
    const R = 80;
    for (let y = Math.round(c.screenY) - R; y <= c.screenY + R; y++) {
      for (let x = Math.round(c.screenX) - R; x <= c.screenX + R; x++) {
        if (!g.isValidCoord(x, y)) continue;
        const ref = g.ref(x, y);
        if (!g.isLand(ref) || g.hasOwner(ref)) continue;
        const mine = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(
          ([dx, dy]) =>
            g.isValidCoord(x + dx, y + dy) &&
            g.ownerID(g.ref(x + dx, y + dy)) === me,
        );
        if (!mine) continue;
        const s = th.worldToScreenCoordinates({ x: x + 0.5, y: y + 0.5 });
        const hit = document.elementFromPoint(s.x, s.y)?.id ?? "";
        if (hit !== "game-input-overlay") continue;
        out.push({ x, y, d: Math.hypot(x - c.screenX, y - c.screenY) });
      }
    }
    return out.sort((a, b) => a.d - b.d).slice(0, n);
  }, max);

const findCoast = (page, x, y) =>
  page.evaluate(
    ([cx, cy]) => {
      const g = document.querySelector("build-menu").game;
      for (let r = 0; r < 300; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const tx = cx + dx;
            const ty = cy + dy;
            if (!g.isValidCoord(tx, ty)) continue;
            const ref = g.ref(tx, ty);
            if (g.isLand(ref) && g.isShore(ref)) return { x: tx, y: ty };
          }
        }
      }
      return null;
    },
    [x, y],
  );

/** Centre of the local player's territory (spawn tile as a fallback). */
const playerCenter = (page, fallback) =>
  page.evaluate((fb) => {
    const me = document.querySelector("build-menu").game.myPlayer();
    const loc = me?.nameLocation();
    return loc && loc.size > 0 ? { x: loc.x, y: loc.y } : fb;
  }, fallback);

const { browser, page } = await launch({ rafIntervalMs: RAF_MS });
const consoleMessages = collectConsole(page);

let ok = false;
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
  const stats0 = await viewStats(page);
  console.log("   view:", JSON.stringify(stats0));
  if (stats0.view !== "ThreeMapRenderer") {
    throw new Error(`expected ThreeMapRenderer, got ${stats0.view}`);
  }
  await useManualFrames(page);

  console.log("3. spawn + expand…");
  const tile = await spawn(page, await findSpawnTile(page));
  console.log(`   spawned at (${tile.x},${tile.y})`);
  await waitForSpawnPhaseEnd(page);
  await setAttackRatio(page, 0.5);
  for (let i = 0; i < 2; i++) {
    const before = await gameState(page);
    const target = await findExpansionTile(page, tile);
    if (target === null) break;
    await attack(page, target.x, target.y);
    await waitForTick(page, before.ticks + 40);
    const after = await gameState(page);
    console.log(
      `   expand ${i + 1}: tiles ${before.myPlayer.tilesOwned} -> ${after.myPlayer.tilesOwned}`,
    );
  }

  // Let the bots grow for a while so the far view shows real territories.
  await waitForTick(page, 400);
  const center = await playerCenter(page, tile);
  const { width: W, height: H } = (await gameState(page)).mapSize;

  console.log("4. screenshots…");
  await pumpFrames(page);
  console.log(`   frame cost (SwiftShader): ${await frameCost(page)} ms`);
  await setCamera(page, W / 2, H / 2, 0.8);
  await pumpFrames(page);
  console.log("   far:", JSON.stringify(await viewStats(page)));
  await shot(page, "three-far");

  await setCamera(page, center.x, center.y, 1.8);
  await pumpFrames(page);
  console.log("   default:", JSON.stringify(await viewStats(page)));
  await shot(page, "three-default");

  await setCamera(page, center.x, center.y, 8);
  await pumpFrames(page);
  console.log("   near:", JSON.stringify(await viewStats(page)));
  await shot(page, "three-near");

  console.log("5. picking under tilt (scale 8): attack an adjacent tile…");
  const pick = await page.evaluate(() => {
    const th = document.querySelector("build-menu").transformHandler;
    const v = window.__webglView;
    return {
      projector: th.projector != null,
      tiltDeg: (v.rig.tilt * 180) / Math.PI,
    };
  });
  console.log("   ", JSON.stringify(pick));
  if (!pick.projector) throw new Error("TransformHandler has no projector");
  if (pick.tiltDeg < 5) throw new Error("expected a tilted camera at scale 8");
  const before = await gameState(page);
  const targets = await findBorderTargets(page);
  if (targets.length === 0) throw new Error("no unowned border tile on screen");
  const target = targets[0];
  const s = await clickWorld(page, target.x, target.y);
  // The click must resolve to the aimed tile through the projector.
  const picked = await page.evaluate(
    ([sx, sy]) =>
      document
        .querySelector("build-menu")
        .transformHandler.screenToWorldCoordinates(sx, sy),
    [s.x, s.y],
  );
  console.log(
    `   aimed (${target.x},${target.y}) -> screen (${s.x.toFixed(1)},${s.y.toFixed(1)}) -> picked (${picked.x},${picked.y})`,
  );
  if (picked.x !== target.x || picked.y !== target.y) {
    throw new Error("picking under tilt resolved to the wrong tile");
  }
  await waitForTick(page, before.ticks + 50);
  const after = await gameState(page);
  if (after.myPlayer.tilesOwned <= before.myPlayer.tilesOwned) {
    throw new Error(
      `territory did not grow after a tilted click (${before.myPlayer.tilesOwned} -> ${after.myPlayer.tilesOwned})`,
    );
  }
  console.log(
    `   territory grew ${before.myPlayer.tilesOwned} -> ${after.myPlayer.tilesOwned} ✓`,
  );

  const coast = (await findCoast(page, tile.x, tile.y)) ?? center;
  console.log(`   coast tile (${coast.x},${coast.y})`);
  await setCamera(page, coast.x + 0.5, coast.y + 0.5, 16);
  await pumpFrames(page);
  console.log("   closest:", JSON.stringify(await viewStats(page)));
  await shot(page, "three-closest");

  console.log("   final:", JSON.stringify(await gameState(page)));
  ok = true;
  console.log("THREE SHOTS OK");
} finally {
  console.log(`console errors/warnings (${consoleMessages.length}):`);
  for (const e of consoleMessages.slice(0, 60)) console.log("  ", e);
  await browser.close();
  if (!ok) process.exitCode = 1;
}
