/**
 * content.js - YouTube Scraper & Activity Tracker Content Script
 * Monitors SPA transitions and captures true watch time metrics locally.
 */

let activeVideoId = null;
let watchTimer = null;
let urlCheckInterval = null;
let activeWatchSeconds = 0;
let lastReportedWatchSeconds = 0;
let lastTickTime = null;
let isScriptOrphaned = false;

// Named event listener for clean teardown on context invalidation
function handleYouTubePageTransition() {
  if (isScriptOrphaned) return;
  const url = new URL(window.location.href);
  const videoId = url.searchParams.get('v');

  // Verify we are actually on a watch page and it's a new video
  if (videoId && videoId !== activeVideoId) {
    stopTracking(); // Stop tracking previous video
    activeVideoId = videoId;
    activeWatchSeconds = 0;
    lastReportedWatchSeconds = 0;
    
    // Allow the elements to render fully on SPA transition
    setTimeout(() => {
      if (isScriptOrphaned) return;
      startTracking(videoId);
    }, 1500);
  } else if (!videoId) {
    // Navigated away from watch page
    stopTracking();
    activeVideoId = null;
  }
}

// Named event listener for page visibility adjustments
function handleVisibilityChange() {
  if (isScriptOrphaned) return;
  if (document.visibilityState === 'hidden') {
    // Pause tracking when tab minimized
    lastTickTime = null;
  } else {
    lastTickTime = Date.now();
  }
}

// Hook into YouTube's SPA navigation completed event
document.addEventListener('yt-navigate-finish', handleYouTubePageTransition);

// Fallback checking to support regular loads or restarts
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  handleYouTubePageTransition();
} else {
  window.addEventListener('DOMContentLoaded', handleYouTubePageTransition);
}

// Add state hooks
window.addEventListener('beforeunload', stopTracking);
document.addEventListener('visibilitychange', handleVisibilityChange);

// Fallback URL checking to support SPA transitions missed by YouTube events
urlCheckInterval = setInterval(() => {
  if (isScriptOrphaned) return;
  const url = new URL(window.location.href);
  const videoId = url.searchParams.get('v');
  if (videoId && videoId !== activeVideoId) {
    handleYouTubePageTransition();
  } else if (!videoId && activeVideoId) {
    handleYouTubePageTransition();
  }
}, 2000);

/**
 * Safely dispatch messages to Chrome service worker, catching context invalidations.
 */
function safeSendMessage(message) {
  if (isScriptOrphaned) return;
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
      chrome.runtime.sendMessage(message);
    } else {
      cleanupOrphanedScript();
    }
  } catch (error) {
    if (error.message && error.message.includes('Extension context invalidated')) {
      cleanupOrphanedScript();
    }
  }
}


/**
 * Gracefully release resources, remove listeners, and clear intervals when orphaned.
 */
function cleanupOrphanedScript() {
  isScriptOrphaned = true;
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
  if (urlCheckInterval) {
    clearInterval(urlCheckInterval);
    urlCheckInterval = null;
  }
  
  // Unbind named event listeners to completely shut down script threads in the tab
  document.removeEventListener('yt-navigate-finish', handleYouTubePageTransition);
  window.removeEventListener('DOMContentLoaded', handleYouTubePageTransition);
  window.removeEventListener('beforeunload', stopTracking);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  
  console.log('[Rewind] YouTube content script gracefully shut down.');
}

/**
 * Scrapes metadata from the DOM and initializes watch tracking.
 * @param {string} videoId 
 * @param {number} retryCount
 */
