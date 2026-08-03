#!/usr/bin/env node
/**
 * Release manifest tool.
 *
 * The version used to live in six places by hand and had already drifted:
 * plugin.json / marketplace.json / daemon said 0.10.0-rc.2, the MCP server
 * package.json said 0.9.4, packages/shared said 0.10.0-alpha.0, and
 * src/mcp/server.ts carried a hardcoded "0.9.4" that nobody had bumped since
 * v0.9.4 — so `peer_list` misreported every peer's version for five releases.
 *
 * Now there is one source of truth and two derived layers:
 *
 *   .claude-plugin/plugin.json  version   <- SOURCE OF TRUTH for a branch
 *     |- servers/claude-bridge/package.json
 *     |- servers/claude-bridge-daemon/package.json
 *     |- packages/shared/package.json
 *          `- src/mcp/server.ts reads its package.json at build time (esbuild
 *             inlines it), so the code can no longer disagree.
 *
 *   .claude-plugin/marketplace.json       <- CATALOG, lives on main only,
 *     one entry per release channel, each pinned to a tag + commit.
 *
 * Usage:
 *   node scripts/release.mjs check
 *       Verify every manifest agrees. Run by .githooks/pre-push.
 *
 *   node scripts/release.mjs set --version 0.10.1-rc.1 [--name claude-bridge-dev]
 *       Write the version into plugin.json and all package.json files.
 *       `--name` sets the plugin identity for the branch's channel:
 *       `claude-bridge` on main, `claude-bridge-dev` on develop.
 *
 *   node scripts/release.mjs catalog --channel dev --version 0.10.1-rc.1 \
 *                            --ref v0.10.1-rc.1 [--sha <commit>]
 *       Point a catalog entry at a tag. Run on main.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PLUGIN_MANIFEST = ".claude-plugin/plugin.json";
const CATALOG = ".claude-plugin/marketplace.json";
/** Every package.json whose version must equal the plugin manifest's. */
const PACKAGES = [
  "servers/claude-bridge/package.json",
  "servers/claude-bridge-daemon/package.json",
  "packages/shared/package.json",
];

/** Catalog entry name per release channel. Must be unique within a marketplace. */
const CHANNEL_PLUGIN_NAME = {
  stable: "claude-bridge",
  dev: "claude-bridge-dev",
};

function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf-8"));
}

function writeJson(rel, obj) {
  writeFileSync(join(ROOT, rel), `${JSON.stringify(obj, null, 2)}\n`, "utf-8");
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

// ---------------------------------------------------------------- check

function cmdCheck() {
  const plugin = readJson(PLUGIN_MANIFEST);
  const version = plugin.version;
  let ok = true;

  if (!version) {
    fail(`${PLUGIN_MANIFEST} has no version`);
    return;
  }
  const validNames = Object.values(CHANNEL_PLUGIN_NAME);
  if (!validNames.includes(plugin.name)) {
    fail(`${PLUGIN_MANIFEST} name '${plugin.name}' is not one of ${validNames.join(" / ")}`);
    ok = false;
  }

  for (const rel of PACKAGES) {
    const pkg = readJson(rel);
    if (pkg.version !== version) {
      fail(`${rel} version ${pkg.version} != ${PLUGIN_MANIFEST} ${version}`);
      ok = false;
    }
  }

  // The catalog only exists on the release branch; skip when it does not list
  // this plugin (e.g. a topic branch that never carries the catalog).
  let catalog = null;
  try {
    catalog = readJson(CATALOG);
  } catch {
    // no catalog on this branch — nothing more to check
  }
  if (catalog) {
    const names = new Set();
    for (const entry of catalog.plugins ?? []) {
      if (names.has(entry.name)) {
        fail(`${CATALOG} lists '${entry.name}' twice — names must be unique per marketplace`);
        ok = false;
      }
      names.add(entry.name);
      if (!entry.source?.ref && !entry.source?.sha) {
        fail(`${CATALOG} entry '${entry.name}' pins neither ref nor sha`);
        ok = false;
      }
      if (entry.version && entry.source?.ref && entry.source.ref !== `v${entry.version}`) {
        fail(
          `${CATALOG} entry '${entry.name}': version ${entry.version} does not match ref ${entry.source.ref}`,
        );
        ok = false;
      }
    }
  }

  if (ok) console.log(`✓ manifests agree on ${version} (plugin '${plugin.name}')`);
}

// ------------------------------------------------------------------ set

function cmdSet(args) {
  const version = args.version;
  if (!version || version === true) {
    fail("set requires --version <x.y.z>");
    return;
  }
  const plugin = readJson(PLUGIN_MANIFEST);
  const before = plugin.version;
  plugin.version = version;

  if (args.name && args.name !== true) {
    const validNames = Object.values(CHANNEL_PLUGIN_NAME);
    if (!validNames.includes(args.name)) {
      fail(`--name must be one of ${validNames.join(" / ")}`);
      return;
    }
    plugin.name = args.name;
  }
  writeJson(PLUGIN_MANIFEST, plugin);
  console.log(`  ${PLUGIN_MANIFEST}: ${before} -> ${version} (name '${plugin.name}')`);

  for (const rel of PACKAGES) {
    const pkg = readJson(rel);
    const was = pkg.version;
    pkg.version = version;
    writeJson(rel, pkg);
    console.log(`  ${rel}: ${was} -> ${version}`);
  }
  console.log("✓ manifests written — src/mcp/server.ts follows package.json at build time");
}

// -------------------------------------------------------------- catalog

function cmdCatalog(args) {
  const channel = args.channel;
  if (!channel || !(channel in CHANNEL_PLUGIN_NAME)) {
    fail(`catalog requires --channel ${Object.keys(CHANNEL_PLUGIN_NAME).join("|")}`);
    return;
  }
  const wantedName = CHANNEL_PLUGIN_NAME[channel];
  const catalog = readJson(CATALOG);
  const entry = (catalog.plugins ?? []).find((p) => p.name === wantedName);
  if (!entry) {
    fail(`${CATALOG} has no entry named '${wantedName}' — add it before pointing it at a tag`);
    return;
  }
  if (args.version && args.version !== true) {
    entry.version = args.version;
  }
  if (args.ref && args.ref !== true) {
    entry.source.ref = args.ref;
  }
  if (args.sha && args.sha !== true) {
    entry.source.sha = args.sha;
  }
  writeJson(CATALOG, catalog);
  console.log(
    `✓ ${channel}: '${wantedName}' -> version ${entry.version}, ref ${entry.source.ref}` +
      (entry.source.sha ? `, sha ${String(entry.source.sha).slice(0, 12)}` : ""),
  );
}

// ----------------------------------------------------------------- main

const [, , cmd, ...rest] = process.argv;
const args = parseArgs(rest);

switch (cmd) {
  case "check":
    cmdCheck();
    break;
  case "set":
    cmdSet(args);
    break;
  case "catalog":
    cmdCatalog(args);
    break;
  default:
    console.error("usage: release.mjs check | set --version X [--name N] | catalog --channel C ...");
    process.exitCode = 2;
}
