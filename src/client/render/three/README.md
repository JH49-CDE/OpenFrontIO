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
| `three_wakes=1`              | Lot-4 prototype: ship wakes (foam V and stern wash behind moving ships)                 |
| `three_front=1`              | Lot-4 prototype: the living front (capture wave, smoke and sparks, attack arrows)       |
| `three_night=1`              | Lot-4 prototype: night and lights (moonlit map, lit cities, impact flashes)             |

`three_quality=low` also draws railways as flat strips only, switches
units and structures to their low-poly models from closer zooms and keeps
the structure icons up to 7 px per tile instead of 5 (see "Performance
notes" and "Structure icons").

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

  | File                                                       | Draws                                                                                                                                                                         |
  | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `SceneEnvironment.ts`                                      | Sun and hemisphere lights, sky dome, distance fog                                                                                                                             |
  | `TerrainLayer.ts`, `shaders/terrain.ts`                    | Relief mesh: terrain colours, territory fill, borders, fallout (burnt ground, hotspots, embers), coastal water; close-up detail and smooth relief shading; the map-edge apron |
  | `TerritoryCosmetics.ts` (owned by `TerrainLayer`)          | Territory patterns and skins in the fill (terrain shader)                                                                                                                     |
  | `SurfaceOverlay.ts` (owned by `TerrainLayer`)              | Coordinate grid and small-player glow, painted on the ground (terrain shader + sea-level plane)                                                                               |
  | `EffectTrails.ts` (shared: terrain, water, units)          | Boat and nuke trails on the ground (terrain + water shaders), the cosmetic effect palette                                                                                     |
  | `WaterLayer.ts`, `shaders/water.ts`                        | Sea plane: depth tint, waves, screen-scaled glints, shore foam; boat / nuke trails over water                                                                                 |
  | `StructureLayer.ts`                                        | Icons when zoomed out (`StructureIcons.ts`) fading into instanced models standing on pads fitted to the land and the relief; bars, level badges                               |
  | `UnitLayer.ts`                                             | Instanced ships, trains, nukes, shells and missiles (culled, low-poly when small); health bars; nuke / SAM ribbons (nuke contrails, or their owner's trail effect)            |
  | `RailTracks.ts` (owned by `UnitLayer`)                     | Railways: per-block ballast strips, sleepers and rails close up                                                                                                               |
  | `WakeLayer.ts` (owned by `UnitLayer`)                      | Ship wakes (lot 4, `three_wakes=1`): foam V and stern wash behind moving ships, one instanced draw over the sea                                                               |
  | `OverlayLayer.ts`                                          | Build ghost and range ring, nuke arc, nuke target rings, attack rings, move and blocked markers                                                                               |
  | `SpawnOverlay.ts`, `SamRings.ts` (owned by `OverlayLayer`) | Spawn halos; SAM range rings                                                                                                                                                  |
  | `FxLayer.ts`                                               | Explosions, mushroom clouds, shockwaves, smoke, sparkles; smoke over fallout zones (`FalloutField.ts`, kept by `TerrainLayer`)                                                |
  | `NameLayer.ts`                                             | Player names, troop counts, flags, attack labels, gold popups (DOM)                                                                                                           |
  | `FrontField.ts`, `LivingFront.ts` (lot 4, `three_front=1`) | Living front: capture stamps, border events and front segments (TerrainLayer's); smoke and sparks (FxLayer), attack arrows (OverlayLayer)                                     |
  | `NightLights.ts`, `shaders/night.ts` (lot 4)               | Night (`three_night=1`): moonlit environment, city lightmap and impact flashes (terrain, water), lit windows (structures), light names                                        |

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

## Facade methods (`MapRendererLike`)

What each method the game calls does in the 3D renderer (lot 2 state).
Every method exists (the facade implements `MapRendererLike`); "no-op"
ones are documented in the code and below.

| Methods                                                                                                                                     | 3D renderer                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setCameraState`, `createProjector`                                                                                                         | Camera rig and picking (`CameraRig.ts`)                                                                                                                                                                                               |
| `uploadTileAndTrailState`, `uploadLiveDelta`, `applyTerrainRects`, `rebuildTerrain`                                                         | Tile state (bounded uploads), terrain patches, trails' full push (`TerrainLayer`, `EffectTrails`)                                                                                                                                     |
| `updatePalette`, `updateRelations`, `setLocalPlayerID`, `setHighlightOwner`, `setAltView`                                                   | Territory colours, alt view (terrain, structure icons and models, trails); relations also feed the structures (ally colours)                                                                                                          |
| `addPlayers`, `updatePlayerCosmetics`, `initSkinAtlas`, `setPlayerSkin`, `setPlayerSpawn`                                                   | Names, flags, crowns (`NameLayer`); territory patterns and skins (`TerritoryCosmetics`); team mode from the players' teams                                                                                                            |
| `uploadLiveTrailDelta`, `updateEffectPalette`                                                                                               | Boat / nuke trails and the effect palette (`EffectTrails`), nuke ribbons in effect colours (`UnitLayer`)                                                                                                                              |
| `updateNames`, `refreshNames`, `setAttackTroopLabels`, `applyBonusEvents`                                                                   | Names, troop counts, attack labels, gold popups (`NameLayer`); `updateNames` also gives the SAM rings the local player's allies                                                                                                       |
| `updateUnits`, `updateStructures`, `applyDeadUnits`, `applyConquestEvents`, `setSelectedUnits`, `uploadRailroadState`                       | Units, structures (icons ↔ models), bars, badges, SAM ring inputs, FX, railways; the night's city lights (lot 4)                                                                                                                      |
| `setHighlightStructureTypes`, `updateGhostPreview`, `setSAMAllianceClusters`                                                                | Build-bar highlight (icons), build ghost (model + icon), range ring, SAM range rings                                                                                                                                                  |
| `updateNukeTrajectory`, `updateNukeTelegraphs`, `updateAttackRings`, `showMoveIndicator`, `triggerBlockedFlash`                             | `OverlayLayer` overlays                                                                                                                                                                                                               |
| `updateSpawnOverlay`, `updateSmallPlayerGlow`, `setGridView`                                                                                | Spawn halos, small-player glow, coordinate grid (see "Parity overlays")                                                                                                                                                               |
| `getSettings`, `dispose`                                                                                                                    | Render settings (read live by the layers), lifecycle                                                                                                                                                                                  |
| No-ops: `applyRailroadDust`, `setLocalRailColor`, `updateSpiralRibbons`, `setMapLayers` and the other map-layer methods, `setMouseWorldPos` | Not drawn: railway construction dust and rail colours, the spiral vortex, the decorative map layers (3 maps), hover effects. Defense coverage (`TerrainLayer.setDefenseCoverage`, fed by `updateStructures`) stays a no-op on purpose |

## Cosmetics support

| Cosmetic (catalog)                                 | Default renderer               | 3D renderer                                                                                |
| -------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| Flag, crown                                        | Name labels                    | Same (`NameLayer`, DOM)                                                                    |
| Territory pattern                                  | Territory pass                 | Same rules, draped (`TerritoryCosmetics`)                                                  |
| Territory skin                                     | Skin atlas                     | Same rules, draped, mipmapped (`TerritoryCosmetics`)                                       |
| Boat trail effect (gradient / transition / spiral) | Trail pass                     | Same colours on the ground and the sea (`EffectTrails`); spiral = its first colour         |
| Nuke trail effect                                  | Trail pass + spiral ribbons    | Ground track as above; the 3D aerial ribbon takes the effect colours; no spiral vortex     |
| Nuke explosion                                     | Shockwave / sparkles           | Shockwave ring with the cosmetic's radius, speed and first colour (`FxLayer`); no sparkles |
| Structure, warship, train, railway effects         | Structure / unit / rail passes | Not drawn (palette blocks 2-5 are mirrored, nothing reads them)                            |

## Structure icons

`StructureLayer` draws the default renderer's structure icons
(`StructureIcons.ts`, the look of `gl/passes/StructurePass.ts`) when zoomed
out, and fades them into the 3D models as you zoom in.

- **What an icon shows** (same rules as `structure.frag.glsl`): a shape
  per type (city circle, port pentagon, factory hexagon, defense post
  octagon, SAM square, silo triangle) and, above the default renderer's
  dots zoom (`structure.dotsZoomThreshold` device px per tile), the white
  glyph of `resources/atlases/icon-atlas.png` (loaded with `assetUrl`,
  `crossOrigin = "anonymous"`); fill = territory colour × `fillDarken`,
  ring = border colour × `borderDarken` (the territory colour for the
  local player); grey while under construction; the red X when marked for
  deletion; the build-menu highlight (white outline, other types dimmed);
  in the alt view, self / ally / enemy colours (render settings
  `affiliation`, the default renderer's "unit" row), on the models too.
  Ally colours need the relation matrix: `StructureLayer.setRelations`,
  fed with what the facade's `updateRelations` receives; without it every
  other player reads as an enemy, as in the default renderer before
  relations arrive. Not shown: the structures cosmetic effect (effect
  palette, see the cosmetics plan).
- **Size**: the default renderer's on the same screen. StructurePass
  works in device px (`iconSize × iconScale(zoom × dpr) × shape scale`),
  so on a 1× screen icons are 18 CSS px dots at full map (0.7 px per
  tile), 36 px at 1.8 and 60 px from 3 px per tile, times 1-1.55 per type.
- **Billboards**: anchored on the relief under the structure (the highest
  point under its footprint), screen-aligned and without depth test, so
  they stay upright and whole under tilt. They draw in the transparent
  queue after the models (renderOrder 15), before FX, the build ghost and
  rings (20 and up) and the status bars (60), and above units, as in the
  default renderer where structures draw after ground units.
- **Crossfade** (CSS px per tile; model weight w = smoothstep across the
  band; icon alpha = `iconAlphaAt(w)`: 1 over the first half of the band,
  then a smoothstep down to 0 as w goes from 0.5 to 1):

  | Zoom                                                                                     | default | `three_quality=low` |
  | ---------------------------------------------------------------------------------------- | ------- | ------------------- |
  | Icons only: no model, no shadow                                                          | < 2.5   | < 3.5               |
  | Band: icons fade and shrink to the model footprint, low-poly models grow from the ground | 2.5-5   | 3.5-7               |
  | Models only                                                                              | > 5     | > 7                 |

  Models switch on at the band start and off only below start / 1.1, each
  switch costing one rebuild; they appear at 35% width and 15% height
  under an opaque icon, so nothing pops, and no structure material is
  transparent. The icons stay opaque until the models are about two thirds
  of their size (w = 0.5, 3.75 px per tile; 0.8 opacity at 4, 0.1 at
  4.5): with `1 − w` (the first version) the verify screenshots showed the
  structures at 4 px per tile as a third-opaque icon over a 15-20 px
  model, readable by neither type nor owner. The full models replace the low-poly ones at 5 px per tile
  (12 in low quality), so in the default quality low-poly models are only
  drawn inside the band.

- **Level badges and progress bars** show above the dots zoom (like the
  default renderer's level numbers), anchored above the icon when zoomed
  out and above the model when zoomed in, gliding with w; the icons draw no
  number, so each level shows once. Known differences: the default draws
  its progress bars below the icon and at every zoom (they are 14 × 3
  tiles in world space), the 3D ones above it and only from the dots zoom
  on; the build-bar highlight dims the default's level numbers of the other
  types, not the 3D badges.
- **Build ghost**: while the icons show, the ghost is an icon too
  (StructurePass's ghost: the structure's icon at 50% opacity, mixed
  half-way to green when upgrading, to red when it cannot be built), plus
  the same icon on the structure being upgraded; it follows the icons'
  size and crossfade (a second `StructureIcons` instance sharing the
  atlas, renderOrder 16, nothing done without a ghost). OverlayLayer's 3D
  ghost model and its footprint frame stay; the model follows the
  structures' crossfade (hidden while they are icons, growing in with
  them). The facade's `updateGhostPreview` feeds both.
- **Picking** is unchanged: clicks go through the projector to a tile, and
  the icons take no part in it.
- **Costs**: see "Performance notes".

## Parity overlays: spawn halos, small-player glow, SAM rings, grid

The default renderer's spawn overlay, small-player glow, SAM range rings and
coordinate grid, with the same semantics (what is shown, when, to whom,
colours and animation from `render-settings.json`), draped on the relief.
Everything on the ground drapes on the **drawn surface**: `TerrainLayer` is
the `ReliefSurface` (`types.ts`) the overlays get, whose `surfaceAt`
interpolates the relief mesh's own triangles (coast lift included) and
clamps to the sea plane, so draped geometry matches what is on screen.

- **Spawn halos** (`updateSpawnOverlay`, `SpawnOverlay.ts`, port of
  `SpawnOverlayPass`). Who is listed is decided by
  `WebGLFrameBuilder.syncSpawnOverlay`: during the spawn phase every spawned
  human (the local player, teammates, others); after it only the local
  player while the tutorial keeps its ring up (`setOwnSpawnRing`); an
  empty list hides everything. Local player: a halo breathing between ×0.5
  and ×1.15 of 10 → 30 tiles, opacity 65 → 100%, pulsing white → gold (own
  territory colour in team games), inner part transparent so the territory
  shows. Teammates: a 5 → 14 tile halo in their colour. Others: their
  colour on the unowned tiles within 9 tiles of their spawn. Drawn
  others → teammates → self. Breath: `spawnOverlay.animSpeed` (0.008
  rad/ms, ~0.8 s) of local time. 3D: each centre gets a patch of the relief
  grid around it (the terrain mesh's own vertices, clamped to the sea
  plane, same triangulation), one merged mesh with a polygon offset, so the
  halo lies exactly on slopes, coasts and sea and relief in front hides it
  under tilt; unlit, and the local halo has a 1.25 HDR gain (a soft glow
  under bloom). The phase itself still makes tile uploads immediate.
- **Small-player glow** (`updateSmallPlayerGlow`, `SurfaceOverlay.ts`, port
  of `SmallPlayerGlowPass`). The set (1 byte per owner smallID) is pushed
  by `WebGLFrameBuilder.syncSmallPlayerGlow`: alive humans with ≤ 0.2% of
  the land, after the first minute, rescanned every 10 ticks; null = none.
  A soft red aura (`smallPlayerGlow.color`, alpha 0.9) over and around
  their territory, breathing (`pulseSpeed`), faded by the `strength`
  graphics setting read live (0 = off). The mask is built on the GPU like
  the default renderer, only when a set is pushed: an extract pass marks
  each 4×4-tile block holding a highlighted owner, then a 5-tap separable
  blur, into a W/4 × H/4 RGBA8 target pair (World: 500×250).
- **Coordinate grid** (`setGridView`, `SurfaceOverlay.ts`, port of
  `CoordinateGridPass`). Shown while the grid view is on (M key; the
  toggle is remembered in localStorage `renderer:grid_view_enabled`, the
  default renderer's key) or the alt view is held (space). White lines
  (`mapOverlay.coordinateGridOpacity`) on cells of `gridCellSize(W, H)`
  tiles (about 10 across the short side, at most 50 columns), and a label
  per cell (rows A, B, … AA…, columns 1, 2, …; letters and numbers, so no
  `translateText`) at its top-left once a cell spans 60 device px, font
  `altView.gridFontSize` grown with the zoom as the default. 3D: lines are
  anti-aliased with `fwidth`, so they stay ~1.25 px wide across a tilted
  view; labels are stretched along the view by 1 / cos(tilt) so they read
  upright.
- Grid and glow are computed per fragment from the world position: on land
  (and on the coastal water the relief draws itself) by the terrain shader
  (a delimited block of `shaders/terrain.ts`, after lighting, before fog),
  on open water by a sea-level plane over the map (`sea-overlay`, 2
  triangles, drawn right after the water and behind the relief), since the
  water is a separate translucent plane above the seabed. Being painted on
  the ground, they sit under what stands on it (3D models, units, structure
  icons), where the default renderer draws the glow over structures and
  the grid over everything but names.
- **SAM range rings** (`setSAMAllianceClusters`, `SamRings.ts`, port of
  `SamRadiusPass`). Shown while a ghost of a SAM launcher, missile silo,
  city, atom or hydrogen bomb is placed, or while the build bar highlights
  SAM launchers or bombs (`setHighlightStructureTypes`). A dashed ring of
  `samRange(level)` tiles around every active SAM launcher (from
  `updateStructures`), green for the local player, yellow for allies and
  teammates (from `updateNames` and the players' teams), red otherwise;
  rings of one side merge by circle union (only uncovered arcs are drawn).
  A SAM being upgraded shows its growing radius and the target radius
  (its side gets a faint preview ring), refreshed at 20 Hz. Look from
  `samRadius` (stroke ±1.5 tiles, 12/6-tile dashes rotating at 14 tiles/s,
  alpha 0.8). The alliance clusters only matter in the default's "owner"
  colour mode, which is ported but which nothing switches on. 3D: each arc
  is a ribbon 4 tiles wide with 5 vertices across, columns every half grid
  step (at least 1 tile), each vertex at the drawn surface + 0.4 tile, with
  a polygon offset. On the World map that keeps every ribbon above the
  relief (never below, < 1 tile above on the sharpest ridges, ~0.4
  typical); columns on flat runs (sea, plains) are dropped down to the
  circle's polygon resolution. Dashes, rotation and smoothing are in the
  fragment shader; heights are cached per circle until the relief changes.
- **Ghost range ring** (the build-time ring of `RangeCirclePass`: SAM, atom
  / hydrogen bomb, factory and defense post ranges, white or red when the
  nuke would break an alliance) was already drawn by `OverlayLayer`; its
  polar grid is now ~2 tiles apart on the rim with a 1-tile band of rings
  where the stroke is (it dipped up to 1.3 tiles under ridges with ≤ 96
  segments and 3-tile rings), and the fill is closer to the default's 20%
  white (`RANGE_FILL_ALPHA`).
- `setDefenseCoverage` stays a no-op (see `TerrainLayer`).
- **Costs** (headless, World, measured on the JS side; GPU time needs a
  real GPU). Nothing is drawn or computed while an overlay is off: no draw
  call, no mask pass, no ring build, and the terrain shader skips its block
  on a uniform branch.

  | Overlay (when shown)                         | Draw calls                         | Triangles (high / low)                | JS (high / low)                     |
  | -------------------------------------------- | ---------------------------------- | ------------------------------------- | ----------------------------------- |
  | Spawn halos, 1 self + 1 teammate + 30 others | +1                                 | 10.5k / 3.0k (self alone 2.6k / 0.6k) | 0.8 / 0.15 ms when a spawn moves    |
  | Small-player glow                            | +1 (sea plane), +3 per pushed set  | 2                                     | < 0.02 ms per push or frame         |
  | Coordinate grid                              | +1 (sea plane, shared w/ the glow) | 2                                     | < 0.01 ms per frame                 |
  | SAM rings, 60 launchers                      | +1                                 | 51k / 32k                             | 1.1 / 0.8 ms per rebuild, see below |
  | Ghost range ring, radius 118 / 70 / 30       | unchanged                          | 10.8k / 4.2k / 1.0k (by radius)       | 0.9 / 0.4 / 0.15 ms per cursor move |
  - An unchanged spawn list (pushed every tick) costs 0.04 ms.
  - The glow's 3 off-screen passes run once per pushed set (~1/s) over
    W/4 × H/4 texels; its two targets take 1 MB on World, the set texture
    4 KB. The grid's label atlas takes 216 KB.
  - SAM rings: the first build samples the heights at 2-3 ms of JS per
    frame (13 frames on high, 5 on low) and shows the rings when all are
    in; its last frame fills the buffers (up to ~11 / 4 ms the first time).
    Later rebuilds (allies or launchers changed) take 1.1 / 0.8 ms, and a
    SAM being upgraded rebuilds every 50 ms (1.9 / 1.0 ms) while shown.
  - Ghost range ring: was 6.0k / 3.0k / 0.6k triangles; rebuilt as the
    cursor moves, like before.

  Per fragment while shown: the terrain shader adds one glow-mask sample
  and the grid math (one glyph sample on label pixels); the sea plane does
  one `texelFetch` (land test) plus the same on water pixels.

## Territory cosmetics: patterns and skins

`TerritoryCosmetics.ts` (owned by `TerrainLayer`) draws the paid territory
cosmetics in the terrain shader's fill, with the default renderer's
semantics (`gl/shaders/map-overlay/territory.frag.glsl` lines 69-113,
`gl/passes/SkinAtlasArray.ts`, the pattern and skin code of
`gl/Renderer.ts`). The facade's `addPlayers` / `updatePlayerCosmetics`
(`patternMeta`, `patternData`), `initSkinAtlas`, `setPlayerSkin`,
`setPlayerSpawn` and the players' teams feed it; nothing changed in
`WebGLFrameBuilder`.

- **What is shown, when, to whom**: what the frame builder pushes, i.e.
  the cosmetics each player shows under the cosmetics visibility settings
  (`visibleCosmetics`, refreshed through `updatePlayerCosmetics`). Both are
  gated by `passEnabled.territoryPatterns` (render settings, debug GUI; read
  live), drawn in the normal view only (the alt view shows relation
  colours) and never on fallout tiles.
- **Pattern**: the bitmap (`writePatternEntry` layout: width, height, scale
  per player, 1024 bytes of bits) repeats in tile space from the map
  origin, one bit per 2^scale × 2^scale tiles; a set bit paints the
  player's secondary colour (palette row 1), a clear bit the fill colour.
  Same integer math as the default (bit `(y >> s) mod h · w + (x >> s) mod
  w`), same orientation, and like the default it is not faded at any zoom
  (at full map the motif is a few pixels per period).
- **Skin**: one 1024 × 1024-tile layer per unique URL of the game (the
  player set is locked at game start), the image drawn centred into it,
  downscaled to fit, never upscaled; it is stamped once, centred on the
  player's spawn tile (UV 0.5), plain fill outside it; blended into the
  fill by the image alpha, raw colours in free-for-all, multiplied by the
  territory colour in team games (any player with a team). A skin overrides
  the pattern. Images load late (the layer reads as transparent, so the
  plain fill shows, until it arrives); one that fails (CORS, 404) stays the
  plain fill and logs the default's warning (`Skin image failed to load`).
  Unregistered URLs are ignored, as in the default.
- **3D adaptation**: both are looked up per tile (the tile under the
  fragment) after the fill colour is read and before saturation, highlight
  and lighting, exactly where the default modifies its fill, so they drape
  on the relief by construction and are lit like the plain fill (same
  hillshade, same territory alpha over the ground, Neutral tone mapping
  keeps the colours below ~0.8). The skin keeps the default's
  tile-quantised UV (one texel per tile: blocky close up, like the
  default), but its mip level comes from `textureGrad` with the fragment's
  world-space derivatives, so tilted views pick the right level (4×
  anisotropic filtering where available).
- **Data**: one RGBA32F texel per owner (`uCosmeticMeta`, 4096 × 1):
  `(0, …)` none, `(1, width, height, scale)` pattern, `(2, layer, anchor x,
  anchor y)` skin; the pattern bits (`uPatternBits`, R8UI 1024 × 4096, the
  facade's `patternData` copied); the skin atlas (`uSkinAtlas`, a
  `THREE.DataArrayTexture`, RGBA8, mipmapped, clamped). The anchor (0, 0)
  before a spawn is known is the map origin, as in the default.
- **Lifecycle**: the same URL list again (`initSkinAtlas` after a context
  restore, `WebGLFrameBuilder.clearCaches`) keeps the loaded layers; a
  different list rebuilds the atlas. After a context restore three
  re-uploads every texture from its CPU copy (the next frame clears pending
  layer updates so the whole atlas goes up). `dispose` cancels pending
  loads; an image arriving later is dropped.
- **Testing locally**: `localStorage["dev-pattern"]` (base64url bitmap,
  plus `dev-primary` / `dev-secondary`) and `localStorage["dev-skin"]` (an
  image URL; it must load with CORS) equip a pattern / skin in solo games,
  in both renderers (`UserSettings.getDevOnlyPattern` / `getDevOnlySkin`,
  read by `getPlayerCosmetics` like `dev-crown`). A `data:` URL does not
  work: `assetUrl` only passes `scheme://` URLs through.
- **Costs** (GPU-independent; World map, headless):

  | Item                                       | Cost                                                                                                                                                                                                                                       |
  | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | Per owned-land fragment (normal view)      | +1 `texelFetch` (meta) when any player has a cosmetic, 0 otherwise (uniform switch); the default renderer always pays 2                                                                                                                    |
  | Pattern owner                              | +1 `texelFetch` (bits), +1 on secondary bits (palette row 1); as the default                                                                                                                                                               |
  | Skin owner                                 | +1 trilinear (anisotropic) sample from the atlas; the default: +1 `texelFetch` (anchor) + 1 sample                                                                                                                                         |
  | Draw calls / triangles                     | none added (the terrain draw, 9 samplers instead of 6)                                                                                                                                                                                     |
  | VRAM                                       | meta 64 KB; pattern bits 4 MB once a player has a pattern (0 before; the default always 4 MB); 5.33 MiB per skin layer                                                                                                                     |
  | CPU memory                                 | the same copies: 4 MB pattern bits, 4 MB per skin layer (three re-uploads them after a context restore)                                                                                                                                    |
  | JS, `addPlayers` / `updatePlayerCosmetics` | ~0.2-0.3 ms (4096 slots compared and packed); the first pattern allocates the bits (~1.7 ms), uploaded whole in the next render; later changes upload only the changed rows. Headless game start (pattern + skin): 3.5 ms max, 6 ms in all |
  | JS, `initSkinAtlas`                        | ~0.4-0.5 ms (layers allocated zeroed), then per image on load: draw + read-back + copy, 15 ms headless (SwiftShader host, once per skin)                                                                                                   |
  | Per frame                                  | one uniform write; nothing else                                                                                                                                                                                                            |

  Counters (`perfStats`, layer `terrain`): `patternPlayers`,
  `skinPlayers`, `skinLayers`, `skinLayersLoaded`, `skinLayersFailed`,
  `skinMB`, `patternMB`, `cosmeticsMB`, `patternRowUploads`,
  `patternRowsUploaded`, `skinDecodeMsMax` / `skinDecodeMsTotal`,
  `cosmeticsSetupMsMax` / `cosmeticsSetupMsTotal`.

- **Parity check** (headless, same spawn tile, full map and zoom 1.8, 4, 8,
  20 in both renderers): the pattern's motif sits on the same tiles with the
  same orientation at every zoom; the skin is placed identically (grid
  lines, bars, the transparent band showing the fill colour), wins over a
  pattern, falls back to the plain fill on a CORS failure, and survives a
  `WEBGL_lose_context` loss and restore. Colours are the 3D fill's: the
  same hues, a little darker and more saturated where the hillshade and the
  3D ground under the 59% fill differ from the 2D map (as for plain fills).
- **Not done yet**: spiral nuke-trail vortexes, nuke explosion styles, the
  railway effect and the warship, train and structure effects are not
  drawn. The effect palette and the boat / nuke trails are (next section).

## Cosmetic effects: boat and nuke trails, effect palette

`EffectTrails.ts` draws the default renderer's boat and nuke trails
(`gl/passes/TrailPass.ts`, `gl/shaders/map-overlay/trail.frag.glsl`) with
the cosmetic effect palette, and colours the nukes' aerial ribbons by the
same palette. One instance per map, shared (refcounted) by `TerrainLayer`
(paints the trails on the relief, sends the uploads, reports the
counters), `WaterLayer` (paints them on the sea) and `UnitLayer` (the
ribbons). The facade's `uploadTileAndTrailState`, `uploadLiveTrailDelta`,
`updateEffectPalette` and `updateRelations` feed it; nothing changed in
`WebGLFrameBuilder`, `GameView` or `TrailManager`.

- **What is shown, when, to whom** (unchanged): the trail buffer of
  `frame/TrailManager.ts`, stamped every tick for transport ships and
  nukes (atom, hydrogen, MIRV and its warheads; a nuke only up to its last
  tile, so the trail never leads the missile): owner in bits 0-11, bit 12
  = nuke trail. A tile keeps its trail while a trail claiming it lives (the
  whole path, no fade) and is cleared when its last claimant dies; every
  player sees every trail. Colour (`trailColorAt`, the TS twin of the
  shader): in the alt view the owner's "unit" affiliation colour (self /
  ally / enemy, the default's `AffiliationPalette` row 1) and no effect;
  otherwise the owner's effect for the trail's kind (block 0 =
  `transportShipTrail`, block 1 = `nukeTrail`): none = the territory colour
  (palette row 0); one colour = flat; gradient = cyclic bands along the
  world diagonal x + y, `colorSize` tiles each, scrolling at
  `movementSpeed` tiles/s; transition = the whole trail cross-fading
  through the list `frequency` times a second; spiral = its first colour
  (the ground centreline). At `mapOverlay.trailAlpha` while
  `passEnabled.trail` is on (both read live, debug GUI).
- **Effect palette** (`updateEffectPalette`, pushed by
  `WebGLFrameBuilder.syncPlayerEffects` when a player's equipped effects
  resolve from the catalog, or when the debug GUI's Effect Editor overrides
  the local player's): the RGBA32F 4096 × 48 array (6 blocks of 8 rows:
  boat trail, nuke trail, structures, warship, train, railway; layout of
  `EffectPalette.packEffectEntry`), mirrored as is into one `DataTexture`
  (`EffectPaletteTexture`) shared by the terrain, water and ribbon
  shaders. Re-uploaded whole on each push, like the default (pushes are
  rare). Only the two trail blocks are drawn so far.
- **Nuke ribbons** (`UnitLayer`'s `TrailRenderer`): a nuke whose owner has
  a nuke-trail effect gets a ribbon in the effect's colours, looked up per
  fragment at the ribbon's world x / z with the same palette, style and
  clock as the ground track under it (a gradient's bands line up with the
  track's; a transition changes colour in step), composited over the
  scene at 85% opacity × the ribbon's taper, with a little extra emission
  (×1.5) for the bloom. A SAM missile's ribbon is unchanged: the warm
  additive glow (one material, premultiplied blending: alpha 0 adds,
  alpha > 0 is "over"). Without an effect, and in the alt view, a nuke's
  ribbon is a contrail behind a short glow and the bombs are capped on
  screen (see "Lot 3: names close up, structure bases, bombs in flight").
- **3D adaptation**: the trail is painted per tile by the ground shaders
  (`EFFECT_TRAILS_GLSL`), so it drapes on the relief and lies on the
  waves: on land, and on the coastal water the relief draws itself, by the
  terrain shader (a delimited block of `shaders/terrain.ts`, after
  lighting, before the surface overlays and fog); on open water by the
  water shader (a delimited block of `shaders/water.ts`, "over" the
  translucent water and what shows through it). Both composite the same
  colour, lit flat (`diffuseLight(UP)`, like a fill on flat ground), at
  `trailAlpha`, so the trail is seamless across the shoreline and keeps
  its colour on slopes and under tilt; waves still show through it at the
  default's 41%. Boats float on their trail; the trail sits under the 3D
  units, structures and icons, under the small-player glow and the grid
  (the default draws it over structures and the glow, under the grid).
- **Uploads** (bounded, nothing dropped): the facade only gets a row range
  per tick (TrailManager's min..max row over every stamped tile: on World
  ~600 rows at the median, up to the whole map), so a tick only marks those
  rows. Each frame, `TerrainLayer.update` diffs up to 512k texels of marked
  rows (`TRAIL_DIFF_BUDGET`, whole rows, from where the last frame stopped)
  against the CPU mirror the texture is uploaded from, 4 tiles per compare
  (`TRAIL_WORD_COMPARE`: a float64 compare is exact because trail texels
  never set bit 15). A changed tile marks its 16×16-tile cell dirty in a
  `TileUploadQueue` (lot 1), and the same frame sends at most 8 merged
  rectangles and 128k texels (`TRAIL_UPLOAD_BUDGET`, one `texSubImage2D`
  each through `TextureRectUploader`), the rest in the next frames in scan
  order. A row is unmarked only once diffed and a cell marked clean only
  once a rectangle covering it was sent, from the mirror's latest values,
  so the GPU copy always converges to the live buffer. The full push
  (`uploadTileAndTrailState`: first tick, context restore) and a queue past
  half the map are one immediate full upload. The default renderer instead
  sends the whole row band (full map width) every tick.
- **Switches**: the ground shaders skip the trail fetch while no tile
  holds a trail (an exact count kept by the diff) or `passEnabled.trail`
  is off, and every effect lookup while no player has a trail effect
  (`uEffectsOn`); the ribbon shader the same for nuke-trail effects. The
  effect palette texture is a 1×1 placeholder until a push holds an
  effect (the default always allocates its 3 MiB).
- **Testing locally**: the debug GUI's Effect Editor (Settings →
  Development only → debug GUI) overrides the local player's effects in
  both renderers. A palette can also be pushed from the console with the
  game's own packing, e.g. in a dev build:
  `const pp = await import("/src/client/render/gl/utils/PlayerPalette.ts")`,
  fill a `Float32Array(4096 * 48 * 4)` with `pp.writePlayerEffects(pal,
  sid, (type) => attrs[type], { setNukeTrailSpiral() {},
  clearNukeTrailSpiral() {} })`, then `__webglView.updateEffectPalette(pal)`
  (the frame builder only pushes again when an effect resolves).
- **Costs** (GPU-independent; World map, 2000 × 1000):

  | Item                                 | Cost                                                                                                                                                                                                                                                                                                                                             |
  | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | Per ground fragment                  | +1 `texelFetch` (R16UI trail) on terrain fragments (land and coastal water) and sea-plane fragments inside the map, only while a tile holds a trail; 0 otherwise. The default: a full-screen pass with 1 fetch per pixel, always                                                                                                                 |
  | Per trail fragment                   | + the colour: no effect 1 fetch (palette), +1 while any player has a trail effect; flat 1, spiral 2, transition 5, gradient 6; alt view 1 (affiliation). About the default's own counts                                                                                                                                                          |
  | Per ribbon fragment                  | 0 without a nuke-trail effect in the game; else 1 (owner without one), 2, 5 or 6                                                                                                                                                                                                                                                                 |
  | Draw calls / triangles               | none added (in the terrain and water draws; the default adds a full-screen pass). Terrain shader: 12 samplers (was 9), water: 5 (was 1)                                                                                                                                                                                                          |
  | VRAM                                 | trail texture W × H R16UI (3.8 MB, as the default), alt-view colours 16 KB, effect palette 3 MiB once a player has an effect (the default: always)                                                                                                                                                                                               |
  | CPU memory                           | the trail mirror W × H × 2 (3.8 MB; the default keeps none, it uploads from TrailManager's array), the effect palette mirror (3 MiB, once allocated)                                                                                                                                                                                             |
  | Uploads per frame                    | at most 8 `texSubImage2D` and 128k texels (`trailUploadCallsLastFrame`, `trailTexelsLastFrame`); see the measurements below                                                                                                                                                                                                                      |
  | JS per tick (`uploadLiveTrailDelta`) | marking the reported rows: ≤ 0.1 ms. Diffing them there instead cost 0.9 ms at the median, 2.2 ms p99 and up to 10 ms per tick in a headless late game                                                                                                                                                                                           |
  | JS per frame                         | the diff: at most `TRAIL_DIFF_BUDGET` (512k texels, ~0.3-0.6 ms once the JIT is warm, up to ~1.3 ms under the harness's load; the very first diff of a page ~10 ms), the rectangles' uploads, a few uniform writes; the alt-view colours are rebuilt (4096 owners) only while the alt view is held and the relations or the local player changed |
  | JS, `updateEffectPalette`            | copy + count (786k floats), well under 1 ms, rare                                                                                                                                                                                                                                                                                                |

  Counters (`perfStats`, layer `terrain`): `trailsOn`, `trailTiles`,
  `trailUploadCallsLastFrame`, `trailTexelsLastFrame`,
  `trailUploadCallsMax`, `trailTexelsMax`, `trailPendingCells`,
  `trailPendingTexels`, `trailUploadCallsTotal`, `trailTexelsTotal`,
  `trailFullUploads`, `trailDeltas` (row ranges received),
  `trailPendingRows` (rows still to diff), `trailScannedTexelsLastFrame` /
  `trailScannedTexelsTotal`, `trailDiffMsLastFrame`, `trailDiffMsMax` /
  `trailDiffMsTotal` (per frame, `three_perf` only), `trailMB`,
  `effectBoatPlayers`,
  `effectNukePlayers`, `effectPlayers`, `effectPaletteUploads`,
  `effectPaletteMB`, `trailAffiliationRebuilds`; layer `units`:
  `nukeEffectRibbons`.

  Headless late game (World, 30 bots, ~1,200-1,400 ticks, 13-18
  transports in flight; `three_perf`): a tick reports 413-604 rows at the
  median, 809-886 at p90 and up to 972 (of 1,000), i.e. up to the whole map
  each tick, where the default renderer uploads that band every tick. The
  frames then diffed 524k texels each (whole rows) and sent 0-6 rectangles
  of 0-55k texels, leaving no cell queued (the harness draws a frame every
  ~4 s, so marked rows pile up between frames there). Projected to 60 FPS
  (a tick every 6 frames): a median tick's rows are diffed within 2 frames,
  a p90 one within 4.

- **Parity check** (headless, same spawn tile in both renderers, World):
  six synthetic trails across a coastline (the game's own
  `writePlayerEffects`: gradient and flat boat trails, transition and
  spiral nuke trails, two owners without an effect) at zoom 1.8, 4, 8
  and 20; a real transport ship and an atom bomb of a player with a
  gradient boat trail and a transition nuke trail, paused mid-flight.
  Same tiles, widths, band sizes and colours in both (the 3D ones a
  little darker on water, lit like the sea, and a little paler on bright
  lit relief), seamless across the shore, draped under tilt; the alt view
  shows self / enemy colours without effects in both. The 3D ribbon of a
  bomb with an effect takes the ground track's colours, and stays the warm
  glow without one. No console errors.
- **Context restore**: three re-uploads the trail, palette and alt-view
  textures from their CPU copies; `ClientGameRunner` re-pushes the full
  trail state (`uploadTileAndTrailState`), which clears the pending rows
  and cells, and `WebGLFrameBuilder.clearCaches` re-resolves the effects
  (the mirror keeps the last palette meanwhile).
- **Not drawn yet**: the spiral vortex (`updateSpiralRibbons`, the
  default's `SpiralRibbonPass`; a spiral nuke trail shows its first
  colour, on the ground and on the ribbon), the structures, warship, train
  and railway effects (blocks 2-5 are mirrored but unused), nuke explosion
  styles beyond the first colour, size and speed (FxLayer).

## Readability at distance (lot 3)

Zoomed out, who owns what reads at a glance (like the default renderer's
flat map), the coasts are a thin line, the map no longer ends in a
straight cut, and railways no longer read as borders. Close up (from ~5
CSS px per tile; borders from 8) the look is the lot-2 one. The curves are
pure helpers in `TerrainShading.ts` (`territoryLook`, `shoreViewScale`,
`edgeReachTiles`, `apronWidthTiles`, `apronReachZoomScale`, `mirrorIntoMap`,
`apronWarp`, `virtualLandReach`, `apronWaterMagnitude`, `apronFillFade`)
and `RailTracks.ts` (`railStripLook`), unit-tested;
the GLSL is in delimited `lot 3` blocks of `shaders/terrain.ts` and
`shaders/water.ts`.

- **Territories** (`territoryLook`, set by `TerrainLayer.update` from the
  zoom at the screen centre, `FrameInfo.cssPxPerTile`, and the pixel
  ratio). Strategy weight `far` = 1 − smoothstep(1.25, 5, zoom); the
  border grows over 1.25-8.

  | CSS px per tile          | Fill opacity | Border, CSS px (tiles) | Hillshade flattened on owned land | Alt-view fill |
  | ------------------------ | ------------ | ---------------------- | --------------------------------- | ------------- |
  | ≤ 1.25 (full map: 0.7)   | 0.82         | 2.4 (1, the maximum)   | 35%                               | 0.55          |
  | 1.8 (default zoom)       | 0.81         | 2.4 (1)                | 33%                               | 0.54          |
  | 3                        | 0.72         | 2.2 (0.74)             | 19%                               | 0.48          |
  | 4                        | 0.63         | 2.0 (0.5)              | 6%                                | 0.43          |
  | ≥ 5 (≥ 8 for the border) | 0.588        | 1.3 (0.2 minimum)      | 0                                 | 0.4           |

  The fill opacity close up is `mapOverlay.territoryAlpha` (never
  lowered); "flattened" means that share of the hillshade (sun +
  hemisphere light and slope occlusion) is replaced by flat light on owned
  tiles, so a territory reads as one colour while the relief still shows
  (unowned land keeps all of it). At the default zoom the border is one
  full tile, like the default renderer's.

- **Alt view** (space). The ground is still desaturated, but owned land is
  dimmed to 82% and unowned land to 50% (it was 60% for both), the
  affiliation fill is 0.4-0.55 (above; was 0.3) or twice
  `altView.fillAlpha` if larger, and the affiliation border colour is
  lifted towards white (× 1.15 + 0.12): neutral (grey) territory and its
  borders were nearly invisible on the darkened terrain, they now read as
  lighter grey areas with light borders.
- **No border along the map edge**: the shader's `ownerAt` clamps to the
  map, so an edge tile's owner continues past it (the default renderer
  draws a border there); the territory fill stops at the edge instead
  (below), which keeps the playfield's limit readable.
- **Map-edge apron** (`TerrainLayer`, `shaders/terrain.ts`). Around the
  map, part of the terrain mesh (same draw call): a strip per edge sloping
  from the edge vertices (never below `COAST_LIFT`) down to `COAST_LIFT`
  over `APRON_SLOPE_TILES` (8), so land at the edge meets it without a
  cliff, then flat to `apronWidthTiles` (World: (2 + 0.15 + 1) × 18 + 8 =
  65 tiles). Picking is unchanged (rays off the map return NaN, as
  before; the apron is not in the height field). It also keeps tilted
  views from looking under the relief: the vertical skirts that hung from
  the map edges before were left under it, always hidden but still drawn
  (and shaded) first, and the perf triage removed them.
  - **Lookups**: the shader looks tiles up at the point mirrored at the map
    border (`mirrorIntoMap`), so the land and coasts continue past the edge
    (no stretched edge row), after warping the point more with the
    distance past the edge (`apronWarp`: ± 0.45 × the distance, capped at
    `APRON_WARP_CAP` 20 tiles, two value noises of a 40-tile period;
    `APRON_WARP_GAIN` 0.9 keeps the mapping fold-free): near the edge the
    land continues, farther out it is no recognisable mirror image (the
    first version showed symmetric "Rorschach" islands).
  - **Virtual coast** (`virtualLandReach`): the land reaches the mean reach
    `edgeReachTiles` (0.9% of the longest side, 8-32 tiles; World 18, ~13 px
    at full map) × 0.15-2 (two low-frequency octaves stretched over
    `APRON_REACH_NOISE` [0.25, 0.75]) ± 0.15 (`APRON_RAGGED`, a finer
    octave): along the edge some land dies at once and some runs far, so
    the break-up no longer runs parallel to the edge at a constant
    distance. Close up the mean reach shrinks (`apronReachZoomScale`: × 1 up
    to 2 CSS px per tile, × `APRON_ZOOM_NEAR` 0.4 from 8): the made-up land
    stays a fringe of a few dozen px instead of whole islands.
  - **Fill**: the territory fill fades out within max(1.5 tiles, 6 device
    px) past the edge (`apronFillFade`): the playfield's limit stays
    readable, edge owners do not look bigger, and in the alt view the
    affiliation colours stop at the grid's rectangle. No borders, trails,
    grid or glow there.
  - **Land**: it fades like a page margin, desaturated (up to 50%), dimmed
    (20%) and blended into the sea (45%, + 30% just before the virtual
    coast) with the distance; in the alt view it is dimmed a further 30%.
  - **Water**: the mirrored water's magnitude, or past the virtual coast
    its distance from it, whichever is deeper (`apronWaterMagnitude`): a
    shelf like a real coast's (the same shallows and foam, narrowed zoomed
    out by `shoreViewScale`), never the wide pale band of shallows the
    first version drew along the whole edge; open sea within the mean
    reach + 8 tiles of the coast, shaded as WaterLayer's off-map plane,
    which takes over at the ring's rim (seamless).
  - **Seam**: inside the map the relief's shading fades to flat over the
    last `EDGE_FLAT_TILES` (3) tiles, so under tilt it meets the flat-lit
    apron without a straight seam across the land.
- **Railways** (`railStripLook`). The default renderer's RailroadPass
  hides railways at `railMinZoom − railFadeRange` = 1 device px per tile
  and below and fades them in linearly up to `railMinZoom` = 3 (render
  settings `railroad`, read here as constants, checked by a test). The 3D
  strips follow that fade × 1.5 (the strip is half a tile wide, the
  default's line a full tile), times the lot-1 light → ballast ramp:
  hidden at full map (0.7 CSS px per tile on a 1× screen: the strip mesh
  is not drawn at all), 33% opacity at 1.8 (was 55%), the lot-1 look from
  ~2.3 device px per tile (55% at 2.4, 67% at 3, opaque ballast at 5), so
  the network still shows at the default zoom as a faint light line rather
  than a border. On a 2× screen the same device px come at half the CSS
  zoom. Rebuilds keep running while the strips are hidden. Differences
  with the default: the 3D strip keeps its neutral light colour (the
  default colours rails by owner: border colour, the local player's rail
  colour), because `RailTracks` has no owner data.
- **Costs** (GPU-independent; World map). Draw calls: unchanged by the
  territory, halo and apron changes (the apron is in the terrain draw);
  railways −1 draw call at and below 1 device px per tile. Triangles: the
  apron adds 2 × (2 (cols − 1) + 2 (rows − 1)) + 16 = 6,016 (World, high
  quality; 3,016 with `three_quality=low`), and since the perf triage the
  skirts it hides are gone (−6,000 / −3,000): +16 triangles over lot 2;
  the hidden strips save their ~2.5 triangles per piece (slack included).
  Texture memory: none added. JS: `territoryLook` and three uniform writes per frame, the
  apron's inner row refreshed with the edge vertices on terrain patches.
  Per fragment, by static count: owned land, zoomed out: one more
  `diffuseLight` (ALU, a uniform branch, skipped from 5 px per tile);
  water: one smoothstep; apron fragments run the terrain shader instead
  of the water plane's (which the apron hides): 5 value noises (20
  hashes: 2 for the warp, 3 for the reach), the 5 terrain fetches the
  terrain shader always does (the tile, the 4 bilinear neighbours), the
  water shading, plus the land shading where the virtual land is; no
  border fetches there. Map fragments: a min and a smoothstep for the edge
  flattening (a normalize within 3 tiles of the edge). The edge tiles no
  longer test bounds in `ownerAt`. The apron shares the map's one call of
  `shadeLandTile` and of `shadeWater` (perf triage: its own calls had
  inlined a second copy of both, see "Performance notes").

- **Measured** (headless, SwiftShader, 1920 × 1032, high quality; the
  same recorded game state pushed through the facade before and after:
  World, a seeded 50-bot + nations game recorded at tick 3,242 (44 players,
  1.6k railway pieces) and at tick 19,405 (35k railway pieces)):

  | View (CSS px per tile)      | Draw calls                     | Triangles                        | Railway strip triangles |
  | --------------------------- | ------------------------------ | -------------------------------- | ----------------------- |
  | Full map (0.7), 35k pieces  | 24 → 23                        | 1,135k → 1,053k                  | 87.9k → 0 (not drawn)   |
  | 1.0, 35k pieces             | 25 → 24                        | 1,135k → 1,053k                  | 87.9k → 0               |
  | 1.8 / 3 / 6, 35k pieces     | unchanged                      | +6.0k (apron)                    | unchanged               |
  | Every view, 44-player state | −1 at full map, else unchanged | +6.0k (apron), −4.1k at full map | 4.1k → 0 at full map    |

  Terrain triangles 1,006,000 → 1,012,016 at every zoom (1,006,016 since
  the perf triage removed the hidden skirts). GPU time needs a
  real GPU (`three_perf=1`): the apron's fragments replace the sea plane's
  around the map (similar cost), the rest is a few ALU per fragment.

## Lot 3: names close up, structure bases, bombs in flight

Visual fixes from the real-GPU test (brief items 1, 4 and 7). Nothing
changes with the default renderer.

### Names close up (`NameLayer.ts`)

Names are world-sized like the default renderer's, so close up a big
nation's label grew to hundreds of px (at zoom 11, "Benin" ~170 px tall and
"466K" a quarter of the screen) and hid the models and the mushroom clouds.

- Across `NAME_CLOSE_ZOOM` (4 → 6 CSS px per tile at the screen centre,
  smoothstep) each label blends towards a capped line height,
  `nameCapPx` = 4.5% of the canvas height clamped to 26-52 px (46 px on a
  1032 px canvas), and towards an opacity of `NAME_CLOSE_ALPHA` (0.72; the
  hovered owner stays opaque, disconnected players stay dimmed under it).
  Labels already under the cap keep their size; a label only ever shrinks.
- **At or below 4 px per tile nothing changes**: same sizes, no inline
  opacity, same DOM writes (the strategic read is identical).
- The whole label (name, troops, flag, status row, crown, verified badge)
  is one scaled element, so its parts keep their proportions; the outline
  stays constant on screen (`--k`). Gold popups get the same weight with an
  em cap of `POPUP_CAP_EM_PX` (34 px). Attack labels were already constant
  (17 px).
- Cost: one smoothstep and a min per label and frame; one `opacity` write
  when its 1/100 step changes (only while zooming through 4-6).

### Structure bases (`ProceduralMeshes.ts`, `StructureLayer.ts`)

The bases were wide plazas placed at the highest point under the footprint,
so they floated above slopes on a dark foundation skirt and overhung the sea
near coasts (img09).

- **Smaller, by type and level** (`structurePad`): city 6.2 → 7.6 tiles
  from level 1 to 6 (was 8.4 at every level; at levels 1-3 the towers are
  slimmer, × 0.85, and every tower's roof stays ≥ 0.2 tile from the next,
  so a city reads as a cluster, not one block), port quay 4.6 × 6.4 (was
  5.7 × 7.3; its pier deck sits a little above the quay on longer posts,
  so the posts show over the water), factory 8.2 × 5.3
  (8.4 × 6.5), defense post an earthwork octagon of 6.6 (7.3), SAM launcher
  a round pad of 5.4 / 6.1 / 6.8 by level (7.0-7.6), silo 6.5-6.75 (7.6).
  Types stretched by level (`structureLevelScale`) stretch their pad too.
  Colours vary by type (paving, quay stone, asphalt, earthwork, concrete).
- **On land** (`fitPadOnLand`): the pad (model space, turned like the
  model) is tested against the land tiles (`terrainByteAt`) at samples ≤ 0.8
  tiles apart, 0.05 inside its edge. If it overhangs water the model moves
  towards the land around its tile by 0.5 or `PAD_MAX_SHIFT` 1 tile (5
  directions), or shrinks (scales 0.9 … 0.42), the largest scale first;
  when nothing fits (a one-tile spit) the candidate with the least pad
  area over water wins. The shift was up to 3.5 tiles at first: the model
  then stood off the tile the player clicked and off-centre in its SAM /
  defense range rings, so it is capped at a tile and the pad shrinks
  instead. A port's quay is its pad (on land); its pier still reaches out
  over the water. Icons stay on the structure's tile (default renderer
  parity); level badges and progress bars glide from the icon to the model
  (`statusAnchor`). Picking is unchanged (tile-based).
- **On the relief** (`groundGrid` + the `conform` part material): the drawn
  surface under the pad is sampled on a 3×3 grid (u, v ∈ {0, ½, 1} of the
  pad; each node the mean of 5 samples a quarter cell apart), reduced to
  its least-squares plane, tilted at most `PAD_TOP_MAX_SLOPE` (0.45 rise
  per tile; `planarGrid`, closed form on the regular grid), and passed per
  instance (`iGround0..2`, three vec3). The vertex shader moves every pad
  vertex onto that plane at its own (u, v) (`aFooting`: (u, v, pad width,
  pad depth) in model units) and tilts the pad top's normal to it; every
  other part moves rigidly to the plane at its anchor's (u, v) (each city
  tower, wall section, silo… stands where it is, upright; parts standing
  on the pad reach down to `FOOTING_Y`, so no gap opens under them). The
  pad is a flat slab following the slope: draped on the bilinear grid it
  was creased like crumpled cardboard on rough ground. Its sides reach
  1.6 tiles into the ground. The model is sunk by the plane's float over
  the surface at the 85th percentile of the pad samples
  (`PAD_FLOAT_QUANTILE`, at most `PAD_MAX_SINK` 0.5) plus `PAD_SINK`
  (0.12): on smooth ground the pad's side shows as a thin curb; on rough
  ground bumps cross the slab (it reads as set into the ground) and its
  side shows over the deepest dips. The pad tops are split 2×2 (rect) or
  fanned (round).
- **Contact shadows** are sized to the pad (not the widest extent) and lie
  on the pad's least-squares plane (`fitGroundPlane`, `BlobShadows.push`
  with a slope); the fade band (models growing out of the ground at 2.5-5
  px per tile) is unchanged.
