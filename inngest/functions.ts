import { aggregateDaily } from "./funcs/aggregateDaily";
import { rebuildAll } from "./funcs/rebuildAll";
import { warmCache } from "./funcs/warmCache";

export const functions = [
  aggregateDaily,
  rebuildAll,
  warmCache,
];


