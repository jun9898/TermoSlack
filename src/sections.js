import fetch from 'node-fetch';
import { config } from './config.js';
import { logInfo, logWarn, logError } from './logger.js';

const SECTIONS_URL = 'https://slack.com/api/users.channelSections.list';
const RAW_LOG_LIMIT = 4000;

function truncateRaw(raw) {
  if (typeof raw !== 'string') return String(raw);
  return raw.length > RAW_LOG_LIMIT ? `${raw.slice(0, RAW_LOG_LIMIT)}… (${raw.length} bytes total)` : raw;
}

function pickChannelIds(section) {
  const candidates = [
    section && section.channel_ids_page && section.channel_ids_page.channel_ids,
    section && section.channel_ids,
    section && section.channels
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const ids = candidate
      .map(entry => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry.id === 'string') return entry.id;
        if (entry && typeof entry.channel_id === 'string') return entry.channel_id;
        return null;
      })
      .filter(Boolean);
    if (ids.length > 0) return ids;
  }

  return [];
}

function pickName(section, index) {
  if (section && typeof section.name === 'string' && section.name.trim()) return section.name.trim();
  if (section && typeof section.label === 'string' && section.label.trim()) return section.label.trim();
  if (section && typeof section.type === 'string' && section.type.trim()) return section.type.trim();
  return `Section ${index + 1}`;
}

export function normalizeChannelSections(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const rawSections = Array.isArray(payload.channel_sections)
    ? payload.channel_sections
    : Array.isArray(payload.sections)
      ? payload.sections
      : null;

  if (!rawSections) return null;

  const normalized = [];
  rawSections.forEach((section, index) => {
    const channelIds = pickChannelIds(section);
    if (channelIds.length === 0) return;
    normalized.push({ name: pickName(section, index), channelIds });
  });

  return normalized;
}

export async function fetchChannelSectionsRaw() {
  if (!config.xoxc || !config.xoxd) return { skipped: true, reason: 'SLACK_XOXC / SLACK_XOXD not set' };

  const response = await fetch(SECTIONS_URL, {
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

export async function fetchChannelSections() {
  if (!config.xoxc || !config.xoxd) return null;

  try {
    const result = await fetchChannelSectionsRaw();

    if (result.parseError) {
      logError(`users.channelSections.list returned non-JSON body: ${truncateRaw(result.text)}`, result.parseError);
      return null;
    }

    if (!result.payload || result.payload.ok !== true) {
      logError(`users.channelSections.list failed (HTTP ${result.status}): ${truncateRaw(result.text)}`);
      return null;
    }

    const sections = normalizeChannelSections(result.payload);
    if (!sections) {
      logError(`users.channelSections.list response had no recognizable section list: ${truncateRaw(result.text)}`);
      return null;
    }

    if (sections.length === 0) {
      logWarn('users.channelSections.list returned no sections with channels');
      return null;
    }

    logInfo(`Loaded ${sections.length} Slack sidebar section(s)`);
    return sections;
  } catch (err) {
    logError('Failed to fetch Slack sidebar sections', err);
    return null;
  }
}