- **JS budget** (`PAD_PLACE_BUDGET_MS`, 1.5 ms): `updateStructures` fits new
  structures within the budget and places the rest provisionally on their
  tile (flat, full size), queued; the queue is drained within the same
  budget per frame (at least one; 480 structures arriving at once are all
  fitted within ~40 frames). A terrain change (water nuke) re-seats the
  icons at once and queues every model.
- **Measured** (`tests/client/three`, real World map, 480 structures of
  every type and level, a third of them on shore tiles):

  |                                                                    | before                   | after                                  |
  | ------------------------------------------------------------------ | ------------------------ | -------------------------------------- |
  | Pads with any sample over water                                    | 204 / 480                | 76 / 480                               |
  | Pad area over water (sum)                                          | 4,260 tiles²             | 66 tiles²                              |
  | Pad side above the relief (median / p95 / max)                     | 0.91 / 2.49 / 5.03 tiles | 0.32 / 0.58 / 1.19 tiles               |
  | `updateStructures`, 480 new structures (jsdom, warm, idle machine) | 13-18 ms                 | 21-25 ms (≈10 fitted, the rest queued) |
  | Steady `updateStructures`                                          | 0.18-0.22 ms             | 0.18-0.22 ms                           |
  | Land fit per structure (median / p95 / max)                        | –                        | 0.02 / 0.3 / ~1.5 ms                   |

  "After" is the final version: shifts capped at 1 tile (194 models
  shifted, 152 shrunk; the 3.5-tile cap gave 57 / 480 and 48 tiles²) and
  flat slabs (the bilinear drape gave a side of 0.30 / 0.40 / 0.58 tiles,
  and terrain over 2.4% of the pad tops on average, 19% at the 95th
  percentile; the slabs: 13.6% and 59%, on rough mountain sites).

  Triangles per model: unchanged for cities, ports, factories and silos
  (the pad is 24 triangles, as the former foundation + paving), −8 for
  defense posts and SAM launchers; low-poly models +14 (the pad top is now
  split to follow the ground). Per instance: +36 bytes (`iGround0..2`);
  per vertex of the structure templates: +16 bytes (`aFooting`); per
  vertex in the shader: a 2×2-cell bilinear lookup (≈15 ALU), plus 4 more
  lookups for the pad tops' normals; no texture fetch. Counters
  (`structures`): `padsShifted`, `padsShrunk`, `padPlaceMsMax`,
  `padPlacePending`.

