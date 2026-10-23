/* ============================================================================
 * common/med/gl3d.js — the WebGL2 renderer: a volume and surfaces in 3D
 * ----------------------------------------------------------------------------
 * One canvas, drawn on demand (not every frame), in three passes:
 *   1. opaque meshes (segment surfaces, VTK) into an offscreen colour +
 *      depth target, over the background;
 *   2. that image copied to the screen with its depth, then the volume
 *      ray-cast over it: a box drawn by its back faces, each pixel marching
 *      from where the ray enters the box to where it leaves -- or meets an
 *      opaque mesh (its depth), so a surface inside the volume hides what is
 *      behind it and shows what is in front;
 *   3. transparent meshes, far ones first, blended on top (depth-tested
 *      against the opaque meshes, not against the volume).
 *
 * The volume lives in its own voxel frame: a 3-D texture (half floats,
 * values scaled to 0..1 over the volume's range) and the affine taking
 * texture coordinates to world (RAS mm), so an oblique or flipped volume
 * sits where its header says, as the meshes (already in world mm) do.
 * Modes: "dvr" (composited, window -> colour map and opacity), "mip"
 * (maximum along the ray) and "iso" (the first point above a level, lit).
 *
 * Two more layers, for tractography pages:
 *   lines    streamlines as coloured polylines (setLines: points in world mm,
 *            an RGB per point, index pairs per segment), each step drawn as
 *            a screen-facing quad `width` pixels wide (WebGL's own lines are
 *            1 px on most systems), instanced from the point buffer itself;
 *            opaque ones are drawn with the opaque meshes, see-through ones
 *            last, blended;
 *   slices   the volume as three world-aligned planes (axial, coronal,
 *            sagittal) at chosen world positions, sampled from the same 3-D
 *            texture through the window and colour map, at an opacity.
 *
 * A mesh may fade out downwards: `fade` = [z0, z1] (world S, mm) makes it
 * fully transparent at z0 and as set at z1 -- e.g. a head surface whose
 * jaw and neck, poorly captured by the scan, dissolve instead of ending in
 * a ragged edge.
 *
 * A clip plane, in world space, cuts the volume and every mesh alike.
 * Camera: orbit about a target; perspective, 30° field of view.
 * ========================================================================== */
