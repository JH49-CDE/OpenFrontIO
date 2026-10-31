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
`renderer` parameter.

Fallbacks:

- If the three chunk fails to load, the game starts with the default
  renderer.
- If WebGL2 is software-only or missing, the same WebGL gate appears as with
  the default renderer (`initGL`).
- Replays always use the default renderer. Only the live-game path
  (`ClientGameRunner.createClientGame`) checks the flag.

## Quality switches (URL, `ThreeSettings.ts`)

| Parameter           | Effect                                                                        |
| ------------------- | ----------------------------------------------------------------------------- |
| `three_quality=low` | No bloom, no MSAA, relief capped at ~150k vertices, pixel ratio capped at 1.5 |
| `three_tilt=<deg>`  | Maximum camera tilt, clamped to 0-75 (0 = always top-down; default 50)        |
| `three_bloom=0`/`1` | Force bloom off or on                                                         |

The other knobs in `defaultThreeSettings()` (field of view, tilt zoom range,
relief height, minimum on-screen unit size, …) can only be changed in code.

## Architecture

```
ClientGameRunner ──import()──► ThreeMapRenderer (facade, implements MapRendererLike)
                                 ├─ WebGLRenderer (adopts the initGL context)
                                 ├─ HeightField    ← terrain bytes, shared by all layers
                                 ├─ CameraRig      ← pose, tilt, picking, projection
                                 ├─ layers: SceneEnvironment, TerrainLayer, WaterLayer,
                                 │          StructureLayer, UnitLayer, OverlayLayer,
                                 │          FxLayer, NameLayer (DOM)
                                 └─ post: RenderPass → UnrealBloomPass → OutputPass
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
  | `StructureLayer.ts`                     | Instanced structures, progress bars, level badges                                              |
  | `UnitLayer.ts`                          | Instanced ships, trains, nukes, shells and missiles; railways; health bars                     |
  | `OverlayLayer.ts`                       | Build ghost, nuke arc, nuke target rings, attack rings, move and blocked markers               |
  | `FxLayer.ts`                            | Explosions, mushroom clouds, shockwaves, smoke, sparkles                                       |
  | `NameLayer.ts`                          | Player names, troop counts, flags, attack labels, gold popups (DOM)                            |

  The helpers are `ProceduralMeshes.ts` (all models, built in code),
  `StatusBars.ts`, `PaletteView.ts`, `TerrainCodec.ts`,
  `TerrainResources.ts` and `TerrainShading.ts`. The last one holds
  TypeScript copies of the shader math, used by the unit tests.

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
After a WebGL context loss and restore, GPU resources are not rebuilt, so the
map may stay blank until the page is reloaded.

## Performance notes

- About 20 draw calls per frame in a typical game. The relief is one mesh of
  at most 600k vertices (~1M triangles; 150k vertices with
  `three_quality=low`). Each unit or structure model is one instanced draw.
  FX uses fixed-size pools and allocates nothing per frame.
- Per-tile work happens on the GPU with `texelFetch` on integer textures.
  Tile updates upload only the dirty rows, and no code loops over all tiles
  each frame.
- Close-up terrain detail fades in between ~2.5 and ~7 px per tile, behind a
  branch that real GPUs skip when zoomed out.
- Railway instances are rebuilt from the full per-tile rail buffer, at most
  once every 750 ms and only after a change. This cost grows with map size.
- Names, troop counts and level badges are pooled DOM elements. The frame
  loop never reads layout, and troop text changes at most every 500 ms per
  label.
- Bloom and 4× MSAA on the post-processing target take most of the fill
  rate, and the backing store is capped at pixel ratio 2. On weak GPUs try
  `three_quality=low`.
- The headless harness runs on SwiftShader at about 1.5-4 s per frame, which
  says nothing about real hardware. The prototype has not been profiled on
  real GPUs yet.
- `dispose()` releases the WebGL context (`forceContextLoss`), so starting
  game after game in one tab does not pile up contexts.

## Testing

- Unit tests: `npx vitest run tests/client/three`.
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
