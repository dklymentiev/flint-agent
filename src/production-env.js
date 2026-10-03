// Imported first by index.js: React and Ink load their production builds.
//
// With NODE_ENV unset they loaded the development builds, and React 19's
// development build records a performance.measure for every component render
// (its "Components" profiling track). Nothing clears that buffer. The
// overnight soak of 2026-10-02 ended with 72,784 PerformanceMeasure entries
// and their strings making up most of a 97 MB live heap after /new and a
// full GC, and private bytes rising about 6 MB an hour.
//
// The variable is set only while the modules load (React picks its build
// then) and restored by restoreNodeEnv() afterwards: commands the agent runs
// inherit the environment, and NODE_ENV=production there would make
// `npm install` in the operator's project skip devDependencies.

export const originalNodeEnv = process.env.NODE_ENV;
if (!originalNodeEnv) process.env.NODE_ENV = "production";

/** Put NODE_ENV back as it was before Flint started. */
export function restoreNodeEnv() {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
}
