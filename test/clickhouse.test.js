"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const Path = require("node:path");
const test = require("node:test");
const { buildReportFromClickHouse, syncDatabase } = require("../app");
const { createClickHouseBackend } = require("../lib/storage/clickhouse");
const { defaultOptions } = require("./support/fixtures");

function createSessionFile({ rows, project = "/tmp/project-clickhouse-test", sessionId = "019f4973-7053-7623-a798-0e4cf81ef014", parentSessionId = null }) {
  const filename = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-ch-session-test-")), "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { id: sessionId, ...(parentSessionId ? { forked_from_id: parentSessionId } : {}), cwd: project },
    }),
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { cwd: project, model: "gpt-5.4-mini", effort: "medium" },
    }),
  ];
  for (let i = 0; i < rows; i += 1) {
    lines.push(JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1,
          },
          model_context_window: 128_000,
        },
      },
    }));
  }
  fs.writeFileSync(filename, `${lines.join("\n")}\n`);
  return filename;
}

function createClickHouseServer({ failureStatus = null, failureBody = "", failureAfterInsert = null } = {}) {
  const requests = [];
  const inserts = {};
  const activeRows = {};
  const acceptedInsertCounts = {};
  let injectedFailureTriggered = false;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const queryParam = url.searchParams.get("query") || "";
      const bodyText = body.trim();
      const query = queryParam || (bodyText && !bodyText.startsWith("{") ? body : "");
      const requestInfo = {
        body,
        headers: request.headers,
        query,
        queryParam,
        url,
      };
      requests.push(requestInfo);

      const sendFailure = (status, message) => {
        response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
        response.end(message);
      };

      if (failureStatus !== null) {
        sendFailure(failureStatus, failureBody);
        return;
      }

      const insertMatch = query.trim().match(/^INSERT INTO ([a-z_]+) FORMAT JSONEachRow$/);
      if (insertMatch) {
        const table = insertMatch[1];
        const acceptedBatches = acceptedInsertCounts[table] || 0;
        if (
          failureAfterInsert
          && failureAfterInsert.table === table
          && !injectedFailureTriggered
          && acceptedBatches >= failureAfterInsert.acceptedBatches
        ) {
          injectedFailureTriggered = true;
          sendFailure(failureAfterInsert.status || 503, failureAfterInsert.body || "injected failure");
          return;
        }
        const rows = bodyText ? bodyText.split("\n").map((line) => JSON.parse(line)) : [];
        const insert = {
          bytes: Buffer.byteLength(body),
          body,
          rows: rows.length,
        };
        inserts[table] ??= [];
        inserts[table].push(insert);
        activeRows[table] ??= [];
        activeRows[table].push(...rows);
        acceptedInsertCounts[table] = acceptedBatches + 1;
      }

      const dropMatch = query.trim().match(/^DROP TABLE IF EXISTS ([a-z_]+)$/);
      if (dropMatch) {
        activeRows[dropMatch[1]] = [];
      }

      const deleteMatch = query.trim().match(/^ALTER TABLE ([a-z_]+) DELETE WHERE source_path = \{source:String\}$/);
      if (deleteMatch) {
        const table = deleteMatch[1];
        const sourcePath = url.searchParams.get("param_source");
        activeRows[table] = (activeRows[table] || []).filter((row) => row.source_path !== sourcePath);
      }

      if (query.includes("FROM sources") && query.includes("fingerprint")) {
        const sourcePath = url.searchParams.get("param_source");
        const source = (activeRows.sources || []).find((row) => row.source_path === sourcePath);
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(source ? `${JSON.stringify({ fingerprint: source.fingerprint })}\n` : "");
        return;
      }

      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      if (query.includes("FROM usage_events") && query.includes("UNION ALL")) {
        const usageRows = (activeRows.usage_events || []).length;
        response.end(`${JSON.stringify({
          bucket: "total",
          key1: "",
          key2: "",
          requests: usageRows,
          input: usageRows,
          cacheCreate5m: 0,
          cacheCreate30m: 0,
          cacheCreate1h: 0,
          cacheRead: 0,
          output: usageRows,
          reasoningOutput: 0,
          costUsd: 0,
          reasoningCostUsd: 0,
          costInputUsd: 0,
          costCacheCreate5mUsd: 0,
          costCacheCreate30mUsd: 0,
          costCacheCreate1hUsd: 0,
          costCacheReadUsd: 0,
          costOutputUsd: 0,
          pricedRequests: usageRows,
          unpricedRequests: 0,
          pricedInput: usageRows,
          pricedCacheCreate5m: 0,
          pricedCacheCreate30m: 0,
          pricedCacheCreate1h: 0,
          pricedCacheRead: 0,
          pricedOutput: usageRows,
          pricedReasoningOutput: 0,
        })}\n`);
      } else if (query.includes("FROM sources") && query.includes("countIf")) {
        response.end(JSON.stringify({ files: 1, zipEntries: 0, zipFiles: 0 }) + "\n");
      } else {
        response.end("");
      }
    });
  });
  return { acceptedInsertCounts, activeRows, inserts, requests, server };
}

