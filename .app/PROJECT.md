# PROJECT — Add omp (oh-my-pi) support to tokenomics-viewer

## Overview
`tokenomics-viewer` ingests/parses/visualizes token-usage + pricing for AI coding agents. Currently supports **Claude Code** and **Codex**. This work adds a third first-class platform: **omp (oh-my-pi)** — a top-level platform peer emitting its own consolidated per-session usage log, integrated with full feature parity (ingest→parse→store→visualize→price).

## Original Request (verbatim)
> This project is designed to support cloude code and codex. I need you to add support for omp (oh-my-pi).

## Workflow
FULL path: REQUEST → GRILL → [RESEARCH] → SPEC → DEVELOP ⇄ VALIDATE → DONE

## Phase Status
| Phase | Status |
|-------|--------|
| REQUEST | ✅ done |
| GRILL | ✅ done — REQ.md |
| RESEARCH | ✅ done — RESEARCH.md + integration map |
| SPEC | ✅ done — SPEC.md |
| DEVELOP | in_progress (LeadDev impl) ‖ DrPe pricing (OI-S1) |
| VALIDATE | pending |
| DONE | pending |

## Resolved Decisions (GRILL): D1 omp's own log · D2 top-level peer · D3 full parity · D4 flat per-session · D5 omp's own pricing config · D6 format researched.

## Resolved Architectural Decisions (SPEC): A1 JSONL sessions source · A2 provider="omp" discriminator, no schema migration · A3 provider pinned in parser · A4 rate-limit/subscription out of scope · A5 re-derive cost via calculateCost · A6 ingest all session-tree jsonl (parent + omp subagent sidecars).

## Open Items
- **OI-S1 (resolve via DrPe during DEVELOP):** PRICING.omp values + PRICING_SOURCES.omp URL are PLACEHOLDER — fill from official GLM/Zhipu AI price list.
- **OI-S2:** cacheWrite→cacheCreate5m mapping assumption (cacheWrite empirically 0 in inspected records).
- **OI-S3:** parent-only toggle deferred (YAGNI).

## Artifacts
- `.app/REQ.md` · `.app/RESEARCH.md` · `.app/SPEC.md`
- Integration Map — `agent://LeadDevPatternMap`

## Pending Asks
(none)
