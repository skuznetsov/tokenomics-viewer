"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const Path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const {
  buildReportFromDatabase,
  buildReport,
  calculateCost,
  createLineProcessor,
  finalizeRateLimits,
  main,
  newReport,
  parseArgs,
  startWebServer,
  syncDatabase,
} = require("../app");

function defaultOptions(extra = {}) {
  return {
    source: "all",
    includeArchives: true,
    home: os.homedir(),
    format: "text",
    limitFiles: Number.POSITIVE_INFINITY,
    top: 25,
    openaiContext: "short",
    output: null,
    db: null,
    webserver: false,
    host: "127.0.0.1",
    port: 0,
    progress: false,
    strictJson: false,
    paths: [],
    ...extra,
  };
}

test("aggregates Claude by model, deduplicates requestId, and prices cache buckets", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "claude-fixture");
  const assistantLine = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-05T00:00:00.000Z",
    requestId: "req_duplicate",
    cwd: "/tmp/project-a",
    message: {
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 1_000_000,
        cache_creation_input_tokens: 300_000,
        cache_read_input_tokens: 300_000,
        output_tokens: 400_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 100_000,
          ephemeral_1h_input_tokens: 200_000,
        },
        output_tokens_details: {
          thinking_tokens: 100_000,
        },
      },
    },
  });

  processLine(assistantLine, 1);
  processLine(assistantLine, 2);

  assert.equal(report.total.requests, 1);
  assert.equal(report.models["claude-opus-4-8"].requests, 1);
  assert.equal(report.projects["/tmp/project-a"].requests, 1);
  assert.equal(report.total.reasoningOutput, 100_000);
  assert.equal(report.total.reasoningCostUsd, 2.5);
  assert.equal(report.efforts["<unknown>"].reasoningOutput, 100_000);
  assert.equal(Number(report.total.costUsd.toFixed(6)), 17.775);
  assert.deepEqual(roundCosts(report.total.costsUsd), {
    input: 5,
    cacheCreate5m: 0.625,
    cacheCreate1h: 2,
    cacheRead: 0.15,
    output: 10,
  });
});

test("aggregates Codex token_count by turn_context model and OpenAI cached input pricing", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "codex-fixture");

  processLine(JSON.stringify({
    type: "session_meta",
    timestamp: "2026-07-05T00:00:00.000Z",
    payload: { cwd: "/tmp/project-b", model_provider: "openai" },
  }), 1);
  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-05T00:00:01.000Z",
    payload: { cwd: "/tmp/project-b", model: "gpt-5.5", effort: "high" },
  }), 2);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-05T00:00:02.000Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 1_000_000,
          cached_input_tokens: 100_000,
          output_tokens: 200_000,
          reasoning_output_tokens: 50_000,
        },
        model_context_window: 258_400,
      },
    },
  }), 3);

  assert.equal(report.total.requests, 1);
  assert.equal(report.models["gpt-5.5"].cacheRead, 100_000);
  assert.equal(report.providers.openai.requests, 1);
  assert.equal(report.total.reasoningOutput, 50_000);
  assert.equal(report.total.reasoningCostUsd, 1.5);
  assert.equal(report.efforts.high.requests, 1);
  assert.equal(report.efforts.high.reasoningOutput, 50_000);
  assert.equal(report.modelEfforts["gpt-5.5"].high.reasoningCostUsd, 1.5);
  assert.equal(Number(report.total.costUsd.toFixed(6)), 10.55);
  assert.deepEqual(roundCosts(report.total.costsUsd), {
    input: 4.5,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    cacheRead: 0.05,
    output: 6,
  });
});

