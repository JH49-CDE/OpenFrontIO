# Three.js map renderer (prototype)

An opt-in, experimental 3D renderer for live games, built on
[three.js](https://threejs.org/) (MIT). When enabled it replaces the default
WebGL2 `MapRenderer` (`../gl/`) and draws the map as a lit relief: water with
waves and shore foam, territories and borders draped on the terrain, 3D
units and structures, explosions, names, sky, fog and bloom. The camera looks
straight down when zoomed out and tilts as you zoom in.

The simulation (`packages/**`) is unchanged, and so is the default renderer.
Gameplay and input are the same as with the default renderer; clicks and
hover stay accurate while the camera is tilted.

## Turning it on and off

| URL                                 | Effect                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `?renderer=three`                   | Use the 3D renderer, and remember it (localStorage `openfront.renderer` = `three`) |
| `?renderer=webgl` or `?renderer=gl` | Use the default renderer, and forget the stored choice                             |
| no `renderer` parameter             | The stored choice, else the default renderer                                       |

For one page load, the URL takes priority over the stored choice. Other
values (for example `?renderer=default`) are ignored, so the stored choice
still applies. To return to the default renderer, use `?renderer=webgl` or
delete the localStorage key. All of this lives in `RendererSelection.ts`,
which imports nothing. The homepage loads it only when the URL contains a
`renderer` parameter or a `three_*` parameter (see below).

Fallbacks:

- If the three chunk fails to load, the game starts with the default
  renderer.
- If WebGL2 is software-only or missing, the same WebGL gate appears as with
  the default renderer (`initGL`).
- Replays always use the default renderer. Only the live-game path
  (`ClientGameRunner.createClientGame`) checks the flag.

## Quality switches (URL, `ThreeSettings.ts`)

| Parameter                    | Effect                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `three_quality=low`          | No bloom, relief capped at ~150k vertices, pixel ratio capped at 1.5; keeps canvas MSAA |
| `three_tilt=<deg>`           | Maximum camera tilt, clamped to 0-75 (0 = always top-down; default 50)                  |
| `three_bloom=0`/`1`          | Force bloom off or on (also on top of `three_quality=low`)                              |
| `three_aa=msaa`/`fxaa`/`off` | Anti-aliasing technique (`1` = `msaa`, `0` = `off`; default `msaa`), see below          |
| `three_perf=1`               | Performance panel and `window.__threePerf()`, see below                                 |

`three_quality=low` also draws railways as flat strips only and switches
units and structures to their low-poly models from closer zooms (see
"Performance notes").

They work with `?renderer=three` or with the stored choice, for example
`/?three_quality=low&three_perf=1` once the 3D renderer is remembered.

**They survive the game start.** The homepage rewrites the address bar
when a game starts (solo: `history.pushState` to the bare path;
multiplayer: `#refresh` plus the game path), so `location.search` is empty
by the time the renderer is built. `Main.ts` therefore captures the query
string at bootstrap and hands it to `syncRendererPreferenceFromUrl`, which
keeps the `three_*` parameters for the page and in sessionStorage
(`openfront.threeParams`). `ThreeMapRenderer` reads them back with
`threeSettingsSearch()`: the page-load capture first, else the address bar
(an entry point that never ran the sync), else the tab's sessionStorage.

So the parameters stay for **the whole tab**, including games started
after the in-game Quit button (which reloads the homepage without a
query). A later page load whose URL names `renderer` or any `three_*`
parameter replaces them (`?renderer=three` alone resets them to the
defaults); closing the tab forgets them. `__webglView.threeSettings` shows
what the running game uses.

The other knobs in `defaultThreeSettings()` (field of view, tilt zoom range,
relief height, minimum on-screen unit size, …) can only be changed in code.

## Anti-aliasing (`three_aa`)

Anti-aliasing no longer depends on bloom. `planAntialias()` picks the
pipeline from the settings and the backing-store pixel ratio at
construction (`min(renderDpr(), pixelRatioCap)`); `__webglView.antialias`
shows the result.

| Settings                                      | Pipeline                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| default (`high`: bloom + `msaa`)              | RenderPass → UnrealBloomPass → OutputPass, 4× MSAA on the half-float target (unchanged)           |
| `msaa` without bloom (`low`, `three_bloom=0`) | Straight to the canvas, created with `antialias: true` (the browser picks the samples, usually 4) |
| `fxaa`                                        | RenderPass → [bloom] → OutputPass → FXAAPass, no MSAA                                             |
| `off`                                         | Bloom chain without MSAA, or straight to the canvas without bloom                                 |

- MSAA (target or canvas) only runs below a 1.5× pixel ratio, as before:
  above it the extra pixels already smooth edges, and `low` caps the ratio
  at 1.5, so on high-DPI screens `low` has no MSAA either. FXAA runs at any
  ratio.
- Why the canvas MSAA for `low`: it adds no render target and no
  full-screen pass (the browser resolves the multisampled canvas once per
  frame), and it is nearly free on tile-based mobile GPUs. FXAA would force
  the post-processing chain on (a half-float target, the tone-mapping pass
  and the FXAA pass: three full-screen passes), which costs more than it
  saves on weak GPUs. FXAA is kept as an option to compare on real
  hardware: `three_aa=fxaa` with `three_perf=1` shows the GPU time of each.
- Draw calls of the post-processing chain (headless counts): 14 with
  bloom, 15 with bloom and FXAA, 2 with FXAA alone, 0 straight to the
  canvas. GPU time is what differs and needs a real GPU (`three_perf=1`).
- The context attributes are fixed when the canvas is created, so the plan
  does not follow a later change of `devicePixelRatio` (moving the window
  to another screen); the next game picks it up.

## Architecture

```
ClientGameRunner ──import()──► ThreeMapRenderer (facade, implements MapRendererLike)
                                 ├─ WebGLRenderer (adopts the initGL context)
                                 ├─ HeightField    ← terrain bytes, shared by all layers
                                 ├─ CameraRig      ← pose, tilt, picking, projection
                                 ├─ layers: SceneEnvironment, TerrainLayer, WaterLayer,
                                 │          StructureLayer, UnitLayer, OverlayLayer,
                                 │          FxLayer, NameLayer (DOM)
                                 ├─ post: RenderPass → [UnrealBloomPass] → OutputPass → [FXAAPass]
                                 │        (only with bloom or FXAA; else straight to the canvas)
                                 └─ ThreePerfMonitor (only with three_perf=1)
```

- **Facade.** `ThreeMapRenderer` implements `MapRendererLike`
  (`Pick<MapRenderer, keyof MapRenderer>`), so `WebGLFrameBuilder`,
  `frame/Upload.ts`, the controllers and `ClientGameRunner` call it exactly
  as they call `MapRenderer`. Like the default renderer, it never calls
  `requestAnimationFrame` itself. It re-arms through the injected `raf`,
  which `ClientGameRunner` invokes right after pushing the camera state. A
  frame that throws is logged and the loop is still re-armed.
- **Frame order.** resize → camera rig → `FrameInfo` (`tickAlpha` is
  interpolated from the last sim tick) → environment → terrain → water →
  structures → units → overlays → FX → render (with or without bloom) →
  names. Names come last because they are DOM labels positioned with the
  camera of the frame just drawn.
- **Layers** (one file each; every layer gets the shared `ThreeLayerContext`
  from `types.ts`):

  | File                                    | Draws                                                                                          |
  | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
  | `SceneEnvironment.ts`                   | Sun and hemisphere lights, sky dome, distance fog                                              |
  | `TerrainLayer.ts`, `shaders/terrain.ts` | Relief mesh: terrain colours, territory fill, borders, fallout, coastal water; close-up detail |
  | `WaterLayer.ts`, `shaders/water.ts`     | Sea plane: depth tint, waves, glints, shore foam                                               |
  | `StructureLayer.ts`                     | Instanced structures (culled, low-poly when zoomed out), progress bars, level badges           |
  | `UnitLayer.ts`                          | Instanced ships, trains, nukes, shells and missiles (culled, low-poly when small); health bars |
  | `RailTracks.ts` (owned by `UnitLayer`)  | Railways: per-block ballast strips, sleepers and rails close up                                |
  | `OverlayLayer.ts`                       | Build ghost, nuke arc, nuke target rings, attack rings, move and blocked markers               |
  | `FxLayer.ts`                            | Explosions, mushroom clouds, shockwaves, smoke, sparkles                                       |
  | `NameLayer.ts`                          | Player names, troop counts, flags, attack labels, gold popups (DOM)                            |

  The helpers are `ProceduralMeshes.ts` (all models, built in code),
  `StatusBars.ts`, `PaletteView.ts`, `TerrainCodec.ts`,
  `TerrainResources.ts`, `TileUploadQueue.ts` (which tiles still have to
  reach the GPU, see "Tile uploads") and `TerrainShading.ts`. The last one
  holds TypeScript copies of the shader math, used by the unit tests.
  `ThreePerf.ts` is the performance tool.

- **World space.** X = tile x, Z = tile y, Y = up; 1 unit = 1 tile and sea
  level is Y = 0.
- **HeightField.** A grid of elevations, downsampled from the per-tile
  terrain bytes. Its step is `ceil(sqrt(W·H / targetVertices))`, so even the
  largest maps stay under the vertex budget. A light blur removes the
  one-tile staircase. Terrain changes (for example nukes turning land into
  water) are patched in place. The relief is only a low-pass shape: land
  versus water and ownership are always decided per tile in the shaders,
  never by height.
- **Camera rig and picking.** `CameraRig.ts` builds the camera from the same
  inputs as `TransformHandler` (centre, CSS px per tile, canvas size). The
  camera distance makes the ground scale match the 2D view exactly. Tilt is
  `maxTilt · smoothstep(2.5, 12, zoom)`, and north always stays up. The
  facade's `createProjector()` installs a `MapProjector` on
  `TransformHandler.projector`. It recomputes the camera from live inputs on
  every call, so there is no one-frame lag. It casts screen rays against the
  height field (march, then bisection) and projects world points back to the
  screen. A ray that misses the map returns `NaN`, and every caller already
  rejects that. At tilt 0 over flat ground the results match the 2D formulas
  (unit-tested). `TransformHandler.onZoom` keeps the point under the cursor
  fixed when a projector is set.
- **Shaders** are GLSL 3 strings in `.ts` modules.

## Not drawn yet

These facade methods are documented no-ops: trails, territory skins and
patterns, the effect palette, SAM range rings, the spawn-phase overlay, the
small-player glow, railway construction dust and rail colours, spiral
ribbons, decorative map layers, the tile grid view and defense coverage.
(`updateSpawnOverlay` only passes the spawn phase on to the tile uploads.)

## WebGL context loss

The facade cancels the default (so the browser restores the context) and
skips frames while the context is lost. On restore, three resets its GL
state and re-creates every program, geometry and texture on first use from
the CPU-side copies the layers keep (none discards its arrays after upload,
and every upload goes through three). Then `ClientGameRunner` re-pushes the
full terrain, territory, structure, railway and unit state through
`onContextRestored`; the full tile upload clears the tile upload queue
(nothing is uploaded while the context is lost: frames are skipped), and
the full terrain re-push re-drapes every railway block over the next
frames (within the rail budget).

The earlier note ("GPU resources are not rebuilt, the map may stay blank")
was wrong:

- The real-GPU test of `dc841ca` saw the map come back after
  `WEBGL_lose_context` early in a game.
- A headless (SwiftShader) loss and restore late in a game (World, tick
  ~25,700, ~470 structures, ~1,400 units, 51k railway pieces, game
  paused) brought back the same picture at zoom 1.8 and 8: 0.4% and 0.9%
  of the pixels differ (water animation), the same draw calls and
  triangles, `gl.getError()` 0, railways re-draped within 10 frames. Still
  worth one check on a real GPU.
- The perf tool reads `renderer.info` live: three replaces that object on
  restore, and a monitor holding the old one reported frozen draw calls
  (fixed, `ThreeMapRendererLifecycle.test.ts`).

## When `dispose()` runs

`dispose()` cancels the frame loop, disposes every layer, the post chain,
the perf tool and three's caches, then releases the WebGL context itself
(`forceContextLoss`, skipped when the context is already lost) and removes
its DOM overlay. It is idempotent. Its only caller is the disposer that
`createClientGame` builds with `createRendererDisposer`
(`ClientGameRunner.ts`), which also stops the frame loop and removes the
canvas, the input overlay and `window.__webglView`. That disposer runs from
`ClientGameRunner.stop()`, which is reached:

- through the lobby handle's `stop()` in `Main.ts`: on `beforeunload`, when
  a new lobby is joined in place (an existing handle is stopped first), on
  `leave-lobby` (pre-start errors such as a full lobby, a kick, a
  cancelled match), on a desktop invite, and on the Back button when the
  player is no longer alive;
- by the runner itself when the simulation worker reports an error.

The in-game Quit button (`GameRightSidebar`, `WinModal`, settings modal)
and the Back button navigate to the homepage, so there `dispose()` runs
from the `beforeunload` handler while the page unloads, which frees the
context anyway. Releasing the context matters for the in-place paths
(joining another game without a reload), where contexts would otherwise
pile up. `tests/client/three/StopDisposesView.test.ts` covers
`ClientGameRunner.stop()` → disposer → `ThreeMapRenderer.dispose()` →
`forceContextLoss`.

## Performance tool (`three_perf=1`)

With `?three_perf=1` the facade creates a `ThreePerfMonitor`
(`ThreePerf.ts`). Without it nothing is created: no timer queries, no
scene walks, no DOM, and the frame loop only adds a few null checks.

- **Panel**: bottom-left, inside the map overlay (click-through, under the
  HUD), redrawn twice a second: quality / bloom / AA; FPS, average and p99
  frame interval; JS time in the render loop split into update (resize,
  camera, every layer's `update`), render (`composer.render` or
  `renderer.render`) and names; GPU time; draw calls and triangles of the
  last frame; JS spent in the facade's update calls between frames
  (simulation ticks); then one line per layer with its triangles, its
  update time (avg/max) and its own counters. Labels go through
  `translateText` (`three_perf.*` in `en.json`); the counter names come
  from the layers' code and are shown as is.
- **`window.__threePerf()`** returns the same data as JSON
  (`ThreePerfSnapshot`): `frames`/`windowFrames` (rolling window of 120
  frames), `config` (quality, bloom, antialias, canvas / target MSAA
  samples, fxaa, composer, pixel ratio, backing-store size, relief
  vertices, max tilt), `fps`, and `{avg, p99, max, last}` for `frameMs`,
  `jsMs`, `updateMs`, `renderMs`, `namesMs`, `gpuMs` (null when
  unsupported or no result yet), `drawCalls`, `triangles`,
  `betweenFramesMs`, `calls.<facade method>` (`uploadLiveDelta`,
  `uploadTileAndTrailState`, `applyTerrainRects`, `updateUnits`,
  `updateStructures`, `updateNames`, `applyDeadUnits`,
  `uploadRailroadState`; ms per frame); `gpu.supported` and
  `gpu.disjointResets`; `layers.<name>` with `triangles`, `meshes`,
  `instances`, `updateMs` and `stats`; `topMeshes` (the 12 heaviest
  visible meshes: layer, name, triangles, instances, triangles per
  instance); `memory` (three's geometries, textures, programs). Copy it
  with `copy(JSON.stringify(__threePerf(), null, 2))` in the console.
- **GPU time** uses `EXT_disjoint_timer_query_webgl2`: one `TIME_ELAPSED`
  query brackets each frame's draw (`composer.render` or `renderer.render`:
  scene and post passes, plus the texture and buffer uploads three does
  there). Uploads a layer makes itself are not included: full uploads
  forced between frames with `initTexture`, and the tile-state rectangles
  `TerrainLayer.update` sends before the draw (their count and texels are
  in `layers.terrain.stats`). Results are read a few frames later, a
  disjoint event drops the results in flight, and at most 8 queries are
  pending. Without the extension the panel
  shows "GPU n/a" and `gpuMs` is null.
- **Triangles per layer** walk the scene roots each layer added at
  construction (`track()` in the constructor) and count visible meshes:
  index (or position) count / 3 within the draw range, times `count` for
  an `InstancedMesh` or the instance count of an
  `InstancedBufferGeometry`; sprites count 2, lines and points 0. Frustum
  culling is ignored, so this is what the layer submits at most; the total
  `triangles` comes from `renderer.info` (what was drawn, post passes
  included). Scene children no layer claimed are counted under `other`.
  The walk only runs for the panel and `__threePerf()`, never per frame.
- **Layer counters (`perfStats()` contract)**: a layer that has a method
  `perfStats(): Record<string, number>` gets its result under
  `layers.<name>.stats` and on the panel. It is called at most a few times
  a second, must be cheap and side-effect free (never reset on read: the
  panel and `__threePerf()` share it), and returns plain numbers:
  cumulative counters, current sizes, or the layer's own recent averages /
  maxima, with an `Ms` suffix for times. Per-frame instrumentation should
  only run when `ctx.settings.perf` is true. `UnitLayer` (railways and
  units), `StructureLayer`, `TerrainLayer` (tile uploads) and `FxLayer`
  (particles and fill) implement it:
  - `terrain`: `uploadCallsLastFrame` and `texelsLastFrame` (tile-state
    uploads of the last frame, a full upload pushed between frames
    included, so the first frame of a game shows 1 + the rectangles),
    `uploadCallsMax` and `texelsMax` (over the last 120 frames),
    `pendingTexels` and `pendingCells` (still queued), `uploadCallsTotal`,
    `texelsTotal`, `fullUploads`.
  - `fx`: `glowParticles`, `smokeParticles`, `fireballs`, `decals`,
    `pendingEffects`, `liveEffects`, and `fillScreens` /
    `fillScreensMax` (last frame / max over 120 frames): the screen area
    of the glow and smoke quads and fireballs over the viewport area, an
    estimate of how many times each pixel is blended (decals left out).

## Performance notes

- Draw calls (`renderer.info`, headless, World): 17-19 early in a game
  with bloom (3-5 for the scene plus 14 for the post-processing chain), 3
  without it (`three_quality=low`). Late in a game (~1,400 units, ~460
  structures, ~48k-51k railway pieces): 39-42 at full-map and default
  zoom, 34-38 at zoom 8 and 28 at zoom 20, of which 14 are the post chain
  (25 / 20 / 14 for the scene alone, what `low` or `three_bloom=0` pays).
  The real-GPU test of `dc841ca` counted 33 to 41 late in a game.
  `three_perf` shows the live count. The relief is one mesh of at most
  600k vertices (~1M triangles; ~126k vertices and ~253k triangles on
  World with `three_quality=low`). Each unit or structure model is one
  instanced draw (plus one per low-poly model in use). FX uses fixed-size
  pools and allocates nothing per frame.
- Per-tile work happens on the GPU with `texelFetch` on integer textures,
  and no code loops over all tiles each frame.
- **Tile uploads** (`TerrainLayer`, `TileUploadQueue.ts`). A tick's
  changed tiles only mark 16×16-tile cells dirty. Each frame,
  `TerrainLayer.update` covers the dirty cells with rectangles (runs of
  dirty cells, merged down the rows while a merge adds at most 4096 clean
  texels) and sends at most 8 of them and 256k texels (always at least
  one), each with one `texSubImage2D` (three's public
  `copyTextureToTexture` from an alias of the live buffer). The rest waits
  for the next frames, in scan order from where the last frame stopped,
  so every cell gets its turn; a cell is marked clean only once a
  rectangle covering it was sent, and since the source is the live buffer
  a late rectangle sends the latest values. During the spawn phase
  everything is sent at once (like the default renderer's
  `flushAllDripBuckets`); the first upload, a new buffer, a context
  restore and a queue past half the map are one immediate full upload.
  Before, three sent one call per dirty row in the frame after each tick:
  replaying 90 recorded ticks of a 30-bot World game (headless harness),
  ~144 calls (~9.5k texels) per ordinary tick and 263 calls (64k texels)
  for a hydrogen bomb's tick; now ~27 rectangles (~78k texels) per tick,
  spread over 3-4 frames at 60 FPS, and the bomb's ~31k tiles are one
  rectangle. While frames stop (a background tab keeps receiving ticks)
  the queue stays bounded by the cell count; three's per-row ranges used
  to pile up (578k ranges after ~2,000 ticks, then 1,488 calls and 283 ms
  of JS in one frame). Terrain-byte changes (water nukes) go through the
  same merging, immediately. In a headless late game (World, normal speed,
  60 Hz update loop over 150 s): at most 7 calls and 60k texels per frame;
  a synthetic hydrogen-bomb tick (a disc of 31k tiles) went out as one
  224×224 rectangle in the next frame, where the per-row path needed 201
  calls.
- A hydrogen bomb's FX stay cheap in fill: at their peak (~5 s, the
  puffs grow) `fx.fillScreensMax` read ~1.5 at zoom 4, ~2.9 at zoom 7 and
  ~2.7 at zoom 11 (tilted) in a 1280×720 headless view, i.e. a few
  million blended fragments, with ~110 smoke puffs, ~40 glow particles and
  one fireball; an atom bomb is under a third of that. The headless
  frames with the FX hidden were no faster beyond noise.
