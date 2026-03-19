import { aggregateDaily } from "./funcs/aggregateDaily";
import { rebuildAll } from "./funcs/rebuildAll";
import { warmCache } from "./funcs/warmCache";
import { flushEventBuffer } from "./funcs/flushEventBuffer";

export const functions = [
  aggregateDaily,
  rebuildAll,
  warmCache,
  flushEventBuffer,
];