async function withServer(mock, callback) {
  await new Promise((resolve, reject) => mock.server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  try {
    return await callback(`http://127.0.0.1:${mock.server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => mock.server.close((error) => error ? reject(error) : resolve()));
  }
}

test("ClickHouse backend exposes an independent factory", () => {
  const backend = createClickHouseBackend();
  assert.equal(typeof backend.buildReportFromClickHouse, "function");
  assert.equal(typeof backend.syncClickHouseDatabase, "function");
});

test("ClickHouse sync streams usage rows in bounded insert chunks", async () => {
  const rows = 20_050;
  const jsonl = createSessionFile({
    rows,
    project: "/tmp/project-clickhouse-stream",
    parentSessionId: "019f48d9-4ccc-73c2-bf45-a84e4951347e",
  });
  const mock = createClickHouseServer();

  await withServer(mock, async (url) => {
    const report = await syncDatabase(defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_stream_test",
      clickhouseInsertBatchRows: 100_000,
      clickhouseInsertBatchBytes: 64 * 1024,
      clickhouseReset: true,
      paths: [jsonl],
      progress: false,
    }));

    assert.equal(report.total.requests, rows);
    const queries = mock.requests.map((request) => request.query);
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS rate_limit_samples"));
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS usage_events"));
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS sessions"));
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS codex_sessions"));
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS sources"));
    assert.ok(queries.some((query) => (
      query.includes("CREATE TABLE IF NOT EXISTS codex_sessions")
      && query.includes("ReplacingMergeTree")
      && query.includes("parent_session_id")
    )));
    assert.ok(queries.some((query) => (
      query.includes("CREATE TABLE IF NOT EXISTS usage_events")
      && query.includes("CODEC(ZSTD(3))")
      && query.includes("CODEC(Delta, ZSTD(1))")
      && query.includes("CODEC(Gorilla, ZSTD(1))")
    )));
    const alter = queries.find((query) => query.trim().startsWith("ALTER TABLE usage_events"));
    assert.ok(alter, "long ALTER TABLE SQL should be observed from the request body");
    assert.match(alter, /ADD COLUMN IF NOT EXISTS visible_chars_per_token/);
    assert.equal(mock.inserts.usage_events.reduce((sum, insert) => sum + insert.rows, 0), rows);
    assert.ok(mock.inserts.usage_events.length > 1);
    assert.ok(mock.inserts.usage_events.every((insert) => insert.rows <= 100_000));
    assert.ok(mock.inserts.usage_events.every((insert) => insert.bytes <= 70 * 1024));
    assert.equal(mock.inserts.codex_sessions.length, 1);
    const storedSession = JSON.parse(mock.inserts.codex_sessions[0].body.trim());
    assert.equal(storedSession.session_id, "019f4973-7053-7623-a798-0e4cf81ef014");
    assert.equal(storedSession.parent_session_id, "019f48d9-4ccc-73c2-bf45-a84e4951347e");
    assert.equal(storedSession.source_path, jsonl);
    assert.equal(storedSession.kind, "jsonl");
    assert.equal(storedSession.archive_path, "");
    assert.equal(storedSession.entry_name, "");
    assert.ok(Number.isInteger(storedSession.updated_at_ms));
  });
});

test("ClickHouse usage sink flushes independently on the row limit", async () => {
  const rows = 5;
  const jsonl = createSessionFile({ rows });
  const mock = createClickHouseServer();

  await withServer(mock, async (url) => {
    await syncDatabase(defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_row_limit_test",
      clickhouseInsertBatchRows: 2,
      clickhouseInsertBatchBytes: 1024 * 1024,
      paths: [jsonl],
      progress: false,
    }));
  });

  assert.deepEqual(mock.inserts.usage_events.map((insert) => insert.rows), [2, 2, 1]);
  assert.equal(mock.inserts.usage_events.reduce((sum, insert) => sum + insert.rows, 0), rows);
});

test("ClickHouse retries an unmarked partial source without duplicating rows", async () => {
  const rows = 3;
  const jsonl = createSessionFile({ rows });
  const mock = createClickHouseServer({
    failureAfterInsert: {
      acceptedBatches: 1,
      body: "injected batch failure",
      table: "usage_events",
    },
  });

  await withServer(mock, async (url) => {
    const options = defaultOptions({
      dbEngine: "clickhouse",
      clickhouseDatabase: "tokenomics_retry_test",
      clickhouseInsertBatchBytes: 1024 * 1024,
      clickhouseInsertBatchRows: 2,
      clickhouseUrl: url,
      paths: [jsonl],
      progress: false,
    });

    await assert.rejects(syncDatabase(options), /injected batch failure/);
    assert.equal(mock.acceptedInsertCounts.usage_events, 1);
    assert.equal(mock.activeRows.usage_events.length, 2);
    assert.equal(mock.activeRows.sources?.length || 0, 0);

    const report = await syncDatabase(options);
    assert.equal(report.total.requests, rows);
    assert.equal(mock.activeRows.usage_events.length, rows);
    assert.equal(mock.activeRows.sessions.length, 1);
    assert.equal(mock.activeRows.codex_sessions.length, 1);
    assert.equal(mock.activeRows.sources.length, 1);

    const sourceDeletesAfterRetry = mock.requests.filter((request) => (
      request.query.trim().startsWith("ALTER TABLE")
      && request.url.searchParams.get("param_source") === jsonl
    )).length;
    assert.ok(sourceDeletesAfterRetry > 0);

    await syncDatabase(options);
    const sourceDeletesAfterUnchangedSync = mock.requests.filter((request) => (
      request.query.trim().startsWith("ALTER TABLE")
      && request.url.searchParams.get("param_source") === jsonl
    )).length;
    assert.equal(sourceDeletesAfterUnchangedSync, sourceDeletesAfterRetry);
    assert.equal(mock.activeRows.usage_events.length, rows);
  });
});

test("ClickHouse sync imports JSONL entries from ZIP sources", async () => {
  const jsonl = createSessionFile({ rows: 2 });
  const zip = Path.join(Path.dirname(jsonl), "sessions.zip");
  execFileSync("zip", ["-q", zip, Path.basename(jsonl)], { cwd: Path.dirname(jsonl) });
  const mock = createClickHouseServer();

  await withServer(mock, async (url) => {
    const report = await syncDatabase(defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_zip_test",
      paths: [zip],
      progress: false,
    }));
    assert.equal(report.total.requests, 2);
  });

  assert.equal(mock.inserts.usage_events.reduce((sum, insert) => sum + insert.rows, 0), 2);
  const storedSession = JSON.parse(mock.inserts.sessions[0].body.trim());
  assert.equal(storedSession.kind, "zip-entry");
  assert.equal(storedSession.archive_path, zip);
  assert.equal(storedSession.entry_name, Path.basename(jsonl));
});

test("ClickHouse usage sink flushes independently on the byte limit", async () => {
  const rows = 4;
  const jsonl = createSessionFile({
    rows,
    project: `/tmp/${"p".repeat(2_048)}`,
  });
  const mock = createClickHouseServer();

  await withServer(mock, async (url) => {
    await syncDatabase(defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_byte_limit_test",
      clickhouseInsertBatchRows: 100_000,
      clickhouseInsertBatchBytes: 1_024,
      paths: [jsonl],
      progress: false,
    }));
  });

  assert.equal(mock.inserts.usage_events.length, rows);
  assert.ok(mock.inserts.usage_events.every((insert) => insert.rows === 1));
  assert.ok(mock.inserts.usage_events.every((insert) => insert.bytes > 1_024));
});

test("ClickHouse bounds metadata, session, and source inserts by rows and bytes", async () => {
  const files = Array.from({ length: 20 }, (_, index) => createSessionFile({
    rows: 1,
    sessionId: `019f4973-7623-73a8-0e4c-${(0x0f81ef014 + index).toString(16).padStart(12, "0")}`,
  }));
  const batchRows = 3;
  const batchBytes = 2_048;
  const mock = createClickHouseServer();

  await withServer(mock, async (url) => {
    const report = await syncDatabase(defaultOptions({
      dbEngine: "clickhouse",
      clickhouseDatabase: "tokenomics_metadata_byte_limit_test",
      clickhouseInsertBatchBytes: batchBytes,
      clickhouseInsertBatchRows: batchRows,
      clickhouseUrl: url,
      paths: files,
      progress: false,
    }));
    assert.equal(report.total.requests, files.length);
  });

  for (const table of ["codex_sessions", "sessions", "sources"]) {
    assert.ok(mock.inserts[table]?.length > 0, `${table} should receive rows`);
    assert.ok(mock.inserts[table].every((insert) => insert.rows <= batchRows));
    assert.ok(mock.inserts[table].every((insert) => insert.rows === 1 || insert.bytes <= batchBytes));
  }
  assert.ok(mock.inserts.codex_sessions.length > 1, "header inserts should split on the byte limit");
});

test("ClickHouse requests carry database, auth, and bound query parameters", async () => {
  const jsonl = createSessionFile({ rows: 1 });
  const mock = createClickHouseServer();

  await withServer(mock, async (url) => {
    await syncDatabase(defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_auth_test",
      clickhouseUser: "test-user",
      clickhousePassword: "test-password",
      paths: [jsonl],
      progress: false,
    }));
  });

  assert.ok(mock.requests.length > 0);
  for (const request of mock.requests) {
    if (request.query.trim() !== "CREATE DATABASE IF NOT EXISTS `tokenomics_auth_test`") {
      assert.equal(request.url.searchParams.get("database"), "tokenomics_auth_test");
    }
    assert.equal(request.url.searchParams.get("output_format_json_quote_64bit_integers"), "0");
    assert.equal(request.headers.authorization, `Basic ${Buffer.from("test-user:test-password").toString("base64")}`);
  }
  assert.ok(mock.requests.some((request) => request.url.searchParams.get("param_source") === jsonl));
});

test("ClickHouse non-2xx responses include the server error", async () => {
  const mock = createClickHouseServer({ failureStatus: 503, failureBody: "backend unavailable" });

  await withServer(mock, async (url) => {
    await assert.rejects(
      buildReportFromClickHouse(defaultOptions({
        clickhouseUrl: url,
        clickhouseDatabase: "tokenomics_error_test",
      })),
      /ClickHouse query failed \(503\): backend unavailable/,
    );
  });
});
