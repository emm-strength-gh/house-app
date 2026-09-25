/* Generates every PNG/SVG icon the PWA needs. No dependencies — plain Node
 * (zlib for the PNG encoder, a tiny supersampling rasterizer for the shapes).
 *
 *   node make-icons.js
 *
 * One icon set per app, drawn from the same geometry so the PNGs and SVGs match:
 *   house-*   the House App launcher (index.html) — the installed PWA's icon
 *   energy-*  the Energy Tracker app tile
 *   oni-*     the Oni Orders app tile
 *   grocery-* the Grocery Planner app tile
 *   todo-*    the To Do app tile
 *
 * Variants:
 *   *-180.png           apple-touch-icon: full-bleed square, iOS rounds it itself
 *                       (transparent corners would turn black on iOS)
 *   *-192/512.png       manifest "any": pre-rounded corners, transparent outside
 *   *-maskable-512.png  manifest "maskable": full bleed, artwork shrunk into the
 *                       80% safe circle so Android's mask never clips it
 *   *.svg               full-bleed square used inside the pages (CSS rounds it)
 */
"use strict";
var fs = require("fs");
var path = require("path");
var zlib = require("zlib");

var OUT = path.join(__dirname, "icons");
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

// ---------------------------------------------------------------- geometry
// All coordinates are in a 0..1 unit square.
var BOLT = [[0.60, 0.08], [0.28, 0.54], [0.48, 0.54], [0.40, 0.92], [0.72, 0.44], [0.52, 0.44]];

var ICONS = {
  energy: {
    bg: ["#ffcf33", "#ff7a00"],
    shapes: [{ poly: BOLT, color: "#ffffff" }],
    scaleAny: 0.82, scaleMask: 0.72
  },
  oni: {
    // Same dark-brown -> burnt-orange gradient and bold "ONI" as the original
    // Oni Order Builder icon, redrawn as shapes so no font is needed.
    bg: ["#2e2420", "#d4623a"],
    shapes: [
      { ring: [0.305, 0.50, 0.150, 0.145, 0.066], color: "#fff8f2" },
      { poly: [[0.49, 0.355], [0.555, 0.355], [0.655, 0.525], [0.655, 0.355], [0.72, 0.355],
               [0.72, 0.645], [0.655, 0.645], [0.555, 0.475], [0.555, 0.645], [0.49, 0.645]], color: "#fff8f2" },
      { rect: [0.775, 0.355, 0.066, 0.29, 0], color: "#fff8f2" }
    ],
    scaleAny: 0.92, scaleMask: 0.74
  },
  grocery: {
    // Basket: handle is a ring whose lower half hides behind the rim and body.
    bg: ["#3ddc84", "#0e8a4f"],
    shapes: [
      { ring: [0.50, 0.44, 0.215, 0.23, 0.06], color: "#ffffff" },
      { rect: [0.13, 0.40, 0.74, 0.095, 0.035], color: "#ffffff" },
      { poly: [[0.18, 0.47], [0.82, 0.47], [0.75, 0.82], [0.25, 0.82]], color: "#ffffff" },
      { rect: [0.335, 0.54, 0.05, 0.21, 0.025], color: "#0e8a4f", alpha: 0.35 },
      { rect: [0.475, 0.54, 0.05, 0.21, 0.025], color: "#0e8a4f", alpha: 0.35 },
      { rect: [0.615, 0.54, 0.05, 0.21, 0.025], color: "#0e8a4f", alpha: 0.35 }
    ],
    scaleAny: 0.88, scaleMask: 0.72
  },
  todo: {
    // Checklist: three bullet + line rows, the top one ticked and faded.
    bg: ["#4fb3ff", "#1f5fe0"],
    shapes: [
      { ring: [0.28, 0.30, 0.08, 0.08, 0.08], color: "#ffffff" },
      { poly: [[0.235, 0.303], [0.250, 0.288], [0.271, 0.310], [0.312, 0.266], [0.327, 0.281], [0.271, 0.340]], color: "#3a8cf3" },
      { rect: [0.42, 0.2625, 0.36, 0.075, 0.0375], color: "#ffffff", alpha: 0.55 },
      { ring: [0.28, 0.50, 0.08, 0.08, 0.032], color: "#ffffff" },
      { rect: [0.42, 0.4625, 0.36, 0.075, 0.0375], color: "#ffffff" },
      { ring: [0.28, 0.70, 0.08, 0.08, 0.032], color: "#ffffff" },
      { rect: [0.42, 0.6625, 0.36, 0.075, 0.0375], color: "#ffffff" }
    ],
    scaleAny: 1.0, scaleMask: 0.8
  },
  house: {
    bg: ["#5b6cff", "#9b4fe0"],
    shapes: [
      // White house silhouette (roof with eaves + body) and a warm yellow door.
      { poly: [[0.50, 0.17], [0.86, 0.49], [0.77, 0.49], [0.77, 0.83], [0.23, 0.83], [0.23, 0.49], [0.14, 0.49]], color: "#ffffff" },
      { rect: [0.425, 0.585, 0.15, 0.245, 0.035], color: "#ffc933" }
    ],
    scaleAny: 0.95, scaleMask: 0.78
  }
};

// ---------------------------------------------------------------- raster
function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }

