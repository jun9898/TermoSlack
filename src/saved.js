import fetch from 'node-fetch';
import { config } from './config.js';
import { logInfo, logError } from './logger.js';

const SAVED_URL = 'https://slack.com/api/saved.list';
const RAW_LOG_LIMIT = 4000;

function truncateRaw(raw) {
  if (typeof raw !== 'string') return String(raw);
  return raw.length > RAW_LOG_LIMIT ? `${raw.slice(0, RAW_LOG_LIMIT)}… (${raw.length} bytes total)` : raw;
}

export function hasSavedCredentials() {
  return !!(config.xoxc && config.xoxd);
}

export function normalizeSavedItems(payload) {
  const rawItems = payload && Array.isArray(payload.saved_items) ? payload.saved_items : null;
  if (!rawItems) return null;

  return rawItems
    .filter(item => item && item.item_type === 'message')
    .filter(item => typeof item.item_id === 'string' && typeof item.ts === 'string')
    .map(item => ({
      channelId: item.item_id,
      ts: item.ts,
      dateCreated: Number(item.date_created) || 0,
      dateDue: Number(item.date_due) || 0,
      state: item.state || '',
      todoState: item.todo_state || ''
    }))
    .sort((a, b) => b.dateCreated - a.dateCreated);
}

export async function fetchSavedItems(limit = 50) {
  if (!hasSavedCredentials()) {
    return { ok: false, reason: 'SLACK_XOXC / SLACK_XOXD not set', items: [] };
  }

  try {
    const response = await fetch(SAVED_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.xoxc}`,
        Cookie: `d=${config.xoxd}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `limit=${limit}`
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      logError(`saved.list returned non-JSON body: ${truncateRaw(text)}`, err);
      return { ok: false, reason: 'invalid response', items: [] };
    }

    if (!payload || payload.ok !== true) {
      const reason = (payload && payload.error) || `HTTP ${response.status}`;
      logError(`saved.list failed (${reason}): ${truncateRaw(text)}`);
      return { ok: false, reason, items: [] };
    }

    const items = normalizeSavedItems(payload);
    if (!items) {
      logError(`saved.list response had no recognizable item list: ${truncateRaw(text)}`);
      return { ok: false, reason: 'unexpected response shape', items: [] };
    }

    logInfo(`Loaded ${items.length} saved item(s)`);
    return { ok: true, reason: null, items, counts: payload.counts || null };
  } catch (err) {
    logError('Failed to fetch saved items', err);
    return { ok: false, reason: err.message, items: [] };
  }
}
