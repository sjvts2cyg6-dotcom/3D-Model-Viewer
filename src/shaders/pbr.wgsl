// Metallic-roughness PBR (glTF 2.0 core material model).
// One directional light (Cook-Torrance: GGX NDF, height-correlated Smith-GGX
// visibility, Schlick Fresnel) + hemisphere ambient with an analytic
// split-sum approximation for the specular ambient term.
//
// Output is linear HDR -> ACES-fit tonemap; the render target is an *-srgb
// format so the hardware performs the sRGB encode.
//
// Compile-time features (see renderer/features.ts, renderer/shaderPreprocessor.ts):
//   SHADOWS – directional shadow map in group 0 (reserved; no ShadowPass yet).
// Group 0 binding map (renderer/pipelines.ts FRAME_BINDING):
//   0 = Frame uniforms, 1 = shadow map (depth), 2 = shadow comparison sampler.
// Materials (group 1) and per-draw data (group 2) never depend on features.

struct Frame {
  viewProj  : mat4x4f,
  cameraPos : vec4f,   // xyz
  lightDir  : vec4f,   // xyz: direction light travels (normalised)
  lightColor: vec4f,   // rgb * intensity
  skyColor  : vec4f,   // rgb * intensity
  groundColor: vec4f,  // rgb * intensity
  params    : vec4f,   // x: exposure
#if SHADOWS
  lightViewProj: mat4x4f, // world -> light clip space (see scene/lighting.ts)
  shadowParams : vec4f,   // x: depth bias, y: normal offset (world units), zw: reserved
#endif
};

struct Material {
  baseColor: vec4f,
  emissive : vec4f,    // rgb (already * emissive_strength)
  params   : vec4f,    // metallic, roughness, normalScale, occlusionStrength
  alpha    : vec4f,    // x: cutoff, y: 1 if MASK
};

struct Draw {
  model    : mat4x4f,
  normalMat: mat4x4f,
};

@group(0) @binding(0) var<uniform> frame: Frame;
#if SHADOWS
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSampler: sampler_comparison;
#endif

@group(1) @binding(0) var<uniform> material: Material;
@group(1) @binding(1) var matSampler: sampler;
@group(1) @binding(2) var baseColorTex: texture_2d<f32>;
@group(1) @binding(3) var metalRoughTex: texture_2d<f32>;
@group(1) @binding(4) var normalTex: texture_2d<f32>;
@group(1) @binding(5) var occlusionTex: texture_2d<f32>;
@group(1) @binding(6) var emissiveTex: texture_2d<f32>;

@group(2) @binding(0) var<uniform> draw: Draw;

struct VSIn {
  @location(0) position: vec3f,
  @location(1) normal  : vec3f,
  @location(2) uv      : vec2f,
  @location(3) tangent : vec4f,
};

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) normal  : vec3f,
  @location(2) uv      : vec2f,
  @location(3) tangent : vec4f,
};

@vertex
fn vs_main(in: VSIn) -> VSOut {
  var out: VSOut;
  let world = draw.model * vec4f(in.position, 1.0);
  out.clip = frame.viewProj * world;
  out.worldPos = world.xyz;
  out.normal = (draw.normalMat * vec4f(in.normal, 0.0)).xyz;
  out.tangent = vec4f((draw.model * vec4f(in.tangent.xyz, 0.0)).xyz, in.tangent.w);
  out.uv = in.uv;
  return out;
}

const PI = 3.14159265359;

