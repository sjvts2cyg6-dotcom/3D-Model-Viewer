# WGM container format (v1.0)

`.wgm` ("WebGPU model") is the baked, runtime-ready output of `tools/bake` for the `webgpu`
target. It is designed so the loader does almost no CPU work: one `JSON.parse` of a small
manifest, bounds checks, then sub-ranges of the file are handed straight to
`GPUQueue.writeBuffer` / `writeTexture` (or the KTX2 transcoder).

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
| 4 | u16 | versionMajor | `1`. Readers MUST reject other majors. |
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
  "version": [1, 0],
  "target": "webgpu",                 // target profile that produced the file
  "generator": "webgpu-engine bake 0.1",
  "vertexLayout": "f32-split-v1",     // see below; readers reject unknown layouts
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

### Vertex layout `f32-split-v1`

Non-interleaved streams, exactly what the engine pipelines bind (`renderer/pipelines.ts`):

| Location | Stream | Format | Stride | Required |
|---:|---|---|---:|---|
| 0 | position | float32x3 | 12 | yes |
| 1 | normal | float32x3 | 12 | yes |
| 2 | uv | float32x2 | 8 | only if the material samples any texture |
| 3 | tangent | float32x4 (w = bitangent sign, ±1) | 16 | only if the material has a normal map |

A missing optional stream means "the shader never meaningfully reads it"; the engine binds a
small shared zero buffer for it. Tangents are MikkTSpace (glTF convention).

### Primitive

```jsonc
{
  "material": 0,                  // or null -> engine default material
  "vertexCount": 14556,
  "streams": { "position": {"byteOffset": 0, "byteLength": 174672}, "normal": {...}, "uv": {...}, "tangent": {...} },
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
  "name": "", "encoding": "ktx2" | "rgba8", "codec": "etc1s" | "uastc",
  "colorSpace": "srgb" | "linear", "usage": "color" | "normal" | "data",
  "width": 2048, "height": 2048, "mipLevelCount": 12, "hasAlpha": false,
  "data": { "byteOffset": 0, "byteLength": 769000 },
  "levels": [ { "byteOffset": 0, "byteLength": 16777216, "width": 2048, "height": 2048 }, ... ] // rgba8 only
}
```

- **`ktx2`**: `data` is a complete KTX2 file containing a Basis Universal payload (ETC1S or
  UASTC + Zstd) with the full mip chain. The runtime transcodes it with the Basis transcoder
  to BC7, ASTC 4x4, ETC2 or uncompressed RGBA8, depending on device features. Level-0 sizes
  are multiples of 4 so every compressed level can be uploaded as whole blocks.
- **`rgba8`**: `data` holds the mip chain, level 0 first, tightly packed rows
  (`width * 4` bytes); `levels` gives each level's range relative to `data.byteOffset`.
- The same source image can appear twice when it is used with different `usage`/`colorSpace`
  (e.g. as both sRGB colour and linear data).

## Validation rules (enforced by `readWgm`)

magic, major version, `headerSize >= 32`, `fileByteLength` equals the real length, header
offsets consistent and 16-aligned, every section inside the blob and 16-aligned, every range
4-aligned and inside its section, streams at least `vertexCount * stride` bytes, index range at
least `count * indexSize` bytes, every LOD range inside the index range with a count divisible
by 3. Readers should ignore unknown manifest fields.
