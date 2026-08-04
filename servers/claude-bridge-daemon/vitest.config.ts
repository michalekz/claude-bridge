import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Test FILES run one at a time.
    //
    // Several suites here drive a REAL tmux server, and there is only one per
    // user. Since v0.10.6 the driver's `listWindows()` enumerates every window
    // on that server — which is right in production, where the daemon must see
    // the whole host — so two files creating and killing sessions at the same
    // moment see each other's fixtures. Symptom when this was unset: the
    // real-tmux smoke test failed inside the full run and passed on its own,
    // which is the least useful kind of failure.
    //
    // The alternative, a private tmux socket per file, means threading a
    // `-L <socket>` option through production code purely for tests. Not worth
    // it while the suite takes seconds.
    fileParallelism: false,
  },
});
