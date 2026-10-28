# webgpu-engine

A minimal, dependency-light **browser / WebGPU** rendering engine skeleton in TypeScript.
It is the first of a family of per-platform engines: each runtime is tailored to its
target, and a shared offline asset pipeline (`tools/bake`) bakes glTF into the format each
runtime wants (for this engine: the `.wgm` container, see [FORMAT.md](FORMAT.md)).

Runtime dependency: [`wgpu-matrix`](https://github.com/greggman/wgpu-matrix) (math only).
Baked files need **no decompression or transcoding at load**: vertices are stored in quantized
GPU vertex formats and textures in the GPU's own block format (BC7 / ASTC / ETC2) with
precomputed mips; the loader hands bytes to `writeBuffer` / `writeTexture`.
Runtime asset (lazy-loaded, only for files baked with the opt-in `--texture-format universal`): the Basis Universal transcoder
(`public/basis/`, Apache-2.0, from [BinomialLLC/basis_universal](https://github.com/BinomialLLC/basis_universal)).
Dev tooling: Vite, TypeScript, `@webgpu/types`, `puppeteer-core` (headless screenshots), and for the
offline baker only: `@gltf-transform/*`, `meshoptimizer`, `mikktspace`, `ktx2-encoder` (Basis encoder
wasm), `astc-encoder.js` (ARM astcenc wasm, Apache-2.0), `pngjs`, `jpeg-js`, `tsx`. The baker also runs the
vendored Basis transcoder in Node to turn its UASTC intermediate into BC7 / ETC2 offline. None of the baker dependencies end up in the browser bundle.


## Running

```bash
npm install
npm run dev        # http://localhost:5173  (WebGPU needs https or localhost)
npm run build      # type-check + production bundle in dist/
npm run preview    # serve dist/
npm run screenshot # headless Chrome + SwiftShader render -> screenshot.png (after build)
npm run check:shaders # compile + validate every shader feature variant (incl. disabled ones)
npm test           # baker, device-profile and orchestrator tests (node:test via tsx; needs Chrome for the e2e ones)
npm run bake -- model.glb -o out/   # bake glTF -> out/model.wgm (see "Asset baking")
npm run local -- model.glb -o out/  # probe THIS machine in its browser, then bake for it (see "Three apps")
```

Probe page: `/probe.html` (dev server or `dist/`) measures the device and offers its DeviceProfile as a download.

URL options: `?model=/path/to/file.glb` (or `.gltf`, or a baked `.wgm`, detected by its magic
bytes), `?msaa=1` (disable 4x MSAA), `?dpr=1.5` (cap device pixel ratio, useful on phones to save
fill-rate), `?lod=N` (force LOD level N), `?lodpx=E` (LOD pixel-error threshold, default 1),
`?tex=bc7|astc|etc2|rgba8` (force the transcode target of opt-in `universal` KTX2 files),
`?nocompression=1` (create the device without texture-compression features, to see the
"re-bake for this device" error). A `{tex}` in the model URL (`?model=/out/name.{tex}.wgm`, from
`--texture-format each`) is replaced by the best native format the device supports.

Controls: drag to orbit, right/middle/shift-drag to pan, wheel to zoom.
Touch: one finger orbits, two fingers pinch-zoom and pan.

## Architecture

```
src/
  core/        gpu.ts        adapter/device/canvas setup, clear "WebGPU unsupported" errors, device-lost hook
               resize.ts     ResizeObserver (device-pixel-content-box) -> canvas size * DPR, optional DPR cap
               frameLoop.ts  rAF loop with clamped dt
  renderer/    renderer.ts   frame orchestrator: draw list, uniforms, runs the ordered pass list
               config.ts     RendererConfig ({ msaa, shadows, ... }) -> resolved config
               features.ts   compile-time shader feature set (-> WGSL defines, cache keys)
               shaderPreprocessor.ts  tiny `#if NAME / #else / #endif` for WGSL
               passes/       RenderPass interface, ForwardPass (MSAA + depth), shadowPass.ts (design stub only)
               pipelines.ts  bind-group layouts, vertex layouts, pipeline cache (features x alpha mode x culling)
               material.ts   material description + uniform packing + sort keys
               mesh.ts       GPU buffers for primitives (non-interleaved streams, offsets, LOD levels)
               lod.ts        LOD settings + screen-space error LOD selector
               textures.ts   image upload, GPU mipmap generation, precomputed-mip / compressed upload,
                             1x1 defaults, sampler cache
  scene/       node.ts       scene graph: TRS -> local/world/normal matrices with dirty flags
               camera.ts     perspective camera (WebGPU 0..1 depth)
               scene.ts      scene root, one directional light, hemisphere ambient
               lighting.ts   light-space matrix from scene bounds (hook for shadows)
               bounds.ts     AABB helpers (framing; later culling)
  assets/      gltf.ts       glTF 2.0 / GLB parser -> engine-neutral CPU data (no GPU calls)
               geometry.ts   generate missing normals / tangents, bounds
               modelLoader.ts fetch once, sniff glTF/GLB vs .wgm, CPU data -> GPU resources + scene subtree
               wgm/format.ts  .wgm reader/writer + types (shared with the baker; no DOM/Node APIs)
               wgm/loader.ts  .wgm -> one vertex buffer, one index buffer, textures, materials, nodes
               ktx2/transcoder.ts  Basis transcoder, dynamically imported ONLY for opt-in universal (KTX2) files
  shaders/     pbr.wgsl      metallic-roughness PBR (GGX, Smith-GGX correlated, Schlick), ACES tonemap
               mipmap.wgsl   downsample blit
  controls/    orbit.ts      orbit camera on Pointer Events (mouse + touch + pinch), damped
  probe/       profile.ts    DeviceProfile v1 schema + validation (pure; also used by the baker)
               measure.ts    adapter/limits/compression/screen/benchmark -> DeviceProfile, device class
               main.ts       probe.html app: show/download, optional loopback report (?report=&token=)
  main.ts      demo app: init, load model, frame it, run loop, HUD
probe.html     the probe page (second Vite entry)
tools/bake/    offline baker (Node, never bundled): cli.ts, bake.ts, prepare.ts, geometry.ts,
               device.ts (profile -> options), headlessProbe.ts (--device auto),
               quantize.ts (GPU-native vertex formats + error measurement), presets/ (estimated profiles),
               targets/ (profiles), textures/ (decode, mips, native BC7/ASTC/ETC2 encode, KTX2), test/
tools/local/   orchestrator (node:* only, no baker/probe imports): cli.ts, orchestrator.ts (state machine),
               server.ts (127.0.0.1 report endpoint + static), processes.ts (open URL, spawn baker),
               protocol.ts (own copy of the profile rules, NDJSON parsing), test/
scripts/headless-browser.mjs  headless Chrome stand-in for --browser-cmd (tests / CI)
```

### Key design choices

- **Data flows one way:** `assets` parses into plain typed arrays + descriptors, `modelLoader`
  is the only module that knows both glTF and the renderer. The baked-format loader
  (`assets/wgm/loader.ts`) sits beside it and skips parsing entirely.
- **Bind groups by update frequency:** group 0 = per frame (camera/light), group 1 = per
  material, group 2 = per draw. All per-draw matrices go into **one** uniform buffer, written
  with **one** `writeBuffer` per frame, and selected with dynamic offsets.
- **Draw sorting** by a numeric key (blend pass | pipeline variant | material) minimises
  pipeline and bind-group switches; vertex/index buffers are only rebound when the primitive changes.
- **Pipelines are cached and pre-warmed** at material creation, so the first frame does not hitch.
- **MSAA 4x with `storeOp: 'discard'`** on the multisampled color and depth: only the resolved
  image is written to memory, which matters a lot on tile-based mobile GPUs.
- **sRGB done by hardware:** the canvas is configured with an `*-srgb` view format; base color
  and emissive textures are uploaded as `rgba8unorm-srgb`, data textures as linear.
- **Mipmaps generated on the GPU** at load time for glTF; baked files ship them precomputed.
- **Non-interleaved vertex streams** (position / normal / uv / tangent) keep the loader simple
  and allow a depth-only pass to bind positions alone later. Baked streams are **quantized
  GPU vertex formats** (unorm16 positions dequantized by a per-draw scale/offset, snorm8/16 or
  octahedral normals/tangents, unorm16/float16 UVs); the shader declares `vec4f` inputs so one
  module serves every format, and pipelines are cached per vertex layout
  (`renderer/vertexLayout.ts`; octahedral layouts add an `OCT_NORMAL`/`OCT_TANGENT` define).
- **Tangents generated only when a normal map needs them**; missing normals are computed.
  (glTF path: Lengyel-style at load time; baked path: MikkTSpace in the baker.)

## Extending the renderer / adding shadows later

The renderer is a small pass system driven by one config object:

```ts
const renderer = new Renderer(gpu, { msaa: 4, shadows: false }); // defaults
```

- **Passes.** `Renderer.createPasses()` builds an ordered `RenderPass[]` from the config. Every
  pass implements `setup / resize / prepare? / execute / destroy` (`renderer/passes/pass.ts`).
  The Renderer builds the per-frame data once (sorted draw list, per-draw matrices, frame
  uniforms) and hands it to each enabled pass in order, all recorded into one command encoder.
  Today the list is just `[ForwardPass]`.
- **Shader features.** `features.ts` turns the config into a `ShaderFeatures` set, which becomes
  WGSL `#if` defines (`SHADOWS`, ...) via `shaderPreprocessor.ts`. Shader modules, the group-0
  layout and pipelines are cached per feature set, so variants never collide.
- **Stable bind-group contract.** Only group 0 (per-frame/lighting) varies with features; slots are
  reserved in `FRAME_BINDING` (0 = uniforms, 1 = shadow map, 2 = comparison sampler) and the
  uniform layout in `FRAME_LAYOUT` (`lightViewProj`, `shadowParams` appended only when enabled).
  Materials (group 1) and per-draw data (group 2) never change, so materials need no rework.
  Passes contribute their group-0 resources through `frameBindGroupEntries()`.
- **Zero cost when off.** With `shadows: false` there is no shadow pass, texture, binding,
  uniform bytes (frame block stays 160 B) or shader code; the light visibility term is a
  constant `1.0` (trivially constant-folded). Output is pixel-identical to before the refactor.

**Adding shadows** is a drop-in change (full checklist in `src/renderer/passes/shadowPass.ts`):

1. Implement `ShadowPass` (depth-only pass into a `depth32float` map using `POSITION_ONLY_LAYOUT`
   and the shared per-draw bind group; in `prepare` compute the light matrix with
   `computeDirectionalLightViewProj(scene.light, bounds)` from `scene/lighting.ts` and write it
   at `FRAME_LAYOUT.lightViewProj`; expose map + comparison sampler via `frameBindGroupEntries`).
2. Register it before `ForwardPass` in `createPasses()` when `config.shadows` is set.
3. Flip `SHADOW_PASS_IMPLEMENTED` in `config.ts` (until then `shadows: true` logs a warning and is ignored).
4. Replace the single-tap placeholder in `directionalLightVisibility()` (pbr.wgsl) with real
   filtering (PCF/PCSS, cascades) if desired.

`npm run check:shaders` already compiles the `SHADOWS` variant and validates its pipelines
against the reserved layout, so the contract stays correct while the feature is off.
Other features (IBL, fog, clustered lights, post-processing) follow the same recipe: a flag, a
define, guarded WGSL, an optional pass, and if needed a reserved group-0 slot.

### glTF support

`.glb` and `.gltf` (external files or data URIs); TRIANGLES primitives; POSITION, NORMAL,
TEXCOORD_0, TANGENT; uint8/16/32 indices (or none); interleaved, normalized and sparse
accessors; node TRS or matrix; base color, metallic-roughness, normal, occlusion and emissive
textures with samplers; alpha OPAQUE / MASK / BLEND; doubleSided; `KHR_materials_emissive_strength`.

## Three apps: probe, baker, orchestrator

| App | Command / URL | What it does |
|---|---|---|
| **Probe** | `/probe.html` | Runs on the target device's browser. Reads WebGPU adapter info, features, limits, texture-compression support, screen/DPR, memory, and a short fill-rate benchmark into a **DeviceProfile** JSON. Standalone it shows the profile and offers *Download device-profile.json*. |
| **Baker** | `npm run bake -- in.glb --device profile.json` | Bakes glTF, tailored to a profile: caps texture size to the screen and GPU limits, sets a LOD0 triangle budget on unique geometry and a drawn-triangle estimate (instances) for LOD depth. `--json` for NDJSON events, with meaningful exit codes. |
| **Orchestrator** | `npm run local -- in.glb` | Same-machine convenience. Opens the probe in your **real default browser**, receives the profile over a loopback HTTP report, then runs the baker as a separate process with that profile. Optionally opens the viewer on the result. |

The three only talk through documented interfaces (URL params, HTTP report, CLI args, stdin,
NDJSON, exit codes), so a different engine's probe or baker can be swapped in. See **[PROTOCOL.md](PROTOCOL.md)**.

### Two workflows

```
A) Target is a different machine (e.g. a phone)            B) Target is this machine

  phone browser                 dev machine                  npm run local -- model.glb --detail high
 ┌──────────────┐           ┌─────────────────────────┐      ┌───────────────────────────────────────────────┐
 │ /probe.html  │ download  │ npm run bake -- model.glb│      │ orchestrator (127.0.0.1:random, one-time token)│
 │  (measure)   │──────────▶│   --device profile.json  │      │   1. opens default browser:                    │
 └──────────────┘  profile  │   --detail medium -o out/│      │      /probe.html?report=…/report&token=…       │
                   .json    └────────────┬────────────┘      │   2. probe POSTs DeviceProfile ──▶ validated   │
                                         ▼                   │   3. spawns: bake model.glb --device - --json  │
                                   out/model.wgm             │      (profile on stdin, NDJSON back)           │
                                         │                   │   4. --open: /?model=/out/model.wgm            │
                         host it, open /?model=…/model.wgm   └───────────────────────────────────────────────┘
```

### Probe

Open `/probe.html` on the device (served over https or localhost, since WebGPU needs a secure
context). `?bench=0` skips the benchmark. When the page gets `?report=<loopback url>&token=…` it
also POSTs the profile there (only to `127.0.0.1` / `localhost` / `[::1]`).

### Baker device options

```bash
npm run bake -- model.glb -o out/ --device profile.json --detail medium   # file
cat profile.json | npm run bake -- model.glb --device - --json            # stdin + NDJSON events
npm run bake -- model.glb --device auto                                   # headless probe of this host (needs npm run build)
npm run bake -- --device profile.json --print-device --json               # just validate/print the profile
```

- `--detail low|medium|high|max` scales the texture cap (longest physical screen side × 0.5/1/2/∞,
  power of two, ≤ GPU `maxTextureDimension2D`, ≤ 4096; mobile ≤ 2048 below high; software ≤ 1024;
  ≤ 2 GB RAM ≤ 1024) and two separate triangle numbers (×0.25 / ×4 / unlimited for low/high/max):
  - **LOD0 budget, unique geometry** (`--max-triangles N`; desktop 2M, mobile 300k, software 100k at
    medium): each mesh is counted **once**, however many nodes instance it (and primitives with identical
    positions + indices once, even across separate meshes). Over budget, every primitive's LOD0 is simplified by budget/unique, **but never past the
    position pixel tolerance** (`--pixel-error` px at the profile's screen size with the mesh filling the
    screen), so detail the device can display is kept even if the budget is then exceeded. N instances of a
    mesh get exactly the same LOD0 as one.
  - **Drawn-triangle estimate, instances counted** (`--max-drawn-triangles N`; desktop 5M, mobile 750k,
    software 250k at medium; a guess, not a measurement): never touches LOD0. When the scene as drawn at
    LOD0 exceeds it, the LOD chain gets more levels (up to 8, each `--lod-ratio` of the previous, still capped
    by `--lod-max-error`) so the runtime LOD selector can draw distant copies coarser.
  The `result` stats report `sourceUniqueTriangles`, `sourceDrawnTriangles`, `instances`, `lod0BudgetRatio`,
  `lodLevels`, `triangles` (unique LOD0 after the bake), `lodTriangles` (unique, per level),
  `drawnTrianglesLod0` and `drawnTrianglesCoarsest` (all instances).
- **Texture format** from the profile's `textureCompression` (always native, never transcoded at load):
  ASTC on mobile (or any device without BC; block 6x6 at `--detail low`, else 4x4), BC7 on desktop/software
  with BC, ETC2 if that is all there is, RGBA8 if there is no compression, and `each` (one file per format)
  if the probe saw no WebGPU at all.
- **Vertex precision tolerance** from the screen and detail: position error ≤ 1 / 0.5 / 0.25 / 0.1 px
  (low/medium/high/max) when the mesh's bounding diagonal spans the longest physical screen side;
  normal/tangent error ≤ 1° / 0.5° / 0.25° / 0.05°; UV error ≤ 0.5 / 0.25 / 0.125 / 0.0625 texel of the
  largest texture the material samples. snorm8 normals (max ≈0.4°) pass at low/medium, snorm16 at high/max.
- **Presets** (`--device <name>` or `preset:<name>`, files in `tools/bake/presets/`): `desktop-1080p`
  (BC only, 1920x1080@1, 8 GB), `phone` (ASTC+ETC2, 390x844@3, 4 GB), `phone-etc2` (ETC2 only,
  360x780@2). These are **hand-written estimates of typical devices, not measurements**; their
  `probe.name` says so. A real probe of the target device is always better.
- Any explicit knob (`--max-texture-size`, `--lods`, `--texture-format`, `--vertex-precision`, …) overrides the derived value. The
  baker prints each decision and which flags overrode it.
- Exit codes: 0 ok, 1 internal, 2 usage, 3 input, 4 device profile, 5 bake.

### Orchestrator (`npm run local`)

```bash
npm run build                                   # the orchestrator serves dist/ (probe + viewer)
npm run local -- model.glb -o out/ --detail high --open
npm run local -- model.glb --allow-cached       # if probing fails, use this machine's last profile
npm run local -- model.glb --fallback-headless  # if probing fails, use the headless (software) probe
npm run local -- model.glb --use-cached         # skip probing
```

Strictly sequential: `idle → probing → profile-received → baking → done | error`. The baker is
never started before a complete, schema-valid profile with the right one-time token has arrived.
Malformed or wrong-token reports are rejected (400/403/409) and ignored. On timeout
(`--probe-timeout`, default 120 s), a probe error, the probe tab being closed, or a browser that
cannot be launched, it **does not bake**. It stops with a clear message and a non-zero exit code, unless
`--allow-cached` or `--fallback-headless` was given. It always prints `PROFILE SOURCE: BROWSER | CACHE | HEADLESS`.
Profiles from a real browser are cached per machine (`~/.config/webgpu-engine/device-profile.json`;
`--no-cache`, `--cache-dir`). Unknown flags are passed to the baker. `--browser-cmd "<cmd> {url}"`
(or `WGM_BROWSER`) replaces the default opener (`open` / `start` / `xdg-open`), and `--baker-cmd`
(`WGM_BAKER`) swaps the baker. `--json` gives NDJSON events. Exit codes: 0 ok, 2 usage, 10 probe timeout,
11 probe failed/closed, 12 no browser, 13 fallback unavailable, 20 baker failed.

**Tested on this headless CI-like box:** everything except a real headful browser. The tests use
`scripts/headless-browser.mjs` as a `--browser-cmd` stand-in (headless Chrome + SwiftShader that loads the
URL the orchestrator gives it). **Not tested here:** launching the real default browser via
`xdg-open`/`open`/`start`, a hardware GPU adapter, real screen/DPR values, a real phone, and
the `pagehide` close beacon in an interactive browser. (SwiftShader does expose BC, ASTC and ETC2, so all
three native texture formats are rendered here; the phone/desktop presets are estimates.)

## Asset baking (`tools/bake`)

```bash
npm run bake -- <input.glb|.gltf> -o <outdir> [--target webgpu] [--lods N]
#   --texture-format auto|bc7|astc|etc2|rgba8|each|universal   --astc-block 4x4|5x5|6x6|8x8  --astc-quality fast|medium|thorough
#   --vertex-precision auto|full|low  --normal-encoding auto|oct  --pixel-error PX
#   --lod-ratio 0.5  --lod-max-error 0.05  --max-texture-size 4096  --uastc-level 2  --recompute-tangents  -q
#   --device <file|-|auto|desktop-1080p|phone|phone-etc2>  --detail low|medium|high|max  --max-triangles N  --max-drawn-triangles N  --json  --print-device
#   universal only: --etc1s-quality 192  --[no-]uastc-rdo  --zstd
```

Writes `<outdir>/<name>.wgm` and prints sizes, vertex/triangle counts, per-LOD triangles and timings.
Load it with `?model=/path/to/name.wgm`. Container spec: [FORMAT.md](FORMAT.md).

### Pipeline and target profiles

```
glTF --(@gltf-transform NodeIO)--> Document
     --prepare.ts (shared)-------> dequantize, dedup, weld, normals only if missing,
                                   MikkTSpace tangents where a normal map exists, prune
     --TargetProfile.bake()------> platform package (.wgm for webgpu)
```

A **target profile** (`tools/bake/targets/types.ts`) is `{ id, description, fileExtension,
textureFormats, defaults, bake(doc, ctx) }` registered in `targets/index.ts`. Shared work lives in
`prepare.ts`, `geometry.ts` (meshoptimizer) and `textures/`; a profile decides the vertex layout,
index width, texture codecs and container. Future engines (mobile native, desktop native) add a
profile, e.g. `targets/vulkan-mobile.ts` with quantized interleaved vertices and ASTC-only
textures, without touching the others. Only `webgpu` exists today.

### What the `webgpu` target does

- **Geometry:** weld/dedupe vertices, real MikkTSpace tangents (via `mikktspace`) only where a
  normal map exists, drop tangents/UVs that no material uses, meshoptimizer vertex-cache +
  vertex-fetch reorder, uint16 indices whenever `vertexCount <= 65536`.
- **LODs:** optional chain (`--lods`, default 4 incl. LOD0) from `simplifyWithAttributes`
  (normals + UVs weighted), each level ~`--lod-ratio` of the previous, stopping when
  simplification stalls or exceeds `--lod-max-error`; levels share LOD0's vertices and are
  cache-optimized themselves. Each level stores its error in mesh units.
- **Vertex quantization (`split-v2`, GPU-native, no decode at load):** per primitive the baker
  encodes each stream, decodes it exactly as the GPU's vertex fetch will, measures the worst
  error and keeps the smallest format under the tolerance (`--vertex-precision auto`, default):
  - positions `unorm16x4` on one grid per mesh (no cracks between its primitives), dequantized in
    the vertex shader from the per-draw uniform (`posScale`/`posOffset`); falls back to `float32x3`
    if the grid error would exceed the pixel tolerance (`--pixel-error` overrides it);
  - normals and tangents `snorm8x4` → `snorm16x4` → `float32`, or with `--normal-encoding oct`
    octahedral `snorm16x2` (decoded in the shader; tangent sign folded into y);
  - UVs `unorm16x2` when all lie in [0,1], else `float16x2` if within the UV-texel tolerance, else `float32x2`.
  `--vertex-precision full` keeps float32 everywhere; `low` takes the smallest formats regardless
  (warning when over tolerance). Measured on the Khronos samples: −50% vertex bytes
  (DamagedHelmet 48 → 24 B/vertex: its UVs span [0,2), where float16 would be off by 1 texel at
  2048², so UVs stay float32; BoxTextured 32 → 16; MetalRoughSpheres 24 → 12). Zero-length source
  normals/tangents (MikkTSpace emits them for collapsed UVs) are ignored by the error measure. Stats in the
  file and in the `result` event: `vertexBytesF32`, `vertexBytes`, `vertexFormats`,
  `maxPositionPixelError`, `maxNormalErrorDeg`, `maxUvErrorTexels`.
- **Dedup:** identical geometry (content hash) shared by several meshes is stored once;
  identical (image, usage) textures are encoded once.
- **Textures:** decoded (PNG/JPEG), resized so level 0 is a whole number of blocks (never above
  `--max-texture-size`), full mip chain computed offline (sRGB-correct for colour, renormalized
  for normal maps), then stored **in the GPU's native block format** (`--texture-format`):
  - `auto` (default): from `--device` (see above); **without a profile: BC7** (with a warning);
  - `bc7`: Basis UASTC encode (no RDO, no Zstd) → BC7 transcode **in the baker** (UASTC→BC7 is
    near-lossless); `etc2`: the same intermediate → ETC2 RGB8 (opaque) / ETC2 RGBA8 (alpha);
  - `astc`: ARM astcenc (wasm) per mip level, `--astc-block 4x4|5x5|6x6|8x8` (8 / 5.12 / 3.56 / 2 bits per texel);
  - `rgba8`: raw RGBA8 mip chain (largest, works everywhere);
  - `each`: one file per native format (`name.bc7.wgm`, `name.astc.wgm`, `name.etc2.wgm`,
    `name.rgba8.wgm`) when the target's formats are unknown; load `?model=…/name.{tex}.wgm`;
  - `universal` (opt-in, **the only mode that transcodes at load**): KTX2/Basis, ETC1S colour +
    UASTC data (`uastc` / `etc1s` force one codec); Zstd supercompression only with `--zstd`.

### Textures at runtime

Native files: the loader first checks that the device has the feature for every texture format in
the file (`texture-compression-bc` / `-astc` / `-etc2`). If one is missing it throws before uploading
anything, naming the missing feature and the re-bake (`--device <profile>` / `--texture-format …` /
`each`). Otherwise each mip level goes to `writeTexture` as stored; there is no CPU decode. The load
stats (`window.__engine.loadStats`) break this down: `parseMs`, `geometryUploadMs`,
`textureUploadMs`, `transcoderLoadMs`, `transcodeMs` and `vertexDecodeMs` (the last three are 0 for native files).

Universal (KTX2) files: the transcoder module is a separate chunk that is only imported when such a
file is loaded. It fetches the Basis wasm (~1 MB) from `public/basis/` and transcodes on the main thread
to BC7 → ASTC 4x4 → ETC2 → RGBA8, whichever the device has (override with `?tex=`).

### LOD API

`renderer.lod = { pixelError: 1, force: null }` (also via `RendererConfig.lod`). Each frame, the
renderer projects each primitive's per-level error to pixels using the distance to its world
bounding sphere and picks the coarsest level under `pixelError`. Replace the policy with
`renderer.lodSelector = (prim, node, camera, viewportHeight, settings) => levelIndex`.
glTF-loaded meshes have a single level. The HUD shows how many draws used a reduced level.

### Testing the baker

`npm test` runs `tools/bake/test/*.test.ts`: `budget.test.ts` bakes one mesh referenced by 1 and by 30 nodes and checks the LOD0 is identical (only the drawn estimate deepens the LOD chain) and that a tight pixel tolerance stops the LOD0 budget reduction; `.wgm` write/read round trip, v1-file readability,
quantized-stream validation, rejection of corrupt files (magic, truncation, version, LOD and stream
ranges), LOD invariants, and a full bake of a generated glTF in `rgba8`/full-precision, `bc7`, `astc`,
`etc2`/low-precision and `universal` modes (uint16 indices, positions decoded from unorm16 land on the
source grid, unit tangents with w = ±1, no tangents without a normal map, exact block sizes per mip,
no KTX2 bytes in native files, colour spaces). `quantize.test.ts` covers half floats, position grid
error bounds, snorm8/16 and octahedral normal/tangent error bounds incl. the tangent sign, precision
selection vs tolerance and `--vertex-precision`, the native encoders (BC7, ASTC 4x4 and 6x6, ETC2
RGB/RGBA, RGBA8) and `--texture-format each` / presets through the CLI. `device.test.ts` covers profile
validation, profile → options (texture format per device, ASTC block, tolerances) for desktop/phone/
limited GPUs, the presets, the triangle budgets, and the CLI's `--json` events, `--device -`, flag
overrides and exit codes. `npm run check:shaders` compiles and builds every shader feature × vertex
layout variant (float32, quantized snorm8/16, octahedral, absent streams) on SwiftShader.

`tools/local/test/local.test.ts` runs the real orchestrator CLI against the real baker CLI and the
built probe page (headless stand-in browser). It checks: the import graph (only `node:*` and siblings);
server token, one-time use, and rejection of malformed reports; the happy path in order (report, then
baker spawn, then result, then viewer frames); timeout, then exit 10 with a spy baker never executed;
bad or wrong-token reports rejected, then still no bake; page closed, then exit 11; no display, then exit 12;
`--allow-cached`, then source cache; `--fallback-headless`, then a separate `--print-device` probe before the bake.

Visual check against the glTF path (sample models are git-ignored, never committed):

```bash
mkdir -p test-assets && cd test-assets   # e.g. Khronos glTF-Sample-Assets BoxTextured, DamagedHelmet,
cd ..                                    #      MetalRoughSpheresNoTextures (.glb)
npm run bake -- test-assets/DamagedHelmet.glb -o test-assets/baked --device desktop-1080p
npm run build
ASSETS_DIR=test-assets HIDE_HUD=1 OUT=/tmp/a.png URL_QUERY="?model=/local/DamagedHelmet.glb" node scripts/screenshot.mjs
ASSETS_DIR=test-assets HIDE_HUD=1 OUT=/tmp/b.png URL_QUERY="?model=/local/baked/DamagedHelmet.wgm&lod=0" node scripts/screenshot.mjs
node scripts/compare-images.mjs /tmp/a.png /tmp/b.png /tmp/diff.png   # PSNR etc. + amplified diff
```

`ASSETS_DIR` is served at `/local/` by the preview server; `test-assets/`, `screenshots/`
and `*.wgm` are in `.gitignore`.

## Known gaps (deliberate for a skeleton)

- One sampler per material (taken from its first texture); TEXCOORD_1 and `KHR_texture_transform` ignored.
- No animation, skinning, morph targets, cameras or lights from glTF; no Draco/meshopt
  decoding in the glTF path. The baker warns about and drops animation/skins, TEXCOORD_1 and
  vertex colours; KTX2 is supported only through baked `.wgm` files (not `KHR_texture_basisu` in glTF).
- BLEND materials are drawn after opaques but not sorted back-to-front.
- No frustum culling or instancing yet; draw list is rebuilt every frame.
- Ambient is a hemisphere term + analytic env-BRDF, not image-based lighting; no shadows yet (architecture ready, see above).
- glTF-path tangent generation is Lengyel-style; use baked files for exact MikkTSpace tangents.
- Native textures are not supercompressed, so files are larger on disk than KTX2+Zstd would be
  (that is the price of zero work at load; HTTP `Content-Encoding` can still compress the transfer).
  BC7/ETC2 encoding in the baker (via UASTC) takes seconds per 2K texture.
- One texture format per file: a device without it needs another bake (`each` covers unknown targets).
- `universal` mode transcodes on the main thread.
- The orchestrator's headful path (real default browser, hardware GPU) is untested on the GPU-less build box;
  device classification is heuristic (no GPU tiering by benchmark yet).
- LOD selection has no hysteresis; LODs simplify each primitive independently (no cross-mesh merging).

## Roadmap

Done: native BC7/ASTC/ETC2/RGBA8 textures with precomputed mips (no runtime transcoding;
KTX2 only as opt-in `universal`), GPU-native quantized vertex streams chosen against the device's
visible tolerance, meshopt LOD chains with screen-space selection, shared baking pipeline with
target profiles and device presets, `.wgm` v2 container (v1 still readable).

1. **Progressive textures:** stream low mips first (still native blocks, no transcoding).
2. **Per-texture format choice:** BC1 / ETC2 RGB for opaque colour on capable devices, BC5/EAC RG for
   normal maps (needs a two-channel normal path in the shader).
3. **Interleaved quantized vertices** where it helps fetch (e.g. 16-byte vertices on tilers).
4. **Frustum culling:** world AABB per node tested against camera planes; later a BVH and
   GPU-driven culling with indirect draws. LOD hysteresis and per-node LOD.
5. **Instancing:** batch identical (mesh, material) pairs (the baker already dedupes geometry)
   into one `drawIndexed(count, instances)` with per-instance transforms in a storage buffer.
6. **More bake targets** for the other engines (mobile/desktop native), plus their own probes speaking [PROTOCOL.md](PROTOCOL.md).
7. Then: opt-in shadow maps (`ShadowPass`), IBL (prefiltered env + BRDF LUT baked offline),
   render bundles for static geometry, timestamp-query profiling.

## Headless screenshot notes

`npm run screenshot` launches Chrome with a software SwiftShader Vulkan adapter:
`--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader --use-angle=swiftshader --use-webgpu-adapter=swiftshader`.
Without `--enable-features=Vulkan --use-vulkan=swiftshader` the swap-chain shared image cannot be
created in headless mode and the device is lost after a couple of frames. Override flags with
`CHROME_GPU_FLAGS=...` and the browser with `CHROME=/path/to/chrome`. Frame rates in this mode are
CPU-rendered and meaningless for performance.

## License

The engine source code is released under the [MIT License](LICENSE). The bundled Basis Universal
transcoder in `public/basis/` is Apache-2.0 (see `public/basis/LICENSE`).

## Testing credits

These sample models were used only to test the engine during development. They are **not included** in this repository, and the MIT license above does not apply to them.

- **DamagedHelmet**, from the [Khronos glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/DamagedHelmet) repository. © 2018 ctxwing (rebuild and conversion to glTF), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode); based on an earlier model © 2016 theblueturtle_, licensed [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/legalcode).
- **MetalRoughSpheresNoTextures**, from the [Khronos glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/MetalRoughSpheresNoTextures) repository. © 2019 Kirill Gavrilov, released into the public domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/legalcode).
- **BoxTextured**, from the [Khronos glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/BoxTextured) repository. © 2017 Cesium, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode).
