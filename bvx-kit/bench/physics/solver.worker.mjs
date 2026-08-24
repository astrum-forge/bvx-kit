/**
 * Worker entry for the physics demonstration. The host owns the simulation for the
 * lifetime of the worker - it is seeded once and afterwards receives only edits and
 * emits only deltas.
 */
import { parentPort } from "node:worker_threads";
import { BVXPhysicsHost } from "../../out/index.js";

// BVXPhysicsHost.attach expects a Web Worker shaped scope; node's parentPort adapts
// to it in three lines, which is the point of keeping the host free of any Worker
// API dependency.
const scope = {
    onmessage: null,
    postMessage: (message, transfer) => parentPort.postMessage(message, transfer)
};

new BVXPhysicsHost().attach(scope);

parentPort.on("message", (data) => scope.onmessage({ data }));
