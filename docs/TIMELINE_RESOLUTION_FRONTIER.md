# Timeline Resolution Frontier SDD

Document status: admitted implementation
Current frontier: zoomable 15-minute usage and project cost timelines

## Admitted Surface

- Usage events with valid timestamps aggregate into canonical UTC 15-minute
  buckets for direct scans, SQLite reports, and ClickHouse reports.
- The dashboard may fold those buckets into hourly or daily rows without
  repricing or averaging rates.
- Token Flow, Cost Mix, and Project Cost expose `15m`, `Hourly`, and `Daily`
  resolutions. Existing weekly/monthly Cost Mix remains available.
- Project charts default to hourly precision. Wheel and selection zoom may reach
  one bucket, including a single 15-minute interval.
- Missing or invalid timestamps remain in total aggregates but are excluded from
  intraday timelines.
- The summary payload excludes intraday rows. `/api/timeline` returns a compact
  global range or one explicitly selected project on demand.
- Each provider/model is a stable-color point and Catmull-Rom line series.
  Missing model usage or a missing source interval terminates that model's line.
- Hover or a pinned project interval shows total cost/tokens plus per-model
  `cost / tokens / share`; the chart header remains the aggregate interval mix.

## Rejected Surface

- Fabricating empty intervals or interpolating missing usage as measured data.
- Treating browser-local time as a storage key. Labels may be localized, while
  the API key remains UTC.
- Persisting another timestamp column solely for this view.
- Returning raw event rows to the browser for client-side aggregation.

## Design Laws

1. A 15-minute bucket is `[floor(timestamp/15m), +15m)` in UTC.
2. Coarser rows are sums of complete finer rows; cost components and tariff
   coverage counters must remain additive.
3. Resolution changes reset index zoom because row indexes are not stable across
   bucket widths.
4. A one-point view is valid and must not divide by zero or resize the canvas.
5. Sparse usage is not zero usage: model lines must break instead of connecting
   across an interval where that model has no row.
6. Intraday payload is demand-driven. The initial summary must not include every
   project timeline.

## Falsifiers

- Timestamps at `:14:59.999` and `:15:00.000` land in adjacent buckets.
- Equal project events in separate quarter-hours remain separate in direct,
  SQLite, and ClickHouse summaries.
- Hourly folding equals the sum of its four quarter-hour rows, including cache
  creation/read cost and priced/unpriced counters.
- Invalid timestamps do not create a `1970` or `unknown` intraday point.
- Zoom can reach one row and switching resolution resets the old zoom indexes.
- A model absent from the middle interval produces two disconnected runs.
- The initial summary has no `timeline` branch; project selection fetches only
  that project's compact timeline.

## Evidence

- Unit and API falsifiers: `test/pricing-usage.test.js`, `test/sqlite.test.js`,
  `test/clickhouse.test.js`, `test/dashboard-report.test.js`, and
  `test/web.test.js`.
- Real ClickHouse browser probe on 2026-07-14: daily, 15-minute, and hourly
  canvases rendered colored sparse model series and per-interval model popup.
- Real ClickHouse payload probe on the same dataset: the former eager summary
  was 68.7 MB; the lazy summary was 4.46 MB, a 90-day global timeline 6.51 MB,
  and the selected project's all-time timeline 4.00 MB.
- Full-suite evidence is recorded in the implementation commit.