### Bombs in flight (`UnitLayer.ts`, `ProceduralMeshes.ts`)

A bomb flies up to 120 tiles high: close up the camera is not much higher,
so a bomb crossing the tilted view was drawn hundreds of px long with its
exhaust blooming into a large glow (img06 / img07), while from afar the
trail was a sub-pixel line.

- **Screen-size cap** (`nukeScreenCapPx`, `capScreenScale`): the model's
  length is measured at its own depth and capped at 24 / 30 / 36 / 12 CSS px
  (atom, hydrogen, MIRV, warhead) up to 2 px per tile, growing as
  √(zoom / 2) to ×2 (from 8 px per tile). The 10 px minimum size still
  applies far out. Counters (`units`): `nukesInFlight`,
  `nukesScreenCapped`.
- **Tamed exhaust**: `NUKE_FLAME_GLOW` 2.5 (was 4.5-4.8), the hydrogen
  bomb's band 1.0 (was 1.7): just over the bloom threshold.
- **Readable trail** (the ribbon of `TrailRenderer`): every nuke and MIRV
  warhead keeps a ribbon; without a nuke-trail cosmetic it is now a
  glowing exhaust at the head (`NUKE_HEAD_GLOW_PX` long, below; it was
  fade^1.5 along the whole ribbon) and a light contrail behind it,
  building up over the glow's length, tinted 45% with the owner's colour
  (the default renderer's ground trail is the owner's colour), composited
  over the scene (alpha 0.85; warheads 0.7 × `warheadContrailScale` with
  a dimmer head, so a salvo reads as lines, not as a glowing sheet). The ribbon is at
  least `NUKE_TRAIL_MIN_PX` (3.5) wide on screen at its head (warheads
  `WARHEAD_TRAIL_MIN_PX`, 2), so it shows at full map. The additive glow
  of every ribbon (SAM missiles too) now fades in the fog instead of being
  mixed towards the fog colour (which added haze over the whole ribbon at
  distance). Cosmetic nuke-trail effects and the SAM missiles' look are
  otherwise unchanged.
