/* Color Grading: grade a video on this device and export it.
 *
 * Everything runs in the browser. The file is read from the device, every
 * frame is graded on the GPU and the result is written to this site's private
 * on-device storage (OPFS). Nothing is uploaded anywhere.
 *
 * Pipeline per output frame (all in floating point on the GPU):
 *   decode    the decoder's own planes (8/10/12-bit YCbCr) -> R'G'B' with the
 *             file's matrix and range -> linear light in its primaries ->
 *             BT.709 -> the working space (below). Rotation is baked in here.
 *   resample  Lanczos-3, horizontal then vertical, in linear light, to 1080p
 *             (the short side), cropping a few pixels at most to keep the
 *             aspect ratio exact ("cover").
 *   grade     the preset: white balance, exposure, tone, HSL mix, vibrance /
 *             saturation, colour grading wheels, vignette, grain.
 *   pack      -> YCbCr 4:2:0 with proper chroma siting and dithering:
 *             SDR  BT.709, 8-bit limited range
 *             HDR  BT.2020 HLG, 10-bit limited range (BT.2100, 1000-nit OOTF)
 *             read back from the GPU and handed to the HEVC encoder as
 *             I420 / I420P10, so no browser colour conversion touches it.
 *
 * Working space: display-referred, encoded with the BT.1886 2.4 gamma,
 * 1.0 = SDR reference white (203 nits for HDR, per BT.2408). Its primaries are
 * BT.709 for SDR exports and BT.2020 for HDR exports, so wide-gamut HDR
 * colours are graded intact instead of being clipped into the SDR gamut.
 * Values above 1.0 are HDR highlights.
 *
 * Output frame rate is exactly 30 fps by frame sampling: each output frame
 * uses the source frame nearest in time (60 fps keeps every other frame,
 * 24 fps repeats some). Audio packets are copied untouched when the codec
 * belongs in an MP4 that Apple devices play; otherwise re-encoded to AAC 320.
 *
 * The grade follows how each Premiere Mobile slider behaves; Adobe doesn't
 * publish its formulas, so the look is close to Premiere, not pixel-identical.
 */

export const OUT = {
  shortSide: 1080,
  fps: 30,
  bitrate: 20e6,            // HEVC ~20 Mbps ("High")
  h264Bitrate: 24e6,        // only if the person chooses H.264 because HEVC can't be encoded
  keyFrameInterval: 2,
  audioReencodeBitrate: 320e3,
  sdrWhiteNits: 203,        // BT.2408 reference white for HDR <-> SDR
  hlgPeakNits: 1000         // BT.2100 HLG nominal peak (OOTF gamma 1.2)
};

// Audio that is copied as-is: codecs an MP4 carries and Apple devices play.
const COPY_AUDIO = ["aac", "mp3", "ac3", "eac3"];

const MEDIABUNNY = "./vendor/mediabunny-1.61.6.min.js";
let MB = null;
async function lib() { return MB || (MB = await import(MEDIABUNNY)); }

// =====================================================================
// Pure helpers (no browser APIs; tested in Node by test-tools.js)
// =====================================================================

// 1080p for any aspect ratio: short side 1080, long side rounded to a
// multiple of 8 (needed for 4:2:0 and the packing below).
export function outputSize(dispW, dispH) {
  const S = OUT.shortSide, portrait = dispH > dispW;
  const ratio = Math.max(dispW, dispH) / Math.min(dispW, dispH);
  const long = Math.max(S, Math.round(S * ratio / 8) * 8);
  return portrait ? { w: S, h: long } : { w: long, h: S };
}

// "Cover": scale so the output is filled, then centre-crop the rest. Works in
// square-pixel units; returns source-pixel crop and per-axis scale.
export function coverCrop(srcW, srcH, sqW, sqH, dstW, dstH) {
  const s = Math.max(dstW / sqW, dstH / sqH);
  const fx = srcW / sqW, fy = srcH / sqH;
  const cw = dstW / s * fx, ch = dstH / s * fy;
  return { x: (srcW - cw) / 2, y: (srcH - ch) / 2, w: cw, h: ch, sx: dstW / cw, sy: dstH / ch };
}

// Frame sampling to a fixed rate: which source frame each output frame uses.
// `Sampler` is fed source timestamps in order and calls emit(k) for every
// output frame k whose time is nearest to the previous source frame.
export class Sampler {
  constructor(t0, count, fps) { this.t0 = t0; this.n = count; this.fps = fps; this.k = 0; this.prev = null; }
  // Feed the next source frame's timestamp. Returns the output indices the
  // *previous* frame covers (empty for the first call).
  push(ts) {
    const out = [];
    if (this.prev !== null) {
      const boundary = (this.prev + ts) / 2;
      while (this.k < this.n && this.t0 + this.k / this.fps < boundary - 1e-9) out.push(this.k++);
    }
    this.prev = ts;
    return out;
  }
  // After the last source frame: the remaining output frames use it.
  finish() { const out = []; while (this.k < this.n) out.push(this.k++); return out; }
}
export function assignFrames(timestamps, t0, count, fps) {
  const s = new Sampler(t0, count, fps), map = new Array(count);
  timestamps.forEach((ts, i) => { s.push(ts).forEach(k => { map[k] = i - 1; }); });
  s.finish().forEach(k => { map[k] = timestamps.length - 1; });
  return map;
}

// HEVC level for the picture size at 30 fps (4.1 up to 2.2 MP, else 5.1).
export function hevcCodecString(w, h, tenBit) {
  const level = w * h <= 2228224 ? "L123" : "L153";
  return tenBit ? "hvc1.2.4." + level + ".B0" : "hvc1.1.6." + level + ".B0";
}

export function audioPlan(codec) {
  if (!codec) return { mode: "none" };
  return COPY_AUDIO.indexOf(codec) >= 0 ? { mode: "copy", codec: codec } : { mode: "aac", from: codec };
}

// Preset (as defined in grade.html) -> the numbers the shader needs.
// Sliders are -100..100 (or 0..100) and become -1..1 (0..1); Exposure stays
// in stops. Anything not specified is neutral.
export function gradeParams(p, opts) {
  const n = v => (v == null ? 0 : v);
  const L = (p && p.light) || {}, C = (p && p.color) || {}, V = (p && p.vignette) || {}, G = (p && p.grain) || {};
  const CH = ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"];
  const mix = [];
  CH.forEach(c => { const r = (p && p.mix && p.mix[c]) || [0, 0, 0]; mix.push(n(r[0]) / 100, n(r[1]) / 100, n(r[2]) / 100); });
  const wheels = [];
  ["Shadows", "Midtones", "Highlights", "Global"].forEach(w => {
    const g = p && p.grading && p.grading[w];
    wheels.push(g ? n(g[0]) : 0, g ? n(g[1]) / 100 : 0, g ? n(g[2]) / 100 : 0, g ? 1 : 0);
  });
  const vigOn = !(opts && opts.vignette === false);
  return {
    exposure: n(L.Exposure), contrast: n(L.Contrast) / 100, highlights: n(L.Highlights) / 100,
    shadows: n(L.Shadows) / 100, whites: n(L.Whites) / 100, blacks: n(L.Blacks) / 100,
    temp: n(C.Temperature) / 100, tint: n(C.Tint) / 100, vibrance: n(C.Vibrance) / 100, saturation: n(C.Saturation) / 100,
    mix: mix, wheels: wheels,
    vignette: vigOn ? [n(V.Vignette) / 100, (V.Midpoint == null ? 50 : V.Midpoint) / 100,
                       n(V.Roundness) / 100, (V.Feather == null ? 50 : V.Feather) / 100] : [0, 0.5, 0, 0.5],
    vigHighlights: vigOn ? n(V.Highlights) / 100 : 0,
    grain: [n(G.Grain) / 100, (G.Size == null ? 25 : G.Size) / 100, (G.Roughness == null ? 50 : G.Roughness) / 100]
  };
}
export const NEUTRAL = gradeParams(null);

