import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { SessionStore } from './store.ts';
import type { CodexAccount } from './codex-account.ts';
import { codexTokensSchema, type EventPayload } from '@cc-desk-tunnel/protocol';

export const titlePrompt =
  'Give this conversation a short, searchable title in the user’s language. Summarize the specific topic or task in one line. Return only the title, without quotes or Markdown. Do not call tools.';

export function codexTitle(value: unknown) {
  if (typeof value !== 'string') return '';
  const line = value
    .trim()
    .split(/\r?\n/, 1)[0]
    .replace(/^#+\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length <= 120 ? line : line.slice(0, 119).replace(/[\uD800-\uDBFF]$/, '') + '…';
}

function tokens(raw: Record<string, unknown> | undefined) {
  return codexTokensSchema.safeParse({
    inputTokens: raw?.input_tokens,
    cachedInputTokens: raw?.cached_input_tokens,
    cacheWriteInputTokens: raw?.cache_write_input_tokens,
    outputTokens: raw?.output_tokens,
    reasoningOutputTokens: raw?.reasoning_output_tokens,
    totalTokens: raw?.total_tokens,
  });
}

// A completed compaction can precede its final usage notification on stdio.
// Read the CLI's persisted measurement, never estimate from the length of its summary.
export async function compactedCodexUsage(path: string | null | undefined) {
  if (!path) return;
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let compacted = false;
  let reading;
  try {
    for await (const line of lines) {
      if (!line.includes('"compacted"') && !line.includes('"token_count"')) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.type === 'compacted') {
        compacted = true;
        reading = undefined;
      } else if (
        compacted &&
        record.type === 'event_msg' &&
        record.payload?.type === 'token_count'
      ) {
        const info = record.payload.info;
        const last = tokens(info?.last_token_usage),
          total = tokens(info?.total_token_usage);
        if (
          last.success &&
          total.success &&
          Number.isSafeInteger(info.model_context_window) &&
          info.model_context_window > 0
        )
          reading = {
            last: last.data,
            total: total.data,
            window: info.model_context_window as number,
          };
      }
    }
    return reading;
  } catch {
    // Some threads have no local rollout or are still flushing it.
    return undefined;
  } finally {
    lines.close();
    stream.destroy();
  }
}

export async function restoreCodexSessionInfo(
  store: SessionStore,
  account: Pick<CodexAccount, 'threadInfo' | 'summarizeThread'>,
  updated: (id: string) => void,
  record: (id: string, runId: string, event: EventPayload, createdAt?: string) => void,
  closing: () => boolean,
) {
  for (const session of store.list()) {
    if (closing()) return;
    if (session.activeRun) continue;
    const id = session.id;
    const unnamed = session.autoTitle && session.title === '新会话';
    const compact = store.lastCodexEvent(id, 'native.compact');
    const usage = store.lastCodexEvent(id, 'codex.usage');
    const stale = compact && usage && usage.sequence < compact.sequence;
    if (!unnamed && !stale) continue;
    const fallback = unnamed && codexTitle(store.firstCodexPrompt(id));
    if (fallback) {
      store.renameNative(id, fallback);
      updated(id);
    }
    const thread = store.codexThread(id);
    if (!thread) continue;
    try {
      const info = await account.threadInfo(thread);
      const reading = stale && (await compactedCodexUsage(info?.path));
      if (closing()) return;
      const current = store.get(id).session;
      if (current.activeRun || thread !== store.codexThread(id)) continue;
      if (
        reading &&
        usage?.payload.type === 'codex.usage' &&
        reading.total.totalTokens === usage.payload.total.totalTokens &&
        store.lastCodexEvent(id, 'codex.usage')?.sequence === usage.sequence &&
        store.lastCodexEvent(id, 'native.compact')?.sequence === compact.sequence
      )
        record(id, compact.runId, {
          type: 'codex.usage',
          contextOnly: true,
          model: usage.payload.model,
          threadId: thread,
          ...reading,
        });
      if (unnamed && current.autoTitle && info) {
        const name =
          codexTitle(info.name) ||
          codexTitle(await account.summarizeThread(thread)) ||
          codexTitle(info.preview);
        if (closing()) return;
        const latest = store.get(id).session;
        if (
          name &&
          latest.autoTitle &&
          !latest.activeRun &&
          latest.updatedAt === session.updatedAt &&
          latest.title === (fallback || '新会话')
        ) {
          store.renameNative(id, name);
          if (usage)
            record(id, usage.runId, { type: 'native.title', title: name }, latest.updatedAt);
          updated(id);
        }
      }
    } catch {
      // Deleted, unavailable or still loading threads can be reconciled on a later start.
    }
  }
}
