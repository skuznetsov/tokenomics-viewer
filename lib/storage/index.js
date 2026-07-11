"use strict";

const { createClickHouseBackend } = require("./clickhouse");
const { createSqliteBackend } = require("./sqlite");

const DEFAULT_DB_ENGINE = "sqlite";

function createStorage({ ingest, ...sharedDependencies } = {}) {
  const backendDependencies = {
    ...sharedDependencies,
    ...(ingest || {}),
  };
  const sqlite = createSqliteBackend(backendDependencies);
  const clickhouse = createClickHouseBackend(backendDependencies);

  function selectedDbEngine(options = {}) {
    return options.dbEngine || DEFAULT_DB_ENGINE;
  }

  async function syncDatabase(options) {
    if (selectedDbEngine(options) === "clickhouse") return clickhouse.syncClickHouseDatabase(options);
    return sqlite.syncSqliteDatabase(options);
  }

  async function buildReportFromSelectedDatabase(options = {}) {
    if (selectedDbEngine(options) === "clickhouse") return clickhouse.buildReportFromClickHouse(options);
    return sqlite.buildReportFromDatabase(options.db, options);
  }

  return {
    buildReportFromClickHouse: clickhouse.buildReportFromClickHouse,
    buildReportFromDatabase: sqlite.buildReportFromDatabase,
    buildReportFromSelectedDatabase,
    resolveDbPath: sqlite.resolveDbPath,
    selectedDbEngine,
    syncClickHouseDatabase: clickhouse.syncClickHouseDatabase,
    syncDatabase,
    syncSqliteDatabase: sqlite.syncSqliteDatabase,
  };
}

module.exports = {
  DEFAULT_DB_ENGINE,
  createStorage,
};
