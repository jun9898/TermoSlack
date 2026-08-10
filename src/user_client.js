import { WebClient } from "@slack/web-api";
import { logInfo, logError } from "./logger.js";
import { log } from "console";

let userClient = null;

export function initUserClient(token) {
    userClient = new WebClient(token);
    return userClient;
}

export function getUserClient() {
    return userClient;
}

export function getUserToken(){
    return userClient?.token;
}

export async function getCurrentUserId() {
    if (!userClient) return null;
    try {
        const result = await userClient.auth.test();
        return result.user_id;
    } catch (error) {
        logError('Failed to get current user ID', error);
        return null;
    }
}

export function makeUserClient(userToken) {
    return new WebClient(userToken);
}

export async function sendMessageAsUser(userToken, channel, text) {
    const client = makeUserClient(userToken);
    return client.chat.postMessage({channel, text});
}

export async function sendMessage(channelId, text, threadTs = null) {
    try {
        if (!userClient) {
            throw new Error('User client not initialized');
    }
        const messageOptions = {
            channel: channelId,
            text: text
        };
        
        // If threadTs is provided, send as a thread reply
        if (threadTs) {
            messageOptions.thread_ts = threadTs;
        }
        
        const result = await userClient.chat.postMessage(messageOptions);
        logInfo(`Message sent to ${channelId}${threadTs ? ' (in thread)' : ''}`);
        return result;
}       catch (error) {
        logError(`Error sending message to ${channelId}: ${error.message}`);
        throw error;
}
}


const userNameCache = new Map();
const channelNameCache = new Map();
const botNameCache = new Map();
const INFO_FETCH_CONCURRENCY = 8;

const USER_MENTION_PATTERN = /<@[A-Z0-9]+(\|[^>]+)?>/g;
const CHANNEL_MENTION_PATTERN = /<#[C][A-Z0-9]+(\|[^>]+)?>/g;
const DATE_MENTION_PATTERN = /<!date\^[^>|]*(?:\|([^>]*))?>/g;
const SUBTEAM_MENTION_PATTERN = /<!subteam\^([A-Z0-9]+)(?:\|([^>]*))?>/g;
const BROADCAST_MENTION_PATTERN = /<!(channel|here|everyone)(?:\|[^>]*)?>/g;

function resolveUserName(user) {
  return user?.profile?.display_name || user?.real_name || user?.name;
}