function startTracking(videoId, retryCount = 0) {
  if (isScriptOrphaned || videoId !== activeVideoId) return;
  try {
    const videoElement = document.querySelector('video');
    if (!videoElement) {
      // Retry in a second if player is loading slowly
      if (retryCount < 5) {
        setTimeout(() => startTracking(videoId, retryCount + 1), 1000);
      }
      return;
    }

    // Extract metadata
    let title = getTitle();
    let channelName = getChannelName();
    let channelUrl = getChannelUrl();
    let channelAvatar = getChannelAvatar();
    const duration = Math.round(videoElement.duration || 0);

    // If metadata elements aren't loaded yet, retry a capped number of times
    if ((!title || !channelName) && retryCount < 5) {
      setTimeout(() => startTracking(videoId, retryCount + 1), 1000);
      return;
    }

    // Use robust fallbacks after 5 attempts to guarantee indexing starts
    title = title || getTitle() || document.title || 'YouTube Video';
    channelName = channelName || 'YouTube Creator';
    channelUrl = channelUrl || `https://www.youtube.com/@${channelName.replace(/\s+/g, '')}`;
    channelAvatar = channelAvatar || '';

    // Capture the initial watch entry
    const entryPayload = {
      videoId,
      title,
      channel: channelName,
      channelUrl,
      channelAvatar,
      duration,
      watchTime: 0,
      timestamp: Date.now(),
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    };

    // Report initial load to the background service worker
    safeSendMessage({ action: 'logWatchStart', payload: entryPayload });

    // Begin active watch time tracker loop
    lastTickTime = Date.now();
    
    if (watchTimer) {
      clearInterval(watchTimer);
    }
    
    watchTimer = setInterval(() => {
      if (isScriptOrphaned) return;
      const activeVideo = document.querySelector('video');
      
      if (activeVideo && !activeVideo.paused && !activeVideo.ended && document.visibilityState === 'visible') {
        const now = Date.now();
        if (lastTickTime) {
          const delta = (now - lastTickTime) / 1000;
          
          // Add delta to watch duration, cap it in case tab goes to sleep
          if (delta > 0 && delta < 4) {
            activeWatchSeconds += delta;
          }
        }
        
        // Every 5 seconds, send update to background
        if (Math.round(activeWatchSeconds) % 5 === 0 && activeWatchSeconds > 0) {
          reportWatchProgress(videoId);
        }
      }
      lastTickTime = Date.now();
    }, 1000);

  } catch (error) {
    console.error('Error starting video tracking:', error);
  }
}

/**
 * Send watch progress update to background script (sending incremental deltas)
 * @param {string} videoId 
 */
function reportWatchProgress(videoId) {
  if (isScriptOrphaned || videoId !== activeVideoId) return;
  
  const currentSeconds = Math.round(activeWatchSeconds);
  const deltaSeconds = currentSeconds - lastReportedWatchSeconds;
  
  // Only send if there is new watch activity
  if (deltaSeconds <= 0) return;
  
  safeSendMessage({
    action: 'logWatchProgress',
    payload: {
      videoId,
      watchTime: deltaSeconds
    }
  });
  
  lastReportedWatchSeconds = currentSeconds;
}

/**
 * Tear down watch loops and send final watch count
 */
function stopTracking() {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
  
  if (activeVideoId && activeWatchSeconds > 2) {
    // Send final progress delta before clearing
    reportWatchProgress(activeVideoId);
  }
  
  activeWatchSeconds = 0;
  lastReportedWatchSeconds = 0;
}

/* Helper DOM Scraping Utilities */

function getTitle() {
  // Selector for standard YouTube watch pages
  const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string') 
               || document.querySelector('h1.title.style-scope.ytd-video-primary-info-renderer')
               || document.querySelector('meta[name="title"]');
  
  if (titleEl) {
    return titleEl.content || titleEl.textContent.trim();
  }
  
  // Fallback to document.title, cleaning up the YouTube branding
  let cleanTitle = document.title;
  if (cleanTitle && cleanTitle.endsWith(' - YouTube')) {
    cleanTitle = cleanTitle.substring(0, cleanTitle.length - 10);
  }
  return cleanTitle !== 'YouTube' ? cleanTitle : null;
}

function getChannelName() {
  const channelEl = document.querySelector('ytd-video-owner-renderer yt-formatted-string.ytd-channel-name a')
                 || document.querySelector('#upload-info yt-formatted-string.ytd-channel-name a')
                 || document.querySelector('span[itemprop="author"] link[itemprop="name"]');
  
  if (channelEl) {
    return channelEl.content || channelEl.textContent.trim();
  }
  return null;
}

function getChannelUrl() {
  const channelLink = document.querySelector('ytd-video-owner-renderer yt-formatted-string.ytd-channel-name a')
                   || document.querySelector('#upload-info yt-formatted-string.ytd-channel-name a');
  
  if (channelLink && channelLink.href) {
    return channelLink.href;
  }
  return null;
}

function getChannelAvatar() {
  const avatarImg = document.querySelector('ytd-video-owner-renderer #avatar img')
                 || document.querySelector('ytd-video-owner-renderer img#img')
                 || document.querySelector('.yt-img-shadow img');
  
  if (avatarImg && avatarImg.src && avatarImg.src.startsWith('http')) {
    return avatarImg.src;
  }
  return null;
}
