/* Color Grading: writes a video export into this site's private on-device
 * storage (the Origin Private File System), so long exports don't have to fit
 * in memory. Runs as a worker because the fast, positioned writes the MP4
 * writer needs (createSyncAccessHandle) only exist in workers. Nothing here
 * touches the network.
 *
 * Messages: { id, cmd: "open", name } | { id, cmd: "write", data, position } | { id, cmd: "close" }
 * Replies:  { id, ok: true } or { id, ok: false, error }
 */
"use strict";
var handle = null;

self.onmessage = function (e) {
  var m = e.data;
  run(m).then(function () { self.postMessage({ id: m.id, ok: true }); },
    function (err) { self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) }); });
};

function run(m) {
  if (m.cmd === "open") {
    return navigator.storage.getDirectory()
      .then(function (root) { return root.getFileHandle(m.name, { create: true }); })
      .then(function (fh) { return fh.createSyncAccessHandle(); })
      .then(function (h) { handle = h; handle.truncate(0); });
  }
  if (m.cmd === "write") {
    var data = m.data, off = 0;
    while (off < data.byteLength) off += handle.write(data.subarray(off), { at: m.position + off });
    return Promise.resolve();
  }
  if (m.cmd === "close") {
    if (handle) { handle.flush(); handle.close(); handle = null; }
    return Promise.resolve();
  }
  return Promise.reject(new Error("Unknown command " + m.cmd));
}
