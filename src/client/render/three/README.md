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

  | File                                                       | Draws                                                                                                                                                    |
  | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `SceneEnvironment.ts`                                      | Sun and hemisphere lights, sky dome, distance fog                                                                                                        |
  | `TerrainLayer.ts`, `shaders/terrain.ts`                    | Relief mesh: terrain colours, territory fill, borders, fallout, coastal water; close-up detail                                                           |
  | `TerritoryCosmetics.ts` (owned by `TerrainLayer`)          | Territory patterns and skins in the fill (terrain shader)                                                                                                |
  | `SurfaceOverlay.ts` (owned by `TerrainLayer`)              | Coordinate grid and small-player glow, painted on the ground (terrain shader + sea-level plane)                                                          |
  | `EffectTrails.ts` (shared: terrain, water, units)          | Boat and nuke trails on the ground (terrain + water shaders), the cosmetic effect palette                                                                |
  | `WaterLayer.ts`, `shaders/water.ts`                        | Sea plane: depth tint, waves, glints, shore foam; boat / nuke trails over water                                                                          |
  | `StructureLayer.ts`                                        | Icons when zoomed out (`StructureIcons.ts`) fading into instanced models; bars, level badges                                                             |
  | `UnitLayer.ts`                                             | Instanced ships, trains, nukes, shells and missiles (culled, low-poly when small); health bars; nuke / SAM ribbons (nukes in their owner's trail effect) |
  | `RailTracks.ts` (owned by `UnitLayer`)                     | Railways: per-block ballast strips, sleepers and rails close up                                                                                          |
  | `OverlayLayer.ts`                                          | Build ghost and range ring, nuke arc, nuke target rings, attack rings, move and blocked markers                                                          |
  | `SpawnOverlay.ts`, `SamRings.ts` (owned by `OverlayLayer`) | Spawn halos; SAM range rings                                                                                                                             |
  | `FxLayer.ts`                                               | Explosions, mushroom clouds, shockwaves, smoke, sparkles                                                                                                 |
  | `NameLayer.ts`                                             | Player names, troop counts, flags, attack labels, gold popups (DOM)                                                                                      |

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
| `updateUnits`, `updateStructures`, `applyDeadUnits`, `applyConquestEvents`, `setSelectedUnits`, `uploadRailroadState`                       | Units, structures (icons ↔ models), bars, badges, SAM ring inputs, FX, railways                                                                                                                                                       |
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
  (×1.5) for the bloom. Without an effect, for SAM missiles and in the alt
  view the ribbon is unchanged: the warm additive glow (one material,
  premultiplied blending: alpha 0 adds, alpha > 0 is "over"). The bombs
  themselves are unchanged (lot 3).
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
    counters (see "Cosmetic effects").
  - `overlay`: `spawnHalos`, `spawnVertices`, `spawnTriangles`,
    `spawnRebuilds`; `samVisible`, `samCircles`, `samArcs`,
    `samRingSegments` (8 triangles each), `samPendingCircles` (heights
    still being sampled), `samRebuilds`, `samBuildMs` / `samBuildMsMax`.
  - `structures`: `structureInstances` (= `modelInstancesDrawn`, 3D
    model instances drawn), `structureTriangles`, `modelDrawCalls`,
    `structureLod` (1 = low-poly models), `structureCulled` (outside the
    view, 0 while no model is drawn), `iconInstances`, `iconDrawCalls`
    (0 or 1), `iconTriangles`, `fadeBandInstances` (structures drawn both
    as icon and model, inside the fade band), `modelWeight` (0 = icons
    only, 1 = models only), `iconAlpha` (the icons' crossfade opacity) and
    `ghostIcons` (build ghost icons drawn: 0, 1, or 2 with an upgrade
    target).
  - `units`: the railway counters (`railPieces`, `railTriangles`, …, see
    "Performance notes"), `unitInstances`, `unitLodInstances`,
    `unitCulled`, `unitTriangles`, `unitJsMs`, and `nukeEffectRibbons`
    (nuke ribbons drawn in their owner's effect colours).
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
  `EffectTrailsFacade.test.ts` (facade wiring).
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
