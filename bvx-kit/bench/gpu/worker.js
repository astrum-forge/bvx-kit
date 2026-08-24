import { cpuMeshRange } from './mesher.js';

let occ = null, nb = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.cmd === 'attach') {
    occ = new Uint32Array(m.occ);
    nb = new Int32Array(m.nb);
    self.postMessage({ cmd: 'ready' });
    return;
  }
  if (m.cmd === 'mesh') {
    // repeat inside the worker so the messaging round trip is amortised the same
    // way the single-thread loop amortises its own call overhead
    let faces = 0, touched = 0;
    for (let i = 0; i < m.reps; i++) {
      const r = cpuMeshRange(occ, nb, m.from, m.to);
      faces = r.faces; touched = r.touched;
    }
    self.postMessage({ cmd: 'done', faces, touched });
  }
};
