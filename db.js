/**
 * db.js - Privacy Vault Local IndexedDB Controller
 * Handles fully local storage, indexing, TF-IDF search, and analytics.
 */

const DB_NAME = 'PrivacyVaultDB';
const DB_VERSION = 1;
const STORE_NAME = 'watch_history';

/**
 * Initialize IndexedDB Database
 * @returns {Promise<IDBDatabase>}
 */
export function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => {
      console.error('Database failed to open:', event.target.error);
      reject(event.target.error);
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        
        // Create indexes for efficient querying
        store.createIndex('videoId', 'videoId', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('channel', 'channel', { unique: false });
        store.createIndex('title', 'title', { unique: false });
      }
    };
  });
}

/**
 * Add a new video watch record or update an existing one if watched recently.
 * @param {Object} entry Video metadata entry
 * @returns {Promise<number>} Record ID
 */
export async function addWatchEntry(entry) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    // Check if the same video was logged recently (within last 5 minutes)
    // to prevent duplicate logs on pauses/refresh
    const timestampIndex = store.index('timestamp');
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    const range = IDBKeyRange.lowerBound(fiveMinutesAgo);
    const request = timestampIndex.openCursor(range, 'prev'); // Get latest first

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        const record = cursor.value;
        if (record.videoId === entry.videoId) {
          // It's a duplicate watch within 5 minutes.
          // Update timestamp, duration, and add to watchTime rather than adding a new entry
          record.timestamp = entry.timestamp || Date.now();
          if (entry.watchTime) {
            record.watchTime = (record.watchTime || 0) + entry.watchTime;
          }
          if (entry.duration) {
            record.duration = entry.duration; // Update total duration just in case
          }
          if (entry.channelAvatar) {
            record.channelAvatar = entry.channelAvatar;
          }
          
          const updateRequest = cursor.update(record);
          updateRequest.onsuccess = () => resolve(record.id);
          updateRequest.onerror = (err) => reject(err);
          return;
        }
        cursor.continue();
        return;
      }

      // No recent matching entry found, add new record
      const addRequest = store.add({
        videoId: entry.videoId,
        title: entry.title || 'YouTube Video',
        channel: entry.channel || 'YouTube Creator',
        channelUrl: entry.channelUrl || (entry.channel ? `https://www.youtube.com/@${entry.channel.replace(/\s+/g, '')}` : 'https://www.youtube.com'),
        channelAvatar: entry.channelAvatar || '',
        duration: entry.duration || 0,
        watchTime: entry.watchTime || 0,
        timestamp: entry.timestamp || Date.now(),
        thumbnail: entry.thumbnail || `https://i.ytimg.com/vi/${entry.videoId}/hqdefault.jpg`
      });

      addRequest.onsuccess = (e) => resolve(e.target.result);
      addRequest.onerror = (err) => reject(err);
    };

    request.onerror = (err) => reject(err);
  });
}

/**
 * Retrieve paginated watch history sorted by newest first
 * @param {number} limit Number of records to return
 * @param {number} offset Offset offset
 * @param {string} searchFilter Optional exact filter
 * @returns {Promise<Array>}
 */
export async function getHistory(limit = 50, offset = 0, searchFilter = '') {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('timestamp');
    const results = [];
    let skipped = 0;

    const request = index.openCursor(null, 'prev'); // Newest first

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) {
        resolve(results);
        return;
      }

      const val = cursor.value;
      
      const titleLower = (val.title || '').toLowerCase();
      const channelLower = (val.channel || '').toLowerCase();

      // Filter if search query is provided
      const matchesSearch = !searchFilter || 
        titleLower.includes(searchFilter.toLowerCase()) || 
        channelLower.includes(searchFilter.toLowerCase());

      if (matchesSearch) {
        if (skipped < offset) {
          skipped++;
        } else {
          results.push(val);
          if (results.length >= limit) {
            resolve(results);
            return;
          }
        }
      }
      cursor.continue();
    };

    request.onerror = (err) => reject(err);
  });
}

/**
 * Delete a single watch record by ID
 * @param {number} id Record ID
 * @returns {Promise<boolean>}
 */
export async function deleteWatchEntry(id) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(Number(id));

    request.onsuccess = () => resolve(true);
    request.onerror = (err) => reject(err);
  });
}

/**
 * Clear all watch history from the database
 * @returns {Promise<boolean>}
 */
export async function clearHistory() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();

    request.onsuccess = () => resolve(true);
    request.onerror = (err) => reject(err);
  });
}

/**
 * Perform an in-memory keyword scoring search on titles and channels.
 * Custom implementation supporting search rankings, keyword scoring and timestamp boundaries.
 * @param {string} queryText Search terms
 * @param {Object} options Options like { fromTimestamp, toTimestamp, limit }
 * @returns {Promise<Array>} Scored search results
 */
