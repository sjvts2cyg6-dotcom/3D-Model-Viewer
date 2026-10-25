/**
 * WGM ("WebGPU model") container: types, constants, reader and writer.
 *
 * Shared by the engine (reader) and the offline baker in tools/bake (writer).
 * This file must stay free of DOM / WebGPU / Node APIs so both sides can use it.
 * The normative spec lives in FORMAT.md at the repo root.
 *
 *   [ header 32 B ][ manifest JSON, space-padded to 16 B ][ binary blob ]
 *
 * The binary blob is a sequence of 16-byte-aligned sections (vertex, index,
 * texture). The manifest addresses everything as (section, byteOffset,
 * byteLength) so the loader can hand sub-ranges straight to the GPU.
 */

/** "WGMB" read as a little-endian u32. */
export const WGM_MAGIC = 0x424d4757;
export const WGM_VERSION_MAJOR = 1;
export const WGM_VERSION_MINOR = 0;
export const WGM_HEADER_SIZE = 32;
/** Alignment of the manifest end, the binary blob, and every section. */
export const WGM_SECTION_ALIGN = 16;
/** Alignment of every stream / index range inside a section. */
export const WGM_STREAM_ALIGN = 4;

/**
 * Vertex layout ids. A baked file names the layout it was written for and the
 * loader refuses layouts it cannot bind. `f32-split-v1` is the engine's
 * canonical layout: four non-interleaved streams
 *   loc0 position f32x3 (12 B), loc1 normal f32x3 (12 B),
 *   loc2 uv f32x2 (8 B),        loc3 tangent f32x4 (16 B, w = bitangent sign).
 */
export type WgmVertexLayout = 'f32-split-v1';
export const WGM_VERTEX_LAYOUT: WgmVertexLayout = 'f32-split-v1';
export const WGM_STREAM_STRIDE = { position: 12, normal: 12, uv: 8, tangent: 16 } as const;
export type WgmStreamName = keyof typeof WGM_STREAM_STRIDE;

export type WgmSectionName = 'vertex' | 'index' | 'texture';

export interface WgmSection {
  name: WgmSectionName;
  /** Relative to the start of the binary blob; multiple of 16. */
  byteOffset: number;
  byteLength: number;
}

/** A byte range inside a named section. */
export interface WgmRange {
  byteOffset: number;
  byteLength: number;
}

export interface WgmLod {
  /** First index of this level, relative to the primitive's index range. */
  firstIndex: number;
  indexCount: number;
  /**
   * Simplification error in mesh-local units (0 for the full-detail level).
   * Runtime: projected pixel error = error * worldScale * pixelsPerUnitAtDistance.
   */
  error: number;
}

export interface WgmPrimitive {
  material: number | null;
  vertexCount: number;
  /** Streams in the 'vertex' section. Absent uv/tangent = shader reads zeros. */
  streams: { position: WgmRange; normal: WgmRange; uv?: WgmRange; tangent?: WgmRange };
  /** Range in the 'index' section holding all LOD levels back to back. */
  indices: WgmRange & { format: 'uint16' | 'uint32'; count: number };
  /** lods[0] is full detail; later entries are progressively coarser. */
  lods: WgmLod[];
  bounds: WgmBounds;
}

export interface WgmBounds { min: [number, number, number]; max: [number, number, number] }

export interface WgmMesh { name: string; primitives: WgmPrimitive[] }

export interface WgmSampler {
  magFilter: 'nearest' | 'linear';
  minFilter: 'nearest' | 'linear';
  mipmapFilter: 'nearest' | 'linear';
  addressModeU: 'repeat' | 'mirror-repeat' | 'clamp-to-edge';
  addressModeV: 'repeat' | 'mirror-repeat' | 'clamp-to-edge';
}

/** How a texture's bytes are encoded. */
export type WgmTextureEncoding =
  /** A complete KTX2 file (Basis ETC1S or UASTC, mips included); transcoded at load. */
  | 'ktx2'
  /** Raw RGBA8 mip chain, level 0 first, tightly packed rows (width*4 bytes). */
  | 'rgba8';

export interface WgmTexture {
  name: string;
  encoding: WgmTextureEncoding;
  /** Basis codec inside the KTX2 file (informational; the KTX2 header is authoritative). */
  codec?: 'etc1s' | 'uastc';
  /** 'srgb' for base colour / emissive, 'linear' for data (normal, ORM). */
  colorSpace: 'srgb' | 'linear';
  /** What the texture is used for; drives encoder settings. */
  usage: 'color' | 'normal' | 'data';
  width: number;
  height: number;
  mipLevelCount: number;
  hasAlpha: boolean;
  /** Range in the 'texture' section. */
  data: WgmRange;
  /** rgba8 only: per-level ranges relative to `data.byteOffset`. */
  levels?: (WgmRange & { width: number; height: number })[];
}