test("attributes Codex rate limit consumption by effort and window", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "codex-rate-fixture");

  const emitTurn = (lineNo, timestamp, effort) => {
    processLine(JSON.stringify({
      type: "turn_context",
      timestamp,
      payload: { cwd: "/tmp/project-rate", model: "gpt-5-codex", effort },
    }), lineNo);
  };
  const emitTokenCount = (lineNo, timestamp, input, primaryUsed, secondaryUsed, primaryReset = 1_800_000_000) => {
    processLine(JSON.stringify({
      type: "event_msg",
      timestamp,
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: input,
            cached_input_tokens: Math.floor(input / 2),
            output_tokens: 1_000,
            reasoning_output_tokens: 100,
          },
          model_context_window: 128_000,
        },
        rate_limits: {
          limit_id: "codex",
          limit_name: "Codex",
          plan_type: "pro",
          primary: { used_percent: primaryUsed, window_minutes: 300, resets_at: primaryReset },
          secondary: { used_percent: secondaryUsed, window_minutes: 10080, resets_at: 1_800_400_000 },
        },
      },
    }), lineNo);
  };

  emitTurn(1, "2026-07-05T00:00:00.000Z", "low");
  emitTokenCount(2, "2026-07-05T00:00:10.000Z", 10_000, 10, 20);
  emitTokenCount(3, "2026-07-05T00:10:10.000Z", 20_000, 15, 22);
  emitTurn(4, "2026-07-05T00:10:20.000Z", "high");
  emitTokenCount(5, "2026-07-05T00:20:10.000Z", 30_000, 30, 23);
  emitTokenCount(6, "2026-07-05T05:10:10.000Z", 40_000, 3, 24, 1_800_018_000);
  finalizeRateLimits(report);

  const primary = report.rateLimits.windows["codex/codex:primary_300m"];
  assert.equal(primary.agent, "codex");
  assert.equal(primary.samples, 4);
  assert.equal(primary.increases, 2);
  assert.equal(primary.resets, 1);
  assert.equal(primary.percentUsedDelta, 20);
  assert.equal(primary.byEffort.low.percentUsedDelta, 5);
  assert.equal(primary.byEffort.high.percentUsedDelta, 15);
  assert.equal(primary.byModelEffort["gpt-5-codex"].high.percentUsedDelta, 15);
  assert.equal(primary.latestUsedPercent, 3);
  assert.equal(primary.latestRemainingPercent, 97);

  const secondary = report.rateLimits.windows["codex/codex:secondary_10080m"];
  assert.equal(secondary.samples, 4);
  assert.equal(secondary.increases, 3);
  assert.equal(secondary.percentUsedDelta, 4);
  assert.equal(secondary.latestRemainingPercent, 76);
});

test("aggregates Codex rate limits by day and week agent buckets", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "codex-rate-period-fixture");

  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-06T12:00:00.000Z",
    payload: { cwd: "/tmp/project-rate-period", model: "gpt-5-codex", effort: "xhigh" },
  }), 1);

  const emitTokenCount = (lineNo, timestamp, input, usedPercent) => {
    processLine(JSON.stringify({
      type: "event_msg",
      timestamp,
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: input,
            cached_input_tokens: Math.floor(input / 2),
            output_tokens: 1_000,
          },
          model_context_window: 128_000,
        },
        rate_limits: {
          limit_id: "codex",
          limit_name: "Codex",
          primary: { used_percent: usedPercent, window_minutes: 300, resets_at: 1_800_000_000 },
        },
      },
    }), lineNo);
  };

  emitTokenCount(2, "2026-07-06T12:05:00.000Z", 10_000, 20);
  emitTokenCount(3, "2026-07-06T12:15:00.000Z", 20_000, 35);
  finalizeRateLimits(report);

  const daily = report.rateLimits.daily["codex/2026-07-06/codex:primary_300m"];
  assert.equal(daily.agent, "codex");
  assert.equal(daily.period, "2026-07-06");
  assert.equal(daily.samples, 2);
  assert.equal(daily.percentUsedDelta, 15);
  assert.equal(daily.byEffort.xhigh.percentUsedDelta, 15);

  const weekly = report.rateLimits.weekly["codex/2026-W28/codex:primary_300m"];
  assert.equal(weekly.agent, "codex");
  assert.equal(weekly.period, "2026-W28");
  assert.equal(weekly.percentUsedDelta, 15);
});

