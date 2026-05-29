/**
 * background.js - Privacy Vault Service Worker
 * Handles message brokers, sidepanel actions, and retention jobs.
 */

import { addWatchEntry, enforceRetentionPolicy } from './db.js';

// Open dashboard.html in a new tab when the extension icon is clicked
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

// Set default settings and run maintenance on installation
chrome.runtime.onInstalled.addListener(() => {
  // Set default settings on installation
  chrome.storage.local.get(['aiProvider', 'retentionPolicy', 'autoIndex', 'hasBackfilledRecent'], (result) => {
    const updates = {};
    if (!result.aiProvider) updates.aiProvider = 'gemini_api';
    if (!result.retentionPolicy) updates.retentionPolicy = 'forever';
    if (result.autoIndex === undefined) updates.autoIndex = true;
    
    if (Object.keys(updates).length > 0) {
      chrome.storage.local.set(updates);
    }

    // Try to trigger background backfill on install
    if (!result.hasBackfilledRecent) {
      chrome.storage.local.set({ hasBackfilledRecent: true });
      fetchAndBackfillHistory().catch(() => {});
    }
  });

  // Run initial retention policy check
  runDailyMaintenance();
});

// Alarm for periodic retention policy enforcement (daily)
chrome.alarms.create('dailyMaintenance', { periodInMinutes: 24 * 60 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'dailyMaintenance') {
    runDailyMaintenance();
  }
});

/**
 * Handle incoming messages from Content Scripts or UI Sidepanels
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, payload } = message;

  if (action === 'logWatchStart') {
    // Only index if autoIndex is enabled
    chrome.storage.local.get(['autoIndex'], (settings) => {
      if (settings.autoIndex === false) {
        sendResponse({ success: false, reason: 'Auto indexing disabled by user.' });
        return;
      }

      // Automatically trigger initial recent history backfill on first watch load
      chrome.storage.local.get(['hasBackfilledRecent'], (result) => {
        if (!result.hasBackfilledRecent) {
          chrome.storage.local.set({ hasBackfilledRecent: true });
          fetchAndBackfillHistory();
        }
      });

      addWatchEntry(payload)
        .then((recordId) => {
          sendResponse({ success: true, recordId });
          // Notify sidepanel/dashboard to refresh if open
          chrome.runtime.sendMessage({ action: 'databaseUpdated' }).catch(() => {});
        })
        .catch((error) => {
          console.error('Failed to log watch start:', error);
          sendResponse({ success: false, error: error.message });
        });
    });
    return true; // Keeps the sendResponse channel open for async execution
  }

  if (action === 'logWatchProgress') {
    addWatchEntry(payload)
      .then((recordId) => {
        sendResponse({ success: true, recordId });
        chrome.runtime.sendMessage({ action: 'databaseUpdated' }).catch(() => {});
      })
      .catch((error) => {
        console.error('Failed to log watch progress:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (action === 'triggerManualBackfill') {
    fetchAndBackfillHistory()
      .then((count) => {
        sendResponse({ success: true, count });
      })
      .catch((error) => {
        console.error('Manual backfill failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
});

/**
 * Clean up database based on user's stored retention policy
 */
function runDailyMaintenance() {
  chrome.storage.local.get(['retentionPolicy'], (result) => {
    const policy = result.retentionPolicy || 'forever';
    if (policy !== 'forever') {
      enforceRetentionPolicy(policy)
        .then((deletedCount) => {
          if (deletedCount > 0) {
            console.log(`[Retention Policy] Successfully purged ${deletedCount} expired video logs.`);
            chrome.runtime.sendMessage({ action: 'databaseUpdated' }).catch(() => {});
          }
        })
        .catch((error) => console.error('[Maintenance Error] Failed to enforce retention policy:', error));
    }
  });
}

/**
 * Silent Background Scraper: Fetches the user's YouTube History feed
 * and backfills their latest watched videos dynamically.
 */