export interface WgmTextureRef { texture: number; sampler: number }

export interface WgmMaterial {
  name: string;
  baseColorFactor: [number, number, number, number];
  metallicFactor: number;
  roughnessFactor: number;
  emissiveFactor: [number, number, number];
  normalScale: number;
  occlusionStrength: number;
  alphaMode: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff: number;
  doubleSided: boolean;
  baseColorTexture?: WgmTextureRef;
  metallicRoughnessTexture?: WgmTextureRef;
  normalTexture?: WgmTextureRef;
  occlusionTexture?: WgmTextureRef;
  emissiveTexture?: WgmTextureRef;
}

export interface WgmNode {
  name: string;
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
  mesh?: number;
  children?: number[];
}

export interface WgmManifest {
  format: 'wgm';
  version: [number, number];
  target: string;
  generator: string;
  vertexLayout: WgmVertexLayout;
  sections: WgmSection[];
  nodes: WgmNode[];
  roots: number[];
  meshes: WgmMesh[];
  materials: WgmMaterial[];
  textures: WgmTexture[];
  samplers: WgmSampler[];
  /** Scene bounds at rest pose (world space of the baked scene). */
  bounds: WgmBounds;
  /** Free-form bake statistics (ignored by the loader). */
  stats?: Record<string, unknown>;
}

export interface WgmHeader {
  versionMajor: number;
  versionMinor: number;
  flags: number;
  manifestByteLength: number;
  binaryByteOffset: number;
  binaryByteLength: number;
  fileByteLength: number;
}

export class WgmFormatError extends Error {
  override name = 'WgmFormatError';
}

export function alignUp(n: number, a: number): number {
  return Math.ceil(n / a) * a;
}

/** True if the buffer starts with the WGM magic. */
export function isWgm(data: ArrayBuffer | ArrayBufferView): boolean {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return bytes.byteLength >= 4 && (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0 === WGM_MAGIC;
}

export interface WgmFile {
  header: WgmHeader;
  manifest: WgmManifest;
  /** Zero-copy view of the binary blob. */
  binary: Uint8Array;
  /** Zero-copy view of one section, or an empty array if absent. */
  section(name: WgmSectionName): Uint8Array;
}

/**
 * Parse a .wgm file. Work is O(manifest size): one JSON.parse plus bounds
 * checks; binary data is never copied.
 */
export function readWgm(data: ArrayBuffer | Uint8Array): WgmFile {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < WGM_HEADER_SIZE) throw new WgmFormatError('file too small for a WGM header');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== WGM_MAGIC) throw new WgmFormatError('bad magic (not a .wgm file)');
  const header: WgmHeader = {
    versionMajor: dv.getUint16(4, true),
    versionMinor: dv.getUint16(6, true),
    flags: dv.getUint32(12, true),
    manifestByteLength: dv.getUint32(16, true),
    binaryByteOffset: dv.getUint32(20, true),
    binaryByteLength: dv.getUint32(24, true),
    fileByteLength: dv.getUint32(28, true),
  };
  const headerSize = dv.getUint32(8, true);
  if (header.versionMajor !== WGM_VERSION_MAJOR) {
    throw new WgmFormatError(`unsupported WGM major version ${header.versionMajor} (reader supports ${WGM_VERSION_MAJOR})`);
  }
  if (headerSize < WGM_HEADER_SIZE) throw new WgmFormatError(`bad header size ${headerSize}`);
  if (header.fileByteLength !== bytes.byteLength) {
    throw new WgmFormatError(`length mismatch: header says ${header.fileByteLength} B, got ${bytes.byteLength} B (truncated?)`);
  }
  if (header.binaryByteOffset % WGM_SECTION_ALIGN !== 0 ||
      headerSize + header.manifestByteLength > header.binaryByteOffset ||
      header.binaryByteOffset + header.binaryByteLength > bytes.byteLength) {
    throw new WgmFormatError('inconsistent header offsets');
  }

  const manifestBytes = bytes.subarray(headerSize, headerSize + header.manifestByteLength);
  let manifest: WgmManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as WgmManifest;
  } catch (e) {
    throw new WgmFormatError(`manifest is not valid JSON: ${(e as Error).message}`);
  }
  if (manifest.format !== 'wgm') throw new WgmFormatError('manifest.format is not "wgm"');

  const binary = bytes.subarray(header.binaryByteOffset, header.binaryByteOffset + header.binaryByteLength);
  for (const s of manifest.sections) {
    if (s.byteOffset % WGM_SECTION_ALIGN !== 0 || s.byteOffset + s.byteLength > binary.byteLength) {
      throw new WgmFormatError(`section "${s.name}" out of bounds or misaligned`);
    }
  }
  validateRanges(manifest);

  return {
    header,
    manifest,
    binary,
    section(name) {
      const s = manifest.sections.find((x) => x.name === name);
      return s ? binary.subarray(s.byteOffset, s.byteOffset + s.byteLength) : new Uint8Array(0);
    },
  };
}