test("sorts Codex rate limit snapshots before calculating deltas", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "codex-rate-order-fixture");

  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-05T00:00:00.000Z",
    payload: { cwd: "/tmp/project-rate-order", model: "gpt-5-codex", effort: "high" },
  }), 1);

  const emitTokenCount = (lineNo, timestamp, usedPercent) => {
    processLine(JSON.stringify({
      type: "event_msg",
      timestamp,
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 10_000,
            cached_input_tokens: 5_000,
            output_tokens: 500,
          },
          model_context_window: 128_000,
        },
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: usedPercent, window_minutes: 300, resets_at: 1_800_000_000 },
        },
      },
    }), lineNo);
  };

  emitTokenCount(2, "2026-07-05T00:00:10.000Z", 10);
  emitTokenCount(3, "2026-07-05T00:20:10.000Z", 25);
  emitTokenCount(4, "2026-07-05T00:10:10.000Z", 20);
  finalizeRateLimits(report);

  const primary = report.rateLimits.windows["codex/codex:primary_300m"];
  assert.equal(primary.samples, 3);
  assert.equal(primary.increases, 2);
  assert.equal(primary.outOfOrder, 0);
  assert.equal(primary.resets, 0);
  assert.equal(primary.percentUsedDelta, 15);
});

test("aggregates Codex token_count by total deltas and skips duplicate snapshots", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "codex-delta-fixture");

  processLine(JSON.stringify({
    type: "session_meta",
    timestamp: "2026-07-05T00:00:00.000Z",
    payload: { cwd: "/tmp/project-delta", model_provider: "openai" },
  }), 1);
  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-05T00:00:01.000Z",
    payload: { cwd: "/tmp/project-delta", model: "gpt-5-codex" },
  }), 2);

  const firstInfo = {
    total_token_usage: {
      input_tokens: 1_000_000,
      cached_input_tokens: 100_000,
      output_tokens: 200_000,
      reasoning_output_tokens: 100_000,
      total_tokens: 1_200_000,
    },
    last_token_usage: {
      input_tokens: 1_000_000,
      cached_input_tokens: 100_000,
      output_tokens: 200_000,
      reasoning_output_tokens: 100_000,
      total_tokens: 1_200_000,
    },
    model_context_window: 128_000,
  };

  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-05T00:00:02.000Z",
    payload: { type: "token_count", info: firstInfo },
  }), 3);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-05T00:00:03.000Z",
    payload: { type: "token_count", info: firstInfo },
  }), 4);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-05T00:00:04.000Z",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 1_500_000,
          cached_input_tokens: 150_000,
          output_tokens: 250_000,
          reasoning_output_tokens: 120_000,
          total_tokens: 1_750_000,
        },
        last_token_usage: {
          input_tokens: 500_000,
          cached_input_tokens: 50_000,
          output_tokens: 50_000,
          reasoning_output_tokens: 20_000,
          total_tokens: 550_000,
        },
        model_context_window: 128_000,
      },
    },
  }), 5);

  assert.equal(report.sources.tokenCountSnapshots, 3);
  assert.equal(report.sources.skippedTokenCountSnapshots, 1);
  assert.equal(report.total.requests, 2);
  assert.equal(report.total.input, 1_500_000);
  assert.equal(report.total.cacheRead, 150_000);
  assert.equal(report.total.output, 250_000);
  assert.equal(report.total.reasoningOutput, 120_000);
  assert.equal(Number(report.total.costUsd.toFixed(6)), 4.20625);
  assert.deepEqual(roundCosts(report.total.costsUsd), {
    input: 1.6875,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    cacheRead: 0.01875,
    output: 2.5,
  });
});