async function fetchAndBackfillHistory() {
  try {
    console.log('[Rewind] Running history backfiller (Syncing min(available, 1 month) watched videos)...');
    const response = await fetch('https://www.youtube.com/feed/history');
    if (!response.ok) {
      console.warn('[Rewind] History feed load returned code:', response.status);
      return 0;
    }

    const html = await response.text();
    
    // Locate the embedded ytInitialData JSON object using a robust regex
    const regex = /ytInitialData\s*=\s*({[\s\S]*?});/;
    const match = html.match(regex);
    if (!match) {
      console.warn('[Rewind] Unable to extract watch data blocks.');
      return 0;
    }

    const data = JSON.parse(match[1]);
    
    // Recursively extract all itemSectionRenderer nodes to support all desktop, mobile, and responsive layouts
    const sections = findSectionsRecursively(data);
    if (!sections || sections.length === 0) {
      console.warn('[Rewind] Empty or altered YouTube feed layout (No sections found).');
      return 0;
    }

    let backfilledCount = 0;
    const now = Date.now();
    const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

    // Iterate through daily timeline folders
    for (const itemSection of sections) {
      const items = itemSection?.contents;
      if (!items || !Array.isArray(items)) continue;

      // Extract and parse section title for 1-month boundary checks
      const sectionTitle = itemSection?.header?.itemSectionHeaderRenderer?.title?.runs?.[0]?.text
                        || itemSection?.header?.itemSectionHeaderRenderer?.title?.simpleText
                        || '';
      
      const titleLower = sectionTitle.toLowerCase().trim();
      
      // Halt immediately if we hit relative groupings older than 1 month
      if (titleLower.includes('month') || titleLower.includes('year')) {
        console.log('[Rewind] Reached relative section older than 1 month:', sectionTitle);
        break;
      }

      // Halt immediately if the section has a parseable date older than 30 days
      if (sectionTitle && !['today', 'yesterday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].includes(titleLower)) {
        const parsedDate = new Date(sectionTitle);
        if (!isNaN(parsedDate.getTime())) {
          const ageMs = now - parsedDate.getTime();
          if (ageMs > ONE_MONTH_MS) {
            console.log('[Rewind] Reached absolute date older than 30 days:', sectionTitle);
            break;
          }
        }
      }

      // Resolve a realistic base timestamp for this calendar section grouping
      const sectionBaseTimestamp = getSectionBaseTimestamp(sectionTitle, now);

      let itemIndex = 0;
      for (const item of items) {
        const video = item?.videoRenderer;
        if (!video || !video.videoId) continue;

        // Scrape properties
        const title = video.title?.runs?.[0]?.text || video.title?.simpleText || 'YouTube Video';
        const channel = video.ownerText?.runs?.[0]?.text || 'YouTube Creator';
        const channelUrlPath = video.ownerText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || '';
        const channelUrl = channelUrlPath ? `https://www.youtube.com${channelUrlPath}` : `https://www.youtube.com/@${channel.replace(/\s+/g, '')}`;

        // Scrape channel avatar
        const avatarThumbnails = video.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails
                              || video.channelThumbnail?.thumbnails;
        const channelAvatar = avatarThumbnails?.[0]?.url || '';

        // Parse visual length duration simpleText: e.g. "12:45"
        const durationStr = video.lengthText?.simpleText || video.lengthText?.runs?.[0]?.text || '';
        const duration = parseDurationString(durationStr);

        // Subtract a slight decaying 5-minute offset to maintain chronological ordering within the same day
        const timestamp = sectionBaseTimestamp - (itemIndex * 5 * 60 * 1000);

        try {
          await addWatchEntry({
            videoId: video.videoId,
            title,
            channel,
            channelUrl,
            channelAvatar,
            duration,
            watchTime: 0, // Set to 0 to maintain absolute accuracy (only active session logs count towards watch time)
            timestamp,
            thumbnail: `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`
          });
          backfilledCount++;
        } catch (dbErr) {
          console.warn('[Rewind] Failed to add watch entry for video:', video.videoId, dbErr);
        }
        itemIndex++;
      }
    }

    if (backfilledCount > 0) {
      console.log(`[Rewind] Initial backfill finished: ${backfilledCount} video records added within the 1-month boundary.`);
      // Sync layout
      chrome.runtime.sendMessage({ action: 'databaseUpdated' }).catch(() => {});
    }
    
    return backfilledCount;

  } catch (error) {
    console.error('[Rewind] History backfill process error:', error);
    throw error;
  }
}

/**
 * Converts length text (e.g. "14:20" or "1:05:30") to seconds integer
 */
function parseDurationString(str) {
  if (!str) return 0;
  const parts = str.split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parts[0] || 0;
}

function getSectionBaseTimestamp(sectionTitle, now) {
  if (!sectionTitle) return now;
  const titleLower = sectionTitle.toLowerCase().trim();
  
  if (titleLower === 'today') return now;
  if (titleLower === 'yesterday') return now - 24 * 60 * 60 * 1000;
  
  // Try to parse as day of week
  const daysOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayIdx = daysOfWeek.indexOf(titleLower);
  if (dayIdx !== -1) {
    const currentDay = new Date(now).getDay();
    let diff = currentDay - dayIdx;
    if (diff <= 0) diff += 7; // Go back to last week's day
    return now - diff * 24 * 60 * 60 * 1000;
  }
  
  // Try to parse as relative week ago (handles "week ago" and "weeks ago" since both contain "week")
  if (titleLower.includes('week')) {
    const weeks = parseInt(titleLower) || 1;
    return now - weeks * 7 * 24 * 60 * 60 * 1000;
  }
  
  // Try to parse as absolute date
  const parsed = new Date(sectionTitle);
  if (!isNaN(parsed.getTime())) {
    return parsed.getTime();
  }
  
  return now;
}

/**
 * Helper to recursively traverse JSON looking for itemSectionRenderer nodes.
 * Works perfectly across desktop, mobile, and responsive layouts.
 */
function findSectionsRecursively(obj) {
  if (!obj || typeof obj !== 'object') return [];
  let results = [];
  if (obj.itemSectionRenderer) {
    results.push(obj.itemSectionRenderer);
  }
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const childResults = findSectionsRecursively(obj[key]);
      results = results.concat(childResults);
    }
  }
  return results;
}
