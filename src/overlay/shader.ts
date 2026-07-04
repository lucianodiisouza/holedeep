// Black hole fragment shader — WebGL2 port of blackhole.glsl from
// https://github.com/s0xDk/ghostty-blackhole (MIT, © 2026 s13k <s13k@pm.me>),
// itself after Eric Bruneton's "Real-time High-Quality Rendering of
// Non-Rotating Black Holes". Each pixel's null geodesic is integrated
// numerically — the Binet-form photon acceleration a = -(3/2) h² x / r⁵
// reproduces exact Schwarzschild bending, so the shadow, lensing, photon
// ring and disk all fall out of the physics rather than being painted on.
//
// Changes from the original: the terminal framebuffer becomes a desktop
// screenshot (uScreen), and the stateless wall-clock/cursor-color size modes
// are replaced by real uniforms (uIntensity from the Rust timer). The
// physics core is untouched.

export const VERT = `#version 300 es
void main() {
  // fullscreen triangle from gl_VertexID, no buffers needed
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const FRAG = `#version 300 es
precision highp float;

uniform sampler2D uScreen;     // frozen desktop, rows top-down
uniform vec2  uResolution;     // canvas pixels
uniform float uTime;           // seconds since overlay load (drift/disk animation)
uniform float uIntensity;      // 0..1 master intensity, driven by the timer
uniform float uHoleRadius;     // shadow radius at full intensity, fraction of screen height
uniform float uHasScreen;      // 0 = capture failed, render over deep space
uniform float uSwapBGR;        // 1 = texture is BGRA (live capture frames)

out vec4 fragColor;

// ---------------------------------------------------------------- tunables --
const float LENS_DEPTH    = 13.0;    // hole to "sky" plane distance, r_s — bigger = harder bending
const float STAR_GAIN     = 0.3;     // lensed starfield brightness around the hole
const float DISK_INNER    = 1.8;     // inner edge, r_s
const float DISK_OUTER    = 8.0;     // outer edge, r_s
const float DISK_INCL     = 1.5;     // inclination, rad: 0 face-on, 1.57 edge-on
const float DISK_ROLL     = 0.35;    // screen-plane rotation of the system, rad
const float DISK_GAIN     = 2.2;     // disk emission brightness
const float DISK_OPACITY  = 0.9;     // near disk hides what's behind it (0..1)
const float DISK_TEMP     = 5500.0;  // hottest annulus, Kelvin
const float DOPPLER_MIX   = 0.6;     // relativistic color/brightness asymmetry
const float DISK_BEAM     = 2.5;     // beaming exponent: intensity ~ g^N
const float DISK_SPEED    = 5.0;     // streak speed; negative reverses orbit
const float DISK_WIND     = 7.0;     // spiral winding tightness
const float DISK_CONTRAST = 1.6;     // streak contrast
const float EXPOSURE      = 1.4;     // tonemap exposure for disk light
const float DRIFT_SPEED   = 1.0;     // how fast the hole floats around
const float DILATION_MIN  = 0.2;     // disk time rate at full intensity

// geodesic integration steps per pixel (only pixels near the hole pay this)
#define N_STEPS 48

// critical impact parameter of a Schwarzschild hole, in r_s: rays under this
// fall in; it is the apparent (shadow) radius seen from far away
#define B_CRIT 2.5980762

// ------------------------------------------------------------------- noise --
float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

// value noise whose y lattice wraps every perY cells — used for the disk's
// angular dimension so the streaks tile seamlessly across the atan branch cut
float vnoiseWrapY(vec2 p, float perY) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float y0 = mod(i.y, perY), y1 = mod(i.y + 1.0, perY);
  return mix(mix(hash21(vec2(i.x, y0)),       hash21(vec2(i.x + 1.0, y0)), f.x),
             mix(hash21(vec2(i.x, y1)),       hash21(vec2(i.x + 1.0, y1)), f.x),
             f.y);
}

// mirrored repeat keeps lensed samples on-screen without edge smearing
vec2 mirrorUV(vec2 u) { return 1.0 - abs(1.0 - mod(u, 2.0)); }

vec2 rot(vec2 v, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}