// =====================================================================
// Colour science constants
// =====================================================================
// YCbCr matrices (Kr, Kb).
const MATRIX = { bt709: [0.2126, 0.0722], bt470bg: [0.299, 0.114], smpte170m: [0.299, 0.114], "bt2020-ncl": [0.2627, 0.0593] };
// RGB -> XYZ for each set of primaries (D65), used to build conversions to BT.709.
function rgbToXyz(xr, yr, xg, yg, xb, yb) {
  const xw = 0.3127, yw = 0.3290;
  const X = (x, y) => [x / y, 1, (1 - x - y) / y];
  const R = X(xr, yr), Gp = X(xg, yg), B = X(xb, yb), W = X(xw, yw);
  const m = [[R[0], Gp[0], B[0]], [R[1], Gp[1], B[1]], [R[2], Gp[2], B[2]]];
  const S = solve3(m, W);
  return m.map(row => row.map((v, i) => v * S[i]));
}
function solve3(m, v) { const inv = inv3(m); return [0, 1, 2].map(i => inv[i][0] * v[0] + inv[i][1] * v[1] + inv[i][2] * v[2]); }
function inv3(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
          [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
          [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
function mul3(a, b) { return a.map(r => [0, 1, 2].map(j => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j])); }
const PRIM = {
  bt709: rgbToXyz(0.64, 0.33, 0.30, 0.60, 0.15, 0.06),
  bt2020: rgbToXyz(0.708, 0.292, 0.170, 0.797, 0.131, 0.046),
  smpte170m: rgbToXyz(0.630, 0.340, 0.310, 0.595, 0.155, 0.070),
  bt470bg: rgbToXyz(0.64, 0.33, 0.29, 0.60, 0.15, 0.06),
  smpte432: rgbToXyz(0.680, 0.320, 0.265, 0.690, 0.150, 0.060)
};
export function primariesTo(name, work) { return mul3(inv3(PRIM[work || "bt709"]), PRIM[name] || PRIM.bt709); }
export function primariesTo709(name) { return primariesTo(name, "bt709"); }
const M2020_TO_709 = primariesTo("bt2020", "bt709");
const LUMA = { bt709: [0.2126, 0.7152, 0.0722], bt2020: [0.2627, 0.6780, 0.0593] };
const glMat3 = m => new Float32Array([m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]]); // column-major

// =====================================================================
// GPU renderer
// =====================================================================
const VS = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

const COMMON = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
vec3 toLin(vec3 v) { return sign(v) * pow(abs(v), vec3(2.4)); }
vec3 toGam(vec3 l) { return sign(l) * pow(abs(l), vec3(1.0 / 2.4)); }
float luma709(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float luma2020(vec3 c) { return dot(c, vec3(0.2627, 0.6780, 0.0593)); }
// HLG (BT.2100)
const float HA = 0.17883277, HB = 0.28466892, HC = 0.55991073;
vec3 hlgInvOetf(vec3 e) { vec3 lo = e * e / 3.0, hi = (exp((e - HC) / HA) + HB) / 12.0; return mix(lo, hi, step(vec3(0.5), e)); }
vec3 hlgOetf(vec3 E) { E = max(E, 0.0); vec3 lo = sqrt(3.0 * E), hi = HA * log(max(12.0 * E - HB, 1e-6)) + HC; return mix(lo, hi, step(vec3(1.0 / 12.0), E)); }
// PQ (SMPTE ST 2084) -> nits
vec3 pqEotf(vec3 e) {
  const float m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
  vec3 p = pow(max(e, 0.0), vec3(1.0 / m2));
  return 10000.0 * pow(max(p - c1, 0.0) / (c2 - c3 * p), vec3(1.0 / m1));
}
// Extended Reinhard shoulder: identity below the knee, maps peak -> 1.
float shoulder(float x, float knee, float peak) {
  if (x <= knee) return x;
  float u = (x - knee) / (1.0 - knee), P = max((peak - knee) / (1.0 - knee), 1e-3);
  return knee + (1.0 - knee) * u * (1.0 + u / (P * P)) / (1.0 + u);
}
// Bring linear BT.709 into 0..1 without hue shifts: compress luminance with a
// shoulder, then pull out-of-range channels toward grey.
vec3 fitSdr(vec3 lin, float peak) {
  float Y = max(luma709(lin), 0.0);
  float Yt = peak > 1.0 ? shoulder(Y, 0.6, peak) : min(Y, 1.0);
  vec3 c = Y > 1e-6 ? lin * (Yt / Y) : vec3(Yt);
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), s = 1.0;
  if (mx > 1.0) s = min(s, (1.0 - Yt) / max(mx - Yt, 1e-6));
  if (mn < 0.0) s = min(s, Yt / max(Yt - mn, 1e-6));
  return clamp(Yt + (c - Yt) * s, 0.0, 1.0);
}
uint hashu(uvec3 v) { v = v * 1664525u + 1013904223u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; v ^= v >> 16u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; return v.x ^ v.y ^ v.z; }
float hash01(uvec3 v) { return float(hashu(v) & 0x00FFFFFFu) / 16777216.0; }
`;

// --- decode: YCbCr planes (any bit depth / subsampling / NV12) or RGBA --------
const FS_DECODE = COMMON + `
uniform usampler2D uY, uU, uV;     // planar; for NV12 uU holds interleaved CbCr (RG)
uniform sampler2D uRGBA;           // RGBA path (opaque frames)
uniform int uMode;                 // 0 planar, 1 nv12, 2 rgba, 3 bgra
uniform ivec2 uSub;                // chroma subsampling (1 or 2) x, y
uniform float uMaxCode;            // 255, 1023, 4095
uniform vec4 uRange;               // yOff, yScale, cOff, cScale (in code values)
uniform vec2 uK;                   // Kr, Kb
uniform int uTransfer;             // 0 gamma (SDR), 1 HLG, 2 PQ, 3 linear
uniform mat3 uToWork;              // source linear primaries -> working primaries (linear)
uniform int uPrimariesSame;        // 1 = SDR BT.709 into a BT.709 working space: nothing to convert
uniform float uSdrWhite;           // nits that map to 1.0 (HDR sources)
uniform int uToneMap;              // 1 = squeeze HDR into SDR here (SDR export)
uniform float uPeak;               // HDR peak / SDR white
uniform ivec4 uRect;               // visible rect in the coded frame
uniform int uRot;                  // 0, 90, 180, 270 (clockwise)
out vec4 o;
float fetchC(usampler2D t, int comp, vec2 c, ivec2 size) {
  vec2 f = floor(c); vec2 w = c - f; ivec2 i0 = ivec2(f), mx = size - 1;
  ivec2 a = clamp(i0, ivec2(0), mx), b = clamp(i0 + ivec2(1, 0), ivec2(0), mx), cc = clamp(i0 + ivec2(0, 1), ivec2(0), mx), d = clamp(i0 + ivec2(1, 1), ivec2(0), mx);
  float va = float(texelFetch(t, a, 0)[comp]), vb = float(texelFetch(t, b, 0)[comp]), vc = float(texelFetch(t, cc, 0)[comp]), vd = float(texelFetch(t, d, 0)[comp]);
  return mix(mix(va, vb, w.x), mix(vc, vd, w.x), w.y);
}
void main() {
  ivec2 o2 = ivec2(gl_FragCoord.xy);
  int W = uRect.z, H = uRect.w; ivec2 s;
  if (uRot == 90) s = ivec2(o2.y, H - 1 - o2.x);
  else if (uRot == 180) s = ivec2(W - 1 - o2.x, H - 1 - o2.y);
  else if (uRot == 270) s = ivec2(W - 1 - o2.y, o2.x);
  else s = o2;
  s += uRect.xy;
  vec3 rgb;
  if (uMode >= 2) {
    vec4 t = texelFetch(uRGBA, s, 0);
    rgb = uMode == 3 ? t.bgr : t.rgb;
  } else {
    float Y = float(texelFetch(uY, s, 0).r);
    // Chroma siting: horizontally co-sited with the left luma sample, vertically centred.
    vec2 cpos = vec2(float(s.x) / float(uSub.x), (float(s.y) + 0.5) / float(uSub.y) - 0.5);
    if (uSub.y == 1) cpos.y = float(s.y);
    ivec2 cs = textureSize(uU, 0);
    float Cb, Cr;
    if (uMode == 1) { Cb = fetchC(uU, 0, cpos, cs); Cr = fetchC(uU, 1, cpos, cs); }
    else { Cb = fetchC(uU, 0, cpos, cs); Cr = fetchC(uV, 0, cpos, textureSize(uV, 0)); }
    float y = (Y - uRange.x) / uRange.y, cb = (Cb - uRange.z) / uRange.w, cr = (Cr - uRange.z) / uRange.w;
    float Kr = uK.x, Kb = uK.y, Kg = 1.0 - Kr - Kb;
    float R = y + 2.0 * (1.0 - Kr) * cr, B = y + 2.0 * (1.0 - Kb) * cb;
    rgb = vec3(R, (y - Kr * R - Kb * B) / Kg, B);
  }
  vec3 lin;  // linear, source primaries, 1.0 = SDR white
  if (uTransfer == 1) {
    vec3 E = hlgInvOetf(clamp(rgb, 0.0, 1.0));
    float Ys = luma2020(E);
    lin = 1000.0 * pow(max(Ys, 1e-6), 0.2) * E / uSdrWhite;   // HLG OOTF for a 1000-nit display
  } else if (uTransfer == 2) {
    lin = pqEotf(clamp(rgb, 0.0, 1.0)) / uSdrWhite;
  } else if (uTransfer == 3) {
    lin = rgb;
  } else {
    if (uPrimariesSame == 1) { o = vec4(clamp(rgb, 0.0, 1.0), 1.0); return; }
    lin = toLin(clamp(rgb, 0.0, 1.0));
  }
  if (uPrimariesSame == 0) lin = uToWork * lin;
  if (uToneMap == 1) lin = fitSdr(lin, uPeak);   // only ever into a BT.709 working space
  o = vec4(toGam(lin), 1.0);
}`;

// --- Lanczos-3, one axis, in linear light -----------------------------------
const FS_RESAMPLE = COMMON + `
uniform sampler2D uSrc;
uniform int uAxis;          // 0 horizontal, 1 vertical
uniform float uScale;       // dst / src along the axis
uniform float uOffset;      // crop start in source pixels
uniform int uLen;           // source length along the axis
out vec4 o;
float sinc(float x) { if (abs(x) < 1e-5) return 1.0; float p = 3.14159265358979 * x; return sin(p) / p; }
float lanczos3(float x) { return abs(x) < 3.0 ? sinc(x) * sinc(x / 3.0) : 0.0; }
void main() {
  ivec2 d = ivec2(gl_FragCoord.xy);
  float od = uAxis == 0 ? float(d.x) : float(d.y);
  float center = uOffset + (od + 0.5) / uScale;          // in source pixel units
  float stretch = max(1.0, 1.0 / uScale);                // widen the kernel when shrinking (anti-aliasing)
  float support = 3.0 * stretch;
  int i0 = int(floor(center - support)), i1 = int(ceil(center + support));
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int i = i0; i <= i1; i++) {
    float w = lanczos3((float(i) + 0.5 - center) / stretch);
    if (w == 0.0) continue;
    int ic = clamp(i, 0, uLen - 1);
    ivec2 p = uAxis == 0 ? ivec2(ic, d.y) : ivec2(d.x, ic);
    acc += w * toLin(texelFetch(uSrc, p, 0).rgb);
    wsum += w;
  }
  vec3 lin = acc / wsum;
  o = vec4(toGam(max(lin, 0.0)), 1.0);   // Lanczos rings slightly; never below black
}`;

// --- the grade --------------------------------------------------------------
const FS_GRADE = COMMON + `
uniform sampler2D uIn;
uniform float uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks;
uniform float uTemp, uTint, uVibrance, uSaturation;
uniform vec3 uMix[8];
uniform vec4 uWheel[4];       // hue deg, sat, lum, on
uniform vec4 uVig;            // amount, midpoint, roundness, feather
uniform float uVigHi;
uniform vec3 uGrain;          // amount, size, roughness
uniform float uFrame;         // output frame number (grain moves every frame)
uniform vec2 uOutSize;        // the export's size (grain and vignette are laid out on it)
uniform float uCeil;          // 1.0 SDR, larger for HDR
uniform vec3 uLumaW;          // luminance weights of the working primaries
out vec4 o;
float lumaW(vec3 c) { return dot(c, uLumaW); }