test("treats Codex total counter decreases as a fresh sequence", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "codex-reset-fixture");

  processLine(JSON.stringify({
    type: "session_meta",
    timestamp: "2026-07-05T00:00:00.000Z",
    payload: { cwd: "/tmp/project-reset", model_provider: "openai" },
  }), 1);
  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-05T00:00:01.000Z",
    payload: { cwd: "/tmp/project-reset", model: "gpt-5-codex" },
  }), 2);

  const emitTokenCount = (lineNo, timestamp, total) => {
    processLine(JSON.stringify({
      type: "event_msg",
      timestamp,
      payload: {
        type: "token_count",
        info: {
          total_token_usage: total,
          last_token_usage: total,
          model_context_window: 128_000,
        },
      },
    }), lineNo);
  };

  emitTokenCount(3, "2026-07-05T00:00:02.000Z", {
    input_tokens: 1_000_000,
    cached_input_tokens: 900_000,
    output_tokens: 10_000,
    total_tokens: 1_010_000,
  });
  emitTokenCount(4, "2026-07-05T00:00:03.000Z", {
    input_tokens: 100_000,
    cached_input_tokens: 90_000,
    output_tokens: 1_000,
    total_tokens: 101_000,
  });
  emitTokenCount(5, "2026-07-05T00:00:04.000Z", {
    input_tokens: 150_000,
    cached_input_tokens: 120_000,
    output_tokens: 2_000,
    total_tokens: 152_000,
  });

  assert.equal(report.sources.tokenCountSnapshots, 3);
  assert.equal(report.sources.skippedTokenCountSnapshots, 0);
  assert.equal(report.total.requests, 3);
  assert.equal(report.total.input, 1_150_000);
  assert.equal(report.total.cacheRead, 1_020_000);
  assert.equal(report.total.output, 12_000);
});

test("prices current Codex model ids", () => {
  const cost = calculateCost("openai", "gpt-5-codex", {
    input: 1_000_000,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    cacheRead: 100_000,
    output: 200_000,
    contextWindow: 258_400,
  }, new Date("2026-07-05T00:00:00.000Z"), defaultOptions());

  assert.equal(cost.known, true);
  assert.equal(Number(cost.amount.toFixed(6)), 3.1375);

  const versionedCost = calculateCost("openai", "gpt-5.1-2026-01-15", {
    input: 1_000_000,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    cacheRead: 100_000,
    output: 200_000,
    contextWindow: 258_400,
  }, new Date("2026-07-05T00:00:00.000Z"), defaultOptions());

  assert.equal(versionedCost.known, true);
  assert.equal(Number(versionedCost.amount.toFixed(6)), 3.1375);

  const sparkCost = calculateCost("openai", "gpt-5.3-codex-spark", {
    input: 1_000_000,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    cacheRead: 100_000,
    output: 200_000,
    contextWindow: 258_400,
  }, new Date("2026-07-05T00:00:00.000Z"), defaultOptions());

  assert.equal(sparkCost.known, false);
});

test("parseArgs keeps stdout JSON clean unless progress is explicit", () => {
  assert.equal(parseArgs(["--json"]).progress, false);
  assert.equal(parseArgs(["--json", "--progress"]).progress, true);

  const outputOptions = parseArgs(["--output", "report.json"]);
  assert.equal(outputOptions.format, "json");
  assert.equal(outputOptions.progress, true);
});

test("buildReport scans explicit JSONL path and zip archives", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-test-"));
  const jsonl = Path.join(tmp, "session.jsonl");
  fs.writeFileSync(jsonl, [
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { cwd: "/tmp/project-c", model: "gpt-5.4-mini" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1_000_000,
            cached_input_tokens: 0,
            output_tokens: 1_000_000,
          },
          model_context_window: 128_000,
        },
      },
    }),
    "",
  ].join("\n"));

  const zipPath = Path.join(tmp, "sessions.zip");
  execFileSync("zip", ["-q", zipPath, "session.jsonl"], { cwd: tmp });

  const report = await buildReport(defaultOptions({ paths: [zipPath] }));
  assert.equal(report.sources.zipFiles, 1);
  assert.equal(report.sources.zipEntries, 1);
  assert.equal(report.models["gpt-5.4-mini"].requests, 1);
  assert.equal(Number(report.total.costUsd.toFixed(6)), 5.25);
});

