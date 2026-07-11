"use strict";

const {
  AGENT_CODEX,
  MAX_VALID_OUTPUT_CHARS_PER_TOKEN,
  UNKNOWN_EFFORT,
  UNKNOWN_MODEL,
  UNKNOWN_PROJECT,
  addOutputCharTokenMetric,
  addOutputCharTokenStats,
  addToStats,
  inferProvider,
  isValidDate,
  newVisibleChars,
  outputTextTokens,
} = require("../core/report-model");
const {
  addCodexVisibleChars,
  codexAssistantOutputTextChars,
  codexTraceIds,
  effortFromCodexTurnContext,
  hasUsageTokens,
  normalizeCodexUuid,
  normalizeUsage,
  sameCodexUuid,
  usageFromClaudeUsage,
  usageFromCodexInfo,
} = require("../core/usage");
const { addUsage } = require("../core/aggregate");
const { addRateLimitSnapshot } = require("../core/rate-limits");

function createLineProcessor(report, options, sourceLabel, session = null) {
  const newTurn = (turnId, timestamp) => ({
    turnId: turnId || null,
    timestamp: isValidDate(timestamp) ? timestamp : new Date(NaN),
    project: UNKNOWN_PROJECT,
    model: UNKNOWN_MODEL,
    provider: "openai",
    effort: UNKNOWN_EFFORT,
    visibleOutputChars: 0,
    output: 0,
    reasoningOutput: 0,
    hasOutputCharMetric: false,
  });
  const codexState = {
    sessionId: null,
    forkedFromId: null,
    forkParentTraces: null,
    forkReplayBoundaryTraces: null,
    skippingForkReplay: false,
    preScannedForkReplay: false,
    preferLastTokenUsageAfterForkReplay: false,
    project: UNKNOWN_PROJECT,
    model: UNKNOWN_MODEL,
    provider: "openai",
    effort: UNKNOWN_EFFORT,
    totalUsage: null,
    visibleChars: newVisibleChars(),
    turn: null,
  };
  const seenClaudeRequests = new Set();

  const updateTurnMeta = () => {
    if (!codexState.turn) return;
    codexState.turn.project = codexState.project;
    codexState.turn.model = codexState.model;
    codexState.turn.provider = codexState.provider || "openai";
    codexState.turn.effort = codexState.effort;
  };

  const flushTurn = () => {
    const turn = codexState.turn;
    if (!turn) return null;
    updateTurnMeta();
    const visibleOutputTokens = outputTextTokens(turn);
    let event = null;
    if (!turn.hasOutputCharMetric && turn.visibleOutputChars > 0 && visibleOutputTokens > 0) {
      event = addOutputCharTokenMetric(report, {
        sourcePath: session?.path || sourceLabel,
        turnId: turn.turnId,
        timestamp: turn.timestamp,
        provider: turn.provider,
        model: turn.model,
        project: turn.project,
        effort: turn.effort,
        visibleOutputChars: turn.visibleOutputChars,
        visibleOutputTokens,
      });
      if (session) addOutputCharTokenStats(session.stats, event);
    }
    codexState.turn = null;
    return event;
  };

  const beginForkReplay = () => {
    if (!codexState.skippingForkReplay) {
      codexState.totalUsage = null;
      codexState.visibleChars = newVisibleChars();
      flushTurn();
    }
    codexState.skippingForkReplay = true;
  };

  const endForkReplay = () => {
    codexState.skippingForkReplay = false;
    codexState.totalUsage = null;
    codexState.preferLastTokenUsageAfterForkReplay = true;
  };

  const ensureTurn = (turnId, timestamp) => {
    const normalizedTurnId = turnId || null;
    const timestampValue = isValidDate(timestamp) ? timestamp : new Date(NaN);
    if (codexState.turn && normalizedTurnId && codexState.turn.turnId && normalizedTurnId !== codexState.turn.turnId) {
      flushTurn();
    }
    if (!codexState.turn) {
      codexState.turn = newTurn(normalizedTurnId, timestampValue);
    } else if (!codexState.turn.turnId && normalizedTurnId) {
      codexState.turn.turnId = normalizedTurnId;
    }
    if (!isValidDate(codexState.turn.timestamp) && isValidDate(timestampValue)) {
      codexState.turn.timestamp = timestampValue;
    }
    updateTurnMeta();
  };

  const processor = (line, lineNo) => {
    if (!line.trim()) return;

    let json;
    try {
      json = JSON.parse(line);
    } catch {
      report.sources.parseErrors += 1;
      if (session) session.parseErrors += 1;
      if (options.strictJson) {
        throw new Error(`Invalid JSON in ${sourceLabel}:${lineNo}`);
      }
      return;
    }

    if (session) session.records += 1;

    if (json.type === "session_meta" && json.payload) {
      if (!codexState.sessionId) {
        codexState.sessionId = normalizeCodexUuid(json.payload.id) || json.payload.id || null;
        codexState.forkedFromId = normalizeCodexUuid(json.payload.forked_from_id);
        codexState.forkParentTraces = codexState.forkedFromId
          ? options.codexForkRegistry?.tracesBySession?.get(codexState.forkedFromId) || null
          : null;
        codexState.forkReplayBoundaryTraces = codexState.sessionId
          ? options.codexForkRegistry?.replayBoundariesBySession?.get(codexState.sessionId) || null
          : null;
        codexState.preScannedForkReplay = Boolean(
          codexState.sessionId &&
          options.codexForkRegistry?.replaySessions?.has(normalizeCodexUuid(codexState.sessionId)),
        );
        if (codexState.preScannedForkReplay) beginForkReplay();
      } else if (
        codexState.forkedFromId &&
        sameCodexUuid(json.payload.id, codexState.forkedFromId)
      ) {
        beginForkReplay();
        return;
      }
      codexState.project = json.payload.cwd || codexState.project;
      codexState.provider = json.payload.model_provider || codexState.provider;
      codexState.model = json.payload.model || codexState.model;
      return;
    }

    const traceIds = codexTraceIds(json);
    if (codexState.forkParentTraces) {
      if (traceIds.some((traceId) => codexState.forkParentTraces.has(traceId))) {
        beginForkReplay();
        return;
      }
      if (codexState.skippingForkReplay) {
        if (traceIds.length === 0) return;
        endForkReplay();
      }
    } else if (
      codexState.skippingForkReplay &&
      codexState.forkReplayBoundaryTraces?.size > 0 &&
      traceIds.some((traceId) => codexState.forkReplayBoundaryTraces.has(traceId))
    ) {
      endForkReplay();
    }

    if (codexState.skippingForkReplay) {
      if (json.type === "event_msg" && json.payload?.type === "token_count" && json.payload.info) {
        const codexUsage = usageFromCodexInfo(json.payload.info, codexState.totalUsage);
        codexState.totalUsage = codexUsage.totalUsage || null;
      }
      if (codexState.skippingForkReplay) return;
    }

    if (json.type === "event_msg" && json.payload?.type === "task_started") {
      ensureTurn(json.payload.turn_id || null, new Date(json.timestamp));
    } else if (json.type === "turn_context" && json.payload?.turn_id) {
      ensureTurn(json.payload.turn_id, new Date(json.timestamp));
    }

    const assistantOutputTextChars = codexAssistantOutputTextChars(json);
    addCodexVisibleChars(codexState.visibleChars, json);
    if (assistantOutputTextChars > 0) {
      ensureTurn(null, new Date(json.timestamp));
      codexState.turn.visibleOutputChars += assistantOutputTextChars;
    }

    if (json.type === "turn_context" && json.payload) {
      codexState.project = json.payload.cwd || codexState.project;
      codexState.model = json.payload.model || codexState.model;
      codexState.effort = effortFromCodexTurnContext(json.payload);
      updateTurnMeta();
      return;
    }

    if (json.type === "event_msg" && json.payload?.type === "token_count" && json.payload.info) {
      report.sources.tokenCountSnapshots += 1;
      if (session) session.tokenCountSnapshots += 1;

      const timestamp = new Date(json.timestamp);
      const codexUsage = usageFromCodexInfo(
        json.payload.info,
        codexState.totalUsage,
        codexState.preferLastTokenUsageAfterForkReplay,
      );
      codexState.totalUsage = codexUsage.totalUsage || null;
      codexState.preferLastTokenUsageAfterForkReplay = false;
      const provider = codexState.provider || "openai";
      const model = codexState.model;
      const effort = codexState.effort;
      ensureTurn(null, timestamp);
      codexState.turn.output += codexUsage.usage.output;
      codexState.turn.reasoningOutput += codexUsage.usage.reasoningOutput;

      if (!hasUsageTokens(codexUsage.usage)) {
        addRateLimitSnapshot(report, json.payload.rate_limits, {
          agent: AGENT_CODEX,
          provider,
          model,
          effort,
          timestamp,
          sourcePath: session?.path || sourceLabel,
          lineNo,
          usage: normalizeUsage(codexUsage.usage),
          cost: { known: true, amount: 0, reasoningAmount: 0 },
        });
        report.sources.skippedTokenCountSnapshots += 1;
        if (session) session.skippedTokenCountSnapshots += 1;
        return;
      }

      const added = addUsage(report, {
        provider,
        model,
        project: codexState.project,
        effort,
        timestamp,
        usage: codexUsage.usage,
        visibleChars: codexState.visibleChars,
        sourcePath: session?.path || sourceLabel,
        lineNo,
      }, options);
      const visibleOutputTokens = outputTextTokens(added.usage);
      if (added.visibleChars.output > 0 && visibleOutputTokens > 0) {
        const charsPerToken = added.visibleChars.output / visibleOutputTokens;
        if (charsPerToken <= MAX_VALID_OUTPUT_CHARS_PER_TOKEN) {
          codexState.turn.hasOutputCharMetric = true;
          const outputCharMetric = addOutputCharTokenMetric(report, {
            sourcePath: session?.path || sourceLabel,
            turnId: codexState.turn?.turnId || null,
            timestamp,
            provider,
            model,
            project: codexState.project,
            effort,
            visibleOutputChars: added.visibleChars.output,
            visibleOutputTokens,
          });
          if (session) addOutputCharTokenStats(session.stats, outputCharMetric);
        }
      }
      codexState.visibleChars = newVisibleChars();
      addRateLimitSnapshot(report, json.payload.rate_limits, {
        agent: AGENT_CODEX,
        provider,
        model,
        effort,
        timestamp,
        sourcePath: session?.path || sourceLabel,
        lineNo,
        usage: added.usage,
        cost: added.cost,
      });
      if (session) addToStats(session.stats, added.usage, added.cost, added.visibleChars);
      return;
    }

    if (json.type === "assistant" && json.message?.usage) {
      const requestKey = json.requestId || json.uuid;
      if (requestKey && seenClaudeRequests.has(requestKey)) return;
      if (requestKey) seenClaudeRequests.add(requestKey);

      const model = json.message.model || UNKNOWN_MODEL;
      const added = addUsage(report, {
        provider: inferProvider(model, "anthropic"),
        model,
        project: json.cwd || UNKNOWN_PROJECT,
        effort: UNKNOWN_EFFORT,
        timestamp: new Date(json.timestamp),
        usage: usageFromClaudeUsage(json.message.usage),
        sourcePath: session?.path || sourceLabel,
        lineNo,
      }, options);
      if (session) addToStats(session.stats, added.usage, added.cost);
    }
  };
  if (typeof report._afterLine === "function") processor.afterLine = report._afterLine;
  processor.finalize = () => {
    flushTurn();
    return typeof processor.afterLine === "function" ? processor.afterLine() : null;
  };
  return processor;
}

module.exports = {
  createLineProcessor,
};