fn D_GGX(NdotH: f32, a: f32) -> f32 {
  let a2 = a * a;
  let d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

fn V_SmithGGXCorrelated(NdotV: f32, NdotL: f32, a: f32) -> f32 {
  let a2 = a * a;
  let gv = NdotL * sqrt(NdotV * NdotV * (1.0 - a2) + a2);
  let gl = NdotV * sqrt(NdotL * NdotL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}

fn F_Schlick(f0: vec3f, VdotH: f32) -> vec3f {
  let f = pow(1.0 - VdotH, 5.0);
  return f0 + (vec3f(1.0) - f0) * f;
}

// Karis' mobile analytic approximation of the pre-integrated env BRDF.
fn envBRDFApprox(f0: vec3f, roughness: f32, NdotV: f32) -> vec3f {
  let c0 = vec4f(-1.0, -0.0275, -0.572, 0.022);
  let c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
  let r = roughness * c0 + c1;
  let a004 = min(r.x * r.x, exp2(-9.28 * NdotV)) * r.x + r.y;
  let ab = vec2f(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + ab.y;
}

// Visibility of the directional light at a surface point: 1 = fully lit.
// Without SHADOWS this is a constant and compiles away entirely.
fn directionalLightVisibility(worldPos: vec3f, N: vec3f) -> f32 {
#if SHADOWS
  // Placeholder contract for a future ShadowPass: single hardware-PCF tap.
  // (Filtering kernel, cascades, etc. belong to the real implementation.)
  let biased = worldPos + N * frame.shadowParams.y;
  let lp = frame.lightViewProj * vec4f(biased, 1.0);
  let ndc = lp.xyz / lp.w;
  let uv = ndc.xy * vec2f(0.5, -0.5) + vec2f(0.5);
  let inside = all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)) && ndc.z <= 1.0;
  let lit = textureSampleCompareLevel(shadowMap, shadowSampler, uv, ndc.z - frame.shadowParams.x);
  return select(1.0, lit, inside);
#else
  return 1.0;
#endif
}

// Narkowicz ACES filmic fit.
fn tonemapACES(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs_main(in: VSOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
  // Sample everything up-front so all textureSample calls are in uniform control flow.
  let baseSample = textureSample(baseColorTex, matSampler, in.uv);
  let mrSample   = textureSample(metalRoughTex, matSampler, in.uv);
  let nSample    = textureSample(normalTex, matSampler, in.uv).xyz;
  let aoSample   = textureSample(occlusionTex, matSampler, in.uv).r;
  let emSample   = textureSample(emissiveTex, matSampler, in.uv).rgb;

  let base = baseSample * material.baseColor;
  if (material.alpha.y > 0.5 && base.a < material.alpha.x) {
    discard;
  }

  let metallic  = clamp(material.params.x * mrSample.b, 0.0, 1.0);
  let roughness = clamp(material.params.y * mrSample.g, 0.045, 1.0);
  let a = roughness * roughness;

  // Tangent-space normal mapping (MikkTSpace-style TBN from vertex tangents).
  var N = normalize(in.normal);
  let faceSign = select(-1.0, 1.0, frontFacing);
  N = N * faceSign;
  let tRaw = in.tangent.xyz - N * dot(N, in.tangent.xyz);
  let tLen = length(tRaw);
  if (tLen > 1e-5) {
    let T = tRaw / tLen;
    let B = cross(N, T) * in.tangent.w;
    var tn = nSample * 2.0 - 1.0;
    tn = vec3f(tn.xy * material.params.z, tn.z);
    N = normalize(T * tn.x + B * tn.y + N * tn.z);
  }

  let V = normalize(frame.cameraPos.xyz - in.worldPos);
  let L = -frame.lightDir.xyz;
  let H = normalize(V + L);
  let NdotV = max(dot(N, V), 1e-4);
  let NdotL = clamp(dot(N, L), 0.0, 1.0);
  let NdotH = clamp(dot(N, H), 0.0, 1.0);
  let VdotH = clamp(dot(V, H), 0.0, 1.0);

  let albedo = base.rgb;
  let f0 = mix(vec3f(0.04), albedo, metallic);
  let diffuseColor = albedo * (1.0 - metallic);

  // Direct light.
  let F = F_Schlick(f0, VdotH);
  let spec = F * (D_GGX(NdotH, a) * V_SmithGGXCorrelated(NdotV, NdotL, a));
  let diff = (vec3f(1.0) - F) * diffuseColor / PI;
  let shadow = directionalLightVisibility(in.worldPos, N);
  var color = (diff + spec) * frame.lightColor.rgb * (NdotL * shadow);

  // Hemisphere ambient (diffuse + approximate specular), modulated by AO.
  let hemi = mix(frame.groundColor.rgb, frame.skyColor.rgb, N.y * 0.5 + 0.5);
  let ao = 1.0 + material.params.w * (aoSample - 1.0);
  color += (diffuseColor * hemi + envBRDFApprox(f0, roughness, NdotV) * hemi) * ao;

  color += emSample * material.emissive.rgb;

  color = tonemapACES(color * frame.params.x);
  return vec4f(color, base.a);
}
