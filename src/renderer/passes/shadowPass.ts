/**
 * ShadowPass — NOT IMPLEMENTED (design stub only; nothing here is compiled
 * into the bundle and nothing references it).
 *
 * Shadows are an opt-in feature. When disabled (the default) there is no
 * pass, no shadow-map texture, no extra bindings, no extra uniforms and no
 * shader code (`#if SHADOWS` is compiled out). Adding them is meant to be a
 * drop-in change touching only these places:
 *
 * 1. Implement `ShadowPass implements RenderPass` in this file:
 *    - setup(ctx): create a `depth32float` texture of `ctx.config.shadows.mapSize`
 *      (usage RENDER_ATTACHMENT | TEXTURE_BINDING), a comparison sampler
 *      ({ compare: 'less-equal', minFilter/magFilter: 'linear' }), a light
 *      uniform buffer, and a depth-only pipeline using
 *      `POSITION_ONLY_LAYOUT` + the shared `draw` bind group layout (group 2
 *      dynamic-offset matrices are reused as-is; materials are not needed
 *      except for alpha-MASK casters).
 *    - prepare(frame): pick the casting light (`scene.light.castShadows`),
 *      compute `computeDirectionalLightViewProj(light, computeWorldBounds(scene.root))`
 *      from scene/lighting.ts, write it into `frame.frameUniforms` at
 *      `FRAME_LAYOUT.lightViewProj` and the biases at `FRAME_LAYOUT.shadowParams`,
 *      and into its own light uniform buffer.
 *    - execute(encoder, frame): depth-only render pass into the shadow map over
 *      `frame.drawList` (skip BLEND items), binding only vertex slot 0.
 *    - resize(): no-op (shadow map size is independent of the canvas).
 *    - frameBindGroupEntries(): [
 *        { binding: FRAME_BINDING.shadowMap, resource: shadowMap.createView() },
 *        { binding: FRAME_BINDING.shadowSampler, resource: comparisonSampler },
 *      ]
 * 2. Register it before ForwardPass in `Renderer.createPasses()` when
 *    `config.shadows` is set.
 * 3. Set `SHADOW_PASS_IMPLEMENTED = true` in renderer/config.ts.
 *
 * The WGSL side (Frame.lightViewProj/shadowParams, group 0 bindings 1-2,
 * `directionalLightVisibility`) and the group-0 layout/uniform sizing in
 * pipelines.ts already switch on the SHADOWS feature; materials (group 1) and
 * per-draw data (group 2) are unaffected.
 */
export {};