- **MIRV cap**: the first `MAX_FULL_WARHEAD_TRAILS` (64) live warheads get
  a full trail (12 samples), later ones a short one
  (`WARHEAD_SHORT_TRAIL_POINTS`, 4): every warhead still shows a trail, and
  a 350-warhead salvo costs at most ~2.3k ribbon samples per frame instead
  of ~4.2k. Counters: `trailRibbons`, `trailSamples`, `warheadTrails`.
- **No glowing blobs zoomed out** (`unitGlowAtZoom`): the user's "big
  glowing ellipses" at full map (img00) were bombs at their 10 px minimum
  size whose exhaust and ribbon head crossed the bloom threshold. The unit
  layer's emission (exhausts, shells) and the ribbons' additive glow are
  scaled by `UNIT_GLOW_FAR` (0.45) up to 1.5 CSS px per tile, back to 1 at
  4: the flame (luminance ~0.47 × 2.5 × 0.45) and the head (1.7 × 0.45)
  stay under 1 where a bomb is a few px, and glow as before close up.
- **Head glow of a fixed screen length**: the exhaust glow on the ribbon
  runs `NUKE_HEAD_GLOW_PX` (16 CSS px, at the bomb's depth) behind its
  tail, by distance along the ribbon; when the first segment is longer
  (samples are 40 ms apart, a bomb flies ~10 tiles a tick), one vertex is
  added there so the glow does not stretch over it (it did: a long glowing
  streak behind the bomb).
- **No kink behind the model**: trail samples are points of the bomb's
  path (its centre without the model's lift); the ribbon is drawn with the
  current lift, from the live tail through the samples farther than the
  tail from the centre. Before, each sample kept the tail offset and lift
  of its frame, and as the on-screen cap or the min-size boost changed
  (zooming, or a bomb nearing the camera) the ribbon bent into a hairpin
  just behind the model.
- **Shockwave** (`FxLayer`, `SHOCKWAVE_COLOR`, `SHOCKWAVE_ALPHA`): the
  pale ellipse around an impact in img06 was the default shockwave ring
  (warm white at luminance ~2, opacity 0.85, a band ~7 tiles wide sweeping
  1.5 × the blast radius in 1.5 s), which bloom spread into a glowing disc
  over the territory and labels. It is now just over the bloom threshold
  (luminance ~1.2) at opacity 0.6; size, band and timing are unchanged,
  and a player's nuke-explosion cosmetic still sets its own ring. The
  mushroom cloud, fireball and flashes are untouched.
- **MIRV salvos** (`warheadContrailScale`): warhead contrails' opacity ×
  √(6 / live warheads) (1 up to 6, at least 0.3), so a fan of converging
  warheads adds up to lines, not a pale wedge at full map.
- Cost: no draw call added (the ribbons are one mesh, as before); +4 floats
  per ribbon vertex (`aSmoke`); per ribbon fragment one more tone-map +
  fog evaluation where both the glow and the contrail are present; at
  most one more vertex per bomb ribbon (the glow's end); a distance per
  ribbon vertex in JS. The ribbon rebuild no longer allocates per frame
  (the trail lists are reused).

### Testing

`NameLayer.test.ts` (close-up weight, cap, fade, whole-label scaling,
identical below 4 px per tile, popups), `StructureBases.test.ts` (pad
sizes by type and level, `aFooting`, the conform shader patch and its CPU
twin, ground grid, land fit on coasts / strips / spits, ground plane,
sloped shadows, layer integration on a coast and a slope, the placement
budget and queue, terrain changes), `NukeFlight.test.ts` (cap helpers,
tamed exhaust, contrail mirror, a bomb near the camera capped, trail width
and contrail at full map, warhead trails past the cap).

## Lot 3: fallout, water glints, smooth relief

Items 5, 8 and 9 of the lot-3 feedback. The GLSL is in delimited `lot 3`
blocks of `shaders/terrain.ts` and `shaders/water.ts`; the curves have
TypeScript twins in `TerrainShading.ts`, unit-tested against the shader
strings. Nothing changes without `?renderer=three`.

### Fallout (`shaders/terrain.ts`, `FalloutField.ts`, `FxLayer.ts`)

The fallout was a fluorescent green sheet (an albedo mix towards the
fallout colour plus an emissive pulse) where the relief disappeared. It
is now burnt ground that keeps the relief and the lighting: the block
recolours the ground (over any territory fill, as the default renderer's
`TerritoryPass` does) but never touches the normals, the slope darkening
or the hillshade. Everything hangs on the tile's own fallout bit
(`texelFetch` of the tile under the pixel), so the zone stays exact to
the tile: no colour or glow outside it, and its edge is the tile edge.

- **One hue family at every zoom**: warm ash grey following the ground's
  own brightness (plains, rock, snow), darker than any territory; the
  first version went from an olive moss far out to dark brown close up.
- **Zoomed out** (`falloutLook`, `near` = 1 − smoothstep(0.18, 0.5,
  tiles per device px)): the ash, darker (× 0.78), with a touch (10-22%) of
  the sickly tint (the `mapOverlay.staleNuke*` colour mixed with a dull
  yellow), mottled at a ~10-tile scale (one noise octave, faded before it
  can alias), a faint glow (2.5% of the colour), and a **sickly
  yellow-green rim** on the zone's own tiles next to clean ground
  (`falloutRimTiles`: `FALLOUT_RIM_PX` 1.6 device px wide, 1-4 whole
  tiles, 4 taps of the tile texture; strength `FALLOUT_RIM_FAR` 0.85 →
  `FALLOUT_RIM_NEAR` 0.3 close up). At full map and at 1.8 the zone reads
  at a glance as a scorched hazard zone, not as one more player or a
  forest, in the alt view too (the rim over the dimmed ground), and its
  outline is exact to the tile.
- **Close up** (from ~3-5 px per tile): the ash with soft charred patches
  (−16%, was −32%: it read as camouflage), fine ash dust (± 6%, a 0.4-tile
  octave), wind-blown ash streaks (rotated world-space noise, so no tile
  checker) and a faint sickly stain; the rim stays as a faint line. Then:
  - **Hotspots** (`falloutHotspot`, `hotspotGlow`): at most one per
    `FALLOUT_HOT_CELL` (16) tile cell of a rotated lattice, in 10% of the
    cells (`FALLOUT_HOT_SHARE`; a few dozen on a screen-filling zone at 5
    px per tile, ~5 at 11), radius 1.6-3.2 tiles (`FALLOUT_HOT_RADIUS`),
    and only well inside the zone: the 4 tiles `FALLOUT_HOT_CLEAR` (6)
    tiles from its centre must be fallout too (fetched only for pixels
    inside a hotspot disc). A dim amber core (emissive ≤ ~0.8, at most a
    touch of bloom) in a sickly halo darkening the ash, slowly breathing;
    faded out over 0.25-0.5 tiles per px (they would shimmer) and on steep
    flanks. The first version scattered a hotspot in 28% of 6-tile cells:
    an even pepper of lime dots.
  - **Embers** (`emberRadiusTiles`): on 2% of the fallout tiles plus 20% ×
    the hotspot strength, from ~4-8 px per tile on: a flickering orange
    disc of at least 1.3 device px (0.06-0.25 tile) whose centre lies
    `EMBER_MARGIN` (0.25 tile) inside its tile, so it never leaves it.
  - **Smoke** (`FalloutSmoke` in `FxLayer.ts`): `FALLOUT_SMOKE_SLOTS` (36,
    18 at low quality) thin puffs (peak opacity 0.3) in one draw call with
    the FX smoke material. Each slot loops forever in closed form over an
    emitter (a random fallout tile of a dense cell in view), rising ~9
    tiles, drifting downwind and growing over 7 s; it takes a new emitter
    when its loop wraps (invisible then) or its emitter leaves the view. It
    fades in between 1.2 and 2.4 CSS px per tile; nothing is drawn without
    fallout in view.
- **`FalloutField`** (pure data, kept by `TerrainLayer`): fallout tiles per
  8 × 8-tile cell (dense, a smoke emitter, from 60% of its tiles), updated
  in O(changed tiles) from the same `changedTiles` as the tile uploads (one
  byte per tile keeps each tile's last fallout bit, so counts stay exact).
  A full upload (first tick, a new buffer, context restore) is re-read row
  by row, `FALLOUT_STEP_BUDGET_MS` (0.4 ms) of JS per frame, at least one
  row (World: 2M tiles, 7-17 ms in all over ~20-40 frames, steps of 0.4-0.6
  ms measured); changes landing meanwhile on rows not read yet are left to
  the re-read. A tick costs O(changed tiles): ~1-1.7 ms once for a hydrogen
  bomb's 26k tiles, ~0.3 ms for 20k scattered tiles that flip nothing.
- **Bombs' ground tracks over fallout** (EffectTrails, lot 2): drawn at
  35% and 75% desaturated on fallout tiles, so they no longer read as
  green fallout streaks on the ash (the default renderer's neon sheet hid
  them).
- Costs, per fallout fragment (each part behind a branch on its weight
  since the perf triage, so a GPU skips what is mixed away): 4 tile-texture
  fetches for the rim at every zoom; the far look's 1 value noise while
  `near` < 1 (from ~5.5 px per tile on it is skipped); the near look's 4
  value noises (16 hashes) while `near` > 0, i.e. from ~2 px per tile, not
  at full map or the default zoom (they were computed and mixed away there
  before); the hotspot test (1-2 hashes) only while hotspots can show
  (from 2 px per tile, on flat enough ground), and its 4 fetches only
  inside a disc (~1% of the zone); the ember hash only from 4 px per tile,
  2 more on the ~2-5% of tiles holding an ember. The territory fill is no
  longer computed under fallout (it was replaced anyway). One tile fetch
  where a ground track is drawn (to dim it over fallout). Off fallout the
  block is skipped (a branch on the tile bit; SwiftShader runs every block
  of the program anyway). Smoke: +1 draw call and ≤ 36 quads
  (72 triangles) while any puff shows, ≤ 0.2 ms JS per frame measured
  headless (36 emitter picks: ~0.03 ms). Field: 2 MB of tile bytes plus 3
  arrays of 31k cells (~0.3 MB) on World.

### Water glints at mid zoom (`shaders/water.ts`)

The "vermicelli" at ~4-8 px per tile were the sun's disc mirrored by the
sum of the 5 wave octaves (13 down to 1.3 tiles): long, bright, repeating
contours, a few dozen px wide. Now:

- The reflected sky has no sun disc (`skyRadiance(dir, 0)`); the sun's
  reflection is the glint lobe only.
- The glint lobes see the waves' short octaves only: an octave leaves the
  glints as its wavelength grows from 16 to 40 device px
  (`glintWaveWeight`, `GLINT_WAVE_PX`), at a third of its slope.
- A glitter layer scaled to the screen (`glitterSlope`, `glitterLevels`):
  two value-noise octaves whose period follows the pixel footprint (around
  `GLITTER_PX` = 5 device px), cross-faded over log2 of the footprint (no
  popping while zooming), each rotated and offset by its absolute level and
  drifting, so the glints are small sparkles at any zoom, never a pattern.
- The wave phase is bent by a slow warp, so the crests of the 5 octaves no
  longer line up as a lattice.
- With the sparkles that small, the tight lobe is brighter (0.22, was
  0.05). The glints still only show from ~4 px per tile, so the full-map
  and default-zoom water is unchanged; close up, the waves, fresnel and
  foam are those of lot 2.
- Cost (water plane and coastal terrain fragments while glints show): 2
  value-noise lookups with gradient (8 hashes) and their trig, and the
  glints' share of each live wave octave (a divide and a smoothstep, only
  computed while glints show since the perf triage); at every zoom the
  phase warp (2 sin) on all water fragments; no texture fetch.

### Smooth relief close up (`TerrainLayer.ts`, `shaders/terrain.ts`)

At max zoom snow and rock showed angular cells: the relief mesh is a grid
of `step` tiles (World: 2) with per-vertex normals (creases along its
triangles), and the per-tile detail was a bilinear blend whose slope jumps
at every tile edge. Close up only (weight `close`, from ~3-7 px per tile)
the shading now uses C1 / C2 smooth versions; the geometry, and so the
silhouettes, the projector and picking, is unchanged.

- **Relief texture**: `TerrainLayer` keeps, per grid vertex, the slope
  (dh/dx, dh/dz, the same central differences as the vertex normals) and
  the height as RGBA16F (`cols × rows`, linear filtering; World: 1001 ×
  501 = 3.8 MB), re-sent by rectangle with the normals it follows after a
  terrain change. The shader samples it with a cubic B-spline in 4
  bilinear fetches (`reliefSmooth`; `cubicBsplineTaps`, `reliefGridCoord`)
  for the shading normal and the reference height of the concavity shade.
- **Tile heights**: a quadratic B-spline over the 3 × 3 tiles around the
  sample point (`tileBspline`, 9 fetches at constant offsets, 4 of them
  the bilinear 2 × 2's texels; `quadBsplineAt`) gives the detail slope
  (no jump at tile edges), and the mean upland magnitude the rock and snow
  lines follow (smooth contours instead of the tile staircase).
- **Surface detail**: snow gets wind-combed ripples and a fine grain in its
  bump normals, so the smooth relief does not read as plastic.
- Cost (land fragments close up): 4 more bilinear fetches (the relief,
  at an explicit level 0: no implicit derivatives inside the non-uniform
  branch) and 9 tile texel fetches at constant offsets (4 of them t4's
  texels, in cache; no local array, which GPUs spill to scratch memory
  when it is indexed per fragment), a 3 × 3 weight loop; the bilinear tile
  heights it replaces (4 pow) are skipped once it is fully in (from ~4.5
  device px per tile). Zoomed out a GPU skips it all (the branch is on
  `close`); SwiftShader still pays for the code (see "Performance
  notes").

### Testing

`TerrainSurfaces.test.ts` (fallout look by zoom, the rim's width, embers
inside their tile, hotspots compact inside their cell and sparse, the
fallout block mirrored (rim, hotspot clearance, one hue family) and never
touching normals / ao / shading, ground tracks dimmed over fallout; grid coordinates, B-spline weights, the
2-fetch cubic equal to the 4-tap one, the quadratic tile spline C1 where
the bilinear blend jumps and exact on planes; glitter periods around 5 px
at any zoom, no popping across levels, long wave octaves out of the
glints, the water shader mirrors), `FalloutField.test.ts` (exact counts
from changed tiles against brute force, dense cells incl. edge cells,
bounded full re-read with ticks landing mid-way, emitters only on fallout
tiles of dense cells in view, puff curves), `TerrainLayers.test.ts` (the
relief texture matches the mesh normals and heights; the fallout field
fed from the tile path) and `FxLayer.test.ts` (smoke only over fallout in
view and close enough, within its slots, halved at low quality).

## Lot 4 prototypes

The first three ideas of the lot-4 proposal, each behind its own URL flag
(`ThreeSettings.prototypes`, read once with the other `three_*`
parameters, so fixed for the page):

| Flag            | Prototype        | Files                                                         |
| --------------- | ---------------- | ------------------------------------------------------------- |
| `three_wakes=1` | Ship wakes       | `WakeLayer.ts` (owned by `UnitLayer`)                         |
| `three_front=1` | Living front     | `FrontField.ts`, `LivingFront.ts`, `shaders/terrain.ts`       |
| `three_night=1` | Night and lights | `NightLights.ts`, `shaders/night.ts` (+ the layers it lights) |

They combine freely (`?renderer=three&three_wakes=1&three_front=1&three_night=1`)
and are off by default. Only the URL flag turns the night on: the default
renderer's "Night" graphics preset (or a darker ambient setting) does not,
so a player with that preset keeps the plain day programs; with the flag
on, a darker ambient still deepens the night.

### Off costs nothing

- **By construction.** Without its flag a prototype creates no object,
  texture, uniform, define, draw call or perfStats key. Its shader code
  sits in `#ifdef FRONT_WAVE`, `#ifdef NIGHT` and `#ifdef NIGHT_WINDOWS`
  blocks, and those defines are set in a material's `defines` only at
  creation, so the preprocessor removes the code (never a uniform branch:
  the lot-3 triage showed that SwiftShader pays for every line of the
  terrain program and a GPU pays in register pressure). The wakes have no
  shader code in any other program: their material is never created. What
  is left per frame or event is a null check (`UnitLayer.update`,
  `TerrainLayer.update` / `setTiles`, `FxLayer.update` and its impacts,
  `OverlayLayer.update`, the facade's `updateNames`, `updateStructures`
  and `updateRelations`).
- **Checked headless against HEAD `dc644db`** (the commit before lot 4),
  no `three_*` prototype flag, the same recorded states and fixed cameras
  and clock: the canvas (`readPixels` right after `composer.render`) of
  the late World state at 0.7, 1.8, 5, 11 and 20 CSS px per tile and of
  the fallout state at 0.7, 5, 11 and 1.8 in the alt view: **0 differing
  pixels in 9 of 9 views**. Every linked program's translated shader
  (post-preprocessor, captured through `WEBGL_debug_shaders`) is
  byte-identical to HEAD's (19 programs on the late state, 18 on the
  fallout state), and none contains a lot-4 identifier. Two HEAD sessions
  give the same pixels too, so the check is deterministic. The
  `shaderDefines.ts` test helper resolves the `#ifdef` blocks the same
  way, and the tests assert that nothing of a prototype is left without its
  define.

### Ship wakes (`three_wakes=1`, `WakeLayer.ts`, owned by `UnitLayer`)

Every moving transport, trade ship and warship leaves foam on the sea: a
Kelvin-like V (arms at ±19.5° from the bow, ending at 60% of the wake's
length) and a streaky wash on the centre line behind the stern that
outlasts the arms. Close up (a ship over ~25-60 device px) faint feathers
run along the arms and the water inside the V is churned. The foam noise is
stretched along the track and anchored to the water (the ship's odometer
minus the distance behind its bow), so it stays put as the ship sails on.
Lit like the water's own foam, fogged, clipped to water tiles (no foam on
the shore), depth-tested, 55% in the alt view, 50% at night.

- **Military first** (`WAKE_KINDS`, `wakeKindStrength`): zoomed out
  (≤ 2.5 CSS px per tile) a trade ship's wake is faint (0.55), a
  transport's (1.35) and a warship's (1.5, ×1.15 length, ×1.3 wash) strong;
  trade wakes reach full strength from 6 px per tile.
- **Look by zoom** (`wakeLook`, in drawn ship lengths, the model × its
  min-size boost): full map (≤ 0.9) a short streak of 1.6 ship lengths, no
  arms, opacity 0.4; the V grows in over 0.9-1.6; at the default 1.8, 2
  ship lengths at 0.65; from 10 px per tile 2.6 at 0.85. Foam coverage is
  capped at 0.85 (`WAKE_MAX_ALPHA`: never brighter than the coast's foam).
- **Crowds** (lanes, port queues): wakes whose apex shares a ~32 CSS px
  cell are each dimmed by 1/√n (`wakeCrowdDim`, a 4,096-slot hash per
  frame, no allocation), so convoy lanes do not merge into white bands.
- **Kinematics**: from UnitLayer's tracks (tick segment and drawn
  position). The velocity is an exponential average (350 ms) of the tick
  segments, a steady heading on 4-connected diagonal courses; strength is
  smoothstep(0.08, 0.5) of the speed in tiles per tick, so a stopped or
  docked ship's wake fades within ~0.4-1.2 s.
- **Draw**: one instanced draw (a trapezoid of 2 triangles per wake at
  Y = 0.03, renderOrder −8 between the sea and the contact shadows, no depth
  write), 9 floats per instance in one interleaved buffer (1,024 × 36 B),
  one ranged upload of n × 36 B per frame. Only wakes whose bounding sphere
  is in the view, at most `WAKE_MAX_INSTANCES` (1,024); trade ships stop
  `WAKE_MILITARY_RESERVE` (64) short of it, so the cap never drops a
  transport or a warship.
- **Per wake fragment** (static count): 1 `texelFetch` (the shared R8UI
  terrain bytes, no new texture), 1 value noise (+1 close up), 2 `exp`, 2
  `pow`, a `sin` close up, 1 `fwidth`.
- **Counters** (`units`, flag on only): `wakeInstances`, `wakeCulled`,
  `wakeCapped`, `wakeJsMs` / `wakeJsMsMax` (with `three_perf=1`),
  `wakeUploadKB`.
- **Limits**: a rigid V (no history ribbon), so on a sharp turn it swings
  with the averaged heading instead of curving; clipped per tile at coasts
  (stepped close up, like the sea plane); coastal relief can hide part of a
  wake at the shore. Not done on purpose: a `MAX` blend (with premultiplied
  foam over the sea it would only keep the brighter of foam and water, not
  foam over water; the crowd dimming and the alpha cap handle overlaps) and
  dropping arms by heading stability (a 4-connected diagonal course has
  |mean velocity| / mean speed = 0.71, the same as a zig-zag).
- **Testing**: `ShipWakes.test.ts`.

### Living front (`three_front=1`, `FrontField.ts`, `LivingFront.ts`)

The war reads on the map itself. Three parts, all fed by the tiles that
change hands:

- **Capture wave** (terrain shader, `#ifdef FRONT_WAVE`). A freshly
  captured tile glows: light **added** to the lit, relief-shaded ground (the
  fill and the hillshade read through it), white-hot for the freshest
  captures (`FRONT_HOT_S`, 0.15 s), then the new owner's colour with its
  chroma boosted (a grey or blue owner stays tinted, never washes out to
  white or "water"). One fast rise and a sharp decay (`frontPulse`:
  `FRONT_DECAY_S` 0.22 s plus a faint tail to `FRONT_PULSE_MS`, 1.3 s), no
  ripple, so it is bright on the last ~3 ticks' captures only: the moving
  front line, not a band 5-15 tiles deep. Tiles still on a border get it in
  full, tiles inside the captured band a share (`frontWaveLook.interior`,
  0.3 close up). Zoomed out it is a strong white-hot line with a touch of
  bloom, close up a softer glow (`frontWaveLook`); ×0.6 at night;
  affiliation colours in the alt view. Captures of unclaimed land at 35%.
  The age is blended over the 4 tile centres around the sample point; the
  glow never leaves the captured tile.
- **Smoke and sparks** (FxLayer, `FrontParticles`). Where a tile taken
  from another player is **still on the front when the puff spawns**
  (`FrontField.onBorder`): a light warm-grey puff (linear 0.3 → 0.55,
  opacity ≤ 0.38) rising 0.6 tile above the ground and dissolving as it
  grows over 1.3-1.9 s, and close up a short pop and 2-3 sparks. At most
  `FRONT_SPAWN_PER_FRAME` (8) events per frame, picked uniformly among the
  events in view younger than 400 ms; two pools of FxLayer's materials
  (no new program), `FRONT_SMOKE_CAPACITY` (160) puffs and
  `FRONT_SPARK_CAPACITY` (240) sparks (halved at low quality); none at
  and under 1.3 px per tile (`frontParticleLook`).
- **Attack arrows** (OverlayLayer, `FrontArrows`). Three chevrons marching
  from the attacker into the defender, in the attacker's colour (its
  affiliation colour in the alt view) inside a dark outline, one per front
  cluster (`FrontField.cluster`, cells ~150 CSS px apart:
  `frontArrowCell`), only for pairs with an active, non-retreating attack
  (`outgoingAttacks` through the facade's `updateNames`) whose front still
  moves, the heaviest `FRONT_ARROW_CAP` (32) in view. When two players
  attack each other in one cell, only the heavier side gets an arrow
  (crossing chevrons read as "#"). A front that stops fades out **where it
  is** in 200 ms (no ghost gliding behind the front). 32 CSS px long at full
  map (the name labels stay readable), 64 from 5 px per tile, 84 from 12,
  × 0.85-1.15 by troops. One instanced draw, no depth test, under the
  structure icons and the DOM names.

**Data path** (`FrontField`, pure; built by TerrainLayer only with the
flag): a shadow copy of the tile state gives the previous owner of each
changed tile (`applyChanges`, O(changed tiles) per tick); capture stamps
(R16UI, 15 bits of time in 50 ms units + a "from a player" bit) go up with
the tile state's own rectangles, but **only the rectangles where a stamp
changed** (`takeDirty`): tiles lost to nobody (a nuke, fallout) or other
bit changes cost no stamp upload; a full tile upload sends them in full; a
sweep zeroes cells older than 8 min long before the stamps wrap (27 min),
at most one rectangle per frame. Border events: ≤ 256 per tick in a ring
of 2,048. Front segments: per 32-tile cell and (attacker, defender) pair,
decaying sums (weight and direction 2.5 s, position 250 ms).

**Counters** (flag on only): `terrain.frontUploadCalls`,
`frontTexelsLastFrame`, `frontUploadCallsTotal`, `frontTexelsTotal`,
`frontTextureMB`, `frontFieldMB`, `frontJsMs` / `frontJsMsMax` (the
field's JS since the previous frame), `frontCaptures`,
`frontPvpCaptures`, `frontSegments`, `frontAttacks`, `frontStampedCells`,
`frontSweptCells`; `fx.frontParticles`, `frontSmoke`, `frontSparks`,
`frontSpawnedLastFrame`, `frontSpawnedTotal`, `frontJsMs` (the front pools
are in `fillScreens`); `overlay.frontArrows`, `frontArrowCandidates`,
`frontJsMs`.

**Per fragment** (static count): owned land outside fallout, 1 R16UI
`texelFetch` and a `mod`; inside the glow (captures younger than 1.3 s),
4 more R16UI fetches, 1 palette fetch, 2 `exp` and 3 `pow` (sRGB to
linear), no noise. Arrows: 3 segment distances, no texture. Particles:
FxLayer's sprite shaders.

**A hydrogen bomb** (61,529 tiles to nobody in one tick, `FrontField` in
node): `applyChanges` 5.0 ms the first (cold) call, 0.3 ms warm, 0 dirty
stamp cells, so no stamp upload (tested: "sends no stamps for tiles lost
to nobody"). 1,000 captures from players in one tick: 5.8 ms cold.

**Limits**: arrows only follow moving fronts (a stalled attack shows
none); they are not pushed out of the name labels (smaller at full map
instead); expansion into unclaimed land gets a 35% glow and no smoke or
arrows; during the spawn phase every tick's captures glow (neutral, 35%).

**Testing**: `LivingFront.test.ts`.

### Night and lights (`three_night=1`, `NightLights.ts`, `shaders/night.ts`)

The idea of the default renderer's night (`NightCompositePass`: the scene
× (ambient + a lightmap of point lights)) redone for a lit 3D scene: no
extra pass or draw call, the lights are read by the programs that already
draw the ground, the water, the models and the smoke.

- **Moonlight**: `SceneEnvironment.setNightDepth` blends the sun, sky fill,
  sky dome and fog towards a dim cool moon (`NIGHT_ENVIRONMENT`; exact
  back at depth 0). Terrain, water, wakes and every lit model follow
  through the shared uniforms. The ground is desaturated towards blue-grey
  (65%), the sea 39% and then lifted over a moonlit navy floor, so the
  shallow-water gradient, the shore foam and the ships still read.
- **Territories and names stay readable** (`nightLook`): the fill keeps
  30% of its day brightness at full map (16% close up), a little
  desaturated, the borders 45% (35%). The DOM names turn light with a dark
  outline (`NIGHT_NAME_CSS`, a class set at construction; traitors stay
  red). Icons, badges, bars, the grid and spawn halos are unlit UI and stay
  as they are.
- **City lights** (`NightLightmap`): one light per structure
  (`structureLight`): cities by level (radius 10 → 36 tiles, intensity
  1.1 → 2.9 with log2 of the level), ports and factories smaller (factories
  orange), defense posts and SAM launchers small cool points, silos red, a
  quarter while under construction. Each light is a bright core (Gaussian,
  σ = 0.16 R, 88%) and a faint halo (12%) out to R, splatted into a
  lightmap of 1 texel per 4 tiles on World (502 × 252 RGBA8, 0.48 MB,
  square-root encoded, a black margin), plus a wide glow in alpha shown
  only zoomed out around the icons. The ground gets the **lamp's own warm
  colour** modulated by the ground's brightness (not tinted by the
  territory: no mint or red haze), with a soft knee so the biggest cores do
  not clip, and a street-light grain (one value noise, 3 cells per tile)
  between ~2.5 and ~5 px per tile.
- **Rails** glow faintly in their own colour (`RAIL_NIGHT_GLOW`, the
  strip material's emissive; no shader change), so they never turn into
  black lines that read as borders.
- **Lit windows** (`NIGHT_WINDOWS` in `createPartMaterial`,
  `addWindowMask`, `windowShare`): panes on the vertical plastered walls
  and glass bands, each lit or not by a hash, 30% of a level-1 city's up
  to 61%, factories 55%, ports 35%; fading to their mean from ~4.5 to ~2.5
  px per window cell (no sparkle on towers). Structures self-lit at 0.13 ×
  albedo; units by zoom (`nightLook.units`: 0.35 zoomed out, where a ship
  is a few pixels on the night sea, to 0.13 close up).
- **Impact flashes** (`NightFlashes`, `nightFlashFor` in FxLayer): each
  impact that flashes FxLayer's point lights also starts one of 4 ground
  flashes (uniforms; an atom bomb lights 60 tiles for 1.5 s, a hydrogen
  bomb ~140 tiles for ~2.3 s, white-hot then orange). On land the ground's
  colour is mostly whitened under the flash (a nuke lights the land white,
  not magenta or cyan); on the sea it is added as light on a pale surface,
  so the water around ground zero lights up too.
- **Fallout**: the burnt ash keeps its relief under the moon (the moonlit
  shading lifted ×3.4 on the zone) and a faint glow of its own colour (no
  green tint); embers ×1.5.
- **Bloom** catches the lit windows close up, the embers and the flashes;
  the lamp light stays mostly under it.

**Data path** (`NightLighting`, one per scene, refcounted by TerrainLayer,
WaterLayer, StructureLayer, UnitLayer and FxLayer; TerrainLayer drives its
`update`): the facade's `updateStructures` diffs the lights by unit id
(O(units)) and marks the 16 × 16-texel cells under a changed light dirty
in a `TileUploadQueue`; per frame at most 4 rectangles / 8,192 texels /
1 ms (`LIGHTMAP_BUDGET`, `LIGHTMAP_BUDGET_MS`; the first rectangle always
goes) are rebuilt (squared distances and a kernel table, no sqrt or exp per
texel) and each sent with one `texSubImage2D`; the 4 flash slots and the
look go to uniforms.

**Counters** (`terrain`, night only): `nightDepth`, `nightLights`,
`nightLightmapBuilds`, `nightLightmapRectsLastFrame`,
`nightLightmapTexelsLastFrame`, `nightLightmapPendingCells`,
`nightLightmapMs`, `nightLightmapMsMax`, `nightLightmapMB`,
`nightFlashLights`, `nightFlashesStarted`.

**Per fragment** (static count): terrain land, 1 bilinear lightmap fetch,
the desaturation, fill and border keep, the lamp term and its knee, a
flash loop over the live slots (`uFlashN`, 0 most of the time; per slot a
length, a normalize, a dot and the falloff), 1 value noise for the grain
only in bright cores at ~2.5-5 px per tile (a branch); the terrain's water
path and the sea plane, 1 fetch, the flash loop and the lift; structure
fragments, the window grid (an integer hash, 6 smoothsteps, 1 `fwidth`)
on marked walls and the self-light; unit fragments, the self-light; FX
smoke, 1 dot and 1 smoothstep. No new texture fetch on models or FX.

**Limits**: the lightmap is static per structure (ships, trains and bombs
in flight cast no ground light; ships are self-lit, bombs keep their
exhausts); flashes light the terrain and the water, models only through
FxLayer's point lights (high quality); the moon shines from the sun's
direction; the fallout's embers still read as dots on the dark zone; the
structure icons are not dimmed (UI). The first lightmap build of a late
game (394 lights) takes 13 frames and one cold 7-9 ms frame (the time
budget is checked between rectangles, the first always goes).

**Testing**: `NightLights.test.ts`.

### Costs, measured headless (not a frame rate)

The recorded late World state (2000 × 1000, tick 19,405: 394 structures,
897 moving trade ships, 7 warships), 1920 × 1032, high quality, a fixed
clock, the same four cameras for every configuration (full map 0.7, then
the densest city area at 1.8, 5 and 11 CSS px per tile), one session per
configuration. The render time is one synced render (median of 3: a 1 × 1
`readPixels`, `composer.render`, a 1 × 1 `readPixels`) under SwiftShader,
a proxy for program size and fill, never a GPU time; separate sessions
spread by ±5-10%. The flag-off baseline: 23 / 25 / 35 / 34 draw calls,
1,047k / 1,114k / 1,122k / 1,148k triangles, 16-19 programs, 26
textures, 12,167 / 6,717 / 4,263 / 3,955 ms.

**Wakes** (`three_wakes=1`):

| View (px per tile) | Draw calls | Triangles | Wakes drawn (culled) | Wake JS per frame | Uploaded per frame | Render ms off / on |
| ------------------ | ---------- | --------- | -------------------- | ----------------- | ------------------ | ------------------ |
| 0.7                | +1         | +1,804    | 902 (0)              | 0.4 ms            | 31.7 KB            | 12,167 / 12,708    |
| 1.8                | +1         | +812      | 406 (496)            | 0.2 ms            | 14.3 KB            | 6,717 / 6,833      |
| 5                  | +1         | +208      | 104 (798)            | 0.1 ms            | 3.7 KB             | 4,263 / 4,257      |
| 11                 | +1         | +130      | 65 (837)             | 0.2 ms            | 2.3 KB             | 3,955 / 3,978      |

+1 program, no texture, a 36 KB instance buffer. Per wake fragment: 1
fetch, 1-2 value noises (see "Ship wakes").

**Living front** (`three_front=1`). On the frozen late state nothing
changes hands, so it shows the fixed cost: no draw call or triangle, the
terrain program's FRONT_WAVE variant (same program count), +1 texture
(the R16UI stamps, 3.81 MB; 7.63 MB of CPU memory for stamps and shadow),
render 12,167 / 13,372, 6,717 / 7,391, 4,263 / 4,483 and 3,955 / 4,196 ms
(+1 R16UI fetch on owned land). The moving parts, on the recorded war
(tick 2,621, 51 players, 17 attacks; 30 recorded ticks replayed per view,
6 update-only frames per tick, the busiest front in view):

| View (px per tile) | Draw calls off → on | Front triangles | Arrows | Smoke + sparks | fillScreens | JS per frame (terrain + overlay + FX) | JS per tick (facade push) | Stamp uploads per frame |
| ------------------ | ------------------- | --------------- | ------ | -------------- | ----------- | ------------------------------------- | ------------------------- | ----------------------- |
| 0.7                | 21 → 22             | 32              | 16     | 0              | 0           | 0.09 → 0.30 ms                        | 0.12 → 0.53 ms            | 3.8 calls, 22.5k texels |
| 1.8                | 22 → 24             | 346             | 16     | 157 + 0        | 0.03        | 0.08 → 0.23 ms                        | 0.04 → 0.26 ms            | 3.5 calls, 9.9k texels  |
| 5                  | 23 → 26             | 698             | 10     | 160 + 240      | 0.04        | 0.08 → 0.22 ms                        | 0.09 → 0.20 ms            | 3.5 calls, 9.9k texels  |
| 11                 | 23 → 26             | 708             | 4      | 160 + 240      | 0.20        | 0.06 → 0.13 ms                        | 0.06 → 0.20 ms            | 3.5 calls, 9.9k texels  |

The stamp uploads ride on the tile state's own rectangles, within its
budget (≤ 8 calls, ≤ 256k texels per frame), and only where a stamp
changed.

**Night** (`three_night=1`): no draw call, triangle or instance; the same
program count (the terrain, water, part and smoke programs are their
NIGHT variants); +1 texture (the lightmap, 0.48 MB); 0 texels uploaded per
frame at rest (≤ 8,192 in ≤ 4 rectangles while rebuilding; the first
build of the 394 lights, 18 rectangles over 13 frames, one cold 7.4 ms
frame); render 12,167 / 14,280, 6,717 / 7,343, 4,263 / 4,869 and 3,955 /
4,467 ms (+9-17%: the terrain program's lightmap fetch, lamp, grain and
flash loop, the windows in the structure program).

**All three on**:

| View (px per tile) | Draw calls | Triangles | Programs | Textures      | Render ms off / on |
| ------------------ | ---------- | --------- | -------- | ------------- | ------------------ |
| 0.7                | 23 → 24    | +1,804    | +1       | +2 (+4.29 MB) | 12,167 / 14,756    |
| 1.8                | 25 → 26    | +812      | +1       | +2            | 6,717 / 7,946      |
| 5                  | 35 → 36    | +208      | +1       | +2            | 4,263 / 4,479      |
| 11                 | 34 → 35    | +130      | +1       | +2            | 3,955 / 4,232      |

On the replayed war with all three on: 23 / 25 / 27 / 27 draw calls
(off: 21 / 22 / 23 / 23), the same front counters as above. JS per frame:
the wakes 0.1-0.4 ms, the front 0.1-0.2 ms (+0.1-0.4 ms per tick), the
night ~0 at rest (≤ 1 ms on lightmap-rebuild frames). The whole layers'
update on the frozen state varies by ±1 ms between sessions, more than
these.

### To check on a real GPU

SwiftShader gives no frame rate; these need a real machine (and the iGPU
most of all). Open a solo World game with 50 bots, read
`__threePerf().gpuMs.avg` (wait a few seconds after each camera move) and
the counters below, once with the flags and once without, then once more
with `three_quality=low`:

1. **Wakes**: `?renderer=three&three_perf=1&three_wakes=1`, late game
   (~12 min, hundreds of trade ships), over a busy shipping lane at 0.7,
   1.8, 4 and 8 px per tile. Counters: `layers.units.stats.wake*`
   (`wakeInstances`, `wakeCapped` should stay 0, `wakeJsMs`). In motion: the
   wakes trail the ships smoothly at 60 FPS (no stutter or pop when a ship
   turns, starts or docks), trade lanes stay calm at 1.8, transports and
   warships stand out, the foam does not shimmer when panning.
2. **Living front**: `?renderer=three&three_perf=1&three_front=1`, mid
   game with wars (~4 min), the camera on an active front at 0.7, 1.8, 4, 8
   and 14 px per tile. Counters: `layers.terrain.stats.front*`
   (`frontUploadCalls`, `frontTexelsLastFrame`, `frontJsMs`),
   `layers.fx.stats.front*` and `fillScreens`, `layers.overlay.stats.front*`.
   In motion: the glow runs along the front as it advances (a line, not a
   band; no flicker), smoke rises and dissolves at the front only, sparks
   pop, arrows march into the defender and fade where a front stops (no
   ghost behind it), nothing over the name labels. Also nuke a front with a
   hydrogen bomb: `frontTexelsLastFrame` must stay 0 for the tiles lost.
3. **Night**: `?renderer=three&three_perf=1&three_night=1`, late game,
   a dense city area at 0.7, 1.8, 5 and 11 px per tile, and an atom bomb at
   5 px per tile at night (`gpuMs` during its 0-1.5 s flash). Counters:
   `layers.terrain.stats.night*` (`nightLightmapMs`, `nightLightmapMsMax`
   after a burst of construction, `nightFlashLights`). Look at: city lights
   growing with level, lit windows close up without sparkle while panning,
   the flash lighting land and sea white then orange, rails, names and
   ships readable, fallout keeping its relief. With the graphics "Night"
   preset and no URL flag the 3D renderer must stay in day mode.
4. **All three**: `?renderer=three&three_perf=1&three_wakes=1&three_front=1&three_night=1`
   at the same views; compare `gpuMs` and `jsMs` with the flags off.

## Not drawn yet

These facade methods are documented no-ops: railway construction dust and
rail colours, spiral ribbons (a spiral nuke trail shows its first colour),
decorative map layers, the cursor position (`setMouseWorldPos`: no hover
effects) and defense coverage. See "Facade methods" and "Cosmetics
support" for the full picture.

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
  `uploadTileAndTrailState`, `uploadLiveTrailDelta`, `applyTerrainRects`,
  `updateUnits`,
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
  only run when `ctx.settings.perf` is true. `UnitLayer` (railways,
  units and ribbons), `StructureLayer`, `TerrainLayer` (tile uploads, grid,
  glow, cosmetics and trails),
  `OverlayLayer` (spawn halos, SAM rings) and `FxLayer` (particles and
  fill) implement it:
  - `terrain`: `uploadCallsLastFrame` and `texelsLastFrame` (tile-state
    uploads of the last frame, a full upload pushed between frames
    included, so the first frame of a game shows 1 + the rectangles),
    `uploadCallsMax` and `texelsMax` (over the last 120 frames),
    `pendingTexels` and `pendingCells` (still queued), `uploadCallsTotal`,
    `texelsTotal`, `fullUploads`; `gridOn` and `glowOn` (0 / 1),
    `glowMaskBuilds` and `glowSetUploads` (cumulative), `glowMaskTexels`
    (texels written per mask build, 3 passes); the territory cosmetics
    counters (see "Territory cosmetics") and the trail / effect palette
    counters (see "Cosmetic effects"); lot 3: `falloutTiles`,
    `falloutDenseCells` (smoke emitters), `falloutRebuilding` (0 / 1: a
    full re-read in progress), `falloutMsMax` (JS ms of the fallout field
    per frame, max over 120 frames) and `reliefTextureMB`; lot 4, with
    `three_front=1` only: the `front*` counters of "Living front"; with
    `three_night=1` only: the `night*` counters of "Night and lights".
  - `overlay`: `spawnHalos`, `spawnVertices`, `spawnTriangles`,
    `spawnRebuilds`; `samVisible`, `samCircles`, `samArcs`,
    `samRingSegments` (8 triangles each), `samPendingCircles` (heights
    still being sampled), `samRebuilds`, `samBuildMs` / `samBuildMsMax`;
    with `three_front=1`, `frontArrows`, `frontArrowCandidates`,
    `frontJsMs`.
  - `structures`: `structureInstances` (= `modelInstancesDrawn`, 3D
    model instances drawn), `structureTriangles`, `modelDrawCalls`,
    `structureLod` (1 = low-poly models), `structureCulled` (outside the
    view, 0 while no model is drawn), `iconInstances`, `iconDrawCalls`
    (0 or 1), `iconTriangles`, `fadeBandInstances` (structures drawn both
    as icon and model, inside the fade band), `modelWeight` (0 = icons
    only, 1 = models only), `iconAlpha` (the icons' crossfade opacity) and
    `ghostIcons` (build ghost icons drawn: 0, 1, or 2 with an upgrade
    target); `padsShifted` and `padsShrunk` (models moved / shrunk to stay
    on land), `padPlaceMsMax` (slowest placement, JS ms) and
    `padPlacePending` (placements still queued).
  - `units`: the railway counters (`railPieces`, `railTriangles`, …, see
    "Performance notes"), `unitInstances`, `unitLodInstances`,
    `unitCulled`, `unitTriangles`, `unitJsMs`, `nukeEffectRibbons`
    (nuke ribbons drawn in their owner's effect colours), `nukesInFlight`,
    `nukesScreenCapped`, `trailRibbons`, `trailSamples` and
    `warheadTrails`; lot 4, with `three_wakes=1` only: `wakeInstances`,
    `wakeCulled`, `wakeCapped`, `wakeJsMs` / `wakeJsMsMax` (measured with
    `three_perf=1` only) and `wakeUploadKB` (see "Ship wakes").
  - `fx`: `glowParticles`, `smokeParticles`, `fireballs`, `decals`,
    `pendingEffects`, `liveEffects`, and `fillScreens` /
    `fillScreensMax` (last frame / max over 120 frames): the screen area
    of the glow and smoke quads (fallout puffs included) and fireballs
    over the viewport area, an estimate of how many times each pixel is
    blended (decals left out); `falloutPuffs` (fallout smoke puffs drawn)
    and `falloutSmokeMs` (their JS time, last frame); with
    `three_front=1`, the living front's particle counters.

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
  tile it is light and half transparent so lines do not read as borders,
  and since lot 3 it fades out below ~2.3 device px per tile and is not
  drawn at all from 1 down, like the default renderer (see "Readability at
  distance").
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
  Those 23k and 6.6k structure triangles are now icons (see "Structure
  icons").
- Structures below 2.5 px per tile (3.5 with `three_quality=low`) are
  icons only: one instanced draw of 2 triangles per structure, never
  culled, no model and no shadow. On a synthetic late-game set of 400
  structures (`tests/client/three/structureSet.ts`, 1920×1032 view,
  top-down; `StructureIcons.test.ts` checks it), structure triangles / draw
  calls went from 21.8k / 16 to 0.8k / 1 at full map (0.7 px per tile), 7.9k
  / 15 to 0.8k / 1 at 1.8, 2.5k / 13 to 3.3k / 14 at 3.5 (inside the fade
  band: the 400 icons plus 44 low-poly models in view and their shadows)
  and stayed 3.7k / 8 at 8 (models only; 0.9k with `three_quality=low`).
  Per-frame JS (jsdom, 400 structures, steady view): 0.12 → 0.02 ms at
  full map (no frustum test, only the icon uniforms), 0.7 → 0.6 ms at 1.8
  (the level badges are projected as before), and still ~1.4 ms per frame
  while zooming through 1.5-6 px per tile (model matrices rewritten as the
  fade weight changes).
- **Lot 2 in the headless late game** (same protocol as lot 1: World, 50
  bots + 72 nations, instant build and infinite gold, fast-forwarded to
  tick ~24,850 and paused, 1920×1032, high quality; 1,888 units of which
  480 structures, 53.5k railway pieces; lot 1 measured tick 23,319 with
  1,861 units, 457 structures and 48k pieces). Every lot-2 overlay off:

  | View (CSS px per tile) | Draw calls lot 1 → lot 2 | Structure triangles lot 1 → lot 2     | Structure draws |
  | ---------------------- | ------------------------ | ------------------------------------- | --------------- |
  | Full map (0.7)         | 42 → 25                  | 24.3k → 0.96k (480 icons)             | 1               |
  | Default (1.8)          | 42 → 23                  | 6.9k → 0.96k                          | 1               |
  | Fade band (3.5)        | – → 32                   | 3.6k (480 icons + 52 low-poly models) | 1 + 8 + shadows |
  | Close (8, tilted 31°)  | 37 → 31                  | 6.1k → 4.2k (18 models in view)       | 7               |
  | Max (20, tilted 50°)   | 27 → 27                  | 1.8k → 2.5k                           | 5               |

  Total triangles are 1.15-1.19M at every zoom, of which the relief is
  1.006M and the railway strips 134k (53.5k pieces). `StructureLayer`
  JS per frame (paused, median of 4 frames): 0.1 ms at full map, 0.2 ms at
  1.8, 0.3 ms in the band. Inactive lot-2 features cost nothing: with the
  grid, glow, SAM rings, ghost and spawn halos shown and then switched
  off again, the frame is back to 23 draw calls at 1.8 with 0 overlay
  triangles (the sea-overlay plane hidden, the terrain shader's branches
  off), and `overlay.update` reads 0.0 ms. Shown (same scene, 1.8): grid +1 draw call and 2
  triangles; glow (every alive player) +1 draw call, 3 off-screen passes
  per pushed set (375k texels); SAM rings of 34 launchers (60 arcs, 4.0k
  segments) +1 draw call and 32k triangles, first build 10.3 ms in one
  frame; hydrogen-bomb ghost range disc +7.9k triangles; 31 spawn halos +1
  draw call and 9.1k triangles. Trails, game running at normal speed with
  a frame every ~3 s of sim (~30 ticks per frame, a worst case for 60 FPS):
  at most 2 trail uploads and 4.4k texels per frame, the diff at most
  524k texels and 1.2 ms (p90 0.6 ms), up to 229 reported rows waiting
  one frame, no cell left queued; `uploadLiveTrailDelta` 0.3 ms per frame
  at most (all the ticks in between).

- **Lot 3 in a headless late game** (the recorded World state of
  "Readability at distance": tick 19,405, 1,480 units of which 394
  structures, 897 trade ships and 182 trains, 35.1k railway pieces, pushed
  through the facade; 1920 ×
  1032, high quality; lot 2 = the same state and cameras at `00199ee`):

  | View (CSS px per tile) | Draw calls lot 2 → lot 3 | Triangles lot 2 → lot 3 | Terrain | Units (rails incl.) | Structures |
  | ---------------------- | ------------------------ | ----------------------- | ------- | ------------------- | ---------- |
  | Full map (0.7)         | 24 → 23                  | 1,135k → 1,053k         | 1,012k  | 39.7k (strips off)  | 0.8k       |
  | Default (1.8)          | 25 → 25                  | 1,114k → 1,120k         | 1,012k  | 106.6k              | 0.8k       |
  | 5 (tilted 9°)          | – → 30                   | – → 1,123k              | 1,012k  | 107.4k              | 2.8k       |
  | 11 (tilted 48°)        | – → 31                   | – → 1,202k              | 1,012k  | 185.3k              | 4.0k       |
  | 20 (tilted 50°)        | – → 25                   | – → 1,144k              | 1,012k  | 130.1k              | 1.3k       |

  The terrain's +6.0k triangles are the apron; no lot-3 change adds a draw
  call outside the fallout smoke (+1 while puffs show) and no texture but
  the relief texture (3.8 MB on World). Layer JS per frame stays within
  the headless noise (SwiftShader frames take seconds; a shared CPU), with
  two lot-3 sources worth a real-GPU look: the structure placement queue
  (`padPlaceMsMax` up to 9.6 ms for a single fit under that load, 1.5 ms
  budget per frame otherwise; 394 structures pushed at once leave ~350 in
  the queue, drained a few per frame) and the fallout field's full
  re-read after a full tile upload (`falloutMsMax` 4.4-7 ms headless, 0.4
  ms budget per step). Hydrogen + atom bomb fallout scene (26,155 fallout
  tiles, 391 dense cells): 20 draw calls at full map, 22-24 with the smoke
  (35 of 36 puffs, 70 triangles, `falloutSmokeMs` ≤ 0.2); the embers are in
  the terrain shader (~2% of the fallout tiles, ~520 here; no instances).
  Bombs in flight (3 bombs + 24 warheads): 27 ribbons, 90-120 ribbon
  samples (the head-glow split vertices included), draw calls unchanged
  (23 at full map, 37 at 4, 31 at 11).

- **Lot 3 perf triage** (shader cost; every change keeps the pixels). In
  the lot-3 verification a whole-map frame took 24-32 s headless against
  ~1-7 s before. That is SwiftShader, a CPU renderer: its times are only a
  proxy and say nothing about FPS. On an idle machine the gap was 10.1 s
  (lot 2) → 16.5-17.1 s (lot 3), all of it in the terrain draw, and it was
  program size, not pixel work: SwiftShader runs every block of every
  branch for every fragment (16 value noises behind a branch never taken
  cost as much as the same noises taken), and every call site is inlined.
  Lot 3 had given `shadeLandTile` and `shadeWater`, the two largest
  functions, a second call site (the apron's), so the terrain program
  carried two copies of each, and its zoom-weighted blocks (smooth relief,
  fallout, glitter) are in the program at every zoom. A GPU skips a branch
  that goes the same way for a whole group of pixels, so what it executes
  grew much less (below).
  - **Fixes** (`shaders/terrain.ts`, `shaders/water.ts`, `TerrainLayer.ts`;
    `ShaderPerfTriage.test.ts`):
    - one call site each for `shadeLandTile` and `shadeWater` in the
      terrain shader: the map and the apron select their inputs and share
      them (`shadeWaterTile` is gone);
    - work whose weight is 0 behind a branch instead of computed and mixed
      away: the fallout's near look (4 value noises) while `near` = 0 (full
      map, default zoom) and its far look (1) while `near` = 1, the hotspot
      hashes and clearance fetches while hotspots are faded out, the ember
      hash while embers are; the micro-detail noises (2 value noises with
      gradient, a cos and a sin) and the whole detail normal (4 pow, 2
      normalize) while `detail` = 0 (full map on a 1× screen); the bilinear
      tile heights once the B-spline has replaced them (`smoothW` = 1); the
      territory fill under fallout (replaced) and past the apron's fade
      (weight 0); the glints' share of each wave octave while glints are
      off; the sun disc's `pow(s, 1200)` in the reflected sky (weight 0);
    - the relief's 4 bilinear taps at an explicit level 0 (`textureLod`;
      the same result: no mips, linear min and mag filters), so no
      implicit derivatives sit in a non-uniform branch (undefined in GLSL
      ES; ANGLE's D3D back end may hoist or flatten such a branch);
    - `tileBspline` fetches its 3 × 3 tiles at constant offsets instead of
      filling a `uint[9]` indexed per fragment (scratch memory on most
      GPUs);
    - no skirts (−6,000 triangles on World): always under the apron but
      drawn first in the same draw call, so shaded for nothing in edge
      views, and their depth won over the apron on a few pixels of the
      seam (28 isolated pixels, ~20/255 darker than their neighbours, in a
      tilted view of the south edge; now the apron's colour). The shader's
      wall branch went with them.
  - **Headless render time** (SwiftShader, so a proxy for program size and
    never a GPU time: median of 3 synced renders, 1 × 1 readPixels then
    `composer.render(0)` then 1 × 1 readPixels; 1920 × 1032, DPR 1, high
    quality, World; the recorded late state above and the hydrogen-bomb
    fallout state; game paused, fixed animation clock). "Before" and
    "after" are two sessions; "lot 2" and "default" are the same states and
    cameras measured during the triage (`00199ee`, and the default renderer
    through `GPURenderer.draw`). Spread: ±4% run to run, ±5-10% between
    two builds of a program:

    | View (CSS px per tile)  | Default | Lot 2  | Lot 3 before | Lot 3 after   | After / lot 2 |
    | ----------------------- | ------- | ------ | ------------ | ------------- | ------------- |
    | Late, full map (0.7)    | 1,212   | 10,058 | 16,539       | 11,029 (−33%) | 1.10          |
    | Late, 1.8               | 1,726   | 5,481  | 8,512        | 6,200 (−27%)  | 1.13          |
    | Late, 5 (tilted 9°)     | 1,734   | 3,150  | 5,312        | 4,357 (−18%)  | 1.38          |
    | Late, 11 (tilted 48°)   | 1,714   | 3,288  | 4,954        | 3,704 (−25%)  | 1.13          |
    | Late, 20 (tilted 50°)   | 1,681   | 2,906  | 4,380        | 3,337 (−24%)  | 1.15          |
    | Fallout, full map (0.7) | –       | –      | 17,711       | 10,351 (−42%) | –             |
    | Fallout, 1.8            | 1,656   | 4,622  | 8,152        | 5,034 (−38%)  | 1.09          |
    | Fallout, 5              | 1,608   | 2,761  | 4,636        | 3,235 (−30%)  | 1.17          |
    | Fallout, 11             | 1,576   | 2,368  | 4,400        | 3,151 (−28%)  | 1.33          |

    In the "after" session, the lot-3 shaders swapped back in at runtime
    (same scene, same geometry) took 1.24-1.69× as long in every view and
    drew the same pixels (0 differing pixels in 24 views: the table's,
    map edges, a coast, the alt view, fallout at 3 and 20 and at its edge,
    open water at 4.5, 8 and 20). Canvas dumps of the two sessions match
    exactly in 22 of the 24 views; the other two differ by the skirt seam
    (above) and by one fallout smoke puff (its random emitter follows the
    order the views were taken in; hiding the smoke removes the same
    pixels). Draw calls are unchanged; triangles −6,000 at every view (the
    skirts).

  - **What a GPU executes per fragment, lot 3 over lot 2, after the
    triage.** Full map and default zoom: owned land one more
    `diffuseLight` (far flatten), every map fragment the edge flattening (a
    min and a smoothstep); the apron ring (~10% of the screen at full map,
    only at the map edge otherwise) runs the terrain shader instead of the
    water plane (5 value noises, 5 tile fetches, the water shading);
    fallout 4 rim fetches and the far look's noise; water 2 sin (phase
    warp). From ~2.5 device px per tile, land 4 bilinear relief taps, 9
    tile fetches (4 in cache) and the 3 × 3 loop (9 pow); from ~2 px per
    tile, fallout the near look (4 noises) and the hotspot test, from ~4 px
    its embers; from ~4 px per tile, water the glitter (2 value noises with
    gradient and their trig). Lot 3 also skips the glint lobes below ~4 px
    per tile, which lot 2 computed and multiplied by 0.
  - **Not done**: compile-time variants (`defines`) of the terrain program
    without the close-up, fallout or apron code (they would bring the
    headless frame near lot 2's, but switching programs at zoom thresholds
    risks compile hitches unless every variant is precompiled, and a GPU
    already skips those blocks); an early-out for the outer apron ring
    close up (only edge views would gain, and it adds code every fragment
    pays headless); skipping bloom while nothing crosses its threshold (not
    lot 3, and proving "nothing" without a visible change is not cheap).
  - **Pricing lot 3 on a real GPU** (the numbers that matter):
    `?renderer=three&three_perf=1` in a late game, `__threePerf().gpuMs.avg`
    (a 120-frame window: wait a few seconds after each change) at full map
    (0.7 CSS px per tile), 1.8, 5, 11 and 20, over a fallout zone at 1.8,
    5 and 11, and at a map edge at 1.8; then the same with one feature off
    at a time from the console (each patch recompiles the terrain program
    once):

    ```js
    const t = __webglView.terrain;
    const w = __webglView.water;
    const src = new Map(
      [t.material, w.material].map((m) => [m, m.fragmentShader]),
    );
    // Patch (or with no pairs, restore) one material's shader.
    const off = (m, ...pairs) => {
      let s = src.get(m);
      for (const [a, b] of pairs) s = s.split(a).join(b);
      m.fragmentShader = s;
      m.needsUpdate = true;
    };
    // Smooth relief (normal and tile B-spline):
    off(
      t.material,
      ["if (land && close > 0.0 && dOut <= 0.0) {", "if (false) {"],
      ["close > 0.0 ? tileBspline(b, w)", "false ? tileBspline(b, w)"],
    );
    // Fallout look: off(t.material, ["if (fallout) {", "if (false) {"]);
    // Far flatten: off(t.material, ["if (owner != 0 && uFarFlatten > 0.0) {", "if (false) {"]);
    // Glitter: the same pair ["* glitterSlope(p, t, tpp);", "* vec2(0.0);"]
    // for t.material and w.material.
    off(t.material);
    off(w.material); // back
    // The apron ring: draw the grid only (the water plane shades the ring).
    t.geometry.setDrawRange(0, (t.grid.cols - 1) * (t.grid.rows - 1) * 6);
    t.geometry.setDrawRange(0, Infinity); // back
    ```

    Bloom: `three_bloom=0`.

- Names, troop counts and level badges are pooled DOM elements. The frame
  loop never reads layout, and troop text changes at most every 500 ms per
  label.
- Bloom and 4× MSAA on the post-processing target take most of the fill
  rate (about 1 to 2 ms of 3.6 to 5 ms of GPU time late in a game on the
  laptop RTX of the real-GPU test), and the backing store is capped at
  pixel ratio 2. On weak GPUs try `three_quality=low` (canvas MSAA, no
  post-processing chain).
- The headless harness runs on SwiftShader at about 2.4-11 s per render
  late in a game (World, 1920 × 1032, high quality; 1.5-4 s early on),
  which says nothing about real hardware: its time follows the size of the
  shader programs (it runs every branch), not the work a GPU executes (see
  "Lot 3 perf triage"). Measure with `three_perf=1` on a real GPU.
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
  The parity overlays: `SamRings.test.ts` (circle union, colours, upgrade
  animation, when rings show, lazy and budgeted builds, ribbons never under
  the World relief), `SpawnOverlay.test.ts` (order, radii, breath, draped
  patches), `SurfaceOverlay.test.ts` (grid cell size, labels, grid / alt
  view on-off, glow mask passes per pushed set, strength, context restore),
  `ReliefSurface.test.ts` (`surfaceAt` matches the relief triangles; the
  ghost range rim stays above the World relief) and
  `ParityOverlays.test.ts` (the facade wiring, the grid toggle
  remembered, the relations and the build ghost reaching the structure
  icons). Structure icons: `StructureIcons.test.ts` (atlas order, sizes,
  crossfade weight and opacity, colours, layer integration, no popping
  across the band, build ghost icon, late-game cost).
  Territory cosmetics: `TerritoryCosmetics.test.ts` (the pattern lookup
  against `PatternDecoder` and a literal port of the default's GLSL on
  data written by `writePatternEntry`, orientation, row uploads, skin
  layers / anchors / bounds / placement, skin over pattern, late and failed
  loads, restore, dispose), `TerritoryCosmeticsFacade.test.ts` (facade
  wiring, team mode, the live switch) and `DevSkinHook.test.ts`. Trails and
  the effect palette: `EffectTrails.test.ts` (colours against a literal
  port of the default's trail.frag.glsl on palettes written by
  `writePlayerEffects`, the palette mirror and its switches, a real
  TrailManager driven for 400 ticks with the per-frame diff and upload
  budgets checked and a GPU copy converging to the live buffer, alt-view
  colours), `NukeRibbonEffect.test.ts` (ribbon colour selection and the
  per-vertex owners / switch fed to its shader) and
  `EffectTrailsFacade.test.ts` (facade wiring). Readability at distance
  (lot 3): `TerrainShading.test.ts` (territory look curves: settings look
  from 5 px per tile, full strategy look at full map, monotonic, a one-tile
  border at 1.8; shore halo scale; apron size, mirror, warp, zoom scale,
  virtual coast, fill fade and water magnitude; the GLSL constants against
  the TS ones),
  `TerrainLayers.test.ts` (the apron geometry: slope on the edge vertices,
  flat ring, facing up, covering the ring once; the zoom-driven uniforms,
  alt-view ground) and `RailTracks.test.ts` (`railStripLook` against the
  default renderer's `railroad` settings, by device px; strips not drawn
  while faded out, rebuilds still applied). Lot 3: `NameLayer.test.ts`
  (close-up cap), `StructureBases.test.ts` (pads, land fit within a tile,
  ground grid reduced to a tilt-capped plane, separate city towers, the
  pier on posts, conform shader, placement budget) and `NukeFlight.test.ts`
  (bombs' screen cap, contrails, warhead trails, glow under the bloom
  threshold zoomed out, the trail straight behind the bomb while its size
  changes and its glow ending within the screen length, warhead contrails
  thinned by their number) and `FxLayer.test.ts` (the default shockwave
  ring just over the bloom threshold). Fallout, water glints and smooth
  relief (lot 3): `TerrainSurfaces.test.ts`, `FalloutField.test.ts` and
  additions to `TerrainLayers.test.ts` / `FxLayer.test.ts` (see "Lot 3:
  fallout, water glints, smooth relief"). Perf triage:
  `ShaderPerfTriage.test.ts` (one call site per shading function, work
  whose weight is 0 behind branches, relief fetches at level 0, no local
  array in the tile B-spline, the water's glint share and sun disc only
  when used) and the skirt-free geometry in `TerrainLayers.test.ts`.
  Lot 4: `ShipWakes.test.ts`, `LivingFront.test.ts` and
  `NightLights.test.ts` (see "Lot 4 prototypes"); `shaderDefines.ts`
  (a helper, not a test) resolves a shader's `#ifdef` blocks for the
  "compiled out without the define" tests.
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
  Overpass font, the status atlas and the structure icon atlas), which are
  **CC BY-SA 4.0** with attribution to "OpenFront", plus the territory skin
  images the players equipped (catalog URLs, proprietary, loaded at run time
  like the default renderer does; nothing is bundled, and the parity tests
  use a generated image).
- Assets in `/proprietary` are **all rights reserved** (`/LICENSE-ASSETS`,
  `/proprietary/LICENSE`). Do not use them in work outside OpenFront.
- three.js is a dependency under the MIT license.
