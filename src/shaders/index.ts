// WGSL sources are imported as strings by Vite (`?raw`), so they stay as real
// .wgsl files (editor highlighting, easy to hand to a WGSL linter/minifier).
export { default as pbrWgsl } from './pbr.wgsl?raw';
export { default as mipmapWgsl } from './mipmap.wgsl?raw';
