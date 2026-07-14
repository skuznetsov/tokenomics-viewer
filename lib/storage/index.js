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
  let configurationWrite = Promise.resolve();

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

  async function loadConfiguration(options = {}) {
    if (selectedDbEngine(options) === "clickhouse") return clickhouse.loadConfiguration(options);
    return sqlite.loadConfiguration(options);
  }

  function saveConfiguration(options = {}, configuration) {
    const write = configurationWrite.then(() => {
      if (selectedDbEngine(options) === "clickhouse") return clickhouse.saveConfiguration(options, configuration);
      return sqlite.saveConfiguration(options, configuration);
    });
    configurationWrite = write.catch(() => undefined);
    return write;
  }

  return {
    buildReportFromClickHouse: clickhouse.buildReportFromClickHouse,
    buildReportFromDatabase: sqlite.buildReportFromDatabase,
    buildReportFromSelectedDatabase,
    loadConfiguration,
    resolveDbPath: sqlite.resolveDbPath,
    selectedDbEngine,
    saveConfiguration,
    syncClickHouseDatabase: clickhouse.syncClickHouseDatabase,
    syncDatabase,
    syncSqliteDatabase: sqlite.syncSqliteDatabase,
  };
}

module.exports = {
  DEFAULT_DB_ENGINE,
  createStorage,
};