// the desktop (frozen shot or live frame), or deep space when capture failed
vec3 screenTex(vec2 suv) {
  if (uHasScreen < 0.5) return vec3(0.015, 0.016, 0.03);
  vec3 c = texture(uScreen, suv).rgb;
  return uSwapBGR > 0.5 ? c.bgr : c;
}

// blackbody color from temperature in Kelvin (Tanner Helland fit, normalized)
vec3 blackbody(float T) {
  float t = clamp(T, 1500.0, 40000.0) / 100.0;
  float r = t <= 66.0 ? 1.0
                      : clamp(1.292936 * pow(t - 60.0, -0.1332047), 0.0, 1.0);
  float g = t <= 66.0 ? clamp(0.3900816 * log(t) - 0.6318414, 0.0, 1.0)
                      : clamp(1.1298909 * pow(t - 60.0, -0.0755148), 0.0, 1.0);
  float b = t >= 66.0 ? 1.0
                      : (t <= 19.0 ? 0.0
                                   : clamp(0.5432068 * log(t - 10.0) - 1.1962540, 0.0, 1.0));
  return vec3(r, g, b);
}

// sparse procedural starfield indexed by ray direction — because it is
// sampled with the *bent* ray, stars smear into arcs around the hole for free
vec3 stars(vec3 d) {
  vec2 sph = vec2(atan(d.x, -d.z), asin(clamp(d.y, -1.0, 1.0)));
  vec2 g   = sph * 40.0;
  vec2 id  = floor(g);
  float h  = hash21(id);
  if (h < 0.92) return vec3(0.0);
  vec2 f   = fract(g) - 0.5;
  vec2 off = (vec2(hash21(id + 17.3), hash21(id + 31.7)) - 0.5) * 0.7;
  float spark = smoothstep(0.10, 0.0, length(f - off));
  float tw    = 0.7 + 0.3 * sin(uTime * (0.5 + 2.0 * hash21(id + 5.1)) + 40.0 * h);
  vec3 tint   = mix(vec3(1.0, 0.82, 0.60), vec3(0.75, 0.85, 1.0), hash21(id + 2.9));
  return tint * spark * tw * ((h - 0.92) / 0.08);
}

