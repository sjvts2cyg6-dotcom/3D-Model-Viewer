# webgpu-engine

A minimal, dependency-light **browser / WebGPU** rendering engine skeleton in TypeScript.
It is the first of a family of per-platform engines: each runtime is tailored to its
target, and a shared offline asset pipeline (later) bakes glTF into the format each
runtime wants.

Runtime dependency: [`wgpu-matrix`](https://github.com/greggman/wgpu-matrix) (math only).
Dev tooling: Vite, TypeScript, `@webgpu/types`, `puppeteer-core` (only for the headless screenshot check).


## Running

```bash
npm install
npm run dev        # http://localhost:5173  (WebGPU needs https or localhost)
npm run build      # type-check + production bundle in dist/
npm run preview    # serve dist/
npm run screenshot # headless Chrome + SwiftShader render -> screenshot.png (after build)
npm run check:shaders # compile + validate every shader feature variant (incl. disabled ones)
```

URL options: `?model=/path/to/file.glb` (or `.gltf`), `?msaa=1` (disable 4x MSAA),
`?dpr=1.5` (cap device pixel ratio, useful on phones to save fill-rate).

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
               mesh.ts       GPU buffers for primitives (non-interleaved streams)
               textures.ts   image upload, GPU mipmap generation, 1x1 defaults, sampler cache
  scene/       node.ts       scene graph: TRS -> local/world/normal matrices with dirty flags
               camera.ts     perspective camera (WebGPU 0..1 depth)
               scene.ts      scene root, one directional light, hemisphere ambient
               lighting.ts   light-space matrix from scene bounds (hook for shadows)
               bounds.ts     AABB helpers (framing; later culling)
  assets/      gltf.ts       glTF 2.0 / GLB parser -> engine-neutral CPU data (no GPU calls)
               geometry.ts   generate missing normals / tangents, bounds
               modelLoader.ts CPU data -> GPU resources + scene subtree
  shaders/     pbr.wgsl      metallic-roughness PBR (GGX, Smith-GGX correlated, Schlick), ACES tonemap
               mipmap.wgsl   downsample blit
  controls/    orbit.ts      orbit camera on Pointer Events (mouse + touch + pinch), damped
  main.ts      demo app: init, load model, frame it, run loop, HUD
```

### Key design choices

- **Data flows one way:** `assets` parses into plain typed arrays + descriptors, `modelLoader`
  is the only module that knows both glTF and the renderer. A future loader for the baked
  format will sit beside it and skip parsing entirely.
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
- **Mipmaps generated on the GPU** at load time (a baked pipeline will ship them precomputed).
- **Non-interleaved vertex streams** (position / normal / uv / tangent) keep the loader simple
  and allow a depth-only pass to bind positions alone later.
- **Tangents generated only when a normal map needs them**; missing normals are computed.

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

## Known gaps (deliberate for a skeleton)

- One sampler per material (taken from its first texture); TEXCOORD_1 and `KHR_texture_transform` ignored.
- No animation, skinning, morph targets, cameras or lights from glTF; no Draco/meshopt; KTX2 not yet.
- BLEND materials are drawn after opaques but not sorted back-to-front.
- No frustum culling or instancing yet; draw list is rebuilt every frame.
- Ambient is a hemisphere term + analytic env-BRDF, not image-based lighting; no shadows yet (architecture ready, see above).
- Tangent generation is Lengyel-style, not full MikkTSpace (the baker should emit MikkTSpace tangents).

## Roadmap

1. **KTX2 / Basis Universal textures:** transcode to ASTC (mobile), BC7 (desktop) or ETC2 at load
   time based on `adapter.features` (`texture-compression-astc` / `-bc` / `-etc2`); precomputed mips.
2. **LODs:** per-mesh LOD chains (meshoptimizer simplification in the baker), selected by projected
   screen-space size, with hysteresis.
3. **Frustum culling:** world AABB per node (already computed for framing) tested against camera planes;
   later a BVH and GPU-driven culling with indirect draws.
4. **Instancing:** batch identical (mesh, material) pairs into one `drawIndexed(count, instances)` with
   per-instance transforms in a storage buffer.
5. **Asset baking pipeline (shared across engines):** glTF in -> per-platform packages out: quantized
   and interleaved vertex layouts, meshopt-optimized index order, MikkTSpace tangents, LODs,
   GPU-compressed textures, a tiny binary header the runtime can map straight into GPU buffers.
6. Then: opt-in shadow maps (`ShadowPass`), IBL (prefiltered env + BRDF LUT baked offline),
   render bundles for static geometry, timestamp-query profiling.

## Headless screenshot notes

`npm run screenshot` launches Chrome with a software SwiftShader Vulkan adapter:
`--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader --use-angle=swiftshader --use-webgpu-adapter=swiftshader`.
Without `--enable-features=Vulkan --use-vulkan=swiftshader` the swap-chain shared image cannot be
created in headless mode and the device is lost after a couple of frames. Override flags with
`CHROME_GPU_FLAGS=...` and the browser with `CHROME=/path/to/chrome`. Frame rates in this mode are
CPU-rendered and meaningless for performance.

## License

The engine source code is released under the [MIT License](LICENSE).

## Testing credits

These sample models were used only to test the engine during development. They are **not included** in this repository, and the MIT license above does not apply to them.

- **DamagedHelmet**, from the [Khronos glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/DamagedHelmet) repository. © 2018 ctxwing (rebuild and conversion to glTF), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode); based on an earlier model © 2016 theblueturtle_, licensed [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/legalcode).
- **BoxTextured**, from the [Khronos glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/BoxTextured) repository. © 2017 Cesium, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode).