- Close-up terrain detail fades in between ~2.5 and ~7 px per tile, behind a
  branch that real GPUs skip when zoomed out.
- Railways (`RailTracks.ts`) are kept per block of 64×64 tiles. The facade
  only hands over the whole per-tile rail buffer, so a change is found by
  diffing it against a shadow copy (about 1 ms per 2M tiles, 4 tiles per
  compare), and only the blocks it touches are rebuilt (15-70 µs each,
  matrices written directly). Diffing and rebuilds share a 1.25 ms budget
  per frame; the rest waits for the next frame. Terrain patches re-drape
  only the blocks under them. Each block owns a slot with ~25% slack in one
  instance buffer, so a rebuild uploads only that slot. Two rarer events
  upload the whole buffer once: growth (the buffer doubles; at 128k slots
  that is 8 MB) and compaction (slots re-packed once holes left by moved
  blocks exceed half the live slots plus 2048).
- Railway levels of detail: every piece (half a tile) is a flat
  2-triangle ballast strip, one draw call, never culled; below ~2 px per
  tile it is light and half transparent so lines do not read as borders.
  Sleepers and rails (16 triangles a piece, was 60) are added only for the
  blocks inside the view frustum whose nearest tile covers at least 6 CSS
  px (off again below 5), and never with `three_quality=low`. On a
  synthetic late-game network of 25k-27k pieces on the World map: about
  70k rail triangles at full-map and default zoom and 115k-220k close up,
  instead of 1.5M at every zoom. In a headless late game with 48k pieces
  (twice the real-GPU test's network): 120k at full-map and default zoom
  (strips, slack included), 176k at zoom 8 and 172k at zoom 20 (3.2k-3.5k
  detailed pieces), 120k at every zoom with `three_quality=low`.
- Rail JS per frame is bounded by the budget plus one block, except on
  the rare frames that grow the instance buffer. A 60 Hz update loop over
  150 s of that late game (9,375 frames, normal speed): p99 0.8 ms, four
  frames over 2 ms, max 4.8 ms (the frame that doubled the buffer). The
  old full rebuild of every piece took 21-47 ms per change in the real-GPU
  test.
- Units outside the view frustum are not drawn (nuke trails keep
  sampling). Boats, trains and shells shorter than 24 CSS px on screen (72
  with `three_quality=low`) use low-poly models (8-42 triangles instead of
  36-364). Structures switch to low-poly models below 5 px per tile (12
  with `three_quality=low`, 15% hysteresis) and are culled outside the
  view. A late-game population of 835 units and 380 structures went from
  274k triangles at every zoom to 29k-48k at full-map and default zoom. In
  the headless late game (1,404 mobile units, 457 structures): 45k + 23k
  triangles at full map (all low-poly), 8.5k + 6.6k at zoom 1.8 (1,145
  units and 328 structures culled), 0.6k + 6.1k at zoom 8 (full models).
- Names, troop counts and level badges are pooled DOM elements. The frame
  loop never reads layout, and troop text changes at most every 500 ms per
  label.
- Bloom and 4× MSAA on the post-processing target take most of the fill
  rate (about 1 to 2 ms of 3.6 to 5 ms of GPU time late in a game on the
  laptop RTX of the real-GPU test), and the backing store is capped at
  pixel ratio 2. On weak GPUs try `three_quality=low` (canvas MSAA, no
  post-processing chain).
- The headless harness runs on SwiftShader at about 1.5-4 s per frame, which
  says nothing about real hardware. Measure with `three_perf=1` on a real
  GPU.
- `dispose()` releases the WebGL context (`forceContextLoss`), so starting
  game after game in one tab does not pile up contexts (see "When
  `dispose()` runs").

## Testing

- Unit tests: `npx vitest run tests/client/three`. `RailTracks.test.ts`
  also checks triangle targets and loose per-frame time bounds on a
  synthetic late-game railway network on the real World map
  (`railNetwork.ts`), and replays three's buffer uploads to check that
  what the GPU draws always matches the network through slot moves and
  compactions. `TileUploadQueue.test.ts` and the tile-upload tests
  in `TerrainLayers.test.ts` check the merging, the per-frame budget and
  that a mirrored GPU copy always converges to the live buffer.
- Headless checks in `.claude/skills/run-openfront/`:
  - `three-shots.mjs`: screenshots at four zoom levels plus a click test
    while tilted.
  - `three-smoke.mjs`: smoke test.
  - `three-debug.mjs` and `three-fxdebug.mjs`: long-lived sessions driven by
    command files.

## Licensing

- The code is part of OpenFront and licensed under the **GNU AGPL v3**
  (`/LICENSE`). Modified versions must keep the "© OpenFront and
  Contributors" notices (footer and loading screen) visible, and the 3D view
  must not hide them.
- No external models or textures are used: all geometry and textures are
  generated in code. The only assets loaded come from `/resources` (the
  Overpass font and the status atlas), which are **CC BY-SA 4.0** with
  attribution to "OpenFront".
- Assets in `/proprietary` are **all rights reserved** (`/LICENSE-ASSETS`,
  `/proprietary/LICENSE`). Do not use them in work outside OpenFront.
- three.js is a dependency under the MIT license.
