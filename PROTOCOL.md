# Probe / baker / orchestrator protocol (v1)

Three independent programs cooperate only through the interfaces in this document, so each one
can be swapped for another engine's version (a native probe app, a mobile baker, ...):

| Program | Lives in | Role | Talks via |
|---|---|---|---|
| **Probe** | `probe.html`, `src/probe/` | Runs in the target browser, measures the device, produces a **DeviceProfile** | page UI / download, or HTTP `POST` to a loopback report URL |
| **Baker** | `tools/bake/` (`npm run bake`) | Bakes glTF into an engine format, optionally tailored to a DeviceProfile | CLI args, profile on stdin or a file, **NDJSON** events on stdout, **exit codes** |
| **Orchestrator** | `tools/local/` (`npm run local`) | On one machine: opens the probe in the real browser, waits for its report, then launches the baker | starts processes, opens URLs, receives HTTP reports and NDJSON |

The orchestrator imports none of the probe or baker code (it uses only `node:*` built-ins and its own
files; a test checks the import graph) and never calls into them in-process. It keeps its own copy of
the profile validation rules below (`tools/local/protocol.ts`).

## 1. DeviceProfile v1

JSON object. Required members and validation rules (a report that breaks any of them is rejected):

| Field | Type / rule |
|---|---|
| `schema` | `"wgm-device-profile"` |
| `version` | `1` |
| `probedAt` | ISO-8601 timestamp that parses as a date |
| `probe` | `{ name, version, headless: boolean }`: who measured it; `headless` is true under automation |
| `platform` | object: `{ userAgent, mobile, hardwareConcurrency, deviceMemoryGB: number\|null, maxTouchPoints }` |
| `display` | `{ screenWidth > 0, screenHeight > 0, devicePixelRatio > 0, viewportWidth, viewportHeight, colorGamut: "srgb"\|"p3"\|"rec2020", hdr }`: screen sizes in CSS px |
| `gpu.available` | boolean (false = no WebGPU) |
| `gpu.features` | string array (WebGPU feature names) |
| `gpu.limits` | object of WebGPU limits; must contain `maxTextureDimension2D` when `available` |
| `gpu.textureCompression` | `{ bc, astc, etc2 }`, all booleans |
| `gpu.vendor/architecture/device/description` | strings from `GPUAdapterInfo` (may be empty) |
| `gpu.isFallbackAdapter`, `gpu.preferredCanvasFormat` | informational |
| `benchmark` | `{ fillRateMPixPerSec: number\|null, ms: number\|null }` (null when `?bench=0`) |
| `deviceClass` | `"desktop"` \| `"mobile"` \| `"software"` |

Classification used by this probe: `software` = no WebGPU, fallback adapter, or a
SwiftShader/llvmpipe/WARP adapter; `mobile` = UA-reported mobile, or touch + no BC compression;
otherwise `desktop`. Consumers must ignore unknown extra fields.
Example: [`tools/local/test/fixtures/profile.json`](tools/local/test/fixtures/profile.json).

## 2. Probe page

`/probe.html` (in the built app). URL parameters:

| Param | Meaning |
|---|---|
| (none) | Standalone: measure, show a summary + the JSON, offer **Download device-profile.json** |
| `report=<url>` | After measuring, `POST` the result to this URL. Only loopback hosts are honoured (`127.0.0.1`, `localhost`, `[::1]`); others are ignored and the page stays standalone. |
| `token=<hex>` | Echoed in every report message |
| `bench=0` | Skip the fill-rate benchmark |

Report messages (JSON body; `fetch` with `application/json`, the endpoint answers the CORS preflight; the close beacon uses `text/plain` because `sendBeacon` only allows CORS-safelisted types; servers must parse the body regardless of `Content-Type`):

```jsonc
{ "type": "profile", "token": "…", "profile": { /* DeviceProfile */ } }
{ "type": "error",   "token": "…", "message": "WebGPU not available: …" }
{ "type": "closed",  "token": "…" }   // navigator.sendBeacon on pagehide before finishing
```