const float CENT[8] = float[8](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0);
vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), l = (mx + mn) * 0.5, h = 0.0, s = 0.0;
  if (mx > mn) {
    float d = mx - mn; s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
    if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0; else h = (c.r - c.g) / d + 4.0;
    h *= 60.0;
  }
  return vec3(h, s, l);
}
float hue2(float p, float q, float t) { t = fract(t); if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t; if (t < 0.5) return q; if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0; return p; }
vec3 hsl2rgb(vec3 x) {
  float h = mod(x.x, 360.0) / 360.0, s = x.y, l = x.z;
  if (s <= 0.0) return vec3(l);
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s, p = 2.0 * l - q;
  return vec3(hue2(p, q, h + 1.0 / 3.0), hue2(p, q, h), hue2(p, q, h - 1.0 / 3.0));
}
float band(float h, int i) {
  float c = CENT[i], prev = CENT[(i + 7) % 8], next = CENT[(i + 1) % 8];
  float d = mod(h - c + 540.0, 360.0) - 180.0;
  float span = d < 0.0 ? mod(c - prev + 360.0, 360.0) : mod(next - c + 360.0, 360.0);
  if (span == 0.0) span = 360.0;
  return max(0.0, 1.0 - abs(d) / span);
}
float vnoise(vec2 p, uint seed) {   // smooth value noise for grain clumps
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  uvec3 b = uvec3(uvec2(ivec2(i) + 32768), seed);
  float a = hash01(b), bb = hash01(b + uvec3(1, 0, 0)), c = hash01(b + uvec3(0, 1, 0)), d = hash01(b + uvec3(1, 1, 0));
  return mix(mix(a, bb, f.x), mix(c, d, f.x), f.y);
}
void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 uv = px / vec2(textureSize(uIn, 0));          // 0..1 on this render
  vec3 v = texelFetch(uIn, ivec2(px), 0).rgb;

  // White balance and exposure, in linear light.
  vec3 lin = toLin(v);
  lin *= vec3(1.0 + 0.3 * uTemp, 1.0 - 0.18 * uTint, 1.0 - 0.3 * uTemp);
  lin *= exp2(uExposure);
  v = toGam(max(lin, 0.0));

  // Tone: Highlights / Shadows / Whites / Blacks on luminance, then Contrast
  // around mid-grey; colour ratios are kept so hues don't shift.
  float Y = lumaW(v), t = Y;
  t += uHighlights * 0.28 * smoothstep(0.45, 1.0, t);
  t += uShadows * 0.28 * (1.0 - smoothstep(0.0, 0.5, t));
  t += uWhites * 0.15 * smoothstep(0.65, 1.0, t);
  t += uBlacks * 0.15 * (1.0 - smoothstep(0.0, 0.3, t));
  t = clamp(t, 0.0, uCeil);
  t = clamp(0.5 + (t - 0.5) * (1.0 + uContrast * 0.9), 0.0, uCeil);
  v = Y > 1e-5 ? v * (t / Y) : vec3(t);
  v = clamp(v, 0.0, uCeil);

  // HSL mix per colour band, vibrance and saturation. Done on 0..1 values;
  // HDR highlights are scaled down and back up so they keep their brightness.
  float scale = max(1.0, max(v.r, max(v.g, v.b)));
  vec3 hsl = rgb2hsl(v / scale);
  if (hsl.y > 0.02) {
    vec3 dm = vec3(0.0);
    for (int i = 0; i < 8; i++) { float w = band(hsl.x, i); dm += w * uMix[i]; }
    hsl.x += dm.x * 30.0;
    hsl.y = clamp(hsl.y * (1.0 + dm.y), 0.0, 1.0);
    hsl.z = clamp(hsl.z + dm.z * 0.2 * min(1.0, hsl.y * 3.0), 0.0, 1.0);
  }
  hsl.y = clamp(hsl.y * (1.0 + uVibrance * (1.0 - hsl.y) * 1.2), 0.0, 1.0);
  hsl.y = clamp(hsl.y * (1.0 + uSaturation), 0.0, 1.0);
  v = hsl2rgb(hsl) * scale;

  // Colour grading wheels: tint shadows / midtones / highlights / everything.
  float Yl = lumaW(min(v, vec3(1.0)));
  float ms = 1.0 - smoothstep(0.0, 0.45, Yl), mh = smoothstep(0.5, 1.0, Yl), mm = max(0.0, 1.0 - ms - mh);
  float masks[4] = float[4](ms, mm, mh, 1.0);
  for (int i = 0; i < 4; i++) {
    vec4 w = uWheel[i];
    if (w.w < 0.5) continue;
    vec3 c = hsl2rgb(vec3(w.x, 1.0, 0.5)) - 0.5;
    v += (c * w.y * 0.35 + w.z * 0.12) * masks[i];
  }
  v = max(v, 0.0);

  // Vignette, laid out on the export frame. Roundness 0 follows the frame's
  // shape, +100 is a circle, -100 nearly a rectangle. Highlights protects
  // bright areas from darkening.
  if (uVig.x != 0.0) {
    vec2 q = (uv - 0.5) * 2.0;
    float aspect = uOutSize.x / uOutSize.y;
    if (uVig.z > 0.0) q.x *= mix(1.0, aspect, uVig.z);
    float nexp = 2.0 + max(0.0, -uVig.z) * 6.0;
    float r = pow(pow(abs(q.x), nexp) + pow(abs(q.y), nexp), 1.0 / nexp) / pow(2.0, 1.0 / nexp);
    float m = smoothstep(uVig.y, uVig.y + max(0.05, uVig.w * 0.8), r);
    float amt = uVig.x * 0.6 * m;
    if (amt < 0.0) amt *= 1.0 - uVigHi * smoothstep(0.6, 1.0, lumaW(min(v, vec3(1.0))));
    v *= 1.0 + amt;
  }

  // Film grain: clumpy noise sized on the export frame, new every frame,
  // strongest in the midtones like real film.
  if (uGrain.x > 0.0) {
    vec2 g = uv * uOutSize;
    float cell = 1.0 + uGrain.y * 3.0;
    uint seed = uint(uFrame) * 7919u + 17u;
    float n1 = vnoise(g / cell, seed) - 0.5;
    float n2 = vnoise(g / (cell * 0.5), seed + 101u) - 0.5;
    float n = mix(n1, (n1 + n2) * 0.7, uGrain.z) * 2.0;
    float Yg = lumaW(min(v, vec3(1.0)));
    v += n * uGrain.x * 0.09 * (0.35 + 2.6 * Yg * (1.0 - Yg));
  }
  o = vec4(max(v, 0.0), 1.0);
}`;

// --- to the screen (preview): SDR with dithering -----------------------------
const FS_DISPLAY = COMMON + `
uniform sampler2D uIn;
uniform float uPeak;   // > 1: the grade ran on HDR values, squeeze into SDR for viewing
uniform mat3 uToSdr;   // working primaries -> BT.709
out vec4 o;
void main() {
  ivec2 size = textureSize(uIn, 0);
  ivec2 p = ivec2(gl_FragCoord.xy); p.y = size.y - 1 - p.y;     // texture rows are top-down
  vec3 v = texelFetch(uIn, p, 0).rgb;
  v = toGam(fitSdr(uToSdr * toLin(v), uPeak));
  float d = hash01(uvec3(uvec2(p), 7u)) - hash01(uvec3(uvec2(p), 11u));
  o = vec4(clamp(v + d / 255.0, 0.0, 1.0), 1.0);
}`;

// --- pack YCbCr 4:2:0 into bytes ---------------------------------------------
// Each output RGBA8 pixel carries 4 samples (8-bit) or 2 little-endian samples
// (10-bit), so a readPixels gives the plane exactly as the encoder wants it.
const FS_PACK = COMMON + `
uniform sampler2D uIn;
uniform int uPlane;     // 0 Y, 1 Cb, 2 Cr
uniform int uHdr;       // 0 SDR BT.709 8-bit, 1 HLG BT.2020 10-bit
uniform float uSdrWhite, uPeakNits;
uniform float uFrame;
out vec4 o;
vec3 outRGB(ivec2 p) {   // R'G'B' as it will be encoded
  ivec2 size = textureSize(uIn, 0);
  vec3 v = texelFetch(uIn, clamp(p, ivec2(0), size - 1), 0).rgb;
  if (uHdr == 0) return toGam(fitSdr(toLin(v), 1.0));
  vec3 nits = toLin(v) * uSdrWhite;      // HDR work is already BT.2020
  // Roll highlights off from 75% of the peak so the brightest graded values
  // (up to 1.5x the peak) land on it smoothly instead of clipping.
  float x = luma2020(max(nits, 0.0)) / uPeakNits;
  if (x > 0.75) nits *= shoulder(x, 0.75, 1.5) / x;
  vec3 Fd = max(nits, 0.0) / uPeakNits;                    // 0..1 of the 1000-nit display
  float Yd = luma2020(Fd);
  vec3 Es = Yd > 1e-7 ? Fd * pow(Yd, (1.0 / 1.2) - 1.0) : Fd; // inverse HLG OOTF
  return hlgOetf(clamp(Es, 0.0, 1.0));
}
float code(float x, float off, float scale, float maxc, ivec2 p, uint salt) {
  float d = hash01(uvec3(uvec2(p), uint(uFrame) * 3u + salt)) - hash01(uvec3(uvec2(p), uint(uFrame) * 3u + salt + 1000u));
  return clamp(floor(off + x * scale + 0.5 + d * 0.5), 0.0, maxc);
}
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  int per = uHdr == 1 ? 2 : 4;
  float Kr = uHdr == 1 ? 0.2627 : 0.2126, Kb = uHdr == 1 ? 0.0593 : 0.0722, Kg = 1.0 - Kr - Kb;
  float maxc = uHdr == 1 ? 1023.0 : 255.0, mul = uHdr == 1 ? 4.0 : 1.0;
  float vals[4];
  for (int k = 0; k < 4; k++) {
    if (k >= per) { vals[k] = 0.0; continue; }
    int x = f.x * per + k;
    if (uPlane == 0) {
      vec3 c = outRGB(ivec2(x, f.y));
      vals[k] = code(dot(c, vec3(Kr, Kg, Kb)), 16.0 * mul, 219.0 * mul, maxc, ivec2(x, f.y), 1u);
    } else {
      // 4:2:0, chroma co-sited left: [1 2 1] across, two rows averaged.
      vec3 acc = vec3(0.0);
      for (int r = 0; r < 2; r++) {
        int y = f.y * 2 + r;
        acc += 0.25 * outRGB(ivec2(2 * x - 1, y)) + 0.5 * outRGB(ivec2(2 * x, y)) + 0.25 * outRGB(ivec2(2 * x + 1, y));
      }
      vec3 c = acc * 0.5;
      float Yp = dot(c, vec3(Kr, Kg, Kb));
      float C = uPlane == 1 ? (c.b - Yp) / (2.0 * (1.0 - Kb)) : (c.r - Yp) / (2.0 * (1.0 - Kr));
      vals[k] = code(C, 128.0 * mul, 224.0 * mul, maxc, ivec2(x, f.y), uint(uPlane) * 2u);
    }
  }
  if (uHdr == 1) {
    o = vec4(mod(vals[0], 256.0), floor(vals[0] / 256.0), mod(vals[1], 256.0), floor(vals[1] / 256.0)) / 255.0;
  } else {
    o = vec4(vals[0], vals[1], vals[2], vals[3]) / 255.0;
  }
}`;

export class Renderer {
  constructor() {
    const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(16, 16) : document.createElement("canvas");
    const gl = c.getContext("webgl2", { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("This browser can't run WebGL 2, which grading needs.");
    if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("This browser can't render to floating-point textures, which grading needs.");
    this.canvas = c; this.gl = gl;
    this.vao = gl.createVertexArray();
    this.progs = {
      decode: this.program(FS_DECODE), resample: this.program(FS_RESAMPLE), grade: this.program(FS_GRADE),
      display: this.program(FS_DISPLAY), pack: this.program(FS_PACK)
    };
    this.tex = {}; this.fbo = gl.createFramebuffer();
    this.planes = [gl.createTexture(), gl.createTexture(), gl.createTexture()];
    this.rgbaTex = gl.createTexture();
    this.dummyU = this.makeTex("dummyU", 1, 1, "u8");
    this.dummyF = this.makeTex("dummyF", 1, 1, "f16");
    this.pbo = gl.createBuffer();
  }
  program(fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("Shader: " + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("Program: " + gl.getProgramInfoLog(p));
    const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i), name = info.name.replace(/\[0\]$/, ""); u[name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }
  // Named render targets, reallocated only when the size changes.
  makeTex(name, w, h, kind) {
    const gl = this.gl;
    let t = this.tex[name];
    if (t && t.w === w && t.h === h && t.kind === kind) return t;
    if (t) gl.deleteTexture(t.t);
    const tx = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tx);
    if (kind === "f16") gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
    else if (kind === "rgba8") gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    else gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8UI, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    t = this.tex[name] = { t: tx, w, h, kind };
    return t;
  }
  pass(prog, target, setup) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.t, 0);
      gl.viewport(0, 0, target.w, target.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
    let unit = 0;
    const bind = (name, tex, isInt) => {
      if (prog.u[name] == null) return;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex || (isInt ? this.dummyU.t : this.dummyF.t));
      gl.uniform1i(prog.u[name], unit++);
    };
    setup(prog.u, bind);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Upload a decoded frame and convert it to the working space, rotated and
  // cropped to its visible rect. Returns the working texture.
  async decode(sample, colour, opts) {
    const gl = this.gl;
    const rot = ((sample.rotation || 0) % 360 + 360) % 360;
    const vr = sample.visibleRect || { left: 0, top: 0, width: sample.codedWidth, height: sample.codedHeight };
    const rw = rot === 90 || rot === 270 ? vr.height : vr.width, rh = rot === 90 || rot === 270 ? vr.width : vr.height;
    const out = this.makeTex("work", rw, rh, "f16");
    const fmt = sample.format;
    const planar = /^I4(20|22|44)(P10|P12)?$/.exec(fmt || "");
    let mode, sub = [1, 1], maxCode = 255;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (planar || fmt === "NV12") {
      const size = sample.allocationSize();
      const buf = new ArrayBuffer(size);
      const layout = await sample.copyTo(buf);
      const depth = planar && planar[2] ? (planar[2] === "P10" ? 10 : 12) : 8;
      maxCode = (1 << depth) - 1;
      const bps = depth > 8 ? 2 : 1;
      const W = sample.codedWidth, H = sample.codedHeight;
      if (fmt === "NV12" || (planar && planar[1] === "20")) sub = [2, 2]; else if (planar && planar[1] === "22") sub = [2, 1];
      const cw = Math.ceil(W / sub[0]), ch = Math.ceil(H / sub[1]);
      const up = (tex, i, w, h, comps) => {
        const L = layout[i];
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, L.stride / bps / comps);
        const view = bps === 2 ? new Uint16Array(buf, L.offset, (L.stride / 2) * (h - 1) + w * comps)
                               : new Uint8Array(buf, L.offset, L.stride * (h - 1) + w * comps);
        const ifmt = comps === 2 ? (bps === 2 ? gl.RG16UI : gl.RG8UI) : (bps === 2 ? gl.R16UI : gl.R8UI);
        gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, comps === 2 ? gl.RG_INTEGER : gl.RED_INTEGER, bps === 2 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_BYTE, view);
      };
      up(this.planes[0], 0, W, H, 1);
      if (fmt === "NV12") { up(this.planes[1], 1, cw, ch, 2); mode = 1; }
      else { up(this.planes[1], 1, cw, ch, 1); up(this.planes[2], 2, cw, ch, 1); mode = 0; }
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    } else {
      // Opaque or RGB frames: let the browser hand over RGBA (8-bit SDR).
      const frame = sample.toVideoFrame();
      gl.bindTexture(gl.TEXTURE_2D, this.rgbaTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      frame.close();
      mode = fmt === "BGRA" || fmt === "BGRX" ? 3 : 2;
    }
    // Code values for this bit depth: limited range is 16-235 / 16-240 scaled
    // up from 8-bit (64-940 / 64-960 at 10-bit); full range uses everything.
    const step = (maxCode + 1) / 256;
    const range = colour.fullRange ? [0, maxCode, (maxCode + 1) / 2, maxCode] : [16 * step, 219 * step, 128 * step, 224 * step];
    const rgbaPath = mode >= 2;
    const transfer = rgbaPath ? 0 : colour.transfer === "hlg" ? 1 : colour.transfer === "pq" ? 2 : colour.transfer === "linear" ? 3 : 0;
    const prim = rgbaPath ? "bt709" : colour.primaries;
    const work = opts.work || "bt709";
    this.pass(this.progs.decode, out, (u, bind) => {
      bind("uY", rgbaPath ? null : this.planes[0], true); bind("uU", rgbaPath ? null : this.planes[1], true); bind("uV", mode === 0 ? this.planes[2] : null, true);
      bind("uRGBA", rgbaPath ? this.rgbaTex : null, false);
      gl.uniform1i(u.uMode, mode);
      gl.uniform2i(u.uSub, sub[0], sub[1]);
      gl.uniform1f(u.uMaxCode, maxCode);
      gl.uniform4f(u.uRange, range[0], range[1], range[2], range[3]);
      const K = MATRIX[colour.matrix] || MATRIX.bt709;
      gl.uniform2f(u.uK, K[0], K[1]);
      gl.uniform1i(u.uTransfer, transfer);
      gl.uniformMatrix3fv(u.uToWork, false, glMat3(primariesTo(prim, work)));
      gl.uniform1i(u.uPrimariesSame, prim === "bt709" && transfer === 0 && work === "bt709" ? 1 : 0);
      gl.uniform1f(u.uSdrWhite, OUT.sdrWhiteNits);
      gl.uniform1i(u.uToneMap, opts.toneMap ? 1 : 0);
      gl.uniform1f(u.uPeak, opts.peak || 1);
      gl.uniform4i(u.uRect, vr.left, vr.top, vr.width, vr.height);
      gl.uniform1i(u.uRot, rot);
    });
    return out;
  }

  // Lanczos-3 from the working texture to the output size (cover).
  resample(src, sqW, sqH, dstW, dstH) {
    const gl = this.gl;
    const crop = coverCrop(src.w, src.h, sqW, sqH, dstW, dstH);
    const mid = this.makeTex("mid", dstW, src.h, "f16"), out = this.makeTex("scaled", dstW, dstH, "f16");
    this.pass(this.progs.resample, mid, (u, bind) => {
      bind("uSrc", src.t, false);
      gl.uniform1i(u.uAxis, 0); gl.uniform1f(u.uScale, crop.sx); gl.uniform1f(u.uOffset, crop.x); gl.uniform1i(u.uLen, src.w);
    });
    this.pass(this.progs.resample, out, (u, bind) => {
      bind("uSrc", mid.t, false);
      gl.uniform1i(u.uAxis, 1); gl.uniform1f(u.uScale, crop.sy); gl.uniform1f(u.uOffset, crop.y); gl.uniform1i(u.uLen, src.h);
    });
    return out;
  }

  grade(src, params, frame, outSize, hdr, name) {
    const gl = this.gl, P = params;
    const out = this.makeTex(name || "graded", src.w, src.h, "f16");
    this.pass(this.progs.grade, out, (u, bind) => {
      bind("uIn", src.t, false);
      gl.uniform1f(u.uExposure, P.exposure); gl.uniform1f(u.uContrast, P.contrast); gl.uniform1f(u.uHighlights, P.highlights);
      gl.uniform1f(u.uShadows, P.shadows); gl.uniform1f(u.uWhites, P.whites); gl.uniform1f(u.uBlacks, P.blacks);
      gl.uniform1f(u.uTemp, P.temp); gl.uniform1f(u.uTint, P.tint); gl.uniform1f(u.uVibrance, P.vibrance); gl.uniform1f(u.uSaturation, P.saturation);
      gl.uniform3fv(u.uMix, new Float32Array(P.mix));
      gl.uniform4fv(u.uWheel, new Float32Array(P.wheels));
      gl.uniform4f(u.uVig, P.vignette[0], P.vignette[1], P.vignette[2], P.vignette[3]);
      gl.uniform1f(u.uVigHi, P.vigHighlights);
      gl.uniform3f(u.uGrain, P.grain[0], P.grain[1], P.grain[2]);
      gl.uniform1f(u.uFrame, frame);
      gl.uniform2f(u.uOutSize, outSize.w, outSize.h);
      gl.uniform1f(u.uCeil, hdr ? OUT.hlgPeakNits / OUT.sdrWhiteNits * 1.5 : 1.0);
      const L = LUMA[hdr ? "bt2020" : "bt709"]; gl.uniform3f(u.uLumaW, L[0], L[1], L[2]);
    });
    return out;
  }

  // Show a graded texture on the renderer's canvas (8-bit SDR, dithered).
  display(src, peak, hdrWork) {
    const gl = this.gl;
    if (this.canvas.width !== src.w || this.canvas.height !== src.h) { this.canvas.width = src.w; this.canvas.height = src.h; }
    this.pass(this.progs.display, null, (u, bind) => {
      bind("uIn", src.t, false); gl.uniform1f(u.uPeak, peak || 1);
      gl.uniformMatrix3fv(u.uToSdr, false, glMat3(hdrWork ? M2020_TO_709 : [[1, 0, 0], [0, 1, 0], [0, 0, 1]]));
    });
    return this.canvas;
  }

  // Pack the graded frame into I420 (SDR) or I420P10 (HDR) and read it back.
  async pack(src, hdr, frame) {
    const gl = this.gl, W = src.w, H = src.h, bps = hdr ? 2 : 1, per = hdr ? 2 : 4;
    const ySize = W * H * bps, cSize = (W / 2) * (H / 2) * bps, total = ySize + 2 * cSize;
    const planes = [
      { w: W / per, h: H, offset: 0 },
      { w: W / 2 / per, h: H / 2, offset: ySize },
      { w: W / 2 / per, h: H / 2, offset: ySize + cSize }
    ];
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    if (this.pboSize !== total) { gl.bufferData(gl.PIXEL_PACK_BUFFER, total, gl.STREAM_READ); this.pboSize = total; }
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    planes.forEach((pl, i) => {
      const t = this.makeTex("pack" + i, pl.w, pl.h, "rgba8");
      this.pass(this.progs.pack, t, (u, bind) => {
        bind("uIn", src.t, false);
        gl.uniform1i(u.uPlane, i); gl.uniform1i(u.uHdr, hdr ? 1 : 0);
        gl.uniform1f(u.uSdrWhite, OUT.sdrWhiteNits); gl.uniform1f(u.uPeakNits, OUT.hlgPeakNits);
        gl.uniform1f(u.uFrame, frame);
      });
      gl.readPixels(0, 0, pl.w, pl.h, gl.RGBA, gl.UNSIGNED_BYTE, pl.offset);
    });
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    // Wait for the GPU without blocking the page, so decoding and encoding keep going.
    for (;;) {
      const r = gl.clientWaitSync(sync, 0, 0);
      if (r === gl.ALREADY_SIGNALED || r === gl.CONDITION_SATISFIED) break;
      if (r === gl.WAIT_FAILED) throw new Error("The GPU stopped responding.");
      await new Promise(res => setTimeout(res, 1));
    }
    gl.deleteSync(sync);
    const data = new Uint8Array(total);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return data;
  }
  dispose() { const lose = this.gl.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext(); }
}

// =====================================================================
// Opening a video: details, the plan, and the still frame
// =====================================================================
function describeColour(cs, sample, hdrTrack) {
  const c = Object.assign({}, cs || {});
  const s = sample && sample.colorSpace;
  ["primaries", "transfer", "matrix"].forEach(k => { if (!c[k] && s && s[k]) c[k] = s[k]; });
  if (c.fullRange == null && s && s.fullRange != null) c.fullRange = s.fullRange;
  if (!c.transfer && hdrTrack) c.transfer = "hlg";
  const hdr = c.transfer === "hlg" || c.transfer === "pq";
  if (!c.matrix) c.matrix = hdr ? "bt2020-ncl" : (sample && sample.codedHeight < 720 ? "smpte170m" : "bt709");
  if (!c.primaries) c.primaries = hdr ? "bt2020" : (c.matrix === "smpte170m" ? "smpte170m" : "bt709");
  if (c.primaries === "smpte240m") c.primaries = "smpte170m";
  if (!c.transfer) c.transfer = "bt709";
  c.fullRange = !!c.fullRange;
  c.hdr = hdr;
  return c;
}

// Can this browser really encode HDR? Encode one 10-bit HLG frame and see.
async function canEncodeHdr(w, h) {
  if (typeof VideoEncoder === "undefined") return false;
  const config = { codec: hevcCodecString(w, h, true), width: w, height: h, bitrate: OUT.bitrate, framerate: OUT.fps };
  try {
    const sup = await VideoEncoder.isConfigSupported(config);
    if (!sup.supported) return false;
    let got = false, failed = false;
    const enc = new VideoEncoder({ output: () => { got = true; }, error: () => { failed = true; } });
    enc.configure(config);
    const ySize = w * h, cSize = (w / 2) * (h / 2), data = new Uint16Array(ySize + 2 * cSize);
    data.fill(512, 0, ySize); data.fill(512, ySize);
    const frame = new VideoFrame(data, { format: "I420P10", codedWidth: w, codedHeight: h, timestamp: 0,
      colorSpace: { primaries: "bt2020", transfer: "hlg", matrix: "bt2020-ncl", fullRange: false } });
    enc.encode(frame, { keyFrame: true });
    frame.close();
    await enc.flush();
    enc.close();
    return got && !failed;
  } catch (e) { return false; }
}

export async function openVideo(file) {
  const M = await lib();
  const input = new M.Input({ source: new M.BlobSource(file), formats: M.ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt) { input.dispose(); throw new Error("This file has no video track."); }
  if (!(await vt.canDecode())) { input.dispose(); throw new Error("This browser can't decode this video (" + ((await vt.getCodec()) || "unknown codec") + ")."); }
  const at = await input.getPrimaryAudioTrack();
  const t0 = await vt.getFirstTimestamp();
  const end = await vt.computeDuration();
  const duration = Math.max(0, end - t0);
  let fps = null;
  try { const fr = await vt.computeFrameRateMetrics(); fps = fr.underlyingFrameRate || fr.bestGuessFrameRate; } catch (e) {}
  const rot = await vt.getRotation();
  const sqW0 = await vt.getSquarePixelWidth(), sqH0 = await vt.getSquarePixelHeight();
  const sideways = rot === 90 || rot === 270;
  const disp = { w: sideways ? sqH0 : sqW0, h: sideways ? sqW0 : sqH0 };
  const size = outputSize(disp.w, disp.h);

  const sink = new M.VideoSampleSink(vt);
  const mid = await sink.getSample(t0 + duration / 2) || await sink.getSample(t0);
  if (!mid) { input.dispose(); throw new Error("Couldn't read a frame from this video."); }
  const colour = describeColour(await vt.getColorSpace(), mid, await vt.hasHighDynamicRange());

  // The plan: HDR needs an HDR source, frames that arrive with their 10/12-bit
  // values intact, and an encoder that takes 10-bit HEVC.
  const tenBit = /P1[02]$/.test(mid.format || "");
  let hdrOut = false, sdrReason = null;
  if (colour.hdr) {
    if (!tenBit) sdrReason = "this browser decodes your HDR video to 8-bit, so its HDR detail isn't available";
    else if (!(await canEncodeHdr(size.w, size.h))) sdrReason = "this browser can't encode 10-bit HDR video";
    else hdrOut = true;
  }
  const hevcOk = await M.canEncodeVideo("hevc", { width: size.w, height: size.h, bitrate: OUT.bitrate, fullCodecString: hevcCodecString(size.w, size.h, hdrOut) });
  const audio = at ? audioPlan(await at.getCodec()) : audioPlan(null);

  const renderer = new Renderer();
  const peak = colour.hdr ? OUT.hlgPeakNits / OUT.sdrWhiteNits : 1;
  const work = await renderer.decode(mid, colour, { toneMap: colour.hdr && !hdrOut, peak, work: hdrOut ? "bt2020" : "bt709" });
  const midTime = mid.timestamp;
  const sq = { w: disp.w, h: disp.h };
  const still = renderer.resample(work, sq.w, sq.h, size.w, size.h);
  // Keep the resampled still in its own texture so previews don't redo it.
  const stillCopy = renderer.makeTex("still", size.w, size.h, "f16");
  copyTex(renderer, still, stillCopy);
  mid.close();

  const info = {
    name: file.name, bytes: file.size,
    width: disp.w, height: disp.h, fps, duration, rotation: rot,
    codec: await vt.getCodec(), audioCodec: at ? await at.getCodec() : null,
    colour, hdrIn: colour.hdr, hdrOut, sdrReason, hevcOk,
    out: size, audio, stillTime: midTime - t0
  };
  return new VideoSession(file, input, vt, at, renderer, stillCopy, info, { t0, end, sq, peak });
}

function copyTex(r, from, to) {
  const gl = r.gl;
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, r.fbo);
  gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, from.t, 0);
  const dst = gl.createFramebuffer();
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst);
  gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, to.t, 0);
  gl.blitFramebuffer(0, 0, from.w, from.h, 0, 0, to.w, to.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  gl.deleteFramebuffer(dst);
}

// =====================================================================
// On-device storage for the export (OPFS, written from a worker)
// =====================================================================
const EXPORT_NAME = "grade-export.mp4";
async function openWriter() {
  if (!navigator.storage || !navigator.storage.getDirectory || typeof Worker === "undefined") return null;
  const worker = new Worker("grade-writer.js");
  let seq = 0; const waiting = new Map();
  worker.onmessage = e => { const w = waiting.get(e.data.id); if (!w) return; waiting.delete(e.data.id); e.data.ok ? w.res() : w.rej(new Error(e.data.error)); };
  const call = (msg, transfer) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); worker.postMessage(Object.assign({ id }, msg), transfer || []); });
  try { await call({ cmd: "open", name: EXPORT_NAME }); } catch (e) { worker.terminate(); return null; }
  const writable = new WritableStream({
    write(chunk) { const copy = chunk.data.slice(); return call({ cmd: "write", data: copy, position: chunk.position }, [copy.buffer]); }
  });
  return {
    writable,
    async close() { await call({ cmd: "close" }); worker.terminate(); },
    async abort() { try { await call({ cmd: "close" }); } catch (e) {} worker.terminate(); await clearExport(); },
    async file(name) {
      const root = await navigator.storage.getDirectory();
      const f = await (await root.getFileHandle(EXPORT_NAME)).getFile();
      return new File([f], name, { type: "video/mp4" });
    }
  };
}
export async function clearExport() {
  try { const root = await navigator.storage.getDirectory(); await root.removeEntry(EXPORT_NAME); } catch (e) {}
}

// =====================================================================
// A loaded video: previews and the export
// =====================================================================
class VideoSession {
  constructor(file, input, vt, at, renderer, still, info, priv) {
    this.file = file; this.input = input; this.vt = vt; this.at = at; this.r = renderer; this.still = still; this.info = info; this.p = priv;
  }
  // The still frame with a preset (or the original when preset is null),
  // drawn onto `canvas` (a visible <canvas>), exactly as the export renders it.
  preview(canvas, preset, opts) {
    const r = this.r, info = this.info;
    const params = preset ? gradeParams(preset, opts) : NEUTRAL;
    const g = r.grade(this.still, params, 0, info.out, info.hdrOut);
    const src = r.display(g, info.hdrOut ? this.p.peak : 1, info.hdrOut);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  }

  // Render the whole video with the preset and write an MP4 to device storage.
  // opts: { vignette, codec: "hevc"|"avc", signal, onProgress(done, total, etaSeconds) }
  async export(preset, opts) {
    const M = await lib();
    const info = this.info, out = info.out, r = this.r;
    const hdr = info.hdrOut && opts.codec !== "avc";
    const params = gradeParams(preset, opts);
    const fps = OUT.fps, t0 = this.p.t0, count = Math.max(1, Math.round((this.p.end - t0) * fps));
    const signal = opts.signal;

    await clearExport();
    const writer = await openWriter();
    const target = writer ? new M.StreamTarget(writer.writable, { chunked: true, chunkSize: 4 * 1024 * 1024 }) : new M.BufferTarget();
    const audioMax = info.duration * 100 + 64;   // packets are at least ~10 ms long
    const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: "reserve" }), target });

    const videoSource = new M.VideoSampleSource(opts.codec === "avc"
      ? { codec: "avc", bitrate: OUT.h264Bitrate, keyFrameInterval: OUT.keyFrameInterval, bitrateMode: "variable", latencyMode: "quality" }
      : { codec: "hevc", bitrate: OUT.bitrate, keyFrameInterval: OUT.keyFrameInterval, bitrateMode: "variable", latencyMode: "quality",
          fullCodecString: hevcCodecString(out.w, out.h, hdr) });
    output.addVideoTrack(videoSource, { frameRate: fps, maximumPacketCount: count + 8 });

    let audioSource = null, audioJob = null;
    if (this.at && info.audio.mode === "copy") {
      audioSource = new M.EncodedAudioPacketSource(info.audio.codec);
      output.addAudioTrack(audioSource, { maximumPacketCount: Math.ceil(audioMax) });
    } else if (this.at && info.audio.mode === "aac") {
      audioSource = new M.AudioSampleSource({ codec: "aac", bitrate: OUT.audioReencodeBitrate });
      output.addAudioTrack(audioSource, { maximumPacketCount: Math.ceil(audioMax) });
    }
    await output.start();

    const videoEnd = t0 + count / fps;
    if (audioSource && info.audio.mode === "copy") {
      audioJob = (async () => {
        const sink = new M.EncodedPacketSink(this.at);
        const config = await this.at.getDecoderConfig();
        let first = true;
        for await (const pk of sink.packets()) {
          if (signal && signal.aborted) return;
          if (pk.timestamp + pk.duration <= t0) continue;
          if (pk.timestamp >= videoEnd) break;
          const moved = new M.EncodedPacket(pk.data, pk.type, Math.max(0, pk.timestamp - t0), pk.duration, pk.sequenceNumber);
          await audioSource.add(moved, first ? { decoderConfig: config } : undefined);
          first = false;
        }
        audioSource.close();
      })();
    } else if (audioSource) {
      audioJob = (async () => {
        const sink = new M.AudioSampleSink(this.at);
        for await (const s of sink.samples(t0, videoEnd)) {
          if (signal && signal.aborted) { s.close(); return; }
          s.setTimestamp(Math.max(0, s.timestamp - t0));
          await audioSource.add(s);
          s.close();
        }
        audioSource.close();
      })();
    }

    const colorSpace = hdr
      ? { primaries: "bt2020", transfer: "hlg", matrix: "bt2020-ncl", fullRange: false }
      : { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false };
    const peak = this.p.peak;
    const decodeOpts = { toneMap: info.hdrIn && !hdr, peak, work: hdr ? "bt2020" : "bt709" };
    const sampler = new Sampler(t0, count, fps);
    const startedAt = performance.now();
    let done = 0;

    const emit = async (sample, ks) => {
      if (!ks.length) return;
      const work = await r.decode(sample, info.colour, decodeOpts);
      const scaled = r.resample(work, this.p.sq.w, this.p.sq.h, out.w, out.h);
      for (const k of ks) {
        if (signal && signal.aborted) return;
        const graded = r.grade(scaled, params, k, out, hdr, "xgraded");
        const bytes = await r.pack(graded, hdr, k);
        const frame = new M.VideoSample(bytes, {
          format: hdr ? "I420P10" : "I420", codedWidth: out.w, codedHeight: out.h,
          timestamp: k / fps, duration: 1 / fps, colorSpace
        });
        await videoSource.add(frame);
        frame.close();
        done++;
        if (opts.onProgress) {
          const el = (performance.now() - startedAt) / 1000;
          opts.onProgress(done, count, done > 3 ? el / done * (count - done) : null);
        }
      }
    };

    try {
      const sink = new M.VideoSampleSink(this.vt);
      let prev = null;
      for await (const s of sink.samples(t0)) {
        if (signal && signal.aborted) { s.close(); break; }
        const ks = sampler.push(s.timestamp);
        if (prev) { await emit(prev, ks); prev.close(); }
        prev = s;
        if (sampler.k >= count) break;
      }
      if (prev) { if (!(signal && signal.aborted)) await emit(prev, sampler.finish()); prev.close(); }
      if (signal && signal.aborted) throw new DOMException("Export cancelled", "AbortError");
      videoSource.close();
      if (audioJob) await audioJob;
      await output.finalize();
    } catch (e) {
      try { await output.cancel(); } catch (e2) {}
      if (writer) await writer.abort();
      throw e;
    }

    const base = info.name.replace(/\.[^.]+$/, "") || "video";
    const name = base + " - " + (preset ? preset.id : "graded") + ".mp4";
    let file;
    if (writer) { await writer.close(); file = await writer.file(name); }
    else file = new File([target.buffer], name, { type: "video/mp4" });
    return { file, hdr, frames: count, inMemory: !writer };
  }

  dispose() { try { this.input.dispose(); } catch (e) {} this.r.dispose(); }
}
