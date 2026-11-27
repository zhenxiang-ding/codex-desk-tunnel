import { createServer } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { AccountState, ServerMessage } from '@cc-desk-tunnel/protocol';

type Summary = Omit<Extract<ServerMessage, { type: 'usage.summary' }>, 'type' | 'requestId'>;
type Period = Pick<Summary['windows'][number], 'name' | 'startedAt' | 'resetsAt' | 'utilization'>;
type Page = Omit<Extract<ServerMessage, { type: 'usage.page' }>, 'type' | 'requestId'>;
type RateLimits = {
  windows: { name: string; utilization: number | null; resetsAt: string | null }[];
  measuredAt?: string | null;
};
export type UsageQuery = {
  from?: string;
  to?: string;
  model?: string;
  beforeId?: number;
  offset?: number;
  limit: number;
  bucketMinutes: number;
  offsetMinutes: number;
};

const windowLength: Record<string, number> = { five_hour: 5 * 3600_000 };
const lengthOf = (name: string) =>
  windowLength[name] ?? (name.startsWith('seven_day') ? 7 * 24 * 3600_000 : undefined);
// Two readings taken at the same moment can differ by a point, and the later one may be the lower; a reset
// takes away far more than that.
const resetDrop = 5;
const totals = `COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens, COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens,
  COALESCE(SUM(cost_usd), 0) AS costUsd`;

// Standard short-context USD per million tokens (input, output, cache read, 30-minute write).
// https://developers.openai.com/api/docs/pricing.md . Use one published reference tariff across plans.
const standardRates: Record<string, [number, number, number, number]> = {
  'gpt-6.2-astra': [8, 40, 0.4, 10],
  'gpt-6.2-sol': [2, 10, 0.1, 2.5],
  'gpt-6-astra': [10, 50, 1, 12.5],
  'gpt-6.1-sol': [2, 10, 0.1, 2.5],
  'gpt-6.1-terra': [1, 5, 0.05, 1.25],
  'gpt-6-luna': [0.1, 0.5, 0.01, 0.125],
  'gpt-6-sol': [2, 10, 0.2, 2.5],
  'gpt-5.6-sol': [4, 20, 0.4, 5],
  'gpt-5.6-terra': [2, 12, 0.2, 2.5],
  'gpt-5.6-luna': [0.2, 1.2, 0.02, 0.25],
  'gpt-5.5': [5, 30, 0.5, 5],
  'gpt-5.4': [2.5, 15, 0.25, 2.5],
  'gpt-5.4-mini': [0.75, 4.5, 0.075, 0.75],
  'gpt-5.3-codex': [1.75, 14, 0.175, 1.75],
  'gpt-5.2': [1.75, 14, 0.175, 1.75],
};
const estimate =
  'CASE model ' +
  Object.entries(standardRates)
    .map(
      ([model, [input, output, read, write]]) =>
        `WHEN '${model}' THEN (input_tokens * ${input} + output_tokens * ${output} + cache_read_tokens * ${read} + cache_creation_tokens * ${write}) / 1000000.0`,
    )
    .join(' ') +
  ' ELSE 0 END';

// Codex includes cache reads in inputTokens and reasoning in outputTokens.
const codexInsert = (events: string) => `INSERT OR IGNORE INTO api_requests
  (at, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
   cost_usd, duration_ms, ttft_ms, prompt_id, source, request_id)
  SELECT ROUND(unixepoch(at, 'subsec') * 1000), session_id, COALESCE(payload ->> 'model','未记录'),
    MAX(0, (last ->> 'inputTokens') - (last ->> 'cachedInputTokens') - COALESCE(last ->> 'cacheWriteInputTokens',0)), last ->> 'outputTokens',
    last ->> 'cachedInputTokens', COALESCE(last ->> 'cacheWriteInputTokens',0), 0,
    COALESCE(payload ->> 'durationMs',0), payload ->> 'ttftMs', payload ->> 'promptId', 'codex',
    'codex:' || COALESCE(payload ->> 'threadId',session_id) || ':' || (payload ->> '$.total.totalTokens')
  FROM (SELECT session_id, data ->> 'createdAt' AS at, data -> 'payload' AS payload,
    data -> '$.payload.last' AS last FROM ${events})
  WHERE payload ->> 'type' = 'codex.usage' AND COALESCE(payload ->> 'contextOnly', 0) = 0 AND last ->> 'totalTokens' > 0`;

