// A dependency-free test harness. The project has no build step and no
// node_modules, and it must be runnable both from a terminal (node tests/run.js)
// and from a browser tab (tests/runner.html) on a machine with no Node install.

const suites = [];
let current = null;

export function describe(name, body) {
  current = { name, tests: [] };
  suites.push(current);
  body();
  current = null;
}

export function it(name, body) {
  if (!current) throw new Error("it() must be called inside describe()");
  current.tests.push({ name, body });
}

export class AssertionError extends Error {}

function stringify(value) {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const assert = {
  ok(value, message = "expected a truthy value") {
    if (!value) throw new AssertionError(`${message} (got ${stringify(value)})`);
  },
  notOk(value, message = "expected a falsy value") {
    if (value) throw new AssertionError(`${message} (got ${stringify(value)})`);
  },
  equal(actual, expected, message = "values differ") {
    if (actual !== expected) {
      throw new AssertionError(`${message}: expected ${stringify(expected)}, got ${stringify(actual)}`);
    }
  },
  deepEqual(actual, expected, message = "objects differ") {
    const a = stringify(actual);
    const b = stringify(expected);
    if (a !== b) throw new AssertionError(`${message}: expected ${b}, got ${a}`);
  },
  includes(list, value, message = "value not found") {
    if (!Array.from(list).includes(value)) {
      throw new AssertionError(`${message}: ${stringify(value)} not in ${stringify(Array.from(list))}`);
    }
  },
  async rejects(promise, message = "expected a rejection") {
    try {
      await promise;
    } catch {
      return;
    }
    throw new AssertionError(message);
  },
};

export async function runAll({ log = console.log } = {}) {
  let passed = 0;
  const failures = [];

  for (const suite of suites) {
    log(`\n${suite.name}`);
    for (const test of suite.tests) {
      try {
        await test.body();
        passed += 1;
        log(`  PASS  ${test.name}`);
      } catch (error) {
        failures.push({ suite: suite.name, test: test.name, error });
        log(`  FAIL  ${test.name}`);
        log(`        ${error.message}`);
      }
    }
  }

  log(`\n${passed} passed, ${failures.length} failed`);
  return { passed, failures };
}
