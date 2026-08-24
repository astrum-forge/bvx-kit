// CPU baseline under Node, using the exact same mesher.js and the exact same
// generated world as the browser GPU run. Node is not subject to Chrome's
// background-tab QoS demotion, and it is how the existing .plans figures were
// produced, so this baseline is directly comparable to the repo's 21.9 us/chunk.
//
// The world is deterministic (integer-hash value noise), so the face counts here
// must match the browser's exactly - that is the cross-check that both sides
// measured the same thing.

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildWorld, subWorld, mixedIndices, cpuMeshRange } from './mesher.js';

const SELF = fileURLToPath(import.meta.url);

if (!isMainThread) {
  const occ = new Uint32Array(workerData.occ);
  const nb = new Int32Array(workerData.nb);
  parentPort.on('message', (m) => {
    let r = null;
    for (let i = 0; i < m.reps; i++) r = cpuMeshRange(occ, nb, m.from, m.to);
    parentPort.postMessage(r);
  });
  parentPort.postMessage('ready');
} else {
  const timeIt = (fn, minMs = 500) => {
    fn(); fn(); fn();
    let reps = 1;
    for (;;) {
      const s = performance.now();
      for (let i = 0; i < reps; i++) fn();
      const el = performance.now() - s;
      if (el >= minMs) return el / reps;
      reps = Math.max(reps * 2, Math.ceil(reps * (minMs / Math.max(el, 0.01))));
    }
  };

  const out = { node: process.version, cpus: cpus().length, model: cpus()[0].model };

  const world = buildWorld(24, 6, 24, true);
  const surf = subWorld(world, mixedIndices(world), true);
  out.world = { count: world.count, ...world.classes, surfaceCount: surf.count };

  for (const [name, w] of [['mixed-world', world], ['surface-only', surf]]) {
    const ms = timeIt(() => cpuMeshRange(w.occ, w.nb, 0, w.count));
    const ref = cpuMeshRange(w.occ, w.nb, 0, w.count);
    out[name] = { ms, usPerChunk: ms * 1000 / w.count, chunks: w.count, faces: ref.faces, touched: ref.touched };
    console.log(`1 thread  ${name.padEnd(13)}: ${ms.toFixed(3)} ms / ${w.count} = ${(ms * 1000 / w.count).toFixed(2)} us/chunk  faces=${ref.faces}`);
  }

  out.pools = {};
  for (const nw of [2, 4, 8]) {
    const workers = [];
    for (let i = 0; i < nw; i++) {
      workers.push(new Worker(SELF, { workerData: { occ: surf.occ.buffer, nb: surf.nb.buffer } }));
    }
    await Promise.all(workers.map(w => new Promise(res => w.once('message', res))));

    const run = (reps) => Promise.all(workers.map((w, i) => new Promise(res => {
      const from = Math.floor(i * surf.count / nw), to = Math.floor((i + 1) * surf.count / nw);
      w.once('message', res);
      w.postMessage({ from, to, reps });
    })));

    await run(60);                       // warm every worker's JIT properly
    const REPS = 120;
    const s = performance.now();
    const parts = await run(REPS);
    const ms = (performance.now() - s) / REPS;
    const faces = parts.reduce((a, p) => a + p.faces, 0);
    out.pools[nw] = { ms, usPerChunk: ms * 1000 / surf.count, faces, scaling: out['surface-only'].ms / ms };
    console.log(`${nw} workers surface-only : ${ms.toFixed(3)} ms / ${surf.count} = ${(ms * 1000 / surf.count).toFixed(2)} us/chunk` +
      `  (${(out['surface-only'].ms / ms).toFixed(2)}x vs 1 thread, faces=${faces})`);
    await Promise.all(workers.map(w => w.terminate()));
  }

  console.log('\nJSON ' + JSON.stringify(out));
}