function validateRanges(m: WgmManifest): void {
  const len = (name: WgmSectionName) => m.sections.find((s) => s.name === name)?.byteLength ?? 0;
  const check = (r: WgmRange | undefined, section: WgmSectionName, what: string, minLen = 0) => {
    if (!r) return;
    if (r.byteOffset % WGM_STREAM_ALIGN !== 0) throw new WgmFormatError(`${what}: misaligned offset ${r.byteOffset}`);
    if (r.byteOffset + r.byteLength > len(section)) throw new WgmFormatError(`${what}: range exceeds "${section}" section`);
    if (r.byteLength < minLen) throw new WgmFormatError(`${what}: ${r.byteLength} B < expected ${minLen} B`);
  };
  m.meshes.forEach((mesh, mi) => mesh.primitives.forEach((p, pi) => {
    const tag = `mesh ${mi} prim ${pi}`;
    for (const k of Object.keys(WGM_STREAM_STRIDE) as WgmStreamName[]) {
      check(p.streams[k], 'vertex', `${tag} ${k}`, p.vertexCount * WGM_STREAM_STRIDE[k]);
    }
    const isize = p.indices.format === 'uint16' ? 2 : 4;
    check(p.indices, 'index', `${tag} indices`, p.indices.count * isize);
    for (const l of p.lods) {
      if (l.firstIndex + l.indexCount > p.indices.count || l.indexCount % 3 !== 0) {
        throw new WgmFormatError(`${tag}: LOD range out of bounds`);
      }
    }
  }));
  m.textures.forEach((t, i) => check(t.data, 'texture', `texture ${i}`));
}

// ------------------------------------------------------------------ writer

export interface WgmWriterInput {
  /** Manifest without `format`, `version` and `sections` (filled in here). */
  manifest: Omit<WgmManifest, 'format' | 'version' | 'sections'>;
  sections: Partial<Record<WgmSectionName, Uint8Array>>;
}

const SECTION_ORDER: WgmSectionName[] = ['vertex', 'index', 'texture'];

/** Serialise a WGM file. Sections are written in a fixed order, each 16-B aligned. */
export function writeWgm(input: WgmWriterInput): Uint8Array {
  const sections: WgmSection[] = [];
  let binLen = 0;
  for (const name of SECTION_ORDER) {
    const data = input.sections[name];
    if (!data || data.byteLength === 0) continue;
    binLen = alignUp(binLen, WGM_SECTION_ALIGN);
    sections.push({ name, byteOffset: binLen, byteLength: data.byteLength });
    binLen += data.byteLength;
  }
  binLen = alignUp(binLen, WGM_SECTION_ALIGN);

  const manifest: WgmManifest = {
    format: 'wgm',
    version: [WGM_VERSION_MAJOR, WGM_VERSION_MINOR],
    ...input.manifest,
    sections,
  };
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestPadded = alignUp(WGM_HEADER_SIZE + json.byteLength, WGM_SECTION_ALIGN) - WGM_HEADER_SIZE;
  const binaryOffset = WGM_HEADER_SIZE + manifestPadded;
  const total = binaryOffset + binLen;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, WGM_MAGIC, true);
  dv.setUint16(4, WGM_VERSION_MAJOR, true);
  dv.setUint16(6, WGM_VERSION_MINOR, true);
  dv.setUint32(8, WGM_HEADER_SIZE, true);
  dv.setUint32(12, 0, true); // flags
  dv.setUint32(16, manifestPadded, true);
  dv.setUint32(20, binaryOffset, true);
  dv.setUint32(24, binLen, true);
  dv.setUint32(28, total, true);
  out.set(json, WGM_HEADER_SIZE);
  out.fill(0x20, WGM_HEADER_SIZE + json.byteLength, binaryOffset); // JSON-safe padding
  for (const s of sections) out.set(input.sections[s.name]!, binaryOffset + s.byteOffset);
  return out;
}

/** Append-only byte builder that hands out aligned ranges. */
export class SectionBuilder {
  private chunks: Uint8Array[] = [];
  private length = 0;

  /** Append `data` at the next `align`-byte boundary and return its range. */
  push(data: ArrayBufferView, align = WGM_STREAM_ALIGN): WgmRange {
    const pad = alignUp(this.length, align) - this.length;
    if (pad) { this.chunks.push(new Uint8Array(pad)); this.length += pad; }
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.chunks.push(bytes);
    const range = { byteOffset: this.length, byteLength: bytes.byteLength };
    this.length += bytes.byteLength;
    return range;
  }

  get byteLength(): number { return this.length; }

  finish(): Uint8Array {
    const out = new Uint8Array(alignUp(this.length, WGM_STREAM_ALIGN));
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.byteLength; }
    return out;
  }
}