function decodeEntities(text) {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

export function extractDisplayText(msg) {
  let base = msg.text || '';

  if (Array.isArray(msg.blocks)) {
    const parts = [];
    for (const block of msg.blocks) {
      if (block.type === 'header' && block.text?.text) parts.push(block.text.text);
      if (block.type === 'section') {
        if (block.text?.text) parts.push(block.text.text);
        if (Array.isArray(block.fields)) {
          for (const field of block.fields) {
            if (field?.text) parts.push(field.text);
          }
        }
      }
      if (block.type === 'context' && Array.isArray(block.elements)) {
        for (const el of block.elements) {
          if (el?.text) parts.push(el.text);
        }
      }
    }
    const joined = parts.join('\n');
    if (joined.trim().length > base.trim().length) base = joined;
  }

  if (!base.trim() && Array.isArray(msg.attachments)) {
    const parts = [];
    for (const att of msg.attachments) {
      if (att.title) parts.push(att.title);
      if (att.text) parts.push(att.text);
      if (!att.title && !att.text && att.fallback) parts.push(att.fallback);
    }
    base = parts.join('\n');
  }

  return decodeEntities(base);
}

function formatLinks(text) {
  return text
    .replace(/<(https?:\/\/[^>|]+)\|([^>]+)>/g, (match, url, label) => (label.includes('…') ? url : label))
    .replace(/<(https?:\/\/[^>|]+)>/g, '$1');
}

function collectMentionedUserIds(messages) {
  const userIds = new Set();

  for (const msg of messages) {
    if (msg.user) {
      userIds.add(msg.user);
    }

    const messageText = extractDisplayText(msg);
    if (!messageText.includes('<@')) continue;

    const mentions = messageText.match(USER_MENTION_PATTERN);
    if (!mentions) continue;

    for (const mention of mentions) {
      userIds.add(mention.match(/<@([A-Z0-9]+)/)[1]);
    }
  }

  return userIds;
}

function collectMentionedChannelIds(messages) {
  const channelIds = new Set();

  for (const msg of messages) {
    const messageText = extractDisplayText(msg);
    if (!messageText.includes('<#')) continue;

    const mentions = messageText.match(CHANNEL_MENTION_PATTERN);
    if (!mentions) continue;

    for (const mention of mentions) {
      if (mention.match(/<#[C][A-Z0-9]+\|([^>]+)>/)) continue;
      channelIds.add(mention.match(/<#([C][A-Z0-9]+)/)[1]);
    }
  }

  return channelIds;
}

async function fetchInBatches(ids, fetchOne) {
  for (let i = 0; i < ids.length; i += INFO_FETCH_CONCURRENCY) {
    const batch = ids.slice(i, i + INFO_FETCH_CONCURRENCY);
    await Promise.allSettled(batch.map(fetchOne));
  }
}

async function prefetchUserNames(userIds) {
  const pending = Array.from(userIds).filter(userId => !userNameCache.has(userId));
  if (pending.length === 0) return;

  await fetchInBatches(pending, async (userId) => {
    const userInfo = await userClient.users.info({ user: userId });
    const name = resolveUserName(userInfo.user);
    if (name) {
      userNameCache.set(userId, name);
    }
  });
}

async function prefetchChannelNames(channelIds) {
  const pending = Array.from(channelIds).filter(channelId => !channelNameCache.has(channelId));
  if (pending.length === 0) return;

  await fetchInBatches(pending, async (channelId) => {
    try {
      const channelInfo = await userClient.conversations.info({ channel: channelId });
      if (channelInfo.channel?.name) {
        channelNameCache.set(channelId, channelInfo.channel.name);
      }
    } catch (error) {
      logError(`Failed to resolve channel ${channelId}`, error);
      throw error;
    }
  });
}

const usergroupNames = new Map();
let usergroupsFetched = false;

async function prefetchUsergroups() {
    if (usergroupsFetched) return;
    usergroupsFetched = true;

    try {
        const result = await userClient.usergroups.list({});
        if (result.usergroups) {
            for (const group of result.usergroups) usergroupNames.set(group.id, group.handle || group.name);
            return;
        }
    } catch (error) {
        logInfo('usergroups.list via OAuth unavailable, trying session credentials');
    }

    try {
        const { config } = await import('./config.js');
        if (!config.xoxc || !config.xoxd) return;
        const fetch = (await import('node-fetch')).default;
        const result = await fetch('https://slack.com/api/usergroups.list', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${config.xoxc}`,
                Cookie: `d=${config.xoxd}`
            }
        }).then(r => r.json());
        if (result.ok && result.usergroups) {
            for (const group of result.usergroups) usergroupNames.set(group.id, group.handle || group.name);
            logInfo(`Loaded ${usergroupNames.size} usergroups via session credentials`);
        }
    } catch (error) {
        logError('Failed to fetch usergroups', error);
    }
}

function replaceSpecialMentions(text) {
  if (!text.includes('<!')) return text;

  return text
    .replace(DATE_MENTION_PATTERN, (match, fallback) => (fallback ? fallback : match))
    .replace(SUBTEAM_MENTION_PATTERN, (match, id, label) => {
      if (label) return `@${label.replace(/^@/, '')}`;
      const name = usergroupNames.get(id);
      return name ? `@${name}` : '@group';
    })
    .replace(BROADCAST_MENTION_PATTERN, (match, keyword) => `@${keyword}`);
}

function replaceMentions(text) {
  let messageText = text;

  if (messageText.includes('<@')) {
    const userMentions = messageText.match(USER_MENTION_PATTERN);
    if (userMentions) {
      for (const mention of userMentions) {
        const userId = mention.match(/<@([A-Z0-9]+)/)[1];
        messageText = messageText.replace(mention, `@${userNameCache.get(userId) || userId}`);
      }
    }
  }

  if (messageText.includes('<#')) {
    const channelMentions = messageText.match(CHANNEL_MENTION_PATTERN);
    if (channelMentions) {
      for (const mention of channelMentions) {
        const pipeMatch = mention.match(/<#[C][A-Z0-9]+\|([^>]+)>/);
        if (pipeMatch) {
          messageText = messageText.replace(mention, `#${pipeMatch[1]}`);
        } else {
          const channelId = mention.match(/<#([C][A-Z0-9]+)/)[1];
          messageText = messageText.replace(mention, `#${channelNameCache.get(channelId) || channelId}`);
        }
      }
    }
  }

  return replaceSpecialMentions(messageText);
}

function collectSearchMatchIds(matches) {
  const userIds = new Set();
  const channelIds = new Set();

  for (const match of matches) {
    if (match.user) userIds.add(match.user);
    if (match.channel?.id) channelIds.add(match.channel.id);

    const messageText = match.text || '';

    if (messageText.includes('<@')) {
      const mentions = messageText.match(USER_MENTION_PATTERN);
      if (mentions) {
        for (const mention of mentions) {
          userIds.add(mention.match(/<@([A-Z0-9]+)/)[1]);
        }
      }
    }

    if (messageText.includes('<#')) {
      const mentions = messageText.match(CHANNEL_MENTION_PATTERN);
      if (mentions) {
        for (const mention of mentions) {
          if (mention.match(/<#[C][A-Z0-9]+\|([^>]+)>/)) continue;
          channelIds.add(mention.match(/<#([C][A-Z0-9]+)/)[1]);
        }
      }
    }
  }

  return { userIds, channelIds };
}

function replaceSearchMentions(text) {
  let messageText = text;

  if (messageText.includes('<@')) {
    const userMentions = messageText.match(USER_MENTION_PATTERN);
    if (userMentions) {
      for (const mention of userMentions) {
        const userId = mention.match(/<@([A-Z0-9]+)/)[1];
        const displayName = userNameCache.get(userId);
        if (displayName) {
          messageText = messageText.replace(mention, `@${displayName}`);
        }
      }
    }
  }

  if (messageText.includes('<#')) {
    const channelMentions = messageText.match(CHANNEL_MENTION_PATTERN);
    if (channelMentions) {
      for (const mention of channelMentions) {
        const pipeMatch = mention.match(/<#[C][A-Z0-9]+\|([^>]+)>/);
        if (pipeMatch) {
          messageText = messageText.replace(mention, `#${pipeMatch[1]}`);
          continue;
        }
        const channelId = mention.match(/<#([C][A-Z0-9]+)/)[1];
        const channelName = channelNameCache.get(channelId);
        if (channelName) {
          messageText = messageText.replace(mention, `#${channelName}`);
        }
      }
    }
  }

  return replaceSpecialMentions(messageText);
}

function collectUnresolvedBotIds(messages) {
  const botIds = new Set();

  for (const msg of messages) {
    if (msg.user || msg.username || msg.bot_profile?.name) continue;
    if (msg.bot_id) botIds.add(msg.bot_id);
  }

  return botIds;
}

async function prefetchBotNames(botIds) {
  const pending = Array.from(botIds).filter(botId => !botNameCache.has(botId));
  if (pending.length === 0) return;

  await fetchInBatches(pending, async (botId) => {
    try {
      const botInfo = await userClient.bots.info({ bot: botId });
      botNameCache.set(botId, botInfo.bot?.name || 'Bot');
    } catch (error) {
      logError(`Failed to resolve bot ${botId}`, error);
      botNameCache.set(botId, 'Bot');
    }
  });
}

function decorateMessage(msg) {
  const userName = msg.user
    ? (userNameCache.get(msg.user) || msg.user)
    : (msg.username || msg.bot_profile?.name || (msg.bot_id ? botNameCache.get(msg.bot_id) : null) || 'Bot');

  const hasImages = msg.files && msg.files.length > 0 &&
                   msg.files.some(f => f.mimetype?.startsWith('image/'));

  const imageFiles = hasImages ? msg.files.filter(f => f.mimetype?.startsWith('image/')) : [];

  const displayText = extractDisplayText(msg);

  return {
    ...msg,
    text: formatLinks(replaceMentions(displayText)),
    raw_text: displayText,
    user_name: userName,
    has_images: hasImages,
    image_files: imageFiles
  };
}

async function decorateMessages(messages) {
  await Promise.all([
    prefetchUserNames(collectMentionedUserIds(messages)),
    prefetchChannelNames(collectMentionedChannelIds(messages)),
    prefetchBotNames(collectUnresolvedBotIds(messages)),
    prefetchUsergroups()
  ]);

  return messages.map(decorateMessage);
}

export async function loadMessages(channelId, limit = 20, oldest = undefined) {
  try {
    if (!userClient) {
      throw new Error('User client not initialized');
    }

    const params = {
      channel: channelId,
      limit: limit
    };
    
    // If oldest is provided, get messages before that timestamp
    if (oldest) {
      params.latest = oldest;
    }

    const result = await userClient.conversations.history(params);

    const messagesWithNames = await decorateMessages(result.messages);

    logInfo(`Loaded ${messagesWithNames.length} messages from channel ${channelId}`);
    return messagesWithNames.reverse();
  } catch (error) {
    logError(`Failed to load messages from channel ${channelId}`, error);
    throw error;
  }
}

export async function editMessage(channelId, ts, text) {
    const result = await userClient.chat.update({ channel: channelId, ts, text });
    logInfo(`Message ${ts} edited in ${channelId}`);
    return result;
}

export async function deleteMessage(channelId, ts) {
    const result = await userClient.chat.delete({ channel: channelId, ts });
    logInfo(`Message ${ts} deleted in ${channelId}`);
    return result;
}

export async function addReaction(channelId, ts, name) {
    const result = await userClient.reactions.add({ channel: channelId, timestamp: ts, name });
    logInfo(`Reaction :${name}: added to ${ts} in ${channelId}`);
    return result;
}

export async function getPermalink(channelId, ts) {
    const result = await userClient.chat.getPermalink({ channel: channelId, message_ts: ts });
    return result.permalink;
}

export async function loadThreadReplies(channelId, threadTs) {
  try {
    if (!userClient) {
      throw new Error('User client not initialized');
    }

    const result = await userClient.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 100
    });

    const repliesWithNames = await decorateMessages(result.messages);

    logInfo(`Loaded ${repliesWithNames.length} thread replies`);
    return repliesWithNames;
  } catch (error) {
    logError(`Failed to load thread replies`, error);
    throw error;
  }
}


export async function getUserChannels(userToken) {
    const client = makeUserClient(userToken);
    const res = await client.conversations.list({limit:200});
    return res.channels || [];
}

export async function getUserName(userToken, userId) {
    const client = makeUserClient(userToken);
    const res = await client.users.info({user: userId});
    return (res.user && (res.user.real_name || res.user.name)) || "Unknown";
}

export async function getCustomEmojis() {
    if (!userClient) return {};
    try {
        const result = await userClient.emoji.list();
        if (result.emoji && Object.keys(result.emoji).length > 0) return result.emoji;
    } catch (error) {
        logError('Failed to fetch custom emojis via OAuth, trying session credentials', error);
    }
    return getCustomEmojisViaSession();
}

async function getCustomEmojisViaSession() {
    const { config } = await import('./config.js');
    if (!config.xoxc || !config.xoxd) return {};
    try {
        const fetch = (await import('node-fetch')).default;
        const result = await fetch('https://slack.com/api/emoji.list', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${config.xoxc}`,
                Cookie: `d=${config.xoxd}`
            }
        }).then(r => r.json());
        if (result.ok && result.emoji) {
            logInfo(`Loaded ${Object.keys(result.emoji).length} custom emojis via session credentials`);
            return result.emoji;
        }
        logError(`emoji.list via session failed: ${result.error || 'unknown'}`);
    } catch (error) {
        logError('Failed to fetch custom emojis via session credentials', error);
    }
    return {};
}

export async function searchMessages(query, options = {}) {
  try {
    if (!userClient) {
      throw new Error('User client not initialized');
    }

    logInfo(`Searching for: "${query}"`);

    const searchOptions = {
      query: query,
      sort: options.sort || 'timestamp',
      sort_dir: options.sortDir || 'desc',
      count: options.count || 100
    };

    if (options.page) {
      searchOptions.page = options.page;
    }

    const result = await userClient.search.messages(searchOptions);

    // Process search results with user names and channel info
    const matches = result.messages.matches;
    const { userIds, channelIds } = collectSearchMatchIds(matches);

    await Promise.all([
      prefetchUserNames(userIds),
      prefetchChannelNames(channelIds),
      prefetchUsergroups()
    ]);

    const processedMatches = matches.map((match) => {
      const userName = match.user
        ? (userNameCache.get(match.user) || match.username || match.user)
        : 'Unknown';

      const channelName = match.channel?.id
        ? (channelNameCache.get(match.channel.id) || match.channel.name || match.channel.id)
        : 'Unknown';

      const hasImages = match.files && match.files.length > 0 &&
                       match.files.some(f => f.mimetype?.startsWith('image/'));

      const imageFiles = hasImages ? match.files.filter(f => f.mimetype?.startsWith('image/')) : [];

      return {
        ...match,
        text: replaceSearchMentions(match.text || ''),
        user_name: userName,
        channel_name: channelName,
        channel_id: match.channel?.id,
        has_images: hasImages,
        image_files: imageFiles,
        permalink: match.permalink
      };
    });

    logInfo(`Found ${processedMatches.length} results for "${query}"`);

    return {
      matches: processedMatches,
      total: result.messages.total,
      page: result.messages.pagination?.page || 1,
      page_count: result.messages.pagination?.page_count || 1
    };
  } catch (error) {
    logError(`Failed to search messages for "${query}"`, error);
    throw error;
  }
}

export async function joinChannel(channelName) {
    if (!userClient) {
        throw new Error('User client not initialized');
    }

    try {
        // Remove # prefix if user included it
        const cleanChannelName = channelName.startsWith('#') ? channelName.slice(1) : channelName;
        
        // Join the channel
        const result = await userClient.conversations.join({
            channel: cleanChannelName
        });
        
        return {
            success: true,
            channel: result.channel
        };
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

export async function loadUserChannels() {
    if (!userClient) {
        throw new Error('User client not initialized');
    }

    try {
        // Load all conversation types (channels and DMs only, no groups)
        const result = await userClient.users.conversations({
            types: "public_channel,private_channel,im",
            exclude_archived: true,
            limit: 1000
        });

        if (!result.ok || !result.channels) {
            return [];
        }

        // Process channels and extract last message timestamp from latest field
        const processedChannels = result.channels.map((channel) => {
            // For DMs, use user ID (no user name fetching)
            if (channel.is_im) {
                // Get the actual last message timestamp
                const lastMessageTime = channel.latest ? parseFloat(channel.latest.ts) : 0;
                return {
                    ...channel,
                    displayName: channel.user || channel.id,
                    name: channel.user || channel.id,
                    lastMessageTime: lastMessageTime
                };
            }
            // For regular channels
            else {
                return {
                    ...channel,
                    displayName: channel.name || channel.id,
                    name: channel.name || channel.id
                };
            }
        });

        return processedChannels;
    } catch (error) {
        console.error('Error loading user channels:', error);
        throw error;
    }
}

export async function loadDMUserNames(channels, onProgress) {
    if (!userClient) {
        throw new Error('User client not initialized');
    }

    try {
        // Collect all unique user IDs from DMs
        const userIds = new Set();
        channels.forEach(channel => {
            if (channel.is_im && channel.user) {
                userIds.add(channel.user);
            }
        });

        if (userIds.size === 0) {
            return channels;
        }

        const userIdArray = Array.from(userIds);
        const missing = userIdArray.filter(userId => !userNameCache.has(userId));
        let processed = userIdArray.length - missing.length;

        if (onProgress) {
            onProgress(processed, userIdArray.length);
        }

        for (let i = 0; i < missing.length; i += INFO_FETCH_CONCURRENCY) {
            const batch = missing.slice(i, i + INFO_FETCH_CONCURRENCY);
            await prefetchUserNames(batch);

            processed += batch.length;

            // Report progress
            if (onProgress) {
                onProgress(processed, userIdArray.length);
            }
        }

        // Update channels with user names
        const updatedChannels = channels.map(channel => {
            if (channel.is_im && channel.user) {
                const userName = userNameCache.get(channel.user) || channel.user || channel.id;
                return {
                    ...channel,
                    displayName: userName,
                    name: userName
                };
            }
            return channel;
        });

        return updatedChannels;
    } catch (error) {
        console.error('Error loading DM user names:', error);
        return channels; // Return original channels on error
    }
}
export async function logoutUser() {
  if(!userClient) return;
  try{
    logInfo("Logging out user");
    await userClient.auth.revoke();
    logInfo("Token removed successfully");
  } catch(error){
    logError("Error logging out user", error);
  }
}

export function seedUserNames(users) {
    for (const user of users) {
        if (!user?.id || userNameCache.has(user.id)) continue;
        const name = resolveUserName(user);
        if (name) userNameCache.set(user.id, name);
    }
}

let selfName = null;

export async function getSelfName() {
    if (selfName) return selfName;
    try {
        const auth = await userClient.auth.test();
        await prefetchUserNames(new Set([auth.user_id]));
        selfName = userNameCache.get(auth.user_id) || auth.user || 'Me';
    } catch (error) {
        logError('Failed to resolve own display name', error);
        selfName = 'Me';
    }
    return selfName;
}

export async function listFiles(options = {}) {
    if (!userClient) return null;

    try {
        const result = await userClient.files.list({ count: options.count || 50 });
        const files = result.files || [];

        await prefetchUserNames(new Set(files.map(file => file.user).filter(Boolean)));

        return files.map(file => ({
            id: file.id,
            name: file.name || file.title || file.id,
            title: file.title || file.name || '',
            filetype: file.filetype || '',
            size: file.size || 0,
            user: file.user || '',
            user_name: file.user ? (userNameCache.get(file.user) || file.user) : 'Unknown',
            ts: Number(file.timestamp || file.created) || 0,
            url_private: file.url_private || null,
            url_private_download: file.url_private_download || null,
            permalink: file.permalink || null,
            mimetype: file.mimetype || ''
        }));
    } catch (error) {
        logError('Failed to list files', error);
        return null;
    }
}

async function prefetchConversationLabels(channelIds) {
    const pending = Array.from(channelIds).filter(channelId => !channelNameCache.has(channelId));
    if (pending.length === 0) return;

    const dmPeers = new Map();

    await fetchInBatches(pending, async (channelId) => {
        try {
            const info = await userClient.conversations.info({ channel: channelId });
            const channel = info.channel;
            if (!channel) return;
            if (channel.is_im && channel.user) {
                dmPeers.set(channelId, channel.user);
                return;
            }
            if (channel.name) channelNameCache.set(channelId, channel.name);
        } catch (error) {
            logError(`Failed to resolve conversation ${channelId}`, error);
        }
    });

    if (dmPeers.size === 0) return;

    await prefetchUserNames(new Set(dmPeers.values()));
    for (const [channelId, userId] of dmPeers) {
        channelNameCache.set(channelId, userNameCache.get(userId) || userId);
    }
}

export async function loadSavedMessages(items) {
    if (!userClient) {
        throw new Error('User client not initialized');
    }
    if (!Array.isArray(items) || items.length === 0) return [];

    await prefetchConversationLabels(new Set(items.map(item => item.channelId)));

    const fetched = [];
    for (let i = 0; i < items.length; i += INFO_FETCH_CONCURRENCY) {
        const batch = items.slice(i, i + INFO_FETCH_CONCURRENCY);
        const settled = await Promise.allSettled(batch.map(async (item) => {
            const result = await userClient.conversations.history({
                channel: item.channelId,
                latest: item.ts,
                oldest: item.ts,
                inclusive: true,
                limit: 1
            });
            return result.messages && result.messages[0] ? result.messages[0] : null;
        }));

        settled.forEach((entry, index) => {
            if (entry.status === 'rejected') {
                logError(`Failed to load saved message ${batch[index].channelId}@${batch[index].ts}`, entry.reason);
                fetched.push({ item: batch[index], message: null });
                return;
            }
            fetched.push({ item: batch[index], message: entry.value });
        });
    }

    const present = fetched.filter(entry => entry.message).map(entry => entry.message);
    const decorated = await decorateMessages(present);

    let cursor = 0;
    return fetched.map(entry => {
        const message = entry.message ? decorated[cursor++] : null;
        return {
            channelId: entry.item.channelId,
            channelName: channelNameCache.get(entry.item.channelId) || entry.item.channelId,
            ts: entry.item.ts,
            dateCreated: entry.item.dateCreated,
            threadTs: message && message.thread_ts && message.thread_ts !== entry.item.ts ? message.thread_ts : null,
            userName: message ? message.user_name : null,
            text: message ? message.text : '',
            missing: !message
        };
    });
}

export async function uploadFile(channelId, filePath, title, threadTs = null) {
    if (!userClient) {
        throw new Error('User client not initialized');
    }

    try {
        const fs = await import('fs');
        
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        logInfo(`Uploading file: ${filePath} to ${channelId}`);

        const result = await userClient.files.uploadV2({
            channel_id: channelId,
            file: fs.createReadStream(filePath),
            filename: filePath.split(/[\\/]/).pop(),
            title: title,
            thread_ts: threadTs
        });

        const fileId = result.files && result.files[0] ? result.files[0].id : (result.file ? result.file.id : 'unknown');
        logInfo(`File uploaded successfully: ${fileId}`);
        return result;
    } catch (error) {
        logError(`Failed to upload file to ${channelId}`, error);
        throw error;
    }
}

