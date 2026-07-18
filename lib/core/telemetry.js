"use strict";

function normalizedTimestamp(value) {
  const timestamp = value instanceof Date ? value : new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function addTelemetrySnapshot(report, record) {
  const timestamp = normalizedTimestamp(record.timestamp);
  if (!timestamp) return null;
  const event = {
    sourcePath: record.sourcePath || null,
    lineNo: Number.isFinite(record.lineNo) ? record.lineNo : null,
    timestamp,
    provider: record.provider || "unknown",
    agent: record.agent || "unknown",
    model: record.model || "unknown",
    project: record.project || "unknown",
    eventKind: record.eventKind || "usage_snapshot",
    rawJson: JSON.stringify(record.rawPayload || {}),
  };
  if (event.eventKind === "rate_limit_error") {
    report.providerLimitEvents.push({
      timestamp: event.timestamp,
      provider: event.provider,
      agent: event.agent,
      model: event.model,
      project: event.project,
      message: record.message || null,
    });
  }
  if (typeof report._telemetryEventSink === "function") report._telemetryEventSink(event);
  return event;
}

module.exports = { addTelemetrySnapshot };
