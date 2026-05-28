/**
 * background.js - Privacy Vault Service Worker
 * Handles message brokers, sidepanel actions, and retention jobs.
 */

import { addWatchEntry, enforceRetentionPolicy } from './db.js';

// Configure Side Panel behavior: Open Side Panel on Extension Icon click
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error) => console.error('Failed to set panel behavior:', error));
  }
  
  // Set default settings on installation
  chrome.storage.local.get(['aiProvider', 'retentionPolicy', 'autoIndex'], (result) => {
    const updates = {};
    if (!result.aiProvider) updates.aiProvider = 'gemini_api';
    if (!result.retentionPolicy) updates.retentionPolicy = 'forever';
    if (result.autoIndex === undefined) updates.autoIndex = true;
    
    if (Object.keys(updates).length > 0) {
      chrome.storage.local.set(updates);
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
    console.log('[Privacy Vault] Running silent initial history backfiller...');
    const response = await fetch('https://www.youtube.com/feed/history');
    if (!response.ok) {
      console.warn('[Privacy Vault] History feed load returned code:', response.status);
      return;
    }

    const html = await response.text();
    
    // Locate the embedded ytInitialData JSON object using a robust regex
    const regex = /ytInitialData\s*=\s*({[\s\S]*?});/;
    const match = html.match(regex);
    if (!match) {
      console.warn('[Privacy Vault] Unable to extract watch data blocks.');
      return;
    }

    const data = JSON.parse(match[1]);
    
    // Drill into section structures
    const contents = data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents;
    if (!contents || !Array.isArray(contents)) {
      console.warn('[Privacy Vault] Empty or altered YouTube feed layout.');
      return;
    }

    let backfilledCount = 0;

    // Iterate through daily timeline folders
    for (const section of contents) {
      const items = section?.itemSectionRenderer?.contents;
      if (!items || !Array.isArray(items)) continue;

      for (const item of items) {
        const video = item?.videoRenderer;
        if (!video || !video.videoId) continue;

        // Scrape properties
        const title = video.title?.runs?.[0]?.text || video.title?.simpleText || 'YouTube Video';
        const channel = video.ownerText?.runs?.[0]?.text || 'YouTube Creator';
        const channelUrlPath = video.ownerText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || '';
        const channelUrl = channelUrlPath ? `https://www.youtube.com${channelUrlPath}` : `https://www.youtube.com/@${channel.replace(/\s+/g, '')}`;

        // Parse visual length duration simpleText: e.g. "12:45"
        const durationStr = video.lengthText?.simpleText || video.lengthText?.runs?.[0]?.text || '';
        const duration = parseDurationString(durationStr);

        // Map sequential decaying timestamps
        const timestamp = Date.now() - (backfilledCount * 10 * 60 * 1000); // 10-minute gaps

        await addWatchEntry({
          videoId: video.videoId,
          title,
          channel,
          channelUrl,
          duration,
          watchTime: duration,
          timestamp,
          thumbnail: `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`
        });

        backfilledCount++;
        
        // Cap initial backfill at 50 videos for speed and performance
        if (backfilledCount >= 50) break;
      }
      if (backfilledCount >= 50) break;
    }

    if (backfilledCount > 0) {
      console.log(`[Privacy Vault] Silent initial backfill finished: ${backfilledCount} video records added.`);
      // Sync layout
      chrome.runtime.sendMessage({ action: 'databaseUpdated' }).catch(() => {});
    }

  } catch (error) {
    console.error('[Privacy Vault] History backfill process error:', error);
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
