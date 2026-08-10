import fetch from 'node-fetch';
import { config } from './config.js';
import { logWarn, logError } from './logger.js';

const COUNTS_URL = 'https://slack.com/api/client.counts';
const RAW_LOG_LIMIT = 4000;

function truncateRaw(raw) {
  if (typeof raw !== 'string') return String(raw);
  return raw.length > RAW_LOG_LIMIT ? `${raw.slice(0, RAW_LOG_LIMIT)}… (${raw.length} bytes total)` : raw;
}

function toTimestamp(value) {
  if (typeof value === 'string' || typeof value === 'number') return Number(value);
  if (value && typeof value === 'object') return Number(value.ts);
  return NaN;
}

function computeHasUnreads(entry) {
  if (typeof entry.has_unreads === 'boolean') return entry.has_unreads;
  const lastRead = toTimestamp(entry.last_read);
  const latest = toTimestamp(entry.latest);
  if (Number.isFinite(lastRead) && Number.isFinite(latest)) return latest > lastRead;
  return false;
}

function collectBucket(bucket, target) {
  if (!Array.isArray(bucket)) return;
  for (const entry of bucket) {
    if (!entry || typeof entry.id !== 'string') continue;
    const mentionCount = Number(entry.mention_count) > 0 ? Number(entry.mention_count) : 0;
    const hasUnreads = computeHasUnreads(entry) || mentionCount > 0;
    if (!hasUnreads) continue;
    target.set(entry.id, { hasUnreads: true, mentionCount });
  }
}

export function normalizeUnreadCounts(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const buckets = [payload.channels, payload.mpims, payload.ims, payload.groups];
  if (!buckets.some(bucket => Array.isArray(bucket))) return null;

  const counts = new Map();
  for (const bucket of buckets) collectBucket(bucket, counts);
  return counts;
}

export async function fetchUnreadCountsRaw() {
  if (!config.xoxc || !config.xoxd) return { skipped: true, reason: 'SLACK_XOXC / SLACK_XOXD not set' };

  const response = await fetch(COUNTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.xoxc}`,
      Cookie: `d=${config.xoxd}`,
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8'
    }
  });

  const text = await response.text();
  let payload = null;
  let parseError = null;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    parseError = err;
  }

  return { skipped: false, status: response.status, text, payload, parseError };
}

export async function fetchUnreadCounts() {
  if (!config.xoxc || !config.xoxd) return null;

  try {
    const result = await fetchUnreadCountsRaw();

    if (result.parseError) {
      logError(`client.counts returned non-JSON body: ${truncateRaw(result.text)}`, result.parseError);
      return null;
    }

    if (!result.payload || result.payload.ok !== true) {
      logError(`client.counts failed (HTTP ${result.status}): ${truncateRaw(result.text)}`);
      return null;
    }

    const counts = normalizeUnreadCounts(result.payload);
    if (!counts) {
      logWarn(`client.counts response had no recognizable buckets: ${truncateRaw(result.text)}`);
      return null;
    }

    return counts;
  } catch (err) {
    logError('Failed to fetch Slack unread counts', err);
    return null;
  }
}