// ------------------------------------------------------------------- image --
void main() {
  vec2  res    = uResolution;
  // y-down uv so uv.y = 0 is the top row of the screenshot texture
  vec2  uv     = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y) / res;
  float aspect = res.x / res.y;

  float t = uTime * DRIFT_SPEED;

  // disk extent in r_s, sanitized: the inner edge stays outside the photon
  // sphere (1.5 r_s) where circular orbits stop making sense
  float rin  = max(DISK_INNER, 1.6);
  float rout = max(DISK_OUTER, rin + 0.5);

  // master intensity comes from the real timer instead of a wall-clock hack
  float I  = clamp(uIntensity, 0.0, 1.0);
  float sz = mix(0.22, 1.0, I);

  // lazy Lissajous drift, confined so the hole and its disk stay on screen;
  // bounds adapt to size, drift follows intensity: small calm hole hovers,
  // a big one roams wide (amplitude, not frequency — FM would jerk the phase)
  float ext = (rout / B_CRIT) * uHoleRadius * sz;
  float yLo = 0.10 + ext;
  float yHi = max(yLo, 0.90 - ext);
  float spd = mix(0.35, 1.0, I);
  vec2 center = vec2(
      0.5 + (0.24 * sin(t * 0.21) + 0.05 * sin(t * 0.083)) * spd,
      1.0 - mix(yLo, yHi, 0.5 + (0.42 * sin(t * 0.157 + 2.0) + 0.08 * sin(t * 0.117)) * spd));
  center += I * vec2(0.040 * sin(t * 0.83) + 0.020 * sin(t * 1.31),
                     0.030 * sin(t * 1.03 + 1.0));

  float vis = smoothstep(0.0, 0.10, I);  // hole vanishes entirely at rest
  if (vis <= 0.0) {
    fragColor = vec4(screenTex(uv), 1.0);
    return;
  }
  float rh = uHoleRadius * sz;           // shadow radius in screen units

  // gravitational time dilation theme: the disk winds down as the hole grows
  float dil = mix(1.0, DILATION_MIN, I);

  // aspect-corrected frame centered on the hole (y in units of screen height)
  vec2  p    = (uv - center) * vec2(aspect, 1.0);
  float plen = length(p);

  // screen <-> world mapping: the shadow's true angular size is B_CRIT r_s,
  // and we want it rh screen units wide, so 1 screen unit = W Schwarzschild
  // radii. pr is the pixel in world units, y-up, with the system roll applied.
  float W  = B_CRIT / max(rh, 1e-4);
  vec2  pr = rot(vec2(p.x, -p.y), DISK_ROLL) * W;
  float b  = length(pr);              // the ray's impact parameter, in r_s

  // distance-window: real lensing falls off as 1/b and would shimmer content
  // across the whole screen as the hole drifts; fade it out a few disk
  // diameters away (deliberately unphysical)
  float window = exp(-pow(plen / (7.0 * rh), 2.0));

  float bmax = rout + 3.0;            // rays beyond this can't touch the disk
  float Z0   = max(14.0, rout + 5.0); // camera distance (shared with the tracer)

  // ================= far field: analytic weak deflection ==================
  // Finite-camera weak-field fit, matched against the integrator so there is
  // no visible displacement seam at the handoff radius b = bmax.
  if (b >= bmax) {
    float u    = Z0 * inversesqrt(Z0 * Z0 + b * b);
    float defl = (2.0 / (W * W)) / max(plen, 1e-4)
               * (1.29 * u + 0.07) * max(LENS_DEPTH - 2.14 * u + 0.75, 0.0)
               * window * vis;
    vec2  dir  = p / max(plen, 1e-5);
    vec3  term;
    // mild chromatic aberration: blue bends a touch more than red; faded
    // in away from the handoff circle (the geodesic side has none)
    float ab = 0.035 * smoothstep(1.0, 2.0, b / bmax);
    for (int i = 0; i < 3; i++) {
      float k   = 1.0 + (float(i) - 1.0) * ab;
      vec2  sp  = p - dir * defl * k;
      vec2  suv = mirrorUV(center + sp / vec2(aspect, 1.0));
      term[i]   = screenTex(suv)[i];
    }
    // same starfield as the geodesic region, lit through the weak-field
    // bend so stars don't pop at the boundary circle
    vec3 d = normalize(vec3(-(pr / b) * (2.0 / b), -1.0));
    fragColor = vec4(term + stars(d) * STAR_GAIN * window * vis, 1.0);
    return;
  }

  // ====================== near field: trace the geodesic ==================
  // Parallel rays from a distant camera at +z. The hole is at the origin,
  // r_s = 1. Integrate  x'' = -(3/2) h² x / r⁵  (exact Schwarzschild photon
  // bending; h = |x×v| is conserved, so it's computed once).
  vec3  x  = vec3(pr, Z0);
  vec3  v  = vec3(0.0, 0.0, -1.0);
  float h2 = dot(pr, pr);

  // disk plane: normal tilted DISK_INCL about the screen x-axis
  float ci = cos(DISK_INCL), si = sin(DISK_INCL);
  vec3  n  = vec3(0.0, si, ci);
  vec3  e2 = vec3(0.0, ci, -si);      // in-plane axis completing the frame
  float sdir = DISK_SPEED < 0.0 ? -1.0 : 1.0;
  float spdD = abs(DISK_SPEED);

  vec3  emitc = vec3(0.0);            // accumulated disk light (HDR)
  float trans = 1.0;                  // transmittance toward the background
  bool  captured = false;
  float sPrev = dot(x, n);
  vec3  xPrev = x;

  for (int i = 0; i < N_STEPS; i++) {
    float r2 = dot(x, x);
    if (r2 < 1.0) { captured = true; break; }        // through the horizon
    if (x.z < -Z0 && v.z < 0.0) break;               // escaped out the back
    if (r2 > 4.0 * Z0 * Z0) break;                   // flung far sideways
    float r  = sqrt(r2);
    // step scales with radius: fine near the photon sphere, coarse far out
    float dt = clamp(0.16 * r, 0.03, 1.5);
    // leapfrog (kick-drift-kick) keeps the near-critical orbits stable
    vec3 a = -1.5 * h2 * x / (r2 * r2 * r);
    v += a * (0.5 * dt);
    x += v * dt;
    r2 = dot(x, x);
    r  = sqrt(r2);
    a  = -1.5 * h2 * x / (r2 * r2 * r);
    v += a * (0.5 * dt);

    // ---- thin-disk crossing: the ray pierced the disk plane ----
    float s = dot(x, n);
    if (s * sPrev < 0.0 && trans > 0.02) {
      float tc = sPrev / (sPrev - s);
      vec3  xc = mix(xPrev, x, tc);
      float rc = length(xc);
      if (rc > rin && rc < rout) {
        float band = smoothstep(rin, rin * 1.25, rc)
                   * (1.0 - smoothstep(rout * 0.70, rout, rc));

        // disk-plane polar coords for the streak texture
        float phi   = atan(dot(xc, e2), xc.x);
        float turns = phi / 6.2831853;
        float kep   = pow(rin / rc, 1.5);
        // √(1 − 1.5/r): time runs slower for the inner orbits; dil winds
        // the whole disk down as the hole grows
        float gloc  = sqrt(max(1.0 - 1.5 / rc, 0.02));
        float swirl = rc * DISK_WIND * 0.12 - t * kep * spdD * gloc * dil * sdir;
        float streaks = vnoiseWrapY(vec2(rc * 2.8, turns * 19.0 + swirl * 3.0), 19.0) * 0.65 +
                        vnoiseWrapY(vec2(rc * 1.0, turns * 9.0  + swirl * 1.5 + 7.0), 9.0) * 0.35;
        streaks = 0.35 + DISK_CONTRAST * streaks * streaks;

        // relativistic Doppler + gravitational shift for gas on a circular
        // geodesic: g = √(1 − 1.5/r) / (1 − β·k̂)
        vec3  gasdir = normalize(cross(n, xc)) * sdir;
        float beta   = clamp(inversesqrt(max(2.0 * (rc - 1.0), 0.2)), 0.0, 0.99);
        float g      = gloc / max(1.0 + beta * dot(gasdir, normalize(v)), 0.05);
        g = mix(1.0, g, DOPPLER_MIX);

        // Shakura–Sunyaev temperature profile, peak normalized to 1
        float xpr   = max(1.0 - sqrt(rin / rc), 0.0);
        float tprof = pow(rin / rc, 0.75) * pow(xpr, 0.25) / 0.488;
        vec3  cbb   = blackbody(DISK_TEMP * tprof * g);   // doppler-shifted color
        float boost = pow(g, DISK_BEAM);                  // relativistic beaming

        float density = band * streaks;
        emitc += trans * cbb * (DISK_GAIN * 2.2 * density * tprof * tprof * boost);
        trans *= 1.0 - clamp(DISK_OPACITY * density, 0.0, 1.0);
      }
    }
    sPrev = s;
    xPrev = x;
  }
  // rays still wound up near the photon sphere when the budget ran out are
  // as good as captured
  if (!captured && dot(x, x) < 4.0) captured = true;

  // ---- background: where did the escaped ray come from? ----
  vec3 bg = vec3(0.0);
  if (!captured) {
    vec3 d = normalize(v);
    bg += stars(d) * STAR_GAIN * window * vis;
    if (d.z < -0.05) {
      // project the straight exit ray onto the desktop sky plane at
      // z = -LENS_DEPTH and map back to screen space
      float tpl = (-LENS_DEPTH - x.z) / d.z;
      vec3  hp  = x + d * tpl;
      vec2  q   = rot(hp.xy, -DISK_ROLL) / W;
      vec2  sp  = vec2(q.x, -q.y);
      // the *displacement* is faded by window/vis, never the color — a
      // continuous warp leaves no seam at the far-field boundary
      vec2  suv = mirrorUV(center + (p + (sp - p) * window * vis) / vec2(aspect, 1.0));
      // rays bent past ~90° never reach the sky plane behind the hole;
      // they fade to the starfield instead of sampling garbage
      float toward = smoothstep(0.05, 0.35, -d.z);
      bg += screenTex(suv) * toward;
    }
  }

  // disk light is HDR; tonemap it on top of the untouched desktop sample
  vec3 col = bg * trans + (vec3(1.0) - exp(-emitc * EXPOSURE));
  fragColor = vec4(col, 1.0);
}
`;
