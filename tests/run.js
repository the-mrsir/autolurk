// Entry point for `node tests/run.js`. The Chrome mock is installed before any
// background module is imported, because those modules capture globalThis.chrome
// at call time and ES module instances are cached for the whole process.
import { chromeMock } from "./chrome-mock.js";
import { runAll } from "./harness.js";

chromeMock();

await import("./poll-logic.test.js");
await import("./health.test.js");
await import("./storage.test.js");
await import("./background.test.js");
await import("./features.test.js");
await import("./throttling.test.js");
await import("./content-runtime.test.js");
await import("./grouping.test.js");
await import("./multistream.test.js");
await import("./wake.test.js");
await import("./sync.test.js");
await import("./streaks.test.js");
await import("./update.test.js");
await import("./server.test.js");
// Skips itself outside a browser: it reads source files over fetch.
await import("./static.test.js");
// Last: importing the service worker installs listeners for good.
await import("./service-worker.test.js");

const { failures } = await runAll();

if (failures.length && typeof process !== "undefined") {
  process.exitCode = 1;
}
