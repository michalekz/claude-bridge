import { readFile, stat } from "node:fs/promises";
import { heartbeatPath, makeLogger } from "@claude-bridge/shared";
import packageJson from "../package.json" with { type: "json" };
import { runDaemon } from "./daemon.ts";
import { installSystemd, uninstallSystemd } from "./install.ts";
import { readLock } from "./lock.ts";

const log = makeLogger("daemon.cli");
const DAEMON_VERSION = (packageJson as { version: string }).version;

const HELP = `claude-bridge-daemon ${DAEMON_VERSION}

Commands:
  run                Run the daemon in the foreground (used by systemd)
  install --systemd  Install and start as a systemd --user service (Linux)
  uninstall --systemd
                     Stop, disable, and remove the systemd --user service
  status             Print daemon lock + heartbeat freshness
  version            Print the daemon version
  help               Print this message
`;

async function statusCommand(): Promise<void> {
  const lock = await readLock();
  let heartbeatAgeMs: number | null = null;
  try {
    const s = await stat(heartbeatPath());
    heartbeatAgeMs = Date.now() - s.mtimeMs;
  } catch {
    heartbeatAgeMs = null;
  }
  const alive = lock !== null && heartbeatAgeMs !== null && heartbeatAgeMs < 30_000;
  const report = {
    daemonVersion: DAEMON_VERSION,
    alive,
    lock,
    heartbeatAgeMs,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = alive ? 0 : 1;
}

async function main(argv: string[]): Promise<void> {
  const cmd = argv[0] ?? "help";
  switch (cmd) {
    case "run": {
      await runDaemon({ daemonVersion: DAEMON_VERSION });
      return;
    }
    case "install": {
      if (argv[1] !== "--systemd") {
        process.stderr.write(`install requires --systemd flag\n${HELP}`);
        process.exitCode = 2;
        return;
      }
      await installSystemd();
      return;
    }
    case "uninstall": {
      if (argv[1] !== "--systemd") {
        process.stderr.write(`uninstall requires --systemd flag\n${HELP}`);
        process.exitCode = 2;
        return;
      }
      await uninstallSystemd();
      return;
    }
    case "status": {
      await statusCommand();
      return;
    }
    case "version": {
      process.stdout.write(`${DAEMON_VERSION}\n`);
      return;
    }
    case "help":
    case "--help":
    case "-h": {
      process.stdout.write(HELP);
      return;
    }
    default: {
      process.stderr.write(`Unknown command: ${cmd}\n${HELP}`);
      process.exitCode = 2;
    }
  }
}

// Placate biome unused-import check — readFile is reserved for future
// commands (status --detail will read state.json).
void readFile;

main(process.argv.slice(2)).catch((e) => {
  log.error("cli_fatal", { err: String(e) });
  process.exitCode = 1;
});
