/**
 * content.js - YouTube Scraper & Activity Tracker Content Script
 * Monitors SPA transitions and captures true watch time metrics locally.
 */

let activeVideoId = null;
let watchTimer = null;
let activeWatchSeconds = 0;
let lastTickTime = null;

// Hook into YouTube's SPA navigation completed event
document.addEventListener('yt-navigate-finish', handleYouTubePageTransition);

// Fallback checking to support regular loads or restarts
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  handleYouTubePageTransition();
} else {
  window.addEventListener('DOMContentLoaded', handleYouTubePageTransition);
}

/**
 * Triggered on YouTube internal navigation finishes.
 */
function handleYouTubePageTransition() {
  const url = new URL(window.location.href);
  const videoId = url.searchParams.get('v');

  // Verify we are actually on a watch page and it's a new video
  if (videoId && videoId !== activeVideoId) {
    stopTracking(); // Stop tracking previous video
    activeVideoId = videoId;
    activeWatchSeconds = 0;
    
    // Allow the elements to render fully on SPA transition
    setTimeout(() => {
      startTracking(videoId);
    }, 1500);
  } else if (!videoId) {
    // Navigated away from watch page
    stopTracking();
    activeVideoId = null;
  }
}

/**
 * Scrapes metadata from the DOM and initializes watch tracking.
 * @param {string} videoId 
 */
function startTracking(videoId) {
  try {
    const videoElement = document.querySelector('video');
    if (!videoElement) {
      // Retry in a second if player is loading slowly
      setTimeout(() => startTracking(videoId), 1000);
      return;
    }

    // Extract metadata
    const title = getTitle();
    const channelName = getChannelName();
    const channelUrl = getChannelUrl();
    const duration = Math.round(videoElement.duration || 0);

    if (!title || !channelName) {
      // DOM elements might not be completely rendered yet, retry
      setTimeout(() => startTracking(videoId), 1000);
      return;
    }

    // Capture the initial watch entry
    const entryPayload = {
      videoId,
      title,
      channel: channelName,
      channelUrl,
      duration,
      watchTime: 0,
      timestamp: Date.now(),
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    };

    // Report initial load to the background service worker
    chrome.runtime.sendMessage({ action: 'logWatchStart', payload: entryPayload });

    // Begin active watch time tracker loop
    lastTickTime = Date.now();
    watchTimer = setInterval(() => {
      const activeVideo = document.querySelector('video');
      
      if (activeVideo && !activeVideo.paused && !activeVideo.ended && document.visibilityState === 'visible') {
        const now = Date.now();
        const delta = (now - lastTickTime) / 1000;
        
        // Add delta to watch duration, cap it in case tab goes to sleep
        if (delta > 0 && delta < 4) {
          activeWatchSeconds += delta;
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
 * Send watch progress update to background script
 * @param {string} videoId 
 */
function reportWatchProgress(videoId) {
  if (videoId !== activeVideoId) return;
  chrome.runtime.sendMessage({
    action: 'logWatchProgress',
    payload: {
      videoId,
      watchTime: Math.round(activeWatchSeconds)
    }
  });
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
    // Send final progress before clearing
    reportWatchProgress(activeVideoId);
  }
  
  activeWatchSeconds = 0;
}

// Ensure we save data when page closes or refreshes
window.addEventListener('beforeunload', stopTracking);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    // Pause tracking when tab minimized
    lastTickTime = null;
  } else {
    lastTickTime = Date.now();
  }
});

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
  if (cleanTitle.endsWith(' - YouTube')) {
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
