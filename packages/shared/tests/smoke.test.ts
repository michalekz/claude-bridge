import { describe, expect, it } from "vitest";
import {
  atomicWriteJson,
  bridgeRoot,
  controlDir,
  daemonLockPath,
  eventsFilePath,
  goActivePath,
  makeLogger,
  requestPath,
  resultPath,
  stateFilePath,
} from "../src/index.ts";

describe("shared package smoke", () => {
  it("re-exports path helpers with a stable layout", () => {
    const root = bridgeRoot();
    expect(controlDir()).toBe(`${root}/control`);
    expect(daemonLockPath()).toBe(`${root}/control/daemon.lock`);
    expect(stateFilePath()).toBe(`${root}/control/state.json`);
    expect(eventsFilePath()).toBe(`${root}/control/events.jsonl`);
    expect(requestPath("req-1")).toBe(`${root}/control/requests/req-1.json`);
    expect(resultPath("req-1")).toBe(`${root}/control/results/req-1.json`);
    expect(goActivePath("go-42")).toBe(`${root}/go/active/go-42.json`);
  });

  it("exports atomicWriteJson + makeLogger", () => {
    expect(typeof atomicWriteJson).toBe("function");
    expect(typeof makeLogger).toBe("function");
    const log = makeLogger("smoke");
    expect(typeof log.info).toBe("function");
    expect(typeof log.child).toBe("function");
  });
});