test("main writes final JSON report with per-session metrics", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-output-test-"));
  const jsonl = Path.join(tmp, "session.jsonl");
  const output = Path.join(tmp, "report.json");

  fs.writeFileSync(jsonl, [
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { cwd: "/tmp/project-d", model: "gpt-5-codex" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1_000_000,
            cached_input_tokens: 100_000,
            output_tokens: 200_000,
          },
          model_context_window: 128_000,
        },
      },
    }),
    "",
  ].join("\n"));

  const report = await main(["--no-progress", "--output", output, jsonl]);
  const written = JSON.parse(fs.readFileSync(output, "utf8"));

  assert.equal(report.sessions.length, 1);
  assert.equal(written.sessions.length, 1);
  assert.equal(written.sessions[0].path, jsonl);
  assert.equal(written.sessions[0].lines, 2);
  assert.equal(written.sessions[0].records, 2);
  assert.equal(written.sessions[0].stats.requests, 1);
  assert.equal(written.sessions[0].stats.input, 1_000_000);
  assert.equal(written.sessions[0].stats.cacheRead, 100_000);
  assert.equal(written.sessions[0].stats.output, 200_000);
  assert.equal(Number(written.sessions[0].stats.costUsd.toFixed(6)), 3.1375);
  assert.deepEqual(roundCosts(written.sessions[0].stats.costsUsd), {
    input: 1.125,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    cacheRead: 0.0125,
    output: 2,
  });
  assert.ok(written.sessions[0].durationMs >= 0);
});

test("syncDatabase imports sources idempotently and replaces changed sessions", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-db-test-"));
  const jsonl = Path.join(tmp, "session.jsonl");
  const db = Path.join(tmp, "tokenomics.sqlite");

  const writeSession = (outputTokens) => fs.writeFileSync(jsonl, [
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { cwd: "/tmp/project-db", model: "gpt-5-codex", effort: "high" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1_000_000,
            cached_input_tokens: 100_000,
            output_tokens: outputTokens,
          },
          model_context_window: 128_000,
        },
      },
    }),
    "",
  ].join("\n"));

  writeSession(200_000);
  const first = await syncDatabase(defaultOptions({ db, paths: [jsonl] }));
  const second = await syncDatabase(defaultOptions({ db, paths: [jsonl] }));

  assert.equal(first.total.requests, 1);
  assert.equal(second.total.requests, 1);
  assert.equal(second.total.output, 200_000);
  assert.equal(second.sessions.length, 1);

  writeSession(300_000);
  const updated = await syncDatabase(defaultOptions({ db, paths: [jsonl] }));
  assert.equal(updated.total.requests, 1);
  assert.equal(updated.total.output, 300_000);
  assert.equal(updated.sessions[0].stats.output, 300_000);

  const fromDb = buildReportFromDatabase(db, defaultOptions());
  assert.equal(fromDb.total.requests, 1);
  assert.equal(fromDb.total.output, 300_000);
});

test("web server serves stored SQLite summary and sessions", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-web-test-"));
  const jsonl = Path.join(tmp, "session.jsonl");
  const db = Path.join(tmp, "tokenomics.sqlite");

  fs.writeFileSync(jsonl, [
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { cwd: "/tmp/project-web", model: "gpt-5.4-mini", effort: "medium" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1_000_000,
            cached_input_tokens: 0,
            output_tokens: 1_000_000,
          },
          model_context_window: 128_000,
        },
      },
    }),
    "",
  ].join("\n"));

  await syncDatabase(defaultOptions({ db, paths: [jsonl] }));
  const server = await startWebServer(defaultOptions({ db, host: "127.0.0.1", port: 0 }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const summary = await fetch(`${base}/api/summary`).then((response) => response.json());
    assert.equal(summary.total.requests, 1);
    assert.equal(summary.total.output, 1_000_000);
    assert.equal(summary.topModels[0].name, "gpt-5.4-mini");

    const sessions = await fetch(`${base}/api/sessions`).then((response) => response.json());
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].path, jsonl);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function roundCosts(costs) {
  return Object.fromEntries(
    Object.entries(costs).map(([key, value]) => [key, Number(value.toFixed(6))]),
  );
}
