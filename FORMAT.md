# WGM container format (v2.0)

`.wgm` ("WebGPU model") is the baked, runtime-ready output of `tools/bake` for the `webgpu`
target. It is designed so the loader does almost no CPU work: one `JSON.parse` of a small
manifest, bounds checks, then sub-ranges of the file are handed straight to
`GPUQueue.writeBuffer` / `writeTexture`. Vertex data is stored in quantized **GPU-native
vertex formats** (the vertex fetch unit converts them; no CPU decode) and textures in
**GPU-native block formats** (BC7 / ASTC / ETC2) or raw RGBA8 with precomputed mips (no
transcoding). The only exception is the opt-in `universal` texture mode (KTX2/Basis, see
[Texture](#texture)), which the engine transcodes at load.

**Versions.** v2.0 (current) adds per-stream vertex formats, the `split-v2` vertex layout,
`positionTransform`, and native texture encodings `bc7` / `astc` / `etc2` with a `format`
field. **v1.0 files remain readable**: the reader accepts majors 1 and 2, and a v1 file is
simply a v2 file whose streams have no `format` (float32) and whose textures are `rgba8` or
`ktx2`.

Reference implementation: `src/assets/wgm/format.ts` (reader + writer, shared by engine and baker).

## File layout

```
offset 0                32                     binaryByteOffset (16-aligned)
| header (32 B) | manifest JSON (padded) | binary blob: [vertex][index][texture] |
```

All integers are **little-endian**.

### Header (32 bytes)

| Offset | Type | Field | Notes |
|---:|---|---|---|
| 0 | u32 | magic | `0x424D4757` = ASCII `"WGMB"` |
| 4 | u16 | versionMajor | `2` (v1 files: `1`). Readers MUST reject majors they don't know (this reader: 1, 2). |
| 6 | u16 | versionMinor | `0`. Minor bumps are backward compatible (new optional fields). |
| 8 | u32 | headerSize | `32`. Readers skip to `headerSize` so the header can grow. |
| 12 | u32 | flags | `0`; reserved. |
| 16 | u32 | manifestByteLength | UTF-8 JSON, padded with spaces (0x20) so the blob starts 16-aligned. |
| 20 | u32 | binaryByteOffset | multiple of 16. |
| 24 | u32 | binaryByteLength | multiple of 16. |
| 28 | u32 | fileByteLength | must equal the actual file size (detects truncation). |

### Binary blob

A sequence of **sections**, each starting at a multiple of 16 bytes relative to the blob,
always written in the order `vertex`, `index`, `texture` (empty sections are omitted). Every
range inside a section (vertex stream, index range, texture payload) starts at a multiple of 4,
which satisfies `writeBuffer` / `setVertexBuffer` / `setIndexBuffer` offset rules.

The loader creates **one** `VERTEX` buffer from the whole `vertex` section and **one** `INDEX`
buffer from the whole `index` section; primitives bind them with offsets.

## Manifest

```jsonc
{
  "format": "wgm",
  "version": [2, 0],
  "target": "webgpu",                 // target profile that produced the file
  "generator": "webgpu-engine bake 0.2",
  "vertexLayout": "split-v2",         // v1: "f32-split-v1"; readers reject unknown layouts
  "sections": [{ "name": "vertex", "byteOffset": 0, "byteLength": 1234 }, ...],
  "nodes":   [{ "name": "", "translation": [..], "rotation": [..], "scale": [..], "mesh": 0, "children": [1] }],
  "roots":   [0],                     // root node indices of the default scene
  "meshes":  [{ "name": "", "primitives": [Primitive, ...] }],
  "materials": [Material, ...],
  "textures":  [Texture, ...],
  "samplers":  [{ "magFilter": "linear", "minFilter": "linear", "mipmapFilter": "linear",
                  "addressModeU": "repeat", "addressModeV": "repeat" }],
  "bounds": { "min": [x,y,z], "max": [x,y,z] },   // whole scene, world space, rest pose
  "stats": { ... }                    // informational only
}
```

Sampler values are WebGPU enum strings, so they pass straight to `createSampler`.

### Vertex layout `split-v2`

Four non-interleaved streams. Each stream has a `format` (a WebGPU `GPUVertexFormat`); the
engine builds the matching `GPUVertexBufferLayout` per primitive (`renderer/vertexLayout.ts`)
and caches one pipeline per (shader features, vertex layout, alpha mode, culling).

| Location | Stream | Allowed formats (stride) | Required |
|---:|---|---|---|
| 0 | position | `unorm16x4` (8) + `positionTransform`; `snorm16x4` (8) + `positionTransform`; `float32x3` (12) | yes |
| 1 | normal | `snorm8x4` (4); `snorm16x4` (8); `snorm16x2` (4, `"encoding": "oct"`); `float32x3` (12) | yes |
| 2 | uv | `unorm16x2` (4, only if all UVs lie in [0,1]); `float16x2` (4); `float32x2` (8) | only if the material samples any texture |
| 3 | tangent | `snorm8x4` (4); `snorm16x4` (8); `snorm16x2` (4, `"encoding": "oct"`); `float32x4` (16) | only if the material has a normal map |

- **Positions** (quantized): `q` = the stream's xyz in [0,1] (unorm) or [-1,1] (snorm) as
  converted by the GPU; mesh-local position = `q * positionTransform.scale + positionTransform.offset`.
  The baker uses one grid per **mesh** (all its primitives), so primitives of a mesh never crack
  apart. The 4th component is padding (stride must be a multiple of 4) and is ignored. The
  engine applies the transform in the vertex shader from the per-draw uniform; float32
  positions have no `positionTransform` (scale 1, offset 0).
- **Normals / tangents, xyz form**: unit vector in xyz, `w` = 0 for normals; for tangents `w` =
  bitangent sign (±127 / ±32767 → ±1). Not renormalised in the file; the shader normalises.
- **Octahedral form** (`snorm16x2`, `"encoding": "oct"`, baker flag `--normal-encoding oct`):
  standard octahedral mapping of the unit vector to [-1,1]². For tangents the bitangent sign is
  folded into y: stored `y' = s * (ε + (y*0.5+0.5)(1-ε))` with ε = 1/32767, so
  `s = sign(y')`, `y = (|y'|-ε)/(1-ε)*2-1`. Decoded in the vertex shader (`OCT_NORMAL` /
  `OCT_TANGENT` shader variants).
- **UVs**: `unorm16x2` is exact to 1/65535; `float16x2` is used when UVs leave [0,1] (tiling).
- A missing optional stream means "the shader never meaningfully reads it"; the engine binds a
  small shared zero buffer with `arrayStride` 0. Tangents are MikkTSpace (glTF convention).
- `snorm16x2` without `"encoding": "oct"` is invalid.

The baker picks, per primitive, the smallest format whose **measured** error (it encodes,
decodes as the GPU does and compares) is below the device profile's tolerance; see the
README (`--vertex-precision`, `--detail`). `stats.vertexFormats` / `stats.vertexBytesF32` /
`stats.vertexBytes` record the result.

### Vertex layout `f32-split-v1` (v1 files)

All streams float32: position `float32x3`, normal `float32x3`, uv `float32x2`,
tangent `float32x4`. Streams carry no `format` field. Still loaded by the engine.

### Primitive

```jsonc
{
  "material": 0,                  // or null -> engine default material
  "vertexCount": 14556,
  "streams": {
    "position": { "byteOffset": 0, "byteLength": 116448, "format": "unorm16x4" },
    "normal":   { "byteOffset": 116448, "byteLength": 58224, "format": "snorm8x4" },
    "uv":       { "byteOffset": 174672, "byteLength": 58224, "format": "unorm16x2" },
    "tangent":  { "byteOffset": 232896, "byteLength": 58224, "format": "snorm8x4" }   // or "format": "snorm16x2", "encoding": "oct"
  },
  "positionTransform": { "scale": [1.88, 1.9, 1.84], "offset": [-0.94, -0.9, -0.92] },  // required for unorm16/snorm16 positions
  "indices": { "byteOffset": 0, "byteLength": 162228, "format": "uint16", "count": 81114 },
  "lods": [ { "firstIndex": 0,     "indexCount": 46356, "error": 0 },
            { "firstIndex": 46356, "indexCount": 23178, "error": 0.0042 }, ... ],
  "bounds": { "min": [..], "max": [..] }   // mesh-local AABB
}
```

- `indices.format` is `uint16` whenever `vertexCount <= 65536`, else `uint32`.
- All LOD levels share the primitive's vertex streams; their index lists are stored back to back
  in one range. `lods[0]` is full detail; each later level is coarser.
- `error` is the simplification error in **mesh-local units**. The runtime projects it to
  pixels (`error * worldScale * viewportHeight / (2 tan(fovY/2) * distance)`) and picks the
  coarsest level under a pixel threshold.
- Index order is vertex-cache optimized; vertex order is vertex-fetch optimized for LOD0.

### Material

glTF metallic-roughness semantics: `baseColorFactor`, `metallicFactor`, `roughnessFactor`,
`emissiveFactor` (already multiplied by `KHR_materials_emissive_strength`), `normalScale`,
`occlusionStrength`, `alphaMode` (`OPAQUE|MASK|BLEND`), `alphaCutoff`, `doubleSided`, and optional
`baseColorTexture`, `metallicRoughnessTexture`, `normalTexture`, `occlusionTexture`,
`emissiveTexture`, each `{ "texture": i, "sampler": j }`.

### Texture

```jsonc
{
  "name": "", "encoding": "bc7" | "astc" | "etc2" | "rgba8" | "ktx2",
  "format": "bc7-rgba-unorm-srgb",   // native encodings: the exact GPUTextureFormat
  "codec": "etc1s" | "uastc",        // ktx2 only
  "colorSpace": "srgb" | "linear", "usage": "color" | "normal" | "data",
  "width": 2048, "height": 2048, "mipLevelCount": 12, "hasAlpha": false,
  "data": { "byteOffset": 0, "byteLength": 5592432 },
  "levels": [ { "byteOffset": 0, "byteLength": 4194304, "width": 2048, "height": 2048 }, ... ] // native encodings
}
```

**Native encodings** (default; uploaded with one `writeTexture` per level, no CPU work):

| encoding | `format` values | bytes / 4x4 texels | device feature |
|---|---|---:|---|
| `bc7` | `bc7-rgba-unorm[-srgb]` | 16 | `texture-compression-bc` |
| `astc` | `astc-{4x4,5x5,6x6,8x8}-unorm[-srgb]` (block = WxH texels, 16 B per block) | 16 (4x4) … 4 (8x8) | `texture-compression-astc` |
| `etc2` | `etc2-rgb8unorm[-srgb]` (opaque, 8 B/block), `etc2-rgba8unorm[-srgb]` (alpha, 16 B/block) | 8 / 16 | `texture-compression-etc2` |
| `rgba8` | `rgba8unorm[-srgb]` (v1 files: no `format`, implied by `colorSpace`) | 64 | none |

- `levels` lists every mip level, level 0 first, ranges relative to `data.byteOffset`. Each
  level is tightly packed rows of blocks: `ceil(w/bw) * ceil(h/bh) * bytesPerBlock` bytes
  (rows of texels for rgba8). Level 0 is a whole number of blocks (the baker resizes to a
  multiple of the block size, never above the size cap).
- The file stores exactly one format per texture. A device without the required feature
  cannot use the file: the engine checks **before uploading anything** and fails with an error
  that names the missing feature and the re-bake command. `--texture-format each` writes one
  file per native format (`name.bc7.wgm`, `name.astc.wgm`, `name.etc2.wgm`, `name.rgba8.wgm`);
  the viewer resolves `?model=name.{tex}.wgm` to the best format the device supports.

**`ktx2` (opt-in `universal` mode only)**: `data` is a complete KTX2 file containing a Basis
Universal payload (ETC1S, or UASTC; Zstd supercompression only if baked with `--zstd`) with
the full mip chain. This is the **only** encoding the engine transcodes at load (Basis
transcoder, fetched lazily only for such files) to BC7, ASTC 4x4, ETC2 or RGBA8. Level-0 sizes
are multiples of 4.

The same source image can appear twice when it is used with different `usage`/`colorSpace`
(e.g. as both sRGB colour and linear data).

## Validation rules (enforced by `readWgm`)

magic, major version, `headerSize >= 32`, `fileByteLength` equals the real length, header
offsets consistent and 16-aligned, every section inside the blob and 16-aligned, every range
4-aligned and inside its section, streams at least `vertexCount * stride(format)` bytes with a
format allowed for that stream (oct encoding only with `snorm16x2`), quantized positions have a
`positionTransform`, index range at least `count * indexSize` bytes, every LOD range inside the
index range with a count divisible by 3, every native texture has `levels`, each inside `data`
and at least the exact block size of its level. Readers should ignore unknown manifest fields.
