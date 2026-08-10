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
const INFO_FETCH_CONCURRENCY = 8;

const USER_MENTION_PATTERN = /<@[A-Z0-9]+(\|[^>]+)?>/g;
const CHANNEL_MENTION_PATTERN = /<#[C][A-Z0-9]+(\|[^>]+)?>/g;

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
    .replace(/<(https?:\/\/[^>|]+)\|([^>]+)>/g, '$2')
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

  return messageText;
}

function decorateMessage(msg) {
  const userName = msg.user
    ? (userNameCache.get(msg.user) || msg.user)
    : (msg.username || msg.bot_profile?.name || 'Unknown');

  const hasImages = msg.files && msg.files.length > 0 &&
                   msg.files.some(f => f.mimetype?.startsWith('image/'));

  const imageFiles = hasImages ? msg.files.filter(f => f.mimetype?.startsWith('image/')) : [];

  return {
    ...msg,
    text: formatLinks(replaceMentions(extractDisplayText(msg))),
    user_name: userName,
    has_images: hasImages,
    image_files: imageFiles
  };
}

async function decorateMessages(messages) {
  await Promise.all([
    prefetchUserNames(collectMentionedUserIds(messages)),
    prefetchChannelNames(collectMentionedChannelIds(messages))
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
        return result.emoji || {};
    } catch (error) {
        logError('Failed to fetch custom emojis', error);
        return {};
    }
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
    const processedMatches = await Promise.all(
      result.messages.matches.map(async (match) => {
        let userName = 'Unknown';
        let channelName = 'Unknown';

        // Get user name
        if (match.user) {
          try {
            const userInfo = await userClient.users.info({ user: match.user });
            userName = userInfo.user.profile?.display_name || userInfo.user.real_name || userInfo.user.name;
          } catch (error) {
            userName = match.username || match.user;
          }
        }

        // Get channel name
        if (match.channel?.id) {
          try {
            const channelInfo = await userClient.conversations.info({ channel: match.channel.id });
            channelName = channelInfo.channel.name || match.channel.name;
          } catch (error) {
            channelName = match.channel.name || match.channel.id;
          }
        }

        // Replace user mentions in text
        let messageText = match.text || '';
        const mentionRegex = /<@[A-Z0-9]+(\|[^>]+)?>/g;
        const mentions = messageText.match(mentionRegex);
        
        if (mentions) {
          for (const mention of mentions) {
            const userId = mention.match(/<@([A-Z0-9]+)/)[1];
            try {
              const userInfo = await userClient.users.info({ user: userId });
              const displayName = userInfo.user.profile?.display_name || userInfo.user.real_name || userInfo.user.name;
              messageText = messageText.replace(mention, `@${displayName}`);
            } catch (err) {
              // Keep original mention if user lookup fails
            }
          }
        }

        // Replace channel mentions in text
        const channelMentionRegex = /<#[C][A-Z0-9]+(\|[^>]+)?>/g;
        const channelMentions = messageText.match(channelMentionRegex);
        
        if (channelMentions) {
          for (const mention of channelMentions) {
            // Check if channel name is already in the mention (format: <#C123|channel-name>)
            const pipeMatch = mention.match(/<#[C][A-Z0-9]+\|([^>]+)>/);
            if (pipeMatch) {
              // Use the name from the pipe format
              const channelName = pipeMatch[1];
              messageText = messageText.replace(mention, `#${channelName}`);
            } else {
              // Fetch channel name from API
              const channelId = mention.match(/<#([C][A-Z0-9]+)/)[1];
              try {
                const channelInfo = await userClient.conversations.info({ channel: channelId });
                const chName = channelInfo.channel.name;
                messageText = messageText.replace(mention, `#${chName}`);
              } catch (err) {
                // Keep original mention if channel lookup fails
                logError(`Failed to resolve channel ${channelId} in search`, err);
              }
            }
          }
        }

        // Check if message has files/images
        const hasImages = match.files && match.files.length > 0 && 
                         match.files.some(f => f.mimetype?.startsWith('image/'));
        
        const imageFiles = hasImages ? match.files.filter(f => f.mimetype?.startsWith('image/')) : [];

        return {
          ...match,
          text: messageText,
          user_name: userName,
          channel_name: channelName,
          channel_id: match.channel?.id,
          has_images: hasImages,
          image_files: imageFiles,
          permalink: match.permalink
        };
      })
    );

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

        // Batch fetch user info with controlled concurrency  
        const userMap = new Map();
        const userIdArray = Array.from(userIds);
        const batchSize = 10; // Process 10 users at a time
        let processed = 0;
        
        for (let i = 0; i < userIdArray.length; i += batchSize) {
            const batch = userIdArray.slice(i, i + batchSize);
            
            // Fetch batch in parallel
            const results = await Promise.allSettled(
                batch.map(async (userId) => {
                    const userInfo = await userClient.users.info({ user: userId });
                    if (userInfo.ok && userInfo.user) {
                        return {
                            userId,
                            name: userInfo.user.real_name || userInfo.user.name || userId
                        };
                    }
                    return { userId, name: userId };
                })
            );
            
            // Store successful results
            results.forEach(result => {
                if (result.status === 'fulfilled' && result.value) {
                    userMap.set(result.value.userId, result.value.name);
                }
            });
            
            processed += batch.length;
            
            // Report progress
            if (onProgress) {
                onProgress(processed, userIdArray.length);
            }
            
            // Small delay between batches to respect rate limits
            if (i + batchSize < userIdArray.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        // Update channels with user names
        const updatedChannels = channels.map(channel => {
            if (channel.is_im && channel.user) {
                const userName = userMap.get(channel.user) || channel.user || channel.id;
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

