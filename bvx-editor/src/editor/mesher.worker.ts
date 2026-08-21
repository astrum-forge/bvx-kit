import { BVXWorkerHost } from "@astrumforge/bvx-kit";

/**
 * Worker entry point - the BVXWorkerHost wires a BVXMesher into this worker's
 * message loop. All geometry generation requested by the editor runs here,
 * off the main thread.
 */
new BVXWorkerHost().attach(self as never);