(function () {
  "use strict";
  const Med = (window.Med = window.Med || {});

  // --- Column-major 4×4 matrices (WebGL's layout) -------------------------------
  const mat = {
    ident: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    mul(a, b) {
      const o = new Float32Array(16);
      for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++) {
          let s = 0;
          for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
          o[c * 4 + r] = s;
        }
      return o;
    },
    perspective(fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2), o = new Float32Array(16);
      o[0] = f / aspect; o[5] = f; o[10] = (far + near) / (near - far); o[11] = -1;
      o[14] = (2 * far * near) / (near - far);
      return o;
    },
    /** Med's row-major affine -> column-major. */
    fromRows: (a) => new Float32Array([a[0], a[4], a[8], a[12], a[1], a[5], a[9], a[13],
                                       a[2], a[6], a[10], a[14], a[3], a[7], a[11], a[15]]),
    inv: (m) => new Float32Array(Med.M.inv(Array.from(m))),     // layout-agnostic
    apply(m, x, y, z) {
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
              (m[2] * x + m[6] * y + m[10] * z + m[14]) / w];
    },
  };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const n = Math.hypot(...a) || 1; return a.map((v) => v / n); };

  // --- Float32 -> float16 bits ----------------------------------------------------
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  function toHalf(v) {
    f32[0] = v;
    const x = u32[0], sign = (x >>> 16) & 0x8000;
    let e = ((x >>> 23) & 0xff) - 112, m = x & 0x7fffff;
    if (e <= 0) return sign;                                  // tiny -> 0 (values are 0..1)
    if (e >= 31) return sign | 0x7bff;
    m += 0x1000;                                              // round
    if (m & 0x800000) { m = 0; e++; }
    return sign | (e << 10) | (m >>> 13);
  }

  // --- Shaders --------------------------------------------------------------------
  const MESH_VS = `#version 300 es
  in vec3 aPos; in vec3 aNormal;
  uniform mat4 uViewProj;
  out vec3 vWorld; out vec3 vNormal;
  void main() { vWorld = aPos; vNormal = aNormal; gl_Position = uViewProj * vec4(aPos, 1.0); }`;
  const MESH_FS = `#version 300 es
  precision highp float;
  in vec3 vWorld; in vec3 vNormal;
  uniform vec3 uColor; uniform float uAlpha; uniform vec3 uEye; uniform vec4 uClip;
  uniform vec2 uFade;      // world z: fully faded at x, fully opaque at y (x == y: no fade)
  out vec4 fragColor;
  void main() {
    if (dot(uClip.xyz, vWorld) + uClip.w < 0.0) discard;
    float a = uAlpha;
    if (uFade.y > uFade.x) a *= smoothstep(uFade.x, uFade.y, vWorld.z);
    if (a < 0.004) discard;
    vec3 n = normalize(vNormal);
    if (!gl_FrontFacing) n = -n;
    vec3 l = normalize(uEye - vWorld);
    float diff = max(dot(n, l), 0.0);
    float spec = pow(diff, 40.0) * 0.25;            // headlight: half vector = light
    vec3 c = uColor * (0.28 + 0.72 * diff) + vec3(spec);
    fragColor = vec4(c, a);
  }`;
  // One instance per step (point i -> i+1); aCorner: x 0/1 = which end,
  // y -1/+1 = which side. A step joining two streamlines has aValid 0 and
  // is sent outside the clip volume.
  const LINE_VS = `#version 300 es
  in vec3 aP0; in vec3 aP1; in vec3 aC0; in vec3 aC1; in float aValid; in vec2 aCorner;
  uniform mat4 uViewProj; uniform vec2 uViewport; uniform float uWidth;
  out vec3 vWorld; out vec3 vColor;
  void main() {
    vec4 c0 = uViewProj * vec4(aP0, 1.0), c1 = uViewProj * vec4(aP1, 1.0);
    vec2 s0 = c0.xy / c0.w * uViewport, s1 = c1.xy / c1.w * uViewport;
    vec2 d = s1 - s0;
    float len = length(d);
    d = len > 1e-6 ? d / len : vec2(1.0, 0.0);
    vec2 n = vec2(-d.y, d.x);
    bool end = aCorner.x > 0.5;
    vec4 c = end ? c1 : c0;
    vec2 off = n * aCorner.y * 0.5 * uWidth / uViewport;   // half the width each side; NDC (uViewport = half the size)
    gl_Position = aValid > 0.5 ? vec4(c.xy + off * c.w, c.zw) : vec4(2.0, 2.0, 2.0, 1.0);
    vColor = end ? aC1 : aC0;
    vWorld = end ? aP1 : aP0;
  }`;
  const LINE_FS = `#version 300 es
  precision highp float;
  in vec3 vWorld; in vec3 vColor;
  uniform float uAlpha; uniform vec4 uClip;
  out vec4 fragColor;
  void main() {
    if (dot(uClip.xyz, vWorld) + uClip.w < 0.0) discard;
    fragColor = vec4(vColor, uAlpha);
  }`;
  // A world-aligned plane: aPos is (u, v) in 0..1 over the volume's bounds;
  // uAxis picks which world axis is fixed at uPos.
  const PLANE_VS = `#version 300 es
  in vec2 aUV;
  uniform mat4 uViewProj; uniform int uAxis; uniform float uPos; uniform vec3 uLo; uniform vec3 uHi;
  out vec3 vWorld;
  void main() {
    vec3 w = mix(uLo, uHi, uAxis == 0 ? vec3(0.0, aUV) : uAxis == 1 ? vec3(aUV.x, 0.0, aUV.y) : vec3(aUV, 0.0));
    w[uAxis] = uPos;
    vWorld = w;
    gl_Position = uViewProj * vec4(w, 1.0);
  }`;
  const PLANE_FS = `#version 300 es
  precision highp float; precision highp sampler3D;
  in vec3 vWorld;
  uniform sampler3D uVol; uniform sampler2D uLut; uniform mat4 uTexFromWorld;
  uniform vec2 uWin; uniform float uAlpha; uniform vec4 uClip;
  out vec4 fragColor;
  void main() {
    if (dot(uClip.xyz, vWorld) + uClip.w < 0.0) discard;
    vec3 t = (uTexFromWorld * vec4(vWorld, 1.0)).xyz;
    if (any(lessThan(t, vec3(0.0))) || any(greaterThan(t, vec3(1.0)))) discard;
    float u = clamp((texture(uVol, t).r - uWin.x) / max(uWin.y - uWin.x, 1e-6), 0.0, 1.0);
    fragColor = vec4(texture(uLut, vec2(u, 0.5)).rgb, uAlpha);
  }`;
  const BLIT_VS = `#version 300 es
  void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
  const BLIT_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uColor; uniform highp sampler2D uDepth;
  out vec4 fragColor;
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    fragColor = texelFetch(uColor, p, 0);
    gl_FragDepth = texelFetch(uDepth, p, 0).r;
  }`;
  const VOL_VS = `#version 300 es
  in vec3 aPos;
  uniform mat4 uMVP;
  out vec3 vTex;
  void main() { vTex = aPos; gl_Position = uMVP * vec4(aPos, 1.0); }`;
  const VOL_FS = `#version 300 es
  precision highp float; precision highp sampler3D;
  in vec3 vTex;
  uniform sampler3D uVol; uniform sampler2D uLut; uniform highp sampler2D uDepth;
  uniform vec3 uCamTex; uniform mat4 uTexFromWorld; uniform mat4 uInvViewProj; uniform mat3 uWorldFromTex3;
  uniform mat3 uNormalMat; uniform vec2 uViewport;
  uniform int uMode; uniform vec2 uWin; uniform float uOpacity; uniform float uIso; uniform vec3 uIsoColor;
  uniform float uStep; uniform float uVoxSteps; uniform vec4 uClip; uniform bool uShade; uniform vec3 uTexel;
  out vec4 fragColor;
  // Central differences 1.5 voxels apart: with trilinear filtering each tap
  // blends two voxels, so the normals are smooth instead of showing every
  // voxel step of a sharp edge as a terrace.
  vec3 gradient(vec3 p) {
    vec3 h = 1.5 * uTexel;
    return vec3(texture(uVol, p + vec3(h.x, 0, 0)).r - texture(uVol, p - vec3(h.x, 0, 0)).r,
                texture(uVol, p + vec3(0, h.y, 0)).r - texture(uVol, p - vec3(0, h.y, 0)).r,
                texture(uVol, p + vec3(0, 0, h.z)).r - texture(uVol, p - vec3(0, 0, h.z)).r);
  }
  // Trilinear interpolation in full float precision. Hardware filtering
  // weights the 8 voxels with ~8-bit fractions, which terraces an
  // isosurface; this is used where that shows: the iso hit and its normal.
  ivec3 vdim() { return textureSize(uVol, 0); }
  float exact(vec3 p) {
    vec3 g = clamp(p * vec3(vdim()) - 0.5, vec3(0.0), vec3(vdim() - 1));
    ivec3 i0 = ivec3(floor(g)), i1 = min(i0 + 1, vdim() - 1);
    vec3 f = g - vec3(i0);
    float c000 = texelFetch(uVol, i0, 0).r, c100 = texelFetch(uVol, ivec3(i1.x, i0.y, i0.z), 0).r;
    float c010 = texelFetch(uVol, ivec3(i0.x, i1.y, i0.z), 0).r, c110 = texelFetch(uVol, ivec3(i1.x, i1.y, i0.z), 0).r;
    float c001 = texelFetch(uVol, ivec3(i0.x, i0.y, i1.z), 0).r, c101 = texelFetch(uVol, ivec3(i1.x, i0.y, i1.z), 0).r;
    float c011 = texelFetch(uVol, ivec3(i0.x, i1.y, i1.z), 0).r, c111 = texelFetch(uVol, i1, 0).r;
    return mix(mix(mix(c000, c100, f.x), mix(c010, c110, f.x), f.y), mix(mix(c001, c101, f.x), mix(c011, c111, f.x), f.y), f.z);
  }
  // (A wider stencil hides the voxel-scale terraces a hard-edged label-like
  // volume leaves in any trilinear isosurface, but on real anatomy it
  // reaches into the next tissue layer and muddies the shading: 1.5 voxels.)
  vec3 exactGradient(vec3 p) {
    vec3 h = 1.5 * uTexel;
    return vec3(exact(p + vec3(h.x, 0, 0)) - exact(p - vec3(h.x, 0, 0)),
                exact(p + vec3(0, h.y, 0)) - exact(p - vec3(0, h.y, 0)),
                exact(p + vec3(0, 0, h.z)) - exact(p - vec3(0, 0, h.z)));
  }
  float light(vec3 p, vec3 dirW) {
    vec3 g = uNormalMat * gradient(p);
    float len = length(g);
    if (len < 1e-6) return 1.0;
    vec3 n = g / len;
    return 0.3 + 0.7 * abs(dot(n, dirW));
  }
  void main() {
    vec3 dir = normalize(vTex - uCamTex);
    vec3 inv = 1.0 / dir;
    vec3 t0 = (vec3(0.0) - uCamTex) * inv, t1 = (vec3(1.0) - uCamTex) * inv;
    vec3 tmin = min(t0, t1), tmax = max(t0, t1);
    float near = max(max(max(tmin.x, tmin.y), tmin.z), 0.0);
    float far = min(min(tmax.x, tmax.y), tmax.z);
    // Stop at an opaque mesh.
    float d = texelFetch(uDepth, ivec2(gl_FragCoord.xy), 0).r;
    if (d < 1.0) {
      vec4 w = uInvViewProj * vec4(gl_FragCoord.xy / uViewport * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
      vec3 tp = (uTexFromWorld * vec4(w.xyz / w.w, 1.0)).xyz;
      far = min(far, dot(tp - uCamTex, dir));
    }
    // The clip plane (texture space): keep dot(n, p) + w >= 0.
    if (uClip != vec4(0.0)) {
      float a = dot(uClip.xyz, uCamTex) + uClip.w, b = dot(uClip.xyz, dir);
      if (abs(b) < 1e-8) { if (a < 0.0) discard; }
      else if (b > 0.0) near = max(near, -a / b);
      else far = min(far, -a / b);
    }
    if (near >= far) discard;
    vec3 dirW = normalize(uWorldFromTex3 * dir);
    // Jitter the start against wood-grain banding.
    float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    float x = near + jitter * uStep;
    vec4 acc = vec4(0.0);
    float mx = 0.0;
    float prevV = 0.0, prevX = x;
    for (int i = 0; i < 4096; i++) {
      if (x > far) break;
      vec3 p = uCamTex + dir * x;
      float v = texture(uVol, p).r;
      if (uMode == 0) {
        float u = clamp((v - uWin.x) / max(uWin.y - uWin.x, 1e-6), 0.0, 1.0);
        float a = smoothstep(0.0, 1.0, u) * uOpacity;
        if (a > 0.002) {
          a = 1.0 - pow(1.0 - a, uVoxSteps);
          vec3 c = texture(uLut, vec2(u, 0.5)).rgb;
          if (uShade) c *= light(p, dirW);
          acc.rgb += (1.0 - acc.a) * a * c;
          acc.a += (1.0 - acc.a) * a;
          if (acc.a > 0.98) break;
        }
      } else if (uMode == 1) {
        mx = max(mx, v);
      } else {
        if (v >= uIso && i > 0) {
          float lo = prevX, hi = x;                       // refine the crossing
          for (int k = 0; k < 6; k++) {
            float m = 0.5 * (lo + hi);
            if (exact(uCamTex + dir * m) >= uIso) hi = m; else lo = m;
          }
          vec3 q = uCamTex + dir * hi;
          vec3 g = uNormalMat * exactGradient(q);
          float lit = length(g) > 1e-6 ? 0.25 + 0.75 * abs(dot(normalize(g), dirW)) : 1.0;
          acc = vec4(uIsoColor * lit, 1.0);
          break;
        }
        prevV = v; prevX = x;
      }
      x += uStep;
    }
    if (uMode == 1) {
      float u = clamp((mx - uWin.x) / max(uWin.y - uWin.x, 1e-6), 0.0, 1.0);
      acc = vec4(texture(uLut, vec2(u, 0.5)).rgb * u, u);
    }
    if (acc.a <= 0.0) discard;
    fragColor = acc;
  }`;

  function compile(gl, vs, fs) {
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error("Shader: " + gl.getShaderInfoLog(sh));
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("Program: " + gl.getProgramInfoLog(prog));
    const u = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(prog, i); u[info.name] = gl.getUniformLocation(prog, info.name); }
    return { prog, u, attr: (name) => gl.getAttribLocation(prog, name) };
  }

  // Unit cube, 12 triangles, outward winding.
  const CUBE = new Float32Array([
    0,0,0, 0,1,0, 1,1,0,  0,0,0, 1,1,0, 1,0,0,   0,0,1, 1,0,1, 1,1,1,  0,0,1, 1,1,1, 0,1,1,
    0,0,0, 1,0,0, 1,0,1,  0,0,0, 1,0,1, 0,0,1,   0,1,0, 0,1,1, 1,1,1,  0,1,0, 1,1,1, 1,1,0,
    0,0,0, 0,0,1, 0,1,1,  0,0,0, 0,1,1, 0,1,0,   1,0,0, 1,1,0, 1,1,1,  1,0,0, 1,1,1, 1,0,1]);

  // ==========================================================================
  // The renderer
  // ==========================================================================
  function create(canvas) {
    const gl = canvas.getContext("webgl2", { antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error("This browser has no WebGL2: 3D rendering needs a current browser with hardware graphics.");
    const P = { mesh: compile(gl, MESH_VS, MESH_FS), blit: compile(gl, BLIT_VS, BLIT_FS), vol: compile(gl, VOL_VS, VOL_FS),
                line: compile(gl, LINE_VS, LINE_FS), plane: compile(gl, PLANE_VS, PLANE_FS) };

    const cubeVao = gl.createVertexArray();
    gl.bindVertexArray(cubeVao);
    const cubeBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cubeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, CUBE, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(P.vol.attr("aPos"));
    gl.vertexAttribPointer(P.vol.attr("aPos"), 3, gl.FLOAT, false, 0, 0);
    const emptyVao = gl.createVertexArray();
    const planeVao = gl.createVertexArray();
    gl.bindVertexArray(planeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(P.plane.attr("aUV"));
    gl.vertexAttribPointer(P.plane.attr("aUV"), 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Offscreen target for the opaque meshes.
    const target = { w: 0, h: 0, fb: gl.createFramebuffer(), color: gl.createTexture(), depth: gl.createTexture() };
    function resizeTarget(w, h) {
      if (target.w === w && target.h === h) return;
      target.w = w; target.h = h;
      gl.bindTexture(gl.TEXTURE_2D, target.color);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindTexture(gl.TEXTURE_2D, target.depth);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.color, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, target.depth, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // --- Scene ------------------------------------------------------------------
    const scene = {
      volume: null,        // { tex, dims, worldFromTex (col-major), lut, ... }
      meshes: [],          // { id, vao, count, color:[0..1], alpha, visible, centre }
      background: [0, 0, 0],
      clip: null,          // world plane [nx, ny, nz, w] or null
      vol: { mode: "dvr", win: [0.2, 0.8], opacity: 0.08, iso: 0.4, isoColor: [0.9, 0.85, 0.78], shade: true, quality: 1, visible: true },
      lines: null,         // { vao, bufs, count, alpha, visible, lo, hi }
      // Three world-aligned slices of the volume: pos[a] is the world
      // coordinate on axis a (x = sagittal, y = coronal, z = axial);
      // show[a] whether that plane is drawn.
      slices: { visible: false, pos: [0, 0, 0], show: [true, true, true], opacity: 1, win: [0, 1] },
    };

    // --- Camera -----------------------------------------------------------------
    const cam = { rot: null, dist: 300, target: [0, 0, 0], pan: [0, 0], radius: 100, fov: (30 * Math.PI) / 180 };
    /** Rotation (rows = view x, y, z in world) looking from `from` with `up`. */
    function orient(from, up) {
      const z = norm(from), x = norm(cross(up, z)), y = cross(z, x);
      cam.rot = [x, y, z];
    }
    orient([0, 1, 0], [0, 0, 1]);                         // anterior view

    function viewMatrix() {
      const [x, y, z] = cam.rot;
      const t = cam.target;
      const v = new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, 0, 0, 0, 1]);
      v[12] = -(x[0] * t[0] + x[1] * t[1] + x[2] * t[2]) + cam.pan[0];
      v[13] = -(y[0] * t[0] + y[1] * t[1] + y[2] * t[2]) + cam.pan[1];
      v[14] = -(z[0] * t[0] + z[1] * t[1] + z[2] * t[2]) - cam.dist;
      return v;
    }

    function eyeWorld(view) {
      const inv = mat.inv(view);
      return [inv[12], inv[13], inv[14]];
    }

    // --- Volume -------------------------------------------------------------------
    /**
     * vol: a Med.Volume (current frame). Values are scaled to 0..1 over
     * [lo, hi] (the volume's range) into a half-float 3-D texture; a volume
     * over maxVoxels is subsampled (every s-th voxel) first.
     */
    function setVolume(vol, lo, hi, maxVoxels) {
      if (scene.volume) gl.deleteTexture(scene.volume.tex);
      scene.volume = null;
      if (!vol) return null;
      const max3d = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
      let s = Math.max(1, Math.ceil(Math.cbrt(vol.nvox / maxVoxels)));
      while (vol.dims.some((n) => Math.ceil(n / s) > max3d)) s++;
      const dims = vol.dims.map((n) => Math.ceil(n / s));
      const data = new Uint16Array(dims[0] * dims[1] * dims[2]);
      const span = hi - lo || 1, [nx, ny] = vol.dims;
      let o = 0;
      for (let k = 0; k < dims[2]; k++)
        for (let j = 0; j < dims[1]; j++)
          for (let i = 0; i < dims[0]; i++) {
            const v = vol.value(i * s + nx * (j * s + ny * k * s));
            data[o++] = toHalf(v === v ? Math.min(1, Math.max(0, (v - lo) / span)) : 0);
          }
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.R16F, dims[0], dims[1], dims[2], 0, gl.RED, gl.HALF_FLOAT, data);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.LINEAR);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
      // Texture coordinate t (0..1) -> voxel index of the subsampled grid
      // (t·dims − ½) -> original voxel index (×s) -> world (the affine).
      const a = vol.affine;
      const sub = [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
      const tex2vox = [dims[0], 0, 0, -0.5, 0, dims[1], 0, -0.5, 0, 0, dims[2], -0.5, 0, 0, 0, 1];
      const rows = Med.M.mul(a, Med.M.mul(sub, tex2vox));
      scene.volume = { tex, dims, step: s, worldFromTex: mat.fromRows(rows), rows };
      return scene.volume;
    }

    function setLut(rgb) {
      const px = new Uint8Array(256 * 4);
      for (let i = 0; i < 256; i++) { px[i * 4] = rgb[i * 3]; px[i * 4 + 1] = rgb[i * 3 + 1]; px[i * 4 + 2] = rgb[i * 3 + 2]; px[i * 4 + 3] = 255; }
      if (!scene.lut) scene.lut = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, scene.lut);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    }

    // --- Meshes -------------------------------------------------------------------
    /** positions: Float32Array (world mm, xyz…), normals: same length,
     *  indices: Uint32Array. Returns the mesh record. */
    function addMesh(id, positions, normals, indices, color, alpha) {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const bufs = [gl.createBuffer(), gl.createBuffer(), gl.createBuffer()];
      for (const [i, name, data] of [[0, "aPos", positions], [1, "aNormal", normals]]) {
        gl.bindBuffer(gl.ARRAY_BUFFER, bufs[i]);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        const loc = P.mesh.attr(name);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufs[2]);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < positions.length; i += 3)
        for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], positions[i + d]); hi[d] = Math.max(hi[d], positions[i + d]); }
      const m = { id, vao, bufs, count: indices.length, color, alpha, visible: true, lo, hi,
                  centre: lo.map((v, d) => (v + hi[d]) / 2) };
      scene.meshes.push(m);
      return m;
    }
    function removeMeshes(pred) {
      scene.meshes = scene.meshes.filter((m) => {
        if (!pred(m)) return true;
        m.bufs.forEach((b) => gl.deleteBuffer(b));
        gl.deleteVertexArray(m.vao);
        return false;
      });
    }

    // --- Lines (streamlines) --------------------------------------------------------
    /**
     * positions: Float32Array (world mm, xyz per point), colors: Uint8Array
     * (rgb per point), indices: Uint32Array (pairs: one per segment).
     * Replaces the previous lines; null clears them.
     */
    function setLines(positions, colors, indices) {
      if (scene.lines) {
        scene.lines.bufs.forEach((buf) => gl.deleteBuffer(buf));
        gl.deleteVertexArray(scene.lines.vao);
      }
      const keep = scene.lines ? { alpha: scene.lines.alpha, visible: scene.lines.visible, width: scene.lines.width }
                               : { alpha: 1, visible: true, width: 1.5 };
      scene.lines = null;
      const nPts = positions ? positions.length / 3 : 0;
      if (!positions || !indices || !indices.length || nPts < 2) return null;
      // Steps i -> i+1 that belong to one streamline (the index pairs say).
      const valid = new Uint8Array(nPts - 1);
      for (let k = 0; k < indices.length; k += 2) if (indices[k + 1] === indices[k] + 1) valid[indices[k]] = 1;
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const bufs = [gl.createBuffer(), gl.createBuffer(), gl.createBuffer(), gl.createBuffer()];
      const attr = (name) => P.line.attr(name);
      const inst = (name, buf, size, type, norm, stride, offset) => {
        const loc = attr(name);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, type, norm, stride, offset);
        gl.vertexAttribDivisor(loc, 1);
      };
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs[0]); gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs[1]); gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs[2]); gl.bufferData(gl.ARRAY_BUFFER, valid, gl.STATIC_DRAW);
      inst("aP0", bufs[0], 3, gl.FLOAT, false, 12, 0);
      inst("aP1", bufs[0], 3, gl.FLOAT, false, 12, 12);
      inst("aC0", bufs[1], 3, gl.UNSIGNED_BYTE, true, 3, 0);
      inst("aC1", bufs[1], 3, gl.UNSIGNED_BYTE, true, 3, 3);
      inst("aValid", bufs[2], 1, gl.UNSIGNED_BYTE, false, 1, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs[3]);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(attr("aCorner"));
      gl.vertexAttribPointer(attr("aCorner"), 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < positions.length; i += 3)
        for (let d = 0; d < 3; d++) {
          const v = positions[i + d];
          if (v < lo[d]) lo[d] = v;
          if (v > hi[d]) hi[d] = v;
        }
      scene.lines = { vao, bufs, steps: nPts - 1, lo, hi, ...keep };
      return scene.lines;
    }

    function drawLines(vp, clip) {
      const L = scene.lines;
      const u = P.line.u;
      const dpr = window.devicePixelRatio || 1;
      gl.useProgram(P.line.prog);
      gl.uniformMatrix4fv(u.uViewProj, false, vp);
      gl.uniform2f(u.uViewport, canvas.width / 2, canvas.height / 2);
      gl.uniform1f(u.uWidth, Math.max(1, L.width * dpr));
      gl.uniform1f(u.uAlpha, L.alpha);
      gl.uniform4fv(u.uClip, clip);
      gl.bindVertexArray(L.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, L.steps);
      gl.bindVertexArray(null);
    }

    /** The three slices: the volume's world bounding box, each plane at its
     *  world position, sampled through the window and the colour map. */
    function drawSlices(vp, clip) {
      const V = scene.volume, S = scene.slices;
      const [lo, hi] = volumeBounds();
      const u = P.plane.u;
      gl.useProgram(P.plane.prog);
      gl.uniformMatrix4fv(u.uViewProj, false, vp);
      gl.uniformMatrix4fv(u.uTexFromWorld, false, mat.inv(V.worldFromTex));
      gl.uniform3fv(u.uLo, lo);
      gl.uniform3fv(u.uHi, hi);
      gl.uniform2f(u.uWin, S.win[0], S.win[1]);
      gl.uniform1f(u.uAlpha, S.opacity);
      gl.uniform4fv(u.uClip, clip);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, V.tex); gl.uniform1i(u.uVol, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, scene.lut); gl.uniform1i(u.uLut, 1);
      gl.bindVertexArray(planeVao);
      for (let a = 0; a < 3; a++) {
        if (!S.show[a]) continue;
        gl.uniform1i(u.uAxis, a);
        gl.uniform1f(u.uPos, S.pos[a]);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      gl.bindVertexArray(null);
    }

    function volumeBounds() {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const c of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1]]) {
        const w = mat.apply(scene.volume.worldFromTex, ...c);
        for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], w[d]); hi[d] = Math.max(hi[d], w[d]); }
      }
      return [lo, hi];
    }

    /** World bounding box of what is shown: [lo, hi] or null. */
    function bounds() {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      let any = false;
      const grow = (a, b) => {
        for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], a[d]); hi[d] = Math.max(hi[d], b[d]); }
        any = true;
      };
      if (scene.volume && ((scene.vol.visible && scene.vol.mode !== "off") || scene.slices.visible)) grow(...volumeBounds());
      if (scene.lines && scene.lines.visible) grow(scene.lines.lo, scene.lines.hi);
      for (const m of scene.meshes) {
        if (!m.visible) continue;
        for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], m.lo[d]); hi[d] = Math.max(hi[d], m.hi[d]); }
        any = true;
      }
      return any ? [lo, hi] : null;
    }

    /** Fit the camera to `b` ([lo, hi], world) or to everything shown. */
    function frame(b) {
      b = b || bounds();
      if (!b) return;
      cam.target = b[0].map((v, d) => (v + b[1][d]) / 2);
      cam.radius = Math.hypot(...b[1].map((v, d) => v - b[0][d])) / 2 || 100;
      cam.dist = (cam.radius / Math.sin(cam.fov / 2)) * 1.05;
      cam.pan = [0, 0];
    }

    // --- Drawing ------------------------------------------------------------------
    let interactive = false;
    function render() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      resizeTarget(w, h);
      const view = viewMatrix();
      const proj = mat.perspective(cam.fov, w / h, Math.max(0.1, cam.dist - cam.radius * 3), cam.dist + cam.radius * 3);
      const vp = mat.mul(proj, view);
      const eye = eyeWorld(view);
      const clip = scene.clip || [0, 0, 0, 0];
      const bg = scene.background;

      // 1. Opaque meshes -> target.
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
      gl.viewport(0, 0, w, h);
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      const seeThrough = (m) => m.alpha < 0.999 || !!m.fade;          // a faded mesh is see-through somewhere
      const opaque = scene.meshes.filter((m) => m.visible && !seeThrough(m));
      const clear = scene.meshes.filter((m) => m.visible && seeThrough(m));
      drawMeshes(opaque, vp, eye, clip);
      const L = scene.lines && scene.lines.visible && scene.lines.alpha > 0 ? scene.lines : null;
      const SL = scene.volume && scene.slices.visible && scene.slices.opacity > 0 ? scene.slices : null;
      if (L && L.alpha >= 0.999) drawLines(vp, clip);
      if (SL && SL.opacity >= 0.999) drawSlices(vp, clip);

      // 2. Copy to the screen with depth, then the volume over it.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.depthFunc(gl.ALWAYS);
      gl.useProgram(P.blit.prog);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, target.color); gl.uniform1i(P.blit.u.uColor, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, target.depth); gl.uniform1i(P.blit.u.uDepth, 1);
      gl.bindVertexArray(emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.depthFunc(gl.LESS);

      const V = scene.volume, o = scene.vol;
      if (V && o.visible && o.mode !== "off") {
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.FRONT);
        const u = P.vol.u;
        gl.useProgram(P.vol.prog);
        const mvp = mat.mul(vp, V.worldFromTex);
        const texFromWorld = mat.inv(V.worldFromTex);
        const camTex = mat.apply(texFromWorld, ...eye);
        const W3 = [V.worldFromTex[0], V.worldFromTex[1], V.worldFromTex[2], V.worldFromTex[4], V.worldFromTex[5],
                    V.worldFromTex[6], V.worldFromTex[8], V.worldFromTex[9], V.worldFromTex[10]];
        // Gradient in texture coordinates -> world: (W3⁻¹)ᵀ.
        const T = texFromWorld;
        const normalMat = [T[0], T[4], T[8], T[1], T[5], T[9], T[2], T[6], T[10]];
        // The clip plane in texture space: Wᵀ · plane.
        const Wm = V.worldFromTex;
        const clipTex = scene.clip ? [0, 1, 2, 3].map((c) => Wm[c * 4] * clip[0] + Wm[c * 4 + 1] * clip[1] + Wm[c * 4 + 2] * clip[2] + Wm[c * 4 + 3] * clip[3]) : [0, 0, 0, 0];
        const maxDim = Math.max(...V.dims);
        const step = 1 / (maxDim * o.quality * (interactive ? 0.5 : 1) * 1.5);
        gl.uniformMatrix4fv(u.uMVP, false, mvp);
        gl.uniform3fv(u.uCamTex, camTex);
        gl.uniformMatrix4fv(u.uTexFromWorld, false, texFromWorld);
        gl.uniformMatrix4fv(u.uInvViewProj, false, mat.inv(vp));
        gl.uniformMatrix3fv(u.uWorldFromTex3, false, W3);
        gl.uniformMatrix3fv(u.uNormalMat, false, normalMat);
        gl.uniform2f(u.uViewport, w, h);
        gl.uniform1i(u.uMode, { dvr: 0, mip: 1, iso: 2 }[o.mode]);
        gl.uniform2f(u.uWin, o.win[0], o.win[1]);
        gl.uniform1f(u.uOpacity, o.opacity);
        gl.uniform1f(u.uIso, o.iso);
        gl.uniform3fv(u.uIsoColor, o.isoColor);
        gl.uniform1f(u.uStep, step);
        gl.uniform1f(u.uVoxSteps, step * maxDim);
        gl.uniform4fv(u.uClip, clipTex);
        gl.uniform1i(u.uShade, o.shade ? 1 : 0);
        gl.uniform3f(u.uTexel, 1 / V.dims[0], 1 / V.dims[1], 1 / V.dims[2]);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, V.tex); gl.uniform1i(u.uVol, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, scene.lut); gl.uniform1i(u.uLut, 1);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, target.depth); gl.uniform1i(u.uDepth, 2);
        gl.bindVertexArray(cubeVao);
        gl.drawArrays(gl.TRIANGLES, 0, 36);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.DEPTH_TEST);
      }

      // 3. See-through layers, blended over the opaque ones: the slices,
      //    then the meshes (far first), then the lines. (Exact for one
      //    layer; for several an approximation, as with any unsorted blend.)
      const seeSlices = SL && SL.opacity < 0.999, seeLines = L && L.alpha < 0.999;
      if (clear.length || seeSlices || seeLines) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        if (seeSlices) drawSlices(vp, clip);
        if (clear.length) {
          const dz = (m) => { const v = mat.apply(view, ...m.centre); return v[2]; };
          clear.sort((a, b) => dz(a) - dz(b));
          drawMeshes(clear, vp, eye, clip);
        }
        if (seeLines) drawLines(vp, clip);
        gl.depthMask(true);
      }
      gl.disable(gl.BLEND);
      if (opts.onRender) opts.onRender(view);
    }

    function drawMeshes(list, vp, eye, clip) {
      if (!list.length) return;
      const u = P.mesh.u;
      gl.useProgram(P.mesh.prog);
      gl.uniformMatrix4fv(u.uViewProj, false, vp);
      gl.uniform3fv(u.uEye, eye);
      gl.uniform4fv(u.uClip, clip);
      for (const m of list) {
        gl.uniform3fv(u.uColor, m.color);
        gl.uniform1f(u.uAlpha, m.alpha);
        gl.uniform2fv(u.uFade, m.fade || [0, 0]);
        gl.bindVertexArray(m.vao);
        gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
      }
      gl.bindVertexArray(null);
    }

    let pending = false;
    function redraw() {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; render(); });
    }

    // --- Mouse ----------------------------------------------------------------------
    const opts = {};
    let drag = null;
    function rotateBy(ax, ay) {
      // Turn about the view's y (horizontal drag) and x (vertical drag).
      const [x, y, z] = cam.rot;
      const turn = (v, axis, ang) => {
        const c = Math.cos(ang), s = Math.sin(ang), k = axis;
        const d = k[0] * v[0] + k[1] * v[1] + k[2] * v[2], cr = cross(k, v);
        return [0, 1, 2].map((i) => v[i] * c + cr[i] * s + k[i] * d * (1 - c));
      };
      let nx = turn(x, y, -ax), nz = turn(z, y, -ax);
      const ny = turn(y, nx, -ay);
      nz = turn(nz, nx, -ay);
      nx = norm(nx);
      cam.rot = [nx, norm(ny), norm(cross(nx, ny))];
    }
    // One pointer drags (rotate; right button, middle button or Shift pans);
    // two fingers pinch to zoom and move together to pan.
    const touches = new Map();
    let pinch = null;
    const pinchState = () => {
      const [p, q] = [...touches.values()];
      return { d: Math.hypot(p.x - q.x, p.y - q.y) || 1, x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    };
    const panBy = (dx, dy) => {
      const k = (2 * cam.dist * Math.tan(cam.fov / 2)) / canvas.clientHeight;
      cam.pan[0] += dx * k; cam.pan[1] -= dy * k;
    };
    const zoomBy = (f) => { cam.dist = Math.max(cam.radius * 0.2, Math.min(cam.radius * 20, cam.dist * f)); };
    canvas.addEventListener("pointerdown", (e) => {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* no live pointer */ }
      interactive = true;
      if (touches.size === 2) { drag = null; pinch = pinchState(); return; }
      drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey || e.button === 1 };
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size === 2) {
        const now = pinchState();
        zoomBy(pinch.d / now.d);
        panBy(now.x - pinch.x, now.y - pinch.y);
        pinch = now;
        redraw();
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) panBy(dx, dy);
      else rotateBy(dx * 0.008, dy * 0.008);
      redraw();
    });
    const end = (e) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
      if (touches.size === 0) { drag = null; interactive = false; redraw(); }
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      zoomBy(Math.exp(Math.sign(e.deltaY) * 0.1));
      redraw();
    }, { passive: false });

    return {
      gl, scene, cam, mat, setVolume, setLut, addMesh, removeMeshes, setLines, render, redraw, frame, bounds, orient,
      volumeBounds: () => (scene.volume ? volumeBounds() : null),
      rotateBy, opts,
      setInteractive(v) { interactive = v; },
    };
  }

  Med.gl3d = { create, mat };
})();
