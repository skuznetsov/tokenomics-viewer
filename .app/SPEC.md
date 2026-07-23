# Technical Specification: omp (oh-my-pi) support for tokenomics-viewer

> **Phase:** SPEC (implementation-ready). No code is written in this phase.
> **Status:** All architectural decisions A1–A6 are BINDING and baked in. Open
> items are limited to PLACEHOLDER pricing values to be filled from the official
> omp/GLM price list before release.
> **Sources:** `.app/REQ.md` (FR-1..8, NG-1..5, EC-1..6, AC-1..6),
> `.app/RESEARCH.md` (omp log format/location), and the Integration Map
> (`agent://LeadDevPatternMap`). Every path, signature, and line number below was
> re-verified against the working tree on 2026-07-22.

---

## 0. Resolved architectural decisions (binding — do not re-open)

| ID | Decision | Effect on this SPEC |
|----|----------|---------------------|
| **A1** | omp source = JSONL session transcripts at `~/.omp/agent/sessions/<project-slug>/<ISO-ts>_<uuid>.jsonl`. Each assistant-message line carries a top-level `usage` block. Session total = sum of `usage` blocks. Relocatable via `PI_CODING_AGENT_DIR` (moves `~/.omp/agent`) and `PI_CONFIG_DIR` (renames config root `~/.omp`). | Drives §3 Discovery and §4 Parser. |
| **A2** | NO storage schema migration. `provider="omp"` IS the platform discriminator. omp surfaces via existing provider/model breakdowns. FR-4 is satisfied via provider queryability. | §8 Storage: no column added. |
| **A3** | New provider string `"omp"`. The omp parser sets `provider:"omp"` explicitly on every record (mirror Codex pinning from `session_meta.model_provider`). `inferProvider` is NEVER called for omp. | §4 Parser, §5 Mapper, §6 Pricing all key on `"omp"`. |
| **A4** | Rate-limit/quota telemetry AND subscription-plan detection for omp are OUT OF SCOPE (NG-2/NG-3). | §9 Out of scope. `AGENT_OMP` is defined for vocabulary completeness but NOT emitted on usage events in v1. |
| **A5** | Cost is re-derived from the viewer's OWN omp pricing config via `calculateCost("omp", model, usage, ts, opts)`. omp's precomputed `usage.cost` is NOT trusted (often zero for unpriced models). | §6 Pricing. `usageFromOmpUsage` ignores `usage.cost`. |
| **A6** | Ingest processes ALL `.jsonl` files in the omp session tree for a session (parent transcript + omp's own subagent sidecars). v1: no parent-only toggle (YAGNI). | §3 Discovery walks the whole tree recursively. |

---

## 1. Overview & scope

`tokenomics-viewer` ingests AI coding-agent usage logs and estimates token cost.
It currently supports two platforms — **Claude Code** and **Codex** — across a
single pipeline: discovery → line-shape parsing → normalized-usage mapping →
`addUsage` aggregation → storage (`usage_events`) → dashboard rendering → pricing.

This work adds a third first-class platform: **omp (oh-my-pi)**. omp is a
top-level platform peer with **full feature parity**: it is selectable on the
CLI (`--source omp`), discovered from its own session-tree root, parsed by a new
line-shape branch in the existing line processor, mapped onto the same normalized
usage schema, priced through its own `calculateCost` branch, and stored/persisted
identically to the other platforms. omp is treated as its **own** data source —
it reads omp's JSONL session transcripts directly; it is **not** an aggregation
of the underlying agents omp spawns (NG-1). Records are **flat per session**
(D4/NG-2): each `.jsonl` file is one session; there is no delegation-tree
breakdown and no cross-platform linking (NG-3).

**What parity means concretely:** anywhere a user can select "Claude Code" or
"Codex", they can select "omp"; omp token/cost data flows through the exact same
`addUsage` → `usage_events` path; omp appears in the existing provider/model
breakdowns with no UI change; omp has its own pricing config block.

---

## 2. Provider & constant vocabulary

A single token `"omp"` is used for three intentionally-identical concepts:

| Concept | Value | Where defined | Where consumed |
|---------|-------|---------------|----------------|
| CLI short source value | `"omp"` | `lib/cli.js` validation array + help | `--source omp` selects omp discovery |
| Agent/platform constant | `AGENT_OMP = "omp"` | `lib/core/report-model.js` | Reserved for agent-aware subsystems (rate-limits/telemetry); NOT emitted on usage events in v1 (A4) |
| Provider string | `"omp"` | Pinned explicitly by the omp parser branch | `addUsage` record.provider → `usage_events.provider`; pricing key; provider breakdowns |

> **Why they are the same string:** the CLI already conflates the short source
> value with the agent constant for Codex (`"codex"` == `AGENT_CODEX ==
> "codex"`). For omp we keep the same convention so the CLI value, the agent
> constant, and the provider string are all literally `"omp"`. This avoids the
> Claude-style split (`"claude"` CLI vs `"claude-code"` constant) entirely.

> **Critical invariant (A3):** the provider string `"omp"` is set **explicitly**
> by the parser. `inferProvider(model)` (`lib/core/report-model.js:368-373`) is
> **never** reached for an omp record, because omp logs reference underlying
> models like `glm-5.2`, `claude-opus-4-8`, or `gpt-5-codex`; if those names
> reached `inferProvider` they would be misrouted to `unknown`/`anthropic`/`openai`
> and mispriced, silently violating A5. This mirrors how Codex pins provider from
> `session_meta.model_provider` (`parser.js:209`) rather than from the model name.

---

## 3. Discovery — `lib/ingest/sources.js`

### 3.1 omp discovery branch in `discoverInputs(options)`

`discoverInputs` (`sources.js:140-175`) currently has two branches keyed on
`options.source`: Claude (`:152-156`) and Codex (`:158-172`). Add a third branch,
**structurally identical to the Codex branch**:

```js
if (source === "all" || source === "omp") {
  const ompAgentDir = options.ompHome || resolveOmpAgentDir(home);
  const ompRoot = Path.join(ompAgentDir, "sessions");
  // A6: include ALL .jsonl in the tree — parent transcripts AND omp's own
  // subagent sidecar files (sessions/<slug>/<ts>_<uuid>/*.jsonl).
  const files = await walkFiles(ompRoot, (p) => p.endsWith(".jsonl"));
  inputs.push(...files.map((p) => ({ kind: "jsonl", path: p })));
}
```

- `walkFiles` is the existing helper already used by the Claude and Codex
  branches; it recursively walks a directory and returns files matching the
  predicate. A single recursive walk over `<agentDir>/sessions` captures both the
  parent `<ts>_<uuid>.jsonl` files and the sidecar
  `<ts>_<uuid>/<AgentName>.jsonl` files (the sidecar directory shares the
  parent's filename minus `.jsonl` and lives in the same tree) — satisfying A6.
- Each discovered `{ kind: "jsonl", path }` flows through the **existing** ingest
  pipeline (one source = one session via `startSession`/`finishSession`), exactly
  like Codex. **No new source-helper function is required** for v1 (no omp
  zip/archive format exists; RESEARCH.md confirms omp writes plain append-only
  JSONL). If zip support is ever needed, mirror `codexJsonlSource`/`codexZipEntrySource`.

### 3.2 `resolveOmpAgentDir(home)` — new helper (module-private)

Resolves the omp **agent data directory** (the directory that *contains*
`sessions/`), honoring omp's native relocation env vars per RESEARCH.md Finding 6:

```js
function resolveOmpAgentDir(home) {
  // A1: PI_CODING_AGENT_DIR moves ~/.omp/agent outright (highest precedence
  // among omp-native vars). PI_CONFIG_DIR renames the config root (~/.omp).
  if (process.env.PI_CODING_AGENT_DIR) {
    return Path.resolve(process.env.PI_CODING_AGENT_DIR);
  }
  const configDir = process.env.PI_CONFIG_DIR || ".omp";
  return Path.join(home, configDir, "agent");
}
```

This matches RESEARCH.md's recommended resolution
`PI_CODING_AGENT_DIR ?? path.join(homedir(), PI_CONFIG_DIR || '.omp', 'agent')`
exactly. Default on a stock install: `~/.omp/agent` → sessions at `~/.omp/agent/sessions`.

### 3.3 Env / flag wiring (resolution precedence, high → low)

1. `--omp-home PATH` flag → `options.ompHome` (viewer-native; mirrors `--codex-home`). Points at the **agent data directory** (contains `sessions/`), exactly as `--codex-home` points at the directory containing Codex's `sessions/`.
2. `OMP_HOME` env → `options.ompHome` default in `defaultOptions` (mirrors `CODEX_HOME`).
3. `PI_CODING_AGENT_DIR` env → honored by `resolveOmpAgentDir` when `options.ompHome` is null.
4. `PI_CONFIG_DIR` env → honored by `resolveOmpAgentDir` when neither above is set.
5. `~/.omp/agent` (default).

> Users thus have two ergonomics layers: a viewer-native `--omp-home`/`OMP_HOME`
> (mirrors `--codex-home`/`CODEX_HOME`), and omp's own native
> `PI_CODING_AGENT_DIR`/`PI_CONFIG_DIR`. Both are honored.

---

## 4. Parser — `lib/ingest/parser.js`

### 4.1 Dispatch model (unchanged)

`createLineProcessor(report, options, sourceLabel, session)` (`parser.js:33`)
dispatches by **JSON line shape**, not by source/platform. A single processor
handles Claude and Codex in one pass. We add an omp line-shape branch. **No
source-label sniffing is required** — the omp line shapes are unique to omp logs
and never collide with Claude (`type:"assistant"`) or Codex
(`type:"session_meta"`/`"event_msg"`/`"turn_context"`/`"response_item"`).

### 4.2 omp state (new), modeled on `codexState`

Add a module-private state object inside `createLineProcessor`, beside
`codexState` (`parser.js:56-73`):

```js
const ompState = {
  hasOmpSession: false,     // seen a {"type":"session"} header
  project: UNKNOWN_PROJECT, // from the header cwd
  activeModel: null,        // last model_change value (combined provider/model), fallback only
};
```

### 4.3 omp line-shape branches (inside the `processor(line, lineNo)` closure, `parser.js:142-417`)

Place these branches **after** the Codex branches and **before** the Claude
`type === "assistant"` branch (`:386`). They are mutually exclusive with all
existing branches by `json.type`.

**(a) Session header** — capture project (cwd) for subsequent usage lines.
```js
if (json.type === "session" && json.id) {
  ompState.hasOmpSession = true;
  ompState.project = json.cwd || ompState.project;
  return;
}
```
The header `{"type":"session","version":3,"id":"<uuid>","timestamp":"<ISO>","cwd":"…","title":"…"}` carries no message-level timestamp, so `json.timestamp` here IS the ISO string (no duplicate-key collision on the header line).

**(b) Model-change tracking** — optional fallback for the model id.
```js
if (json.type === "model_change" && typeof json.model === "string") {
  ompState.activeModel = json.model; // combined form, e.g. "zai/glm-5.2"
  return;
}
```

**(c) Assistant-message usage line** — the primary token source (RESEARCH.md §3).
```js
if (json.type === "message" && json.message?.role === "assistant" && json.usage) {
  addOmpUsage(json);
  return;
}
```

**(d) ToolResult-message usage line** — secondary token source (RESEARCH.md §3
"Secondary usage source: ToolResultMessage.usage"). Same `usage` shape; sum it
for exact session totals (A1: session total = Σ of all usage blocks).
```js
if (json.type === "message" && json.message?.role === "toolResult" && json.usage) {
  addOmpUsage(json);
  return;
}
```

### 4.4 `addOmpUsage(json)` — the omp sink (closure-local helper)

```js
const addOmpUsage = (json) => {
  // Model id: prefer the bare model on the assistant line; fall back to the
  // model_change combined form (take the segment after the last '/'), else UNKNOWN.
  const bareModel = typeof json.model === "string" && json.model.length > 0
    ? json.model
    : (ompState.activeModel ? ompState.activeModel.split("/").pop() : UNKNOWN_MODEL);
  const model = bareModel || UNKNOWN_MODEL;

  // ⚠️ Duplicate-timestamp gotcha (RESEARCH.md §3 gotcha 1): omp flattens the
  // entry-level ISO timestamp AND the message-level Unix-ms timestamp onto the
  // SAME object under the key "timestamp". JSON.parse keeps the LAST one, so
  // json.timestamp is the Unix-ms NUMBER (not the ISO string) after a naive parse.
  // new Date(<number>) interprets it as ms-epoch → correct. new Date(<iso-string>)
  // is also correct, so a single new Date(json.timestamp) call handles both;
  // we DO NOT assume json.timestamp is a string.
  const timestamp = new Date(json.timestamp);

  const added = addUsage(report, {
    provider: "omp",                       // A3: explicit pin; inferProvider never called
    model,
    project: ompState.project,             // from the {"type":"session"} header cwd
    effort: UNKNOWN_EFFORT,                // omp has no effort concept (D4 flat)
    timestamp,
    usage: usageFromOmpUsage(json.usage),  // §5; ignores json.usage.cost (A5)
    sourcePath: session?.path || sourceLabel,
    lineNo,
  }, options);
  if (session) addToStats(session.stats, added.usage, added.cost);
};
```

**Recognition predicate is precise and non-colliding:**
- omp assistant usage: `type === "message"` ∧ `message.role === "assistant"` ∧ top-level `usage`.
- Claude: `type === "assistant"` ∧ `message.usage` (nested). Different `type`; different `usage` location.
- Codex: `type === "event_msg"` ∧ `payload.type === "token_count"`. Different `type`.

**No telemetry snapshot is emitted** for omp (A4: rate-limit/quota telemetry out
of scope). This is the only behavioral difference from the Claude branch, which
calls `addTelemetrySnapshot` — omp omits that call entirely.

### 4.5 Duplicate-`timestamp` gotcha — explicit handling

RESEARCH.md §3 gotcha 1: because omp flattens entry-level (ISO string) and
message-level (Unix-ms number) timestamps onto one JSON object under the same key
`timestamp`, `JSON.parse` yields the **number** for `json.timestamp` on message
lines. `new Date(json.timestamp)` correctly interprets both a number (ms-epoch)
and an ISO string, so a single call is correct and robust. The implementer MUST
NOT assume `json.timestamp` is a string (e.g. must not call `.slice`/regex on it)
and MUST NOT rely on the entry-level ISO value being present on message lines.

---

## 5. Usage mapper — `lib/core/usage.js`

Add a new exported mapper `usageFromOmpUsage(usage)` that returns the exact
normalized shape produced by `normalizeUsage` (`usage.js:8-27`):

```
{ input, cacheCreate5m, cacheCreate30m, cacheCreate1h, cacheRead, output,
  reasoningOutput, contextWindow, inputIncludesCacheRead }
```

### 5.1 `usageFromOmpUsage` (new)

```js
function usageFromOmpUsage(usage) {
  const source = usage || {};
  return {
    input: number(source.input),
    cacheCreate5m: number(source.cacheWrite),  // see §5.3 assumption
    cacheCreate30m: 0,
    cacheCreate1h: 0,
    cacheRead: number(source.cacheRead),
    output: number(source.output),
    reasoningOutput: 0,                        // omp Usage has no reasoning field
    contextWindow: 0,
    inputIncludesCacheRead: false,             // see §5.2 (verified invariant)
  };
}
```

`number` is already imported from `report-model` (`usage.js:3-6`). Add
`usageFromOmpUsage` to `module.exports` (`usage.js:247-263`) and to the
destructure in `parser.js` (`parser.js:17-28`).

### 5.2 `inputIncludesCacheRead: false` — verified invariant

RESEARCH.md §3 proves the arithmetic:
`totalTokens = input + output + cacheRead + cacheWrite`
(994 + 57 + 39232 + 0 = 40283 ✅). Therefore omp's `usage.input` is the
**non-cached** prompt-token count — `cacheRead` is a separate bucket, not
included in `input`. Setting `inputIncludesCacheRead: false` tells
`normalizeUsage` (re-applied inside `addUsage` at `aggregate.js:29`) NOT to
subtract `cacheRead` from `input`. (If it were `true`, `input` would be
double-reduced.) This matches how `usageFromClaudeUsage` and
`usageFromCodexTokenUsage` both set `inputIncludesCacheRead: false`.

### 5.3 `cacheWrite → cacheCreate5m` — documented assumption

omp exposes a **single, undifferentiated** `cacheWrite` field (no TTL breakdown).
The normalized schema has three cache-creation buckets (`cacheCreate5m` /
`cacheCreate30m` / `cacheCreate1h`). We map omp `cacheWrite` → `cacheCreate5m`
(the primary/shortest-TTL cache-creation bucket, matching Anthropic's default
ephemeral semantics). **Assumption:** omp's `cacheWrite` represents cache
*creation* tokens priced at the omp `cacheCreate5m` rate. RESEARCH.md notes
`cacheWrite` was empirically **always 0** in inspected `zai/glm-5.2` records, so
this choice is currently low-stakes; it is revisable once real non-zero
`cacheWrite` data appears. The omp pricing block (§6) MUST set `cacheCreate5m`
consistently with this mapping. `cacheCreate30m` and `cacheCreate1h` are always 0
for omp.

### 5.4 `usage.cost` is intentionally ignored (A5)

`usageFromOmpUsage` does NOT read `source.cost`. Cost is re-derived downstream by
`calculateCost("omp", …)` from the viewer's own omp pricing config (§6). RESEARCH.md
§3 gotcha 2 shows omp's `usage.cost` can be all-zero for unpriced models; trusting
it would under-report. EC-4 (unknown model) is handled by `calculateCost`
returning `{known:false}` (§6.4), not by the mapper.

---

## 6. Pricing — `lib/core/pricing.js` + `lib/core/configuration.js`

### 6.1 `PRICING.omp` block (new) — `pricing.js:24-138`

Add a third top-level provider block, structured like the `anthropic` block
(flat price rows, optionally time-windowed arrays). **All numeric values are
PLACEHOLDER** — to be filled from the official omp/GLM (Zhipu AI) price list
before release (see §6.2 source URL).

```js
const PRICING = {
  openai:  { models: { /* unchanged */ } },
  anthropic: { models: { /* unchanged */ } },
  omp: {
    models: {
      // PLACEHOLDER values — replace with official omp/GLM prices (USD per 1M tokens)
      // before release. Source: https://open.bigmodel.dev/pricing (VERIFY + update URL).
      "glm-5.2": {
        input: PLACEHOLDER, cacheCreate5m: PLACEHOLDER, cacheCreate1h: PLACEHOLDER,
        cacheRead: PLACEHOLDER, output: PLACEHOLDER,
      },
      // Add more omp-served models (e.g. glm-4.6, glm-4.5-air) as their logs appear.
    },
  },
};
```

Row field set: `{ input, cacheCreate5m, cacheCreate1h, cacheRead, output }`
(mirrors Anthropic). `cacheCreate30m` is omitted (omp uses no 30m bucket; the
omp `calculateCost` branch hardcodes `cacheCreate30m: 0` in the breakdown, §6.4).
Rows MAY be a timed array `[{until, prices}, {from, prices}]` exactly like
`claude-sonnet-5` (`pricing.js:121-130`); `lookupOmpPrices` handles both shapes.

> **Model key convention:** keys are the **bare** model name from the omp
> assistant line's `json.model` (e.g. `"glm-5.2"`), NOT the combined
> `provider/model` form (`"zai/glm-5.2"`). This matches how Anthropic/OpenAI key
> by bare model name, and matches the `model` value the omp parser stores (§4.4).

### 6.2 `PRICING_SOURCES.omp` (new) — `pricing.js:13-21`

```js
const PRICING_SOURCES = {
  // …existing entries…
  omp: "https://open.bigmodel.dev/pricing", // PLACEHOLDER — verify official omp/GLM price page URL
};
```
The URL is a PLACEHOLDER candidate (Zhipu AI / BigModel pricing). DrPe or the
release step MUST confirm the authoritative omp/GLM price-list URL and update
this constant; the dashboard pricing editor surfaces `sourceUrl` to users.

### 6.3 `lookupOmpPrices(model, timestamp)` (new) — `pricing.js`

A clean mirror of `lookupAnthropicPrices` (`pricing.js:140-156`) reading
`PRICING.omp.models`:

```js
function lookupOmpPrices(model, timestamp) {
  const normalized = normalizeModel(model);
  const names = Object.keys(PRICING.omp.models).sort((a, b) => b.length - a.length);
  const key = names.find((name) => normalized === name || normalized.startsWith(`${name}-`));
  if (!key) return null;
  const entry = PRICING.omp.models[key];
  if (!Array.isArray(entry)) return entry;
  const ts = isValidDate(timestamp) ? timestamp.getTime() : Date.now();
  for (const timed of entry) {
    const from = timed.from ? Date.parse(timed.from) : Number.NEGATIVE_INFINITY;
    const until = timed.until ? Date.parse(timed.until) : Number.POSITIVE_INFINITY;
    if (ts >= from && ts <= until) return timed.prices;
  }
  return entry[entry.length - 1].prices;
}
```
Export it (`pricing.js:313-324`) alongside `lookupAnthropicPrices`/`lookupOpenAIPrices`.

### 6.4 `calculateCost` omp branch (new) — `pricing.js:239-300`

Insert **after** the `provider === "openai"` branch (`:279-297`) and **before**
the final `return { known: false, … }` (`:299`). It mirrors the Anthropic branch
but reads omp prices and hardcodes `cacheCreate30m: 0`:

```js
if (provider === "omp") {
  const prices = Array.isArray(options.pricingCatalog) ? null : lookupOmpPrices(model, timestamp);
  if (!prices) return { known: false, amount: 0, breakdown: newCostBreakdown(), reasoningAmount: 0 };
  const breakdown = applyCostMultiplier({
    input:      (normalizedUsage.input * prices.input) / TOKENS_PER_PRICE_UNIT,
    cacheCreate5m: (normalizedUsage.cacheCreate5m * prices.cacheCreate5m) / TOKENS_PER_PRICE_UNIT,
    cacheCreate30m: 0,
    cacheCreate1h: (normalizedUsage.cacheCreate1h * prices.cacheCreate1h) / TOKENS_PER_PRICE_UNIT,
    cacheRead:  (normalizedUsage.cacheRead * prices.cacheRead) / TOKENS_PER_PRICE_UNIT,
    output:     (normalizedUsage.output * prices.output) / TOKENS_PER_PRICE_UNIT,
  }, options.regionalMultiplier);
  return {
    known: true,
    amount: sumCostBreakdown(breakdown),
    breakdown,
    reasoningAmount: ((reasoningOutput * prices.output) / TOKENS_PER_PRICE_UNIT) * number(options.regionalMultiplier || 1),
  };
}
```

**Dispatch order in `calculateCost` (unchanged logic):**
1. `pricesFromCatalog(provider, …)` runs first (`:242-259`) for ALL providers — so omp custom rows added via the dashboard pricing editor (provider `"omp"`) work automatically with no extra code.
2. Else the provider branches: `anthropic` → `openai` → **`omp` (new)** → final `{known:false}`.

### 6.5 EC-4 (unknown omp model) and EC-5 (missing pricing)

- **EC-4 unknown model:** `lookupOmpPrices` returns `null` → the omp branch
  returns `{ known:false, amount:0, … }`. Downstream, `addUsage`
  (`aggregate.js:60-64`) increments `report.unpricedModels["omp/<model>"]`. No
  silent NaN/zero-cost-as-known; the model is explicitly flagged unpriced. This
  matches existing "unknown model" behavior for the other platforms.
- **EC-5 missing pricing config:** there is no separate "missing config" path —
  an omp model with no `PRICING.omp.models` entry is simply `{known:false}`
  (EC-4). Users add prices at runtime via the dashboard pricing editor
  (provider=`"omp"`), which is the existing mechanism. (REQ EC-5's "clear
  configuration error" is satisfied by the `{known:false}` + `unpricedModels`
  surfacing, consistent with how the other platforms behave.)

### 6.6 `configuration.js` — `rowFromPrices` + `packagedPricingRows`

**`rowFromPrices` (`configuration.js:21-40`)** — extend the two ternaries that
hardcode provider behavior so omp is handled:
- `matchMode` (`:26`): change `provider === "anthropic" ? "prefix" : "snapshot"`
  → `provider === "openai" ? "snapshot" : "prefix"` (so omp → `"prefix"`,
  matching Anthropic; glm models may carry variant suffixes).
- `sourceUrl` (`:36`): change the two-way openai/anthropic ternary to a three-way:
  ```js
  sourceUrl: provider === "openai" ? PRICING_SOURCES.openai
           : provider === "omp" ? PRICING_SOURCES.omp
           : PRICING_SOURCES.anthropic,
  ```
- `cacheRead` (`:34`): unchanged — the existing else branch
  `prices.cacheRead ?? null` already covers omp (omp rows carry `cacheRead`).

**`packagedPricingRows` (`configuration.js:42-62`)** — add a third loop mirroring
the Anthropic loop (`:49-60`), so omp packaged defaults appear in the default
configuration/catalog (and thus in the dashboard pricing editor on first load):
```js
for (const [model, entry] of Object.entries(PRICING.omp.models)) {
  if (Array.isArray(entry)) {
    for (const timed of entry) {
      rows.push(rowFromPrices("omp", model, "standard", timed.prices, {
        effectiveFrom: timed.from, effectiveUntil: timed.until,
      }));
    }
  } else {
    rows.push(rowFromPrices("omp", model, "standard", entry));
  }
}
```
The existing final `.sort(...)` (`:61`) is provider/model/variant/id-stable, so
omp rows sort in without further change.

---

## 7. CLI — `lib/cli.js`

Exact edits (line numbers from verified working tree):

| Location | Current | Change |
|----------|---------|--------|
| `defaultOptions` `:32` | `codexHome: env.CODEX_HOME ? Path.resolve(env.CODEX_HOME) : null,` | **Add** `ompHome: env.OMP_HOME ? Path.resolve(env.OMP_HOME) : null,` immediately after (mirrors codexHome). |
| parse `:77-78` | `--codex-home` / `--codex-home=` | **Add** two parallel arms: `else if (arg === "--omp-home") options.ompHome = Path.resolve(next());` and `else if (arg.startsWith("--omp-home=")) options.ompHome = Path.resolve(arg.slice("--omp-home=".length));` |
| validation `:130-131` | `if (!["all", "claude", "codex"].includes(options.source)) { throw new Error("--source must be all, claude, or codex"); }` | **Add `"omp"`**: `["all", "claude", "codex", "omp"]` and message `"--source must be all, claude, codex, or omp"`. |
| help banner `:179` | `Scans Claude Code and Codex JSONL sessions and estimates token costs.` | **Mention omp**: e.g. `Scans Claude Code, Codex, and omp (oh-my-pi) JSONL sessions and estimates token costs.` |
| help `--source` `:182` | `--source all\|claude\|codex  Source roots…` | **Add `omp`**: `--source all\|claude\|codex\|omp  …` |
| help `--codex-home` `:185` | `--codex-home PATH  Codex data directory (default: CODEX_HOME or ~/.codex)` | **Add** a new line: `--omp-home PATH     omp (oh-my-pi) agent data directory (default: OMP_HOME, PI_CODING_AGENT_DIR, or ~/.omp/agent)` |

Semantics preserved: `--source all` now also discovers omp (the new
`source === "all" || source === "omp"` branch). `--source omp` discovers omp
only. `--source claude`/`codex` are unchanged.

---

## 8. Storage — NO schema change (A2)

**Explicitly: no migration, no new column.** omp records flow through the
existing path unchanged:

1. The omp parser branch calls `addUsage(report, { provider: "omp", … })` (`aggregate.js:23`).
2. `addUsage` resolves `provider = record.provider || inferProvider(model)` (`aggregate.js:27`) → since omp sets `provider:"omp"` explicitly, the value is pinned to `"omp"` and `inferProvider` is never called.
3. `addUsage` calls `calculateCost("omp", model, usage, ts, options)` (`aggregate.js:30`) → the omp branch (§6.4).
4. `addUsage` builds the persisted event (`aggregate.js:66-82`) with `provider:"omp"` and sinks it via `report._usageEventSink` (DB sync) or `report._usageEvents` (in-memory).
5. The `usage_events` table (`lib/storage/sqlite.js:154-189`; mirrored in ClickHouse `lib/storage/clickhouse.js`) already has a `provider` column. omp rows persist with `provider="omp"` — no DDL change.

**FR-4 ("queryable by platform = 'omp'") is satisfied by `WHERE provider = 'omp'`.**
The omp platform is identifiable in storage via the `provider` column; in the
dashboard via the existing provider/model breakdowns. No `platform`/`agent` column
is added to `usage_events` (A2).

---

## 9. Out of scope (per A4 / A2 / NG-2 / NG-3)

The following are explicitly **NOT** changed for omp in this work:

- **Rate-limit / quota telemetry** — `lib/core/rate-limits.js` `normalizeAgentType` (`:101-107`) is NOT extended for omp. The omp parser emits **no** `addRateLimitSnapshot` / `addTelemetrySnapshot` calls (A4).
- **Subscription-plan detection** — `lib/core/subscription-plans.js` `providerForAgent` (`:27-31`) is NOT extended for omp (NG-2/NG-3; omp has no subscription-plan concept in scope).
- **Dashboard UI** — `lib/dashboard.js` `rateLimitProvider` (`:214-218`) is NOT extended. The dashboard needs **NO change**: omp appears automatically in provider/model breakdowns once records reach `addUsage` with `provider:"omp"` (Integration Map §7, verified). No new dropdown/filter/tab/platform-selector is added (NG-4).
- **Storage schema** — no `platform`/`agent` column on `usage_events` or any other table (A2). No ClickHouse schema change.
- **Web API** — no new platform-parameterized endpoint.
- **`inferProvider`** — NOT extended to recognize omp models (A3). omp pins provider explicitly.
- **Parent-only toggle** — no v1 option to restrict ingest to parent transcripts excluding sidecars (A6: all files ingested; YAGNI).

> `AGENT_OMP = "omp"` IS defined and exported (§2) for vocabulary/registry
> completeness and future telemetry parity, but it is **not** emitted on any
> usage event in v1 (usage events carry no `agent` field — `aggregate.js:66-82`).

---

## 10. Tests — `test/` (AC-5), `node --test`

Tests follow the existing behavior-organized style (no per-platform test file is
required). Add omp coverage **inline** to the existing files (preferred, matches
convention) using `test/support/fixtures.js` helpers (`defaultOptions`,
`simpleUsage`, `roundCosts`, `statsFixture`). Reference idioms:
`pricing-usage.test.js:19-63` (parser+pricing happy path),
`parser.test.js:50-97` (discovery round-trip), `parser.test.js:99-120`
(malformed/strict), `cli-input.test.js:44-46` (env wiring).

### T1 — Parser happy path (mirrors `pricing-usage.test.js:19-63`)
Feed a real omp assistant-message line shape through `createLineProcessor`;
assert token totals, the `providerModels["omp/<model>"]` bucket, and cost from
omp pricing. Fixture line (from RESEARCH.md §3, trimmed):
```js
const report = newReport();
const processLine = createLineProcessor(report, defaultOptions(), "omp-fixture");
processLine(JSON.stringify({ type:"session", version:3, id:"019f8c6a-…",
  timestamp:"2026-07-23T00:40:00.339Z", cwd:"/tmp/project-omp", title:"t" }), 1);
processLine(JSON.stringify({
  type:"message", id:"4f9506d3", parentId:"7d542783",
  timestamp:"2026-07-23T00:42:17.380Z",                 // entry-level ISO (shadowed)
  message:{ role:"assistant", content:[] },
  api:"anthropic-messages", provider:"zai", model:"glm-5.2",
  usage:{ input:994, output:57, cacheRead:39232, cacheWrite:0, totalTokens:40283,
          cost:{ input:0.0013916, output:0.0002508, cacheRead:0.01020032, cacheWrite:0, total:0.01184272 } },
  stopReason:"toolUse", timestamp:1784767330214, responseId:"msg_…",   // ms number wins after parse
}), 2);

assert.equal(report.total.requests, 1);
assert.equal(report.total.input, 994);
assert.equal(report.total.cacheRead, 39232);
assert.equal(report.total.output, 57);
assert.equal(report.total.cacheCreate5m, 0);                 // cacheWrite was 0
assert.ok(report.providerModels["omp/glm-5.2"]);
assert.equal(report.projects["/tmp/project-omp"].requests, 1);
// cost: compute expected from the same omp rates used in the PLACEHOLDER block; assert Number(report.total.costUsd.toFixed(6)) === expected.
```
**Assert that `provider` is `"omp"`** (not `"zai"`, not `"unknown"`) to prove the
A3 pin defeated `inferProvider`. Assert `json.usage.cost` was NOT trusted
(overwritten by `calculateCost`).

### T2 — Malformed entry / lenient vs strict (EC-2, mirrors `parser.test.js:99-120`)
One bad JSON line in an omp file increments `report.sources.parseErrors` and
`session.parseErrors` in lenient mode; valid lines still parse; in `strictJson`
mode `buildReport` rejects with `/Invalid JSON in .*:2/`.

### T3 — Pricing known + unknown (EC-4)
- `calculateCost("omp", "glm-5.2", simpleUsage(1_000_000, 500_000), new Date("2026-07-23T00:42:17.380Z"), pricingOptions)` → `{known:true}` with `amount`/`breakdown` matching manual computation from the seeded rates.
- `calculateCost("omp", "glm-not-a-real-model", simpleUsage(100, 50), …)` → `{known:false, amount:0, …}`.

### T4 — Ingest → store → render round-trip (mirrors `parser.test.js:50-97`)
Build a temp omp sessions tree, run `buildReport(defaultOptions({ source:"omp", home, ompHome }))`, assert `report.sessions.length` and `report.total`. Fixture tree:
```
<ompHome>/sessions/-tmp-project-omp/2026-07-23T00-40-00-000Z_<uuid>.jsonl   (header + assistant usage line)
<ompHome>/sessions/-tmp-project-omp/2026-07-23T00-40-00-000Z_<uuid>/SubAgent.jsonl  (sidecar: own header + usage line — proves A6)
```
Assert both files are ingested (2 sessions), both tagged `provider:"omp"`, and
the sidecar's own header cwd is used for its project. Optionally add a sqlite
sync round-trip (`test/sqlite.test.js` idiom) asserting `usage_events` rows carry `provider="omp"`.

### T5 — CLI env / flag wiring (mirrors `cli-input.test.js:44-46`)
- `defaultOptions({ OMP_HOME:"/x" }).ompHome` resolves to `Path.resolve("/x")` (from `lib/cli.js` `defaultOptions`).
- `parseArgs(["--omp-home","/y","--source","omp"]).ompHome` resolves to `/y`.
- `parseArgs(["--source","omp"])` does not throw; `parseArgs(["--source","bogus"])` throws.
- A focused unit test for `resolveOmpAgentDir`: with no env → `<home>/.omp/agent`; with `PI_CONFIG_DIR=".omp2"` → `<home>/.omp2/agent`; with `PI_CODING_AGENT_DIR="/agent"` → `/agent` (wins over `PI_CONFIG_DIR`).

### T6 — Regression (AC-5 / FR-8)
The full existing suite (`node --test`) passes unchanged. omp additions are
purely additive (new branch, new provider block, new constant) and touch no
Claude/Codex code path.

---

## 11. Field-mapping table

omp log → normalized usage (`usageFromOmpUsage`) → persisted `usage_events` row.

| omp usage block field | → normalized usage field | → persisted event (`aggregate.js:66-82`) | Notes |
|---|---|---|---|
| `usage.input` | `input` | `event.usage.input` | non-cached prompt tokens (§5.2) |
| `usage.output` | `output` | `event.usage.output` | completion tokens |
| `usage.cacheRead` | `cacheRead` | `event.usage.cacheRead` | prompt-cache hits |
| `usage.cacheWrite` | `cacheCreate5m` | `event.usage.cacheCreate5m` | §5.3 assumption; cacheCreate30m/1h = 0 |
| — | `cacheCreate30m` = 0 | `event.usage.cacheCreate30m` | omp has no 30m bucket |
| — | `cacheCreate1h` = 0 | `event.usage.cacheCreate1h` | omp has no 1h bucket |
| — | `reasoningOutput` = 0 | `event.usage.reasoningOutput` | omp Usage has no reasoning field |
| — | `contextWindow` = 0 | (not persisted) | — |
| — | `inputIncludesCacheRead` = false | (consumed by `normalizeUsage`, not persisted) | §5.2 |
| `usage.totalTokens` | (not mapped) | — | derived; verified = input+output+cacheRead+cacheWrite |
| `usage.cost.*` | (ignored, A5) | — | cost re-derived by `calculateCost("omp",…)` |
| omp line `model` | (record.model) | `event.model` | bare name, e.g. `"glm-5.2"` |
| (hardcoded) | (record.provider) | `event.provider = "omp"` | A3 explicit pin |
| header `cwd` | (record.project) | `event.project` | from `{"type":"session"}` line |
| — | (record.effort) | `event.effort = "<unknown>"` | omp has no effort (D4) |
| line `timestamp` (ms, post-parse) | (record.timestamp) | `event.timestamp` (ISO) | §4.5 gotcha |

---

## 12. File-by-file change list (ordered by dependency)

> Group A (constants/config) first because B–F consume the `"omp"` provider/agent
> strings. Drawn from the Integration Map checklist, filtered by binding decisions
> A1–A6 (rate-limit/subscription/storage-schema items are dropped as out of scope).

**A — Constants & config**
1. **`lib/core/report-model.js`** — MODIFY. Add `const AGENT_OMP = "omp";` (`:6-8` region) and add `AGENT_OMP` to `module.exports` (`:384-387`). Do NOT touch `inferProvider` (`:368-373`) — A3.
2. **`lib/cli.js`** — MODIFY. Validation array+message (`:130-131`), `defaultOptions.ompHome` (`:32`), `--omp-home` parse (`:77-78`), help banner/`--source`/`--omp-home` (`:179,182,185`). (§7.)

**B — Ingest**
3. **`lib/ingest/sources.js`** — MODIFY. Add `resolveOmpAgentDir(home)` helper; add the `source === "all" || source === "omp"` discovery branch in `discoverInputs` (`:152-172` region) walking `<agentDir>/sessions/**/*.jsonl` (A6: all files). (§3.)
4. **`lib/ingest/parser.js`** — MODIFY. Add `ompState`; add the omp line-shape branches (`type:"session"`, `type:"model_change"`, `type:"message"` assistant+toolResult) and the `addOmpUsage` closure helper inside `createLineProcessor`; add `usageFromOmpUsage` to the `require("../core/usage")` destructure. Pin `provider:"omp"`; do NOT call `inferProvider`; do NOT emit telemetry snapshots. (§4.)
5. **`lib/core/usage.js`** — MODIFY. Add `usageFromOmpUsage(usage)`; export it (`:247-263`). (§5.)

**C — Pricing**
6. **`lib/core/pricing.js`** — MODIFY. Add `PRICING.omp` block (`:24-138`, PLACEHOLDER values), `PRICING_SOURCES.omp` (`:13-21`), `lookupOmpPrices` (+export), and the `provider === "omp"` branch in `calculateCost` (`:239-300`). (§6.1–6.4.)
7. **`lib/core/configuration.js`** — MODIFY. Extend `rowFromPrices` matchMode + sourceUrl ternaries (`:26,36`); add the `PRICING.omp.models` loop to `packagedPricingRows` (`:42-62`). (§6.6.)

**D — Docs & metadata (cleanup)**
8. **`README.md`** — MODIFY. Add omp to the default-roots list and `--source` docs (mirror the `--codex-home`/`CODEX_HOME` documentation). Note `--omp-home`/`OMP_HOME`/`PI_CODING_AGENT_DIR`/`PI_CONFIG_DIR`.
9. **`package.json`** — MODIFY (optional). Add `omp`/`oh-my-pi` to `keywords`/`description`.

**E — Tests (AC-5)**
10. **`test/pricing-usage.test.js`** (and/or **`test/parser.test.js`**) — MODIFY. omp parser happy-path (T1), malformed lenient/strict (T2), pricing known/unknown (T3).
11. **`test/parser.test.js`** — MODIFY. omp ingest→store→render round-trip over a temp omp sessions tree incl. sidecar (T4).
12. **`test/cli-input.test.js`** — MODIFY. `OMP_HOME`/`--omp-home`/`--source omp`/`resolveOmpAgentDir` env wiring (T5).

**NOT modified (out of scope — A4/A2/NG-2/NG-3):**
`lib/core/rate-limits.js`, `lib/core/subscription-plans.js`, `lib/dashboard.js`,
`lib/storage/sqlite.js`, `lib/storage/clickhouse.js`, `lib/web-server.js`,
`public/index.html`.

---

## 13. Acceptance criteria mapping

| AC | Requirement | Spec section(s) | How satisfied |
|----|-------------|-----------------|---------------|
| **AC-1** omp selectable wherever Claude/Codex are (CLI + dashboard) | FR-1, FR-5, FR-6 | §2, §7, §9 | CLI: `--source omp` (§7). Dashboard: no selector exists for any platform; omp surfaces via provider breakdowns with no UI change (§9). `AGENT_OMP`/provider `"omp"` registered (§2). |
| **AC-2** Ingest produces records with same schema, tagged platform="omp" | FR-2, FR-3, FR-4 | §3, §4, §5, §8, §11 | omp branch → `addUsage({provider:"omp",…})` → identical persisted event shape (§8, §11 table). |
| **AC-3** Dashboard shows omp sessions with flat per-session totals + cost from omp pricing | FR-6, FR-7, D4, D5 | §6, §8, §9 | `calculateCost("omp",…)` re-derives cost from omp config (A5); records reach provider/model breakdowns automatically (§9). |
| **AC-4** Unknown omp model → existing unknown-model behavior | FR-7, EC-4 | §6.4, §6.5, §10 (T3) | `lookupOmpPrices`→null → `{known:false}` + `unpricedModels` flag; no NaN/zero-as-known. |
| **AC-5** Tests: parser (happy + malformed), pricing, ingest→store→render round-trip; full suite green | NFR-5, FR-8 | §10 (T1–T6) | Five test cases + regression; `node --test` passes unchanged. |
| **AC-6** Removing/disabling omp source → clear non-silent error; others unchanged | FR-8, EC-1, EC-3 | §3, §9 | `--source omp` with missing/empty root yields zero sessions (graceful, EC-3); discovery errors surface via existing `walkFiles`/ingest conventions; Claude/Codex paths untouched (additive). |

---

## 14. Open items / placeholders (non-blocking for implementation; blocking for accurate cost)

- **OI-S1 (PLACEHOLDER pricing):** `PRICING.omp.models` numeric values and the
  `PRICING_SOURCES.omp` URL are PLACEHOLDER (§6.1–6.2). They MUST be filled from
  the official omp/GLM (Zhipu AI) price list before release. Until filled, omp
  models resolve to `{known:false}` (EC-4) — the integration is functionally
  complete; only the dollar amounts are pending. DrPe to confirm the
  authoritative price-list URL.
- **OI-S2 (cacheWrite bucket):** the `cacheWrite → cacheCreate5m` mapping (§5.3)
  is an assumption; revisit when non-zero `cacheWrite` data is observed.
- **OI-S3 (sidecar toggle):** A6 ingests all files; a future parent-only toggle
  is explicitly deferred (YAGNI).