function inPoly(x, y, pts) {
  var inside = false;
  for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// Elliptical ring: inside the outer ellipse, outside the inner one.
function inRing(x, y, cx, cy, rx, ry, t) {
  var o = (x - cx) * (x - cx) / (rx * rx) + (y - cy) * (y - cy) / (ry * ry);
  var i = (x - cx) * (x - cx) / ((rx - t) * (rx - t)) + (y - cy) * (y - cy) / ((ry - t) * (ry - t));
  return o <= 1 && i > 1;
}
function inRRect(x, y, rx, ry, w, h, r) {
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false;
  var cx = Math.min(Math.max(x, rx + r), rx + w - r);
  var cy = Math.min(Math.max(y, ry + r), ry + h - r);
  var dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function render(icon, size, opts) {
  var SS = 4, buf = Buffer.alloc(size * size * 4);
  var c0 = hex(icon.bg[0]), c1 = hex(icon.bg[1]);
  var scale = opts.scale, corner = opts.corner;
  for (var py = 0; py < size; py++) {
    for (var px = 0; px < size; px++) {
      var acc = [0, 0, 0, 0];
      for (var sy = 0; sy < SS; sy++) for (var sx = 0; sx < SS; sx++) {
        var u = (px + (sx + 0.5) / SS) / size, v = (py + (sy + 0.5) / SS) / size;
        if (corner && !inRRect(u, v, 0, 0, 1, 1, corner)) continue;
        // Diagonal gradient, top-left -> bottom-right.
        var t = (u + v) / 2;
        var col = [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
        // Artwork lives in its own space, scaled about the centre.
        var au = (u - 0.5) / scale + 0.5, av = (v - 0.5) / scale + 0.5;
        icon.shapes.forEach(function (s) {
          var hit = s.poly ? inPoly(au, av, s.poly)
            : s.ring ? inRing(au, av, s.ring[0], s.ring[1], s.ring[2], s.ring[3], s.ring[4])
            : inRRect(au, av, s.rect[0], s.rect[1], s.rect[2], s.rect[3], s.rect[4]);
          if (!hit) return;
          var sc = hex(s.color), a = s.alpha == null ? 1 : s.alpha;
          col = [col[0] + (sc[0] - col[0]) * a, col[1] + (sc[1] - col[1]) * a, col[2] + (sc[2] - col[2]) * a];
        });
        acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += 255;
      }
      var n = SS * SS, i = (py * size + px) * 4, cov = acc[3] / 255;
      // Colour is averaged over covered samples only (straight alpha).
      buf[i] = cov ? Math.round(acc[0] / cov) : 0;
      buf[i + 1] = cov ? Math.round(acc[1] / cov) : 0;
      buf[i + 2] = cov ? Math.round(acc[2] / cov) : 0;
      buf[i + 3] = Math.round(acc[3] / n);
    }
  }
  return buf;
}

// ---------------------------------------------------------------- PNG
var CRC = (function () {
  var t = new Int32Array(256);
  for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(b) { var c = -1; for (var i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  var len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  var td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  var crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  var raw = Buffer.alloc(size * (size * 4 + 1));
  for (var y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------- SVG
function svg(icon, scale) {
  var S = 512, k = function (v) { return +(v * S).toFixed(2); };
  var tr = "translate(" + k(0.5 - 0.5 * scale) + " " + k(0.5 - 0.5 * scale) + ") scale(" + scale + ")";
  var body = icon.shapes.map(function (s) {
    var op = s.alpha != null && s.alpha !== 1 ? ' fill-opacity="' + s.alpha + '"' : "";
    if (s.poly) return '<path d="M' + s.poly.map(function (p) { return k(p[0]) + " " + k(p[1]); }).join("L") + 'Z" fill="' + s.color + '"' + op + "/>";
    if (s.ring) {
      // Stroke centred between the outer and inner edge = the same ring.
      var g = s.ring;
      return '<ellipse cx="' + k(g[0]) + '" cy="' + k(g[1]) + '" rx="' + k(g[2] - g[4] / 2) + '" ry="' + k(g[3] - g[4] / 2) +
        '" fill="none" stroke="' + s.color + '" stroke-width="' + k(g[4]) + '"/>';
    }
    var r = s.rect;
    return '<rect x="' + k(r[0]) + '" y="' + k(r[1]) + '" width="' + k(r[2]) + '" height="' + k(r[3]) + '" rx="' + k(r[4]) + '" fill="' + s.color + '"' + op + "/>";
  }).join("");
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + icon.bg[0] + '"/><stop offset="1" stop-color="' + icon.bg[1] + '"/></linearGradient></defs>' +
    '<rect width="512" height="512" fill="url(#g)"/><g transform="' + tr + '">' + body + "</g></svg>\n";
}

// ---------------------------------------------------------------- write
Object.keys(ICONS).forEach(function (name) {
  var ic = ICONS[name];
  var jobs = [
    [name + "-180.png", 180, { scale: ic.scaleAny, corner: 0 }],
    [name + "-192.png", 192, { scale: ic.scaleAny, corner: 0.225 }],
    [name + "-512.png", 512, { scale: ic.scaleAny, corner: 0.225 }],
    [name + "-maskable-512.png", 512, { scale: ic.scaleMask, corner: 0 }],
    [name + "-32.png", 32, { scale: ic.scaleAny, corner: 0.225 }]
  ];
  jobs.forEach(function (j) {
    fs.writeFileSync(path.join(OUT, j[0]), png(j[1], render(ic, j[1], j[2])));
    console.log("wrote icons/" + j[0]);
  });
  fs.writeFileSync(path.join(OUT, name + ".svg"), svg(ic, ic.scaleAny));
  console.log("wrote icons/" + name + ".svg");
});
