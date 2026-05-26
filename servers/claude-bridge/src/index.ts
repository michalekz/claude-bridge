#!/usr/bin/env node
import { startStdioServer } from "./mcp/server.ts";
import { makeLogger } from "./util/logger.ts";

const log = makeLogger("entry");

async function main(): Promise<void> {
  log.info("boot");
  try {
    await startStdioServer();
  } catch (e) {
    log.error("fatal", { err: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  }
}

void main();