The page exposes `window.__probe = { state: "measuring"|"done"|"error", profile, error,
report: "none"|"sending"|"sent"|"failed", reportError }` for automation.

### Report endpoint (served by the orchestrator)

- Bound to **127.0.0.1 only**, random port unless `--port`.
- `POST /report`; body ≤ 512 KB.
- The token is 24 random bytes (hex), new per run, compared in constant time, and **one-time**:
  the first *accepted* message uses it up.

| Status | When |
|---|---|
| 200 | accepted (`profile` that validates, `error`, or `closed`) |
| 400 | body not JSON, unknown `type`, or `profile` failing validation (response lists the problems) |
| 403 | missing or wrong token |
| 409 | token already used |
| 413 | body too large |

Rejected reports never advance the orchestrator; it keeps waiting until the timeout.

## 3. Baker CLI

```
wgm-bake <input.glb|.gltf> [-o dir] [--device <file|-|auto|preset>] [--detail low|medium|high|max]
         [--max-triangles N] [reduction knobs: --lods, --lod-ratio, --max-texture-size, --texture-format,
          --astc-block, --vertex-precision, --normal-encoding, --pixel-error, …]
         [--json] [--print-device]
```

- `--device <file>` reads a profile file, `-` reads it from **stdin**, `auto` runs a headless
  Chrome probe of this machine (SwiftShader on GPU-less hosts; needs `npm run build`).
  A bare preset name (`desktop-1080p`, `phone`, `phone-etc2`) or `preset:<name>` loads a built-in
  profile from `tools/bake/presets/`; presets are **estimates**, not measurements (source `"preset"`).
- `--detail` scales what the profile allows (texture cap from screen size × 0.5/1/2/∞; triangle
  budget ×0.25/1/4/unlimited around desktop 2M, mobile 300k, software 100k; vertex tolerance
  1/0.5/0.25/0.1 px, 1°/0.5°/0.25°/0.05°; ASTC 6x6 instead of 4x4 at `low`).
- The profile's `gpu.textureCompression` picks a **native** texture format (`options.textureFormat`
  in the `device` event): `astc` (mobile, or no BC), `bc7`, `etc2`, `rgba8`, or `each` if WebGPU was
  unavailable. Nothing in such files is transcoded or decompressed at load. `--texture-format universal`
  (KTX2/Basis) is the only mode the engine transcodes at load; it is never chosen automatically.
- Explicit knobs always override derived ones (listed in `overriddenByFlags`).
- `--print-device` (needs `--device`, input optional) resolves and validates the profile, emits it, and exits without baking.

### NDJSON events (`--json`)

One JSON object per stdout line, each with `event` and `t` (ms since start). Human logs go to stderr or are suppressed.

| `event` | Fields |
|---|---|
| `start` | `tool: "wgm-bake"`, `protocol: 1`, `input`, `target`, `pid` |
| `log` | `level: "info"\|"warn"`, `message` |
| `profile` | (only `--print-device`) `source: "file"\|"stdin"\|"headless"`, `profile` |
| `device` | `source` (`file`\|`stdin`\|`headless`\|`preset`), `summary` (class, gpu, screen, compression, detail, probedAt, headless), `decisions[]`, `options` (incl. `textureFormat`, `astcBlock`, `vertexTolerance`), `overriddenByFlags[]` |
| `output` | (only `--texture-format each`) one per written file, same fields as `result` |
| `result` | `output` (absolute path), `inputBytes`, `outputBytes`, `ms`, `target`, `options`, `stats` (incl. `vertexBytesF32`, `vertexBytes`, `vertexFormats`, `maxPositionPixelError`, `maxNormalErrorDeg`, `maxUvErrorTexels`, `textureFormats`, `textureBytes`), `device` (summary or null). With `--texture-format each`: `output` is the template `<dir>/<name>.{tex}.wgm` (the viewer resolves `{tex}`), `outputs[]` lists the files, and `stats`/`outputBytes` are omitted (see the `output` events). |
| `error` | `code`, `exitCode`, `message` |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | success (a `result` or `profile` event was written) |
| 1 | internal error |
| 2 | usage (unknown option, missing input, bad value) |
| 3 | input unreadable / not glTF |
| 4 | device profile invalid, unreadable, or headless probe failed |
| 5 | bake failed |