export async function keywordSearch(queryText, options = {}) {
  const db = await initDB();
  const limit = options.limit || 20;
  const fromTime = options.fromTimestamp || 0;
  const toTime = options.toTimestamp || Date.now();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('timestamp');
    const matches = [];

    // Parse search tokens
    const searchTokens = queryText.toLowerCase()
      .split(/[\s,\.\-\?\!]+/)
      .filter(t => t.length > 2); // Ignore short words like "the", "a", "on"

    // If query is empty or too short, fetch by timestamp filter instead
    const isKeywordSearch = searchTokens.length > 0;

    const request = index.openCursor(IDBKeyRange.bound(fromTime, toTime), 'prev');

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) {
        // Sort matches by relevance score first, then recency
        if (isKeywordSearch) {
          matches.sort((a, b) => b.score - a.score || b.timestamp - a.timestamp);
        }
        resolve(matches.slice(0, limit));
        return;
      }

      const val = cursor.value;
      let score = 0;

      if (isKeywordSearch) {
        const titleLower = (val.title || '').toLowerCase();
        const channelLower = (val.channel || '').toLowerCase();

        // Calculate overlap score
        searchTokens.forEach(token => {
          if (titleLower.includes(token)) {
            // Title matches have higher weight
            score += 10;
            // Bonus for exact word match
            if (new RegExp(`\\b${token}\\b`).test(titleLower)) score += 5;
          }
          if (channelLower.includes(token)) {
            // Channel matches
            score += 5;
          }
        });

        if (score > 0) {
          matches.push({ ...val, score });
        }
      } else {
        // Simple timestamp matches without keywords
        matches.push(val);
      }

      cursor.continue();
    };

    request.onerror = (err) => reject(err);
  });
}

/**
 * Apply local data retention policies to delete older records.
 * @param {string} policy "forever" | "year" | "six_months" | "thirty_days"
 */
export async function enforceRetentionPolicy(policy) {
  if (!policy || policy === 'forever') return 0;
  
  let cutoffTimestamp = 0;
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  
  if (policy === 'year') {
    cutoffTimestamp = now - 365 * ONE_DAY;
  } else if (policy === 'six_months') {
    cutoffTimestamp = now - 180 * ONE_DAY;
  } else if (policy === 'thirty_days') {
    cutoffTimestamp = now - 30 * ONE_DAY;
  } else {
    return 0;
  }

  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('timestamp');
    const range = IDBKeyRange.upperBound(cutoffTimestamp);
    const request = index.openCursor(range);
    let deletedCount = 0;

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        deletedCount++;
        cursor.continue();
      } else {
        resolve(deletedCount);
      }
    };

    request.onerror = (err) => reject(err);
  });
}

/**
 * Aggregates database watch history for dashboard metrics and SVG graphics.
 * @returns {Promise<Object>} Analytics data payload
 */
export async function getAnalytics() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('timestamp');
    
    let totalCount = 0;
    let totalWatchTime = 0; // seconds
    const channelCounts = {}; // name -> { count, watchTime, avatar }
    const dailyViews = {}; // YYYY-MM-DD -> count
    const dailyWatchTime = {}; // YYYY-MM-DD -> seconds
    const activeDaysMap = {}; // YYYY-MM-DD -> true
    
    // Setup last 7 days keys
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      dailyViews[key] = 0;
      dailyWatchTime[key] = 0;
      last7Days.push(key);
    }

    const request = index.openCursor();

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) {
        // Aggregate top channels (sorted by watch time spent on that creator)
        const topChannels = Object.entries(channelCounts)
          .map(([name, data]) => ({ name, count: data.count, watchTime: data.watchTime, avatar: data.avatar }))
          .sort((a, b) => b.watchTime - a.watchTime || b.count - a.count)
          .slice(0, 5);

        // Daily trend list
        const dailyTrend = last7Days.map(date => ({
          date,
          dayLabel: new Date(date).toLocaleDateString(undefined, { weekday: 'short' }),
          views: dailyViews[date] || 0,
          duration: dailyWatchTime[date] || 0
        }));

        const activeDaysCount = Object.keys(activeDaysMap).length || 1;
        const dailyAverageWatchTime = Math.round(totalWatchTime / activeDaysCount);

        resolve({
          totalCount,
          totalWatchTime,
          dailyAverageWatchTime,
          topChannels,
          dailyTrend
        });
        return;
      }

      const val = cursor.value;
      totalCount++;
      totalWatchTime += (val.watchTime || 0);

      // Track channel and its latest avatar
      if (val.channel) {
        if (!channelCounts[val.channel]) {
          channelCounts[val.channel] = { count: 0, watchTime: 0, avatar: val.channelAvatar || '' };
        }
        channelCounts[val.channel].count++;
        channelCounts[val.channel].watchTime += (val.watchTime || 0);
        if (val.channelAvatar && !channelCounts[val.channel].avatar) {
          channelCounts[val.channel].avatar = val.channelAvatar;
        }
      }

      // Track daily views and active calendar days
      if (val.timestamp) {
        try {
          const entryDate = new Date(val.timestamp).toISOString().split('T')[0];
          activeDaysMap[entryDate] = true;
          if (entryDate in dailyViews) {
            dailyViews[entryDate]++;
            dailyWatchTime[entryDate] += (val.watchTime || 0);
          }
        } catch (e) {
          console.warn('[Privacy Vault] Skipping views tracking for corrupted timestamp record:', val);
        }
      }

      cursor.continue();
    };

    request.onerror = (err) => reject(err);
  });
}
