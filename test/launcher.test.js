"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const Path = require("node:path");
const test = require("node:test");
const {
  browserCommand,
  chooseDatabaseEngine,
  ensureClickHouse,
  launcherAppArgs,
  loadLauncherState,
  launcherDataPath,
  parseLauncherArgs,
  resetClickHouseChoice,
  runLauncher,
  saveLauncherState,
  waitForDashboardProcess,
} = require("../lib/launcher");

test("browser command uses the platform default opener", () => {
  const url = "http://127.0.0.1:8787";
  assert.deepEqual(browserCommand("darwin", url), { command: "open", args: [url] });
  assert.deepEqual(browserCommand("linux", url), { command: "xdg-open", args: [url] });
  assert.deepEqual(browserCommand("win32", url), { command: "cmd", args: ["/c", "start", "", url] });
});

test("launcher arguments keep orchestration flags separate from app arguments", () => {
  assert.deepEqual(parseLauncherArgs([
    "--clickhouse",
    "--no-open",
    "--port", "9001",
    "--",
    "--source", "codex",
  ]), {
    forceEngine: "clickhouse",
    noOpen: true,
    port: 9001,
    resetClickHouseChoice: false,
    appArgs: ["--source", "codex"],
  });
  assert.throws(() => parseLauncherArgs(["--sqlite", "--clickhouse"]), /only one/);
  assert.throws(() => parseLauncherArgs(["--port", "nope"]), /port/);
});

test("remembered ClickHouse choices avoid repeated prompts", async () => {
  let prompts = 0;
  const ask = async () => { prompts += 1; return false; };

  const first = await chooseDatabaseEngine({ state: {}, interactive: true, clickhouseDetected: false, ask });
  assert.deepEqual(first, { engine: "sqlite", rememberedChoice: "declined", changed: true });
  const second = await chooseDatabaseEngine({
    state: { clickhouseChoice: first.rememberedChoice },
    interactive: true,
    clickhouseDetected: false,
    ask,
  });
  assert.deepEqual(second, { engine: "sqlite", rememberedChoice: "declined", changed: false });
  assert.equal(prompts, 1);
});

test("explicit engine override does not rewrite the remembered choice", async () => {
  const result = await chooseDatabaseEngine({
    state: { clickhouseChoice: "declined" },
    forceEngine: "clickhouse",
    interactive: true,
    clickhouseDetected: false,
    ask: async () => { throw new Error("must not prompt"); },
  });
  assert.deepEqual(result, { engine: "clickhouse", rememberedChoice: "declined", changed: false });
});

test("reset removes only the ClickHouse prompt choice", () => {
  assert.deepEqual(resetClickHouseChoice({ clickhouseChoice: "declined", futureSetting: 7 }), { futureSetting: 7 });
});

test("ClickHouse setup skips installation when healthy", async () => {
  const calls = [];
  await ensureClickHouse({
    healthCheck: async () => true,
    findChctl: async () => { calls.push("find"); return "/bin/chctl"; },
    installChctl: async () => calls.push("install"),
    runCommand: async () => calls.push("run"),
    waitForHealth: async () => calls.push("wait"),
  });
  assert.deepEqual(calls, []);
});

test("ClickHouse setup installs CLI, selects stable, and starts the named server", async () => {
  const calls = [];
  let findCalls = 0;
  await ensureClickHouse({
    healthCheck: async () => false,
    findChctl: async () => (++findCalls === 1 ? null : "/home/user/.local/bin/chctl"),
    installChctl: async () => calls.push(["install"]),
    runCommand: async (command, args) => calls.push([command, ...args]),
    waitForHealth: async () => calls.push(["wait"]),
  });
  assert.deepEqual(calls, [
    ["install"],
    ["/home/user/.local/bin/chctl", "local", "use", "stable"],
    ["/home/user/.local/bin/chctl", "local", "server", "start", "--name", "tokenomics", "--http-port", "8123", "--tcp-port", "9000"],
    ["wait"],
  ]);
});

test("ClickHouse setup retries an existing named server without redefining ports", async () => {
  const calls = [];
  let startCalls = 0;
  await ensureClickHouse({
    healthCheck: async () => false,
    findChctl: async () => "/bin/chctl",
    installChctl: async () => { throw new Error("must not install"); },
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      if (args.includes("--http-port") && ++startCalls === 1) throw new Error("server already exists");
    },
    waitForHealth: async () => calls.push(["wait"]),
  });
  assert.deepEqual(calls.at(-2), ["/bin/chctl", "local", "server", "start", "--name", "tokenomics"]);
  assert.deepEqual(calls.at(-1), ["wait"]);
});

test("launcher app arguments enforce sync and selected engine after user arguments", () => {
  assert.deepEqual(launcherAppArgs({
    engine: "clickhouse",
    port: 8789,
    appArgs: ["--source", "codex", "--no-sync"],
  }), [
    "--source", "codex", "--no-sync",
    "--sync", "--webserver", "--host", "127.0.0.1", "--port", "8789", "--db-engine", "clickhouse",
  ]);
});