A replacement baker must accept `<input> -o <dir> --device - --json` plus pass-through knobs, and
emit at least `start`, then `result` (exit 0) or `error` (non-zero). Supporting
`--device auto --print-device --json` is only needed for `--fallback-headless`.

## 4. Orchestrator

```
npm run local -- model.glb [-o out/] [--detail …] [--probe-timeout s] [--allow-cached | --fallback-headless | --use-cached] [--open]
```

### State machine (strictly sequential)

```
          start server
 idle ───────────────────▶ probing ──(valid profile + token)──▶ profile-received ──spawn baker──▶ baking ──exit 0 + result──▶ done
                              │  (timeout / error report / page closed / browser failed)                          │
                              ├── --allow-cached ──▶ valid cache ──────────▶ profile-received                      │
                              ├── --fallback-headless ──▶ baker --print-device ──▶ profile-received                │
                              ▼                                                                                    ▼
                            error  (no bake)                                                                     error
```

- Illegal transitions throw (`TRANSITIONS` in `tools/local/orchestrator.ts`).
- The baker process is spawned **only** in `profile-received → baking`, i.e. only after a complete,
  schema-valid profile arrived with the right token. Timeout, a probe `error`, a `closed` beacon or
  a failed browser launch go straight to `error` unless a fallback flag was given.
- The headless fallback runs as a *separate*, completed baker process (`--print-device`) before the bake process starts.
- The source of the profile is always stated: `browser`, `cache`, or `headless`.
- `--use-cached` skips probing (probing → profile-received from the cache) and fails with exit 13 if there is no valid cache.

The bake is `<baker-cmd> <input> -o <out> --device - --json <pass-through args>` with the profile on stdin.
`--open` then opens `http://127.0.0.1:PORT/?model=/out/<file>.wgm` in the browser.

### Exit codes

| Code | `code` | Meaning |
|---|---|---|
| 0 | | done |
| 1 | `internal` | unexpected error |
| 2 | `usage` | bad arguments / missing build |
| 10 | `probe-timeout` | no valid report within `--probe-timeout` |
| 11 | `probe-error`, `probe-closed`, `browser-failed`, `invalid-profile` | probe failed, page closed, or the browser command failed |
| 12 | `no-browser` | no way to open a browser (no display and no `--browser-cmd`) |
| 13 | `no-cache`, `fallback-failed` | requested fallback unavailable |
| 20 | `baker-failed` | baker exited non-zero or without a `result` |

### Events (`--json`)

`state {from,to}`, `probe {url (token redacted), browser, timeoutMs}`, `report-rejected {status, reason}`,
`probe-failed {code, message}`, `fallback-unavailable`, `profile {source, summary, probedAt}`, `warning {message}`,
`cache-written {file}`, `baker-spawned {pid, args}`, `baker {phase: "probe"|"bake", data: <baker event>}`,
`viewer {url, opened}`, and finally `done {output, source}` or `error {code, exitCode, message, bakerSpawned}`.

### Profile cache

`<cache-dir>/device-profile.json`, written only for profiles received from a real browser report
(unless `--no-cache`):

```json
{ "savedAt": "2026-10-25T12:00:00.000Z", "source": "browser", "profile": { /* DeviceProfile */ } }
```

Default cache dir: `$WGM_CONFIG_DIR`, else `$XDG_CONFIG_HOME` / `%APPDATA%` / `~/.config`, plus `/webgpu-engine`.
It is re-validated before use.
