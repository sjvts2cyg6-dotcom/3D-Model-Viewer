/** Geometry helpers for filling in attributes a source asset omitted. */

/** Area-weighted smooth vertex normals. */
export function computeNormals(positions: Float32Array, indices: ArrayLike<number>): Float32Array {
  const n = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) { n[v] += nx; n[v + 1] += ny; n[v + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

/**
 * Per-vertex tangents (xyz + handedness w) from UV derivatives (Lengyel).
 * Not full MikkTSpace; the offline baking pipeline should generate MikkTSpace
 * tangents so the runtime never has to.
 */
export function computeTangents(
  positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: ArrayLike<number>,
): Float32Array {
  const vcount = positions.length / 3;
  const tan = new Float32Array(vcount * 3);
  const bit = new Float32Array(vcount * 3);
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i], i1 = indices[i + 1], i2 = indices[i + 2];
    const p0 = i0 * 3, p1 = i1 * 3, p2 = i2 * 3;
    const u0 = i0 * 2, u1 = i1 * 2, u2 = i2 * 2;
    const e1x = positions[p1] - positions[p0], e1y = positions[p1 + 1] - positions[p0 + 1], e1z = positions[p1 + 2] - positions[p0 + 2];
    const e2x = positions[p2] - positions[p0], e2y = positions[p2 + 1] - positions[p0 + 1], e2z = positions[p2 + 2] - positions[p0 + 2];
    const du1 = uvs[u1] - uvs[u0], dv1 = uvs[u1 + 1] - uvs[u0 + 1];
    const du2 = uvs[u2] - uvs[u0], dv2 = uvs[u2 + 1] - uvs[u0 + 1];
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) continue;
    const r = 1 / det;
    const tx = (e1x * dv2 - e2x * dv1) * r, ty = (e1y * dv2 - e2y * dv1) * r, tz = (e1z * dv2 - e2z * dv1) * r;
    const bx = (e2x * du1 - e1x * du2) * r, by = (e2y * du1 - e1y * du2) * r, bz = (e2z * du1 - e1z * du2) * r;
    for (const p of [p0, p1, p2]) {
      tan[p] += tx; tan[p + 1] += ty; tan[p + 2] += tz;
      bit[p] += bx; bit[p + 1] += by; bit[p + 2] += bz;
    }
  }
  const out = new Float32Array(vcount * 4);
  for (let v = 0; v < vcount; v++) {
    const p = v * 3;
    const nx = normals[p], ny = normals[p + 1], nz = normals[p + 2];
    // Gram-Schmidt orthogonalise against the normal.
    const d = nx * tan[p] + ny * tan[p + 1] + nz * tan[p + 2];
    let tx = tan[p] - nx * d, ty = tan[p + 1] - ny * d, tz = tan[p + 2] - nz * d;
    const l = Math.hypot(tx, ty, tz);
    if (l < 1e-8) {
      // Degenerate UVs: any vector perpendicular to N.
      if (Math.abs(nx) < 0.9) { tx = 0; ty = -nz; tz = ny; } else { tx = nz; ty = 0; tz = -nx; }
      const l2 = Math.hypot(tx, ty, tz) || 1;
      tx /= l2; ty /= l2; tz /= l2;
    } else {
      tx /= l; ty /= l; tz /= l;
    }
    // Handedness: sign of dot(cross(N, T), B).
    const cx = ny * tz - nz * ty, cy = nz * tx - nx * tz, cz = nx * ty - ny * tx;
    const w = cx * bit[p] + cy * bit[p + 1] + cz * bit[p + 2] < 0 ? -1 : 1;
    out.set([tx, ty, tz, w], v * 4);
  }
  return out;
}

export function computeBounds(positions: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const v = positions[i + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  return { min, max };
}
