// MapLibre 6 locates its web worker with new URL(..., import.meta.url), which
// bundlers can't follow. Serve the (self-contained) worker from public/ instead;
// components/map/maplibre-quest-map.tsx points setWorkerUrl at it.
import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve("maplibre-gl/package.json"));
copyFileSync(join(dist, "dist", "maplibre-gl-worker.mjs"), new URL("../public/maplibre-gl-worker.mjs", import.meta.url));
console.log("copied maplibre-gl-worker.mjs to public/");