// Averages over the requests that report a first-token time; the speed counts only the time spent streaming.
const streaming = `AVG(ttft_ms) AS ttftMs,
  SUM(CASE WHEN ttft_ms IS NOT NULL AND duration_ms > ttft_ms THEN output_tokens END) AS streamedTokens,
  SUM(CASE WHEN ttft_ms IS NOT NULL AND duration_ms > ttft_ms THEN duration_ms - ttft_ms END) AS streamedMs`;
const perSecond = (tokens: number | null, ms: number | null) =>
  tokens && ms ? tokens / (ms / 1000) : null;

// The official CLI reports every model request through its own OpenTelemetry log export; the Linux service is the
// collector. Costs are the CLI's API-price estimate for each request, not a subscription bill.
export function telemetryEnvironment(endpoint: string): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
    OTEL_LOGS_EXPORT_INTERVAL: '2000',
  };
}

export class UsageLog {
  database: DatabaseSync;
  retentionDays: number;
  maxRows: number;
  private readonly codex: boolean;
  private codexWindows: Period[] = [];
  constructor(database: DatabaseSync, retentionDays = 35, maxRows = 200_000, codex = false) {
    this.database = database;
    this.codex = codex;
    this.retentionDays = retentionDays;
    this.maxRows = maxRows;
    database.exec(`
      CREATE TABLE IF NOT EXISTS api_requests (
        id INTEGER PRIMARY KEY, at INTEGER NOT NULL, session_id TEXT, model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL, duration_ms INTEGER NOT NULL, ttft_ms INTEGER, source TEXT, request_id TEXT UNIQUE
      );
      CREATE INDEX IF NOT EXISTS api_requests_at ON api_requests(at);
      CREATE TABLE IF NOT EXISTS usage_windows (
        name TEXT PRIMARY KEY, started_at INTEGER NOT NULL, resets_at INTEGER, utilization REAL, observed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
    `);
    // The prompt a request belongs to, which is how one turn's requests, subagents included, are told apart.
    const columns = database.prepare('PRAGMA table_info(api_requests)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'prompt_id'))
      database.exec('ALTER TABLE api_requests ADD COLUMN prompt_id TEXT');
    database.exec('CREATE INDEX IF NOT EXISTS api_requests_prompt ON api_requests(prompt_id)');
    database.exec('CREATE INDEX IF NOT EXISTS api_requests_session ON api_requests(session_id)');
    if (codex) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS codex_limits(account TEXT, mins INTEGER, percent REAL, reset INTEGER, observed INTEGER, PRIMARY KEY(account, mins));
        BEGIN;
        DROP TRIGGER IF EXISTS log_codex_usage;
        CREATE TRIGGER log_codex_usage AFTER INSERT ON events
        WHEN NEW.data ->> '$.payload.type' = 'codex.usage' BEGIN
          ${codexInsert('(SELECT NEW.data AS data, NEW.session_id AS session_id)')};
          UPDATE api_requests SET cost_usd = ${estimate} WHERE changes() > 0 AND id = last_insert_rowid();
        END; COMMIT;`);
      if (!database.prepare("SELECT 1 FROM migrations WHERE name='codex-call-log'").get()) {
        database.exec('BEGIN');
        try {
          database.exec(codexInsert('events'));
          database.exec("INSERT INTO migrations VALUES ('codex-call-log'); COMMIT");
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      }
      if (
        !database.prepare("SELECT 1 FROM migrations WHERE name='codex-reference-prices-v1'").get()
      ) {
        database.exec(`BEGIN; UPDATE api_requests SET cost_usd = ${estimate} WHERE source='codex';
          INSERT INTO migrations VALUES ('codex-reference-prices-v1'); COMMIT;`);
      }
    }
    this.restoreStarts();
    this.prune();
  }
  // Periods that a one-point dip in the reported utilization had cut short get back the start their reset time
  // implies. Only the period boundary is corrected; the request records were never touched.
  private restoreStarts(now = Date.now()) {
    if (this.database.prepare("SELECT 1 FROM migrations WHERE name = 'usage-window-start'").get())
      return;
    const windows = (
      this.database.prepare('SELECT name, started_at, resets_at FROM usage_windows').all() as {
        name: string;
        started_at: number;
        resets_at: number | null;
      }[]
    ).flatMap((window) => {
      const length = lengthOf(window.name);
      if (!length || !window.resets_at || window.resets_at <= now) return [];
      const expected = window.resets_at - length;
      return window.started_at > expected
        ? [{ ...window, resets_at: window.resets_at, expected }]
        : [];
    });
    this.database.exec('BEGIN');
    try {
      // The stored start alone cannot tell a cut-short period from one a reset card began, so the quota readings
      // kept with the sessions are read once, and only when some period needs it.
      const resets = windows.length ? this.earlyResets(windows, now) : new Map<string, number>();
      for (const window of windows)
        this.database
          .prepare('UPDATE usage_windows SET started_at = ? WHERE name = ?')
          .run(
            Math.min(window.started_at, Math.max(window.expected, resets.get(window.name) ?? 0)),
            window.name,
          );
      this.database.prepare("INSERT INTO migrations VALUES ('usage-window-start')").run();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  // The last time each period's utilization fell as a reset makes it fall while its reset time stayed the same.
  private earlyResets(
    windows: { name: string; resets_at: number; expected: number }[],
    now: number,
  ) {
    const resets = new Map<string, number>();
    if (
      !this.database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'")
        .get()
    )
      return resets;
    // The text test spares parsing every event of every session; few of them are quota readings.
    const readings = (
      this.database
        .prepare(
          `SELECT COALESCE(json_extract(data, '$.payload.rateLimits.measuredAt'), json_extract(data, '$.createdAt')) AS at,
            json_extract(data, '$.payload.rateLimits.windows') AS windows
          FROM events
          WHERE instr(data, '"native.metrics"') > 0 AND json_extract(data, '$.payload.type') = 'native.metrics'
            AND json_extract(data, '$.payload.rateLimits.available') = 1`,
        )
        .all() as { at: string; windows: string }[]
    )
      .map((row) => ({
        at: Date.parse(row.at),
        windows: (JSON.parse(row.windows) ?? []) as RateLimits['windows'],
      }))
      .filter((reading) => reading.at <= now)
      .sort((a, b) => a.at - b.at);
    for (const window of windows) {
      let previous: { at: number; utilization: number | null } | undefined;
      for (const { at, windows } of readings) {
        const reading = windows.find((item) => item.name === window.name);
        const end = reading?.resetsAt && Date.parse(reading.resetsAt);
        if (!reading || !end || Math.abs(end - window.resets_at) > 5 * 60_000) continue;
        if (at < window.expected || (previous && at <= previous.at)) continue;
        if (
          reading.utilization !== null &&
          previous?.utilization != null &&
          previous.utilization - reading.utilization >= resetDrop
        )
          resets.set(window.name, previous.at);
        previous = { at, utilization: reading.utilization };
      }
    }
    return resets;
  }
  // Accepts one OTLP/HTTP JSON log export and keeps only the model request records.
  ingest(body: unknown) {
    const insert = this.database.prepare(`INSERT OR IGNORE INTO api_requests
      (at, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms, ttft_ms, source, request_id, prompt_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let stored = 0;
    for (const resource of asArray((body as { resourceLogs?: unknown })?.resourceLogs))
      for (const scope of asArray(resource?.scopeLogs))
        for (const record of asArray(scope?.logRecords)) {
          const fields = new Map<string, string | number>();
          for (const attribute of asArray(record?.attributes)) {
            const value =
              attribute?.value?.stringValue ??
              attribute?.value?.intValue ??
              attribute?.value?.doubleValue;
            if (typeof attribute?.key === 'string' && value !== undefined)
              fields.set(attribute.key, value);
          }
          if (fields.get('event.name') !== 'api_request') continue;
          const number = (name: string) => {
            const value = Number(fields.get(name));
            return Number.isFinite(value) && value >= 0 ? value : 0;
          };
          const text = (name: string) => {
            const value = fields.get(name);
            return typeof value === 'string' && value ? value.slice(0, 200) : null;
          };
          const at =
            Date.parse(String(fields.get('event.timestamp'))) ||
            Math.floor(Number(record.timeUnixNano) / 1e6) ||
            Date.now();
          stored += Number(
            insert.run(
              at,
              text('session.id'),
              text('model') ?? 'unknown',
              number('input_tokens'),
              number('output_tokens'),
              number('cache_read_tokens'),
              number('cache_creation_tokens'),
              number('cost_usd'),
              number('duration_ms'),
              fields.has('ttft_ms') ? number('ttft_ms') : null,
              text('query_source'),
              text('request_id'),
              text('prompt.id'),
            ).changes,
          );
        }
    return stored;
  }
  // Statistics follow the official quota periods. A period ends when the reported reset time moves or the utilization
  // falls by more than the jitter between readings, which also covers resets granted outside the normal schedule.
  observe(rateLimits: RateLimits, now = Date.now()) {
    const measuredAt = (rateLimits.measuredAt && Date.parse(rateLimits.measuredAt)) || now;
    for (const window of rateLimits.windows) {
      const previous = this.database
        .prepare(
          'SELECT started_at, resets_at, utilization, observed_at FROM usage_windows WHERE name = ?',
        )
        .get(window.name) as
        | {
            started_at: number;
            resets_at: number | null;
            utilization: number | null;
            observed_at: number;
          }
        | undefined;
      // A long turn repeats its last reading with every context refresh, by then possibly older than another
      // session's; only a newer reading says anything.
      if (previous && measuredAt <= previous.observed_at) continue;
      const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) || null : null;
      const length = lengthOf(window.name);
      const expected = resetsAt && length ? resetsAt - length : undefined;
      let startedAt = previous?.started_at ?? Math.min(measuredAt, expected ?? measuredAt);
      if (
        previous &&
        ((resetsAt !== null &&
          previous.resets_at !== null &&
          Math.abs(resetsAt - previous.resets_at) > 5 * 60_000) ||
          (window.utilization !== null &&
            previous.utilization !== null &&
            previous.utilization - window.utilization >= resetDrop))
      )
        // The reset happened between the two observations; the reported period start is used when it falls in between.
        startedAt = Math.min(measuredAt, Math.max(previous.observed_at, expected ?? measuredAt));
      // An expired window is reported without a reset time until its next period begins; the last one known
      // stays, so that the next period is recognised by its new reset time however little had been used.
      this.database
        .prepare(
          `INSERT INTO usage_windows (name, started_at, resets_at, utilization, observed_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET started_at = excluded.started_at, resets_at = excluded.resets_at,
          utilization = excluded.utilization, observed_at = excluded.observed_at`,
        )
        .run(
          window.name,
          startedAt,
          resetsAt ?? previous?.resets_at ?? null,
          window.utilization,
          measuredAt,
        );
    }
  }
  // Official subscription readings belong to the signed-in account. Local request counts cover this VPS.
  codexAccount(state: AccountState, now = Date.now()) {
    this.codexWindows = [];
    if (!state.loggedIn || state.authMethod !== 'chatgpt' || !state.email) return;
    const account = createHash('sha256')
      .update(JSON.stringify([state.email, state.organization, state.subscriptionType]))
      .digest('hex');
    this.database.prepare('DELETE FROM codex_limits WHERE reset <= ?').run(now / 1000);
    const save = this.database.prepare(`INSERT INTO codex_limits VALUES (?,?,?,?,?)
      ON CONFLICT(account,mins) DO UPDATE SET percent=excluded.percent,reset=excluded.reset,observed=excluded.observed
      WHERE excluded.observed >= observed`);
    const observed = state.codexLimitsAt && Date.parse(state.codexLimitsAt);
    for (const w of [state.codexLimits?.primary, state.codexLimits?.secondary]) {
      if (observed && w?.windowDurationMins && w.resetsAt && w.resetsAt > now / 1000)
        save.run(account, w.windowDurationMins, w.usedPercent, w.resetsAt, observed);
    }
    const readings = this.database
      .prepare('SELECT mins,percent,reset FROM codex_limits WHERE account=? ORDER BY mins')
      .all(account) as { mins: number; percent: number; reset: number }[];
    for (const r of readings) {
      const name = r.mins === 300 ? 'five_hour' : r.mins === 10080 ? 'seven_day' : null;
      if (!name) continue;
      this.codexWindows.push({
        name,
        startedAt: new Date(r.reset * 1000 - r.mins * 60000).toISOString(),
        resetsAt: new Date(r.reset * 1000).toISOString(),
        utilization: r.percent,
      });
    }
  }
  currentCodexWindows(now = Date.now()) {
    return this.codexWindows.filter((w) => w.resetsAt && Date.parse(w.resetsAt) > now);
  }
  summary(now = Date.now()): Summary {
    if (this.codex) {
      const counts = this.database.prepare(
        `SELECT ${totals} FROM api_requests WHERE source='codex' AND at >= ? AND at <= ?`,
      );
      const first = this.database
        .prepare("SELECT MIN(at) AS at FROM api_requests WHERE source='codex'")
        .get()?.at as number | null;
      return {
        retentionDays: this.retentionDays,
        firstRecordAt: first ? new Date(first).toISOString() : null,
        windows: this.currentCodexWindows(now).map((w) => ({
          ...w,
          ...(counts.get(Date.parse(w.startedAt), now) as Omit<
            Summary['windows'][number],
            keyof Period
          >),
        })),
      };
    }
    const windows = this.database
      .prepare('SELECT name, started_at, resets_at, utilization FROM usage_windows ORDER BY rowid')
      .all() as {
      name: string;
      started_at: number;
      resets_at: number | null;
      utilization: number | null;
    }[];
    const first = this.database.prepare('SELECT MIN(at) AS at FROM api_requests').get() as {
      at: number | null;
    };
    return {
      retentionDays: this.retentionDays,
      firstRecordAt: first.at ? new Date(first.at).toISOString() : null,
      windows: windows.map((window) => {
        // Past the reset time nothing has been reported yet for the next period; only later requests can belong to it.
        const expired = window.resets_at !== null && window.resets_at <= now;
        const startedAt = expired ? window.resets_at! : window.started_at;
        return {
          name: window.name,
          startedAt: new Date(startedAt).toISOString(),
          resetsAt: window.resets_at && !expired ? new Date(window.resets_at).toISOString() : null,
          utilization: expired ? null : window.utilization,
          ...(this.database
            .prepare(`SELECT ${totals} FROM api_requests WHERE at >= ?`)
            .get(startedAt) as Omit<
            Summary['windows'][number],
            'name' | 'startedAt' | 'resetsAt' | 'utilization'
          >),
        };
      }),
    };
  }
  query(query: UsageQuery, title: (sessionId: string) => string | null): Page {
    const conditions = [
      'at >= ?',
      'at < ?',
      this.codex ? "source = 'codex'" : "source IS NOT 'codex'",
    ];
    const range: (string | number)[] = [
      query.from ? Date.parse(query.from) : 0,
      query.to ? Date.parse(query.to) : Number.MAX_SAFE_INTEGER,
    ];
    const filtered = [...conditions, ...(query.model ? ['model = ?'] : [])].join(' AND ');
    const values = [...range, ...(query.model ? [query.model] : [])];
    const rows = this.database
      .prepare(
        `SELECT id, at, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        cost_usd, duration_ms, ttft_ms, source FROM api_requests
      WHERE ${filtered}${query.beforeId ? ' AND id < ?' : ''} ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(
        ...values,
        ...(query.beforeId ? [query.beforeId] : []),
        query.limit + 1,
        query.offset ?? 0,
      ) as Record<string, number | string | null>[];
    const total = this.database
      .prepare(
        `SELECT ${totals}, COALESCE(SUM(duration_ms), 0) AS durationMs, ${streaming}
      FROM api_requests WHERE ${filtered}`,
      )
      .get(...values) as Record<string, number | null>;
    const bucket = query.bucketMinutes * 60_000,
      offset = query.offsetMinutes * 60_000;
    const series = this.database
      .prepare(
        `SELECT CAST((at + ?) / ? AS INTEGER) AS bucket, COUNT(*) AS requests, SUM(cost_usd) AS costUsd,
        SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
        SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
        SUM(cache_read_tokens) AS cacheReadTokens, SUM(cache_creation_tokens) AS cacheCreationTokens
      FROM api_requests WHERE ${filtered} GROUP BY bucket ORDER BY bucket`,
      )
      .all(offset, bucket, ...values) as ({
      bucket: number;
      tokens: number;
    } & Page['series'][number])[];
    // Like the model list, the breakdown covers every model of the range, whichever one is being looked at.
    const byModel = this.database
      .prepare(
        `SELECT model, ${totals} FROM api_requests WHERE ${conditions.join(' AND ')}
        GROUP BY model ORDER BY costUsd DESC, requests DESC, model`,
      )
      .all(...range) as Page['byModel'];
    const { streamedTokens, streamedMs, ...sums } = total;
    return {
      rows: rows.slice(0, query.limit).map((row) => ({
        id: row.id as number,
        at: new Date(row.at as number).toISOString(),
        sessionId: row.session_id as string | null,
        sessionTitle: row.session_id ? title(row.session_id as string) : null,
        model: row.model as string,
        inputTokens: row.input_tokens as number,
        outputTokens: row.output_tokens as number,
        cacheReadTokens: row.cache_read_tokens as number,
        cacheCreationTokens: row.cache_creation_tokens as number,
        costUsd: row.cost_usd as number,
        durationMs: row.duration_ms as number,
        ttftMs: row.ttft_ms as number | null,
        source: row.source as string | null,
      })),
      hasMore: rows.length > query.limit,
      totals: {
        ...(sums as Page['totals']),
        outputPerSecond: perSecond(streamedTokens, streamedMs),
      },
      // The model list ignores the model filter so the filter can be changed from any selection.
      models: byModel.map((row) => row.model).sort(),
      byModel,
      series: series.map(({ bucket: index, ...item }) => ({
        ...item,
        at: new Date(index * bucket - offset).toISOString(),
      })),
    };
  }
  // One question's model requests, summed with the figures the call log shows: the requests of its prompts, which
  // include a subagent's long after the turn, and those inside its time window, which include the ones made under a
  // prompt the CLI never told us of.
  turnStats(
    sessionId: string,
    turn: { promptIds: string[]; startedAt?: number; endedAt?: number },
  ) {
    const { streamedTokens, streamedMs, costUsd, ...sums } = this.database
      .prepare(
        `SELECT ${totals}, COALESCE(SUM(duration_ms), 0) AS modelMs, COALESCE(SUM(source IN ('sdk', 'codex')), 0) AS mainRequests, ${streaming}
      FROM api_requests WHERE session_id = ? AND (at >= ? AND at <= ?${
        turn.promptIds.length > 0
          ? ` OR prompt_id IN (${turn.promptIds.map(() => '?').join(',')})`
          : ''
      })`,
      )
      .get(sessionId, turn.startedAt ?? null, turn.endedAt ?? null, ...turn.promptIds) as Record<
      string,
      number | null
    > & {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      modelMs: number;
      mainRequests: number;
      ttftMs: number | null;
    };
    return { ...sums, outputPerSecond: perSecond(streamedTokens, streamedMs) };
  }
  // A whole session's requests, subagents included, summed the way turnStats sums a turn. Turns are the distinct
  // prompts; a request without one belongs to no turn.
  sessionStats(sessionId: string) {
    const { streamedTokens, streamedMs, ...sums } = this.database
      .prepare(
        `SELECT ${totals}, COUNT(DISTINCT prompt_id) AS turns, COALESCE(SUM(duration_ms), 0) AS modelMs, ${streaming}
      FROM api_requests WHERE session_id = ?`,
      )
      .get(sessionId) as {
      turns: number;
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      modelMs: number;
      ttftMs: number | null;
      streamedTokens: number | null;
      streamedMs: number | null;
      costUsd: number;
    };
    const first = this.database.prepare('SELECT MIN(at) AS at FROM api_requests').get() as {
      at: number | null;
    };
    return {
      ...sums,
      outputPerSecond: perSecond(streamedTokens, streamedMs),
      firstRecordAt: first.at ? new Date(first.at).toISOString() : null,
    };
  }
  prune(now = Date.now()) {
    this.database
      .prepare('DELETE FROM api_requests WHERE at < ?')
      .run(now - this.retentionDays * 24 * 3600_000);
    this.database
      .prepare(
        'DELETE FROM api_requests WHERE id <= (SELECT id FROM api_requests ORDER BY id DESC LIMIT 1 OFFSET ?)',
      )
      .run(this.maxRows);
  }
}
function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

// Loopback only: the CLI processes on this host are the only senders.
export function createUsageReceiver(log: UsageLog) {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/logs') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) request.destroy();
      else chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        log.ingest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      } catch {
        response.writeHead(400).end();
      }
    });
  });
  const timer = setInterval(() => log.prune(), 3600_000);
  timer.unref();
  return {
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No listening address');
      return `http://127.0.0.1:${address.port}/v1/logs`;
    },
    async close() {
      clearInterval(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