test("launcher stores SQLite data outside the application release", () => {
  assert.equal(
    launcherDataPath({ TOKENOMICS_DATA_HOME: "/var/tokenomics-data" }, "/home/user"),
    Path.join("/var/tokenomics-data", "tokenomics-viewer", "tokenomics.sqlite"),
  );
  assert.equal(
    launcherDataPath({ XDG_DATA_HOME: "/home/user/.xdg-data" }, "/home/user"),
    Path.join("/home/user/.xdg-data", "tokenomics-viewer", "tokenomics.sqlite"),
  );
  assert.equal(
    launcherDataPath({}, "/home/user"),
    Path.join("/home/user", ".local", "share", "tokenomics-viewer", "tokenomics.sqlite"),
  );
});

test("launcher pins SQLite to its persistent data path", () => {
  assert.deepEqual(launcherAppArgs({
    engine: "sqlite",
    port: 8787,
    sqliteDb: "/data/tokenomics.sqlite",
    appArgs: ["--db", "/tmp/disposable.sqlite"],
  }), [
    "--db", "/tmp/disposable.sqlite",
    "--sync", "--webserver", "--host", "127.0.0.1", "--port", "8787",
    "--db-engine", "sqlite", "--db", "/data/tokenomics.sqlite",
  ]);
});

test("launcher reuses an existing dashboard and starts a protected sync", async () => {
  const calls = [];
  const exitCode = await runLauncher([], {
    loadState: async () => ({}),
    saveState: async () => calls.push("save"),
    dashboardReady: async () => true,
    triggerSync: async () => calls.push("sync"),
    openBrowser: async () => calls.push("open"),
    log: (message) => calls.push(message),
  });
  assert.equal(exitCode, 0);
  assert.ok(calls.includes("sync"));
  assert.ok(calls.includes("open"));
  assert.equal(calls.includes("save"), false);
});

test("browser opener failure does not fail an otherwise ready dashboard", async () => {
  const messages = [];
  const exitCode = await runLauncher([], {
    loadState: async () => ({}),
    saveState: async () => {},
    dashboardReady: async () => true,
    triggerSync: async () => {},
    openBrowser: async () => { throw new Error("no opener"); },
    log: (message) => messages.push(message),
  });
  assert.equal(exitCode, 0);
  assert.ok(messages.some((message) => /could not open.*no opener/i.test(message)));
  assert.ok(messages.some((message) => /http:\/\/127\.0\.0\.1:8787/.test(message)));
});

test("launcher honors remembered SQLite choice and opens after readiness", async () => {
  const calls = [];
  const exitCode = await runLauncher([], {
    loadState: async () => ({ clickhouseChoice: "declined" }),
    saveState: async () => calls.push("save"),
    dashboardReady: async () => false,
    clickhouseDetected: async () => { throw new Error("must not detect after remembered decline"); },
    findAvailablePort: async () => 8791,
    spawnTokenomics: async (args) => {
      calls.push(["spawn", ...args]);
      return { exit: Promise.resolve(0), stop: () => calls.push("stop") };
    },
    waitForDashboard: async () => calls.push("ready"),
    openBrowser: async () => calls.push("open"),
    sqliteDb: "/data/tokenomics.sqlite",
    interactive: false,
    log: () => {},
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    ["spawn", "--sync", "--webserver", "--host", "127.0.0.1", "--port", "8791", "--db-engine", "sqlite", "--db", "/data/tokenomics.sqlite"],
    "ready",
    "open",
  ]);
});

test("reset flag persists the reduced state and exits without launching", async () => {
  const calls = [];
  const exitCode = await runLauncher(["--reset-clickhouse-choice"], {
    loadState: async () => ({ clickhouseChoice: "accepted", futureSetting: true }),
    saveState: async (state) => calls.push(state),
    dashboardReady: async () => { throw new Error("must not inspect dashboard"); },
    log: (message) => calls.push(message),
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(calls[0], { futureSetting: true });
  assert.match(calls[1], /reset/i);
});

test("dashboard readiness fails promptly when the server process exits", async () => {
  await assert.rejects(
    waitForDashboardProcess(
      "http://127.0.0.1:8787",
      { exit: Promise.resolve(12) },
      async () => false,
      { timeoutMs: 10_000, intervalMs: 1 },
    ),
    /exit code 12/,
  );
});

test("explicit engine override does not reuse a dashboard with an unknown engine", async () => {
  const calls = [];
  await runLauncher(["--clickhouse", "--no-open"], {
    loadState: async () => ({}),
    saveState: async () => {},
    dashboardReady: async () => true,
    triggerSync: async () => calls.push("reuse"),
    ensureClickHouse: async () => calls.push("clickhouse"),
    findAvailablePort: async () => 8792,
    spawnTokenomics: async () => ({ exit: Promise.resolve(0), stop: () => {} }),
    waitForDashboard: async () => calls.push("ready"),
    interactive: false,
    log: () => {},
  });
  assert.deepEqual(calls, ["clickhouse", "ready"]);
});

test("launcher state is written atomically and malformed state fails open", async () => {
  const directory = await fs.mkdtemp(Path.join(os.tmpdir(), "tokenomics-launcher-state-"));
  const filename = Path.join(directory, "nested", "launcher.json");
  await saveLauncherState(filename, { clickhouseChoice: "accepted" });
  assert.deepEqual(await loadLauncherState(filename), { clickhouseChoice: "accepted" });
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  }
  await fs.writeFile(filename, "not-json");
  assert.deepEqual(await loadLauncherState(filename), {});
});
