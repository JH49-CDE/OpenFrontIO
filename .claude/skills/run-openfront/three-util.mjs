// Helpers shared by the Three.js renderer scripts (three-*.mjs).
//
// Frame pumping: a full three frame costs ~4 s of CPU under SwiftShader, so
// even the 3 s rAF throttle of `launch({ rafIntervalMs: 3000 })` keeps all
// 4 cores busy and the sim crawls at ~0.3 ticks/s. Once a game runs,
// `useManualFrames` queues rAF callbacks instead and only `pumpFrames` runs
// them: the sim gets the CPU back (~10 ticks/s) and every screenshot
// follows exactly the frames it asked for.

/** Offline dev noise in the page console (unreachable API hosts, Lit dev
 * mode, SwiftShader readback stalls, the headless `navigator.keyboard`). */
export const CONSOLE_NOISE =
  /Failed to load resource|WebSocket connection to|ERR_(NAME_NOT_RESOLVED|TUNNEL|CONNECTION_REFUSED)|Error polling|net::|Failed to fetch|No JWT found|Lit is in dev mode|Unrecognized feature|GPU stall due to ReadPixels|scheduled an update|keyboard\.addEventListener/;

/** Collects page errors / warnings (minus CONSOLE_NOISE) into an array. */
export function collectConsole(page) {
  const messages = [];
  page.on("console", (m) => {
    const text = m.text();
    if (CONSOLE_NOISE.test(text)) return;
    const type = m.type();
    if (
      type === "error" ||
      type === "warning" ||
      /ThreeMapRenderer|THREE\./.test(text)
    ) {
      messages.push(`[${type}] ${text.slice(0, 600)}`);
    }
  });
  page.on("pageerror", (e) => {
    if (!CONSOLE_NOISE.test(e.message)) {
      messages.push(`[pageerror] ${e.message.slice(0, 600)}`);
    }
  });
  return messages;
}

/**
 * Put world point (x, y) at the canvas centre at the given zoom (CSS px per
 * tile): the inverse of ClientGameRunner's syncCamera centre formula.
 */
export const setCamera = (page, x, y, scale) =>
  page.evaluate(
    ([wx, wy, s]) => {
      const th = document.querySelector("build-menu").transformHandler;
      th.clearTarget();
      const W = th.game.width();
      const H = th.game.height();
      const r = th.boundingRect();
      th.scale = s;
      th.offsetX = wx - W / 2 - (r.width - W) / (2 * s);
      th.offsetY = wy - H / 2 - (r.height - H) / (2 * s);
    },
    [x, y, scale],
  );

/** Switch the page to manually pumped frames (see the file comment). */
export const useManualFrames = (page) =>
  page.evaluate(() => {
    window.__rafQueue = [];
    window.requestAnimationFrame = (cb) => {
      window.__rafQueue.push(cb);
      return window.__rafQueue.length;
    };
    window.cancelAnimationFrame = () => {};
    window.__pumpFrame = () => {
      const q = window.__rafQueue;
      window.__rafQueue = [];
      const t = performance.now();
      for (const cb of q) cb(t);
      return q.length;
    };
  });

/**
 * Run `n` renderer frames (2 = camera change applied, then a settled frame).
 * Right after `useManualFrames` the frame loop's callback may still sit in
 * the old throttled timer, so each frame retries until the renderer has
 * really drawn (its `lastFrameMs` advanced).
 */
export async function pumpFrames(page, n = 2, timeoutMs = 30_000) {
  for (let i = 0; i < n; i++) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const drew = await page.evaluate(() => {
        const v = window.__webglView;
        const before = v.lastFrameMs;
        window.__pumpFrame();
        return v.lastFrameMs !== before;
      });
      if (drew) break;
      if (Date.now() > deadline) throw new Error("no frame was rendered");
      await page.waitForTimeout(250);
    }
  }
}

/** Wall time of one full frame (render + GPU sync), ms. */
export const frameCost = (page) =>
  page.evaluate(() => {
    const gl = window.__webglView.renderer.getContext();
    const px = new Uint8Array(4);
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    sync();
    const t0 = performance.now();
    window.__pumpFrame();
    sync();
    return Math.round(performance.now() - t0);
  });

/** Renderer stats from the debug handle (whole-frame draw calls, tilt, …). */
export const viewStats = (page) =>
  page.evaluate(() => {
    const v = window.__webglView;
    const info = v?.renderer?.info;
    return {
      view: v?.constructor?.name,
      tiltDeg: v?.rig ? +((v.rig.tilt * 180) / Math.PI).toFixed(1) : null,
      calls: info?.render?.calls,
      triangles: info?.render?.triangles,
      programs: info?.programs?.length,
      geometries: info?.memory?.geometries,
      textures: info?.memory?.textures,
      overlayNodes: document.querySelectorAll("#three-map-overlay *").length,
    };
  });
