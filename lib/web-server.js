"use strict";

const http = require("node:http");
const { URL } = require("node:url");
const dashboard = require("./dashboard");

function sendJson(response, value, status = 200) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendHtml(response, body, status = 200) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function createReportCache(buildReport, initialReport = null) {
  if (typeof buildReport !== "function") throw new TypeError("createReportCache requires a report builder");
  let report = initialReport;
  let pending = null;
  return {
    async get() {
      if (report) return report;
      if (!pending) {
        pending = Promise.resolve(buildReport())
          .then((built) => {
            report = built;
            return built;
          })
          .finally(() => {
            pending = null;
          });
      }
      return pending;
    },
  };
}

function createWebServer({
  buildReportFromSelectedDatabase,
  resolveDbPath,
} = {}) {
  async function handleWebRequest(request, response, options) {
    if (request.method !== "GET") {
      sendJson(response, { error: "method not allowed" }, 405);
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
    try {
      if (url.pathname === "/") {
        sendHtml(response, await dashboard.dashboardHtml());
        return;
      }
      if (url.pathname === "/favicon.ico") {
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }

      if (!["/api/report", "/api/summary", "/api/sessions"].includes(url.pathname)) {
        sendJson(response, { error: "not found" }, 404);
        return;
      }

      const report = await options.reportCache.get();
      if (url.pathname === "/api/report") {
        sendJson(response, report);
      } else if (url.pathname === "/api/summary") {
        sendJson(response, dashboard.webSummary(report, options));
      } else if (url.pathname === "/api/sessions") {
        sendJson(response, report.sessions.slice().sort((a, b) => b.stats.costUsd - a.stats.costUsd));
      }
    } catch (error) {
      sendJson(response, { error: error.message }, 500);
    }
  }

  async function startWebServer(options) {
    const db = resolveDbPath(options);
    const reportOptions = { ...options, db };
    const serverOptions = {
      ...reportOptions,
      reportCache: options.reportCache || createReportCache(
        () => buildReportFromSelectedDatabase(reportOptions),
        options.preloadedReport || null,
      ),
    };
    const server = http.createServer((request, response) => {
      handleWebRequest(request, response, serverOptions).catch((error) => {
        sendJson(response, { error: error.message }, 500);
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    return server;
  }

  return {
    handleWebRequest,
    startWebServer,
  };
}

module.exports = {
  createReportCache,
  createWebServer,
  sendHtml,
  sendJson,
};
