import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * refresh-limits — backoff při selhání endpointu (v0.11.27).
 *
 * Doloženo 18. 8. 2026: /api/oauth/usage vracel 429 třináct hodin v kuse a
 * hook bez dotyku throttle markeru při selhání znamenal 1 curl na KAŽDÝ
 * PostToolUse KAŽDÉHO peera — flotila bušila do endpointu bez omezení
 * (a možná si 429 sama udržovala). Oprava: marker se dotýká i při selhání,
 * kadence pokusů je jednotná 1/THROTTLE_SECONDS.
 *
 * Subprocess záměrně (vzor statusline-passthrough): testuje se týž CJS
 * artefakt, který se reálně spouští z hooku, s izolovaným HOME.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SOURCE = join(HERE, "..", "..", "src", "refresh-limits", "main.ts");
const PKG_ROOT = join(HERE, "..", "..");

let bundlePath: string;
let buildDir: string;

const pExecFile = promisify(execFile);

beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), "refresh-limits-test-"));
  bundlePath = join(buildDir, "refresh-limits.cjs");
  await pExecFile(
    "npx",
    [
      "esbuild",
      SOURCE,
      "--bundle",
      "--platform=node",
      "--target=node18",
      "--format=cjs",
      `--outfile=${bundlePath}`,
    ],
    { cwd: PKG_ROOT },
  );
}, 60_000);

afterAll(async () => {
  await rm(buildDir, { recursive: true, force: true });
});

/** Izolovaný HOME s credentials souborem (linuxový fallback readOAuthToken). */
async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "refresh-limits-home-"));
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-test-token-not-real" } }),
  );
  return home;
}

function runHook(home: string, pathDir: string) {
  // Přes /bin/sh s pipe: hook čte stdin do 'end' (drainStdin) — bez uzavřeného
  // stdinu by visel; CC mu reálně posílá payload a rouru zavírá.
  return pExecFile("/bin/sh", ["-c", `echo '{}' | ${process.execPath} ${bundlePath}`], {
    env: { HOME: home, PATH: pathDir },
    timeout: 15_000,
  });
}

const markerPath = (home: string) => join(home, ".claude-bridge", "live", "last-oauth-refresh");
const oauthPath = (home: string) => join(home, ".claude-bridge", "live", "oauth-api.json");

describe("refresh-limits backoff", () => {
  it(
    "selhání curlu se dotkne throttle markeru a nezapíše envelope",
    { timeout: 20_000 },
    async () => {
      const home = await makeHome();
      const emptyBin = await mkdtemp(join(tmpdir(), "empty-bin-")); // PATH bez curl → spawn selže
      try {
        await runHook(home, emptyBin);
        const st = await stat(markerPath(home)); // marker MUSÍ existovat i po selhání
        expect(st.isFile()).toBe(true);
        await expect(stat(oauthPath(home))).rejects.toThrow(); // envelope se při selhání nepíše
      } finally {
        await rm(home, { recursive: true, force: true });
        await rm(emptyBin, { recursive: true, force: true });
      }
    },
  );

  it(
    "čerstvý marker drží throttle i po předchozím selhání (žádný re-touch)",
    { timeout: 20_000 },
    async () => {
      const home = await makeHome();
      const emptyBin = await mkdtemp(join(tmpdir(), "empty-bin-"));
      try {
        await mkdir(join(home, ".claude-bridge", "live"), { recursive: true });
        await writeFile(markerPath(home), "SENTINEL\n");
        await runHook(home, emptyBin);
        expect(await readFile(markerPath(home), "utf8")).toBe("SENTINEL\n"); // early-return, obsah nedotčen
      } finally {
        await rm(home, { recursive: true, force: true });
        await rm(emptyBin, { recursive: true, force: true });
      }
    },
  );

  it(
    "úspěch dál zapisuje envelope i marker (regresní stráž fixu)",
    { timeout: 20_000 },
    async () => {
      const home = await makeHome();
      const fakeBin = await mkdtemp(join(tmpdir(), "fake-bin-"));
      try {
        const fakeCurl = join(fakeBin, "curl");
        await writeFile(
          fakeCurl,
          `#!/bin/sh\ncat > /dev/null\nprintf '{"five_hour":{"utilization":0.1}}'\n`,
        );
        await chmod(fakeCurl, 0o755);
        await runHook(home, fakeBin);
        const envelope = JSON.parse(await readFile(oauthPath(home), "utf8"));
        expect(envelope.data.five_hour.utilization).toBe(0.1);
        const st = await stat(markerPath(home));
        expect(st.isFile()).toBe(true);
      } finally {
        await rm(home, { recursive: true, force: true });
        await rm(fakeBin, { recursive: true, force: true });
      }
    },
  );
});
