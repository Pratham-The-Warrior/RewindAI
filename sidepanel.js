/**
 * sidepanel.js - Master Frontend Controller for Privacy Vault
 * Manages tab navigations, IndexedDB rendering, Google Takeout imports,
 * and the client-side Gemini RAG query engine.
 */

import { getHistory, deleteWatchEntry, clearHistory, getAnalytics, keywordSearch, enforceRetentionPolicy, addWatchEntry } from './db.js';

// Configuration states
let activeView = 'dashboard';
let userApiKey = '';
let groqApiKey = '';
let groqModel = 'llama3-70b-8192';
let aiProvider = 'gemini_api';
let autoIndex = true;
let retentionPolicy = 'forever';

// Mockup placeholder data matching the user's reference image exactly
// to display on a brand-new empty index for a striking first impression.
const MOCK_VIDEOS = [
  {
    id: 'mock1',
    videoId: 'vector-db-101',
    title: 'Understanding Vector Databases for AI Apps',
    channel: 'Tech Channel',
    duration: 860,
    watchTime: 860,
    timestamp: Date.now() - 30 * 60 * 1000, // 30 mins ago
    thumbnail: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=500&auto=format&fit=crop&q=60'
  },
  {
    id: 'mock2',
    videoId: 'local-first-arch',
    title: 'Local-First Software Architecture Explained',
    channel: 'Dev Talks',
    duration: 525,
    watchTime: 520,
    timestamp: Date.now() - 2 * 60 * 60 * 1000, // 2h ago
    thumbnail: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=500&auto=format&fit=crop&q=60'
  },
  {
    id: 'mock3',
    videoId: 'rust-data-eng',
    title: 'Full Course: Rust for Data Engineering',
    channel: 'Code Academy',
    duration: 2550,
    watchTime: 1200,
    timestamp: Date.now() - 24 * 60 * 60 * 1000, // 1 day ago
    thumbnail: 'https://images.unsplash.com/photo-1515879218367-8466d910aaa4?w=500&auto=format&fit=crop&q=60'
  },
  {
    id: 'mock4',
    videoId: 'privacy-first-engine',
    title: 'Privacy First: Why We Built a Custom Engine',
    channel: 'Founder Vlog',
    duration: 330,
    watchTime: 330,
    timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000, // 3 days ago
    thumbnail: 'https://images.unsplash.com/photo-1563986768609-322da13575f3?w=500&auto=format&fit=crop&q=60'
  }
];

// Document lifecycle hook
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  setupNavigation();
  setupEventListeners();
  await refreshDatabaseViews();
});

/**
 * Loads stored settings from Chrome Storage
 */
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['geminiApiKey', 'groqApiKey', 'groqModel', 'aiProvider', 'autoIndex', 'retentionPolicy'], (result) => {
      userApiKey = result.geminiApiKey || '';
      groqApiKey = result.groqApiKey || '';
      groqModel = result.groqModel || 'llama3-70b-8192';
      aiProvider = result.aiProvider || 'gemini_api';
      autoIndex = result.autoIndex !== false;
      retentionPolicy = result.retentionPolicy || 'forever';

      // Set input states in HTML DOM
      const keyInput = document.getElementById('setting-api-key');
      if (keyInput) keyInput.value = userApiKey;

      const groqKeyInput = document.getElementById('setting-groq-key');
      if (groqKeyInput) groqKeyInput.value = groqApiKey;

      const groqModelSelect = document.getElementById('setting-groq-model');
      if (groqModelSelect) groqModelSelect.value = groqModel;

      const providerSelect = document.getElementById('setting-ai-provider');
      if (providerSelect) {
        providerSelect.value = aiProvider;
        toggleApiKeyGroup(aiProvider);
      }

      const retentionSelect = document.getElementById('setting-retention');
      if (retentionSelect) retentionSelect.value = retentionPolicy;

      const autoIndexCheck = document.getElementById('ctrl-auto-index');
      if (autoIndexCheck) autoIndexCheck.checked = autoIndex;

      resolve();
    });
  });
}

/**
 * Handle navigation switches
 */
function setupNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const view = item.getAttribute('data-view');
      switchView(view);
      
      // Active styling
      navItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');
    });
  });

  // Gear header action redirect
  const gearBtn = document.getElementById('util-gear');
  if (gearBtn) {
    gearBtn.addEventListener('click', () => {
      switchView('lab');
      navItems.forEach(i => {
        i.classList.remove('active');
        if (i.getAttribute('data-view') === 'lab') i.classList.add('active');
      });
    });
  }

  // Brand navigation click
  const brandNav = document.getElementById('nav-brand');
  if (brandNav) {
    brandNav.addEventListener('click', (e) => {
      e.preventDefault();
      switchView('dashboard');
      navItems.forEach(i => {
        i.classList.remove('active');
        if (i.getAttribute('data-view') === 'dashboard') i.classList.add('active');
      });
    });
  }
}

/**
 * Switches current visual display pane
 * @param {string} view 
 */
function switchView(view) {
  activeView = view;
  
  // Hide all panels
  const panels = document.querySelectorAll('.view-panel');
  panels.forEach(p => p.classList.remove('active'));

  // Show selected
  const targetPanel = document.getElementById(`view-${view}`);
  if (targetPanel) {
    targetPanel.classList.add('active');
  }

  // Update headers
  const title = document.getElementById('page-title');
  const subtitle = document.getElementById('page-subtitle');
  
  if (view === 'dashboard') {
    title.textContent = 'Dashboard Overview';
    subtitle.textContent = 'Your local viewing history is securely encrypted.';
  } else if (view === 'history') {
    title.textContent = 'History Timeline';
    subtitle.textContent = 'Chronological index of all indexed video activities.';
    renderTimeline();
  } else if (view === 'sync') {
    title.textContent = 'Data Portability';
    subtitle.textContent = 'Export backup data or sync local indexes.';
  } else if (view === 'chat') {
    title.textContent = 'AI Insights Chat';
    subtitle.textContent = 'Natural language database query grounded in your history.';
  } else if (view === 'lab') {
    title.textContent = 'Privacy Lab Settings';
    subtitle.textContent = 'Manage API credentials, storage limits, and imports.';
  }
}

/**
 * Bind DOM click elements and settings togglers
 */
function setupEventListeners() {
  // Auto-Index Toggle
  const autoIndexCheck = document.getElementById('ctrl-auto-index');
  if (autoIndexCheck) {
    autoIndexCheck.addEventListener('change', (e) => {
      autoIndex = e.target.checked;
      chrome.storage.local.set({ autoIndex });
      showToast(autoIndex ? 'Real-time watch logging enabled' : 'Watch logging paused');
    });
  }

  // RAG Search Enable Toggle
  const ragSearchCheck = document.getElementById('ctrl-rag-search');
  if (ragSearchCheck) {
    ragSearchCheck.addEventListener('change', (e) => {
      chrome.storage.local.set({ ragSearch: e.target.checked });
      showToast(e.target.checked ? 'RAG AI query engine enabled' : 'AI chatbot query restricted');
    });
  }

  // Clear/Purge Buttons
  const purgeBtn = document.getElementById('ctrl-purge-btn');
  if (purgeBtn) {
    purgeBtn.addEventListener('click', handlePurgeDatabase);
  }

  const sidebarClearBtn = document.getElementById('sidebar-clear-btn');
  if (sidebarClearBtn) {
    sidebarClearBtn.addEventListener('click', handlePurgeDatabase);
  }

  // Save Settings
  const saveBtn = document.getElementById('btn-save-settings');
  if (saveBtn) {
    saveBtn.addEventListener('click', saveApiKeySettings);
  }

  // Save Groq Settings
  const saveGroqBtn = document.getElementById('btn-save-groq');
  if (saveGroqBtn) {
    saveGroqBtn.addEventListener('click', saveGroqSettings);
  }

  // Test API Key connection
  const testBtn = document.getElementById('btn-test-key');
  if (testBtn) {
    testBtn.addEventListener('click', testGeminiApiKey);
  }

  // Test Groq API connection
  const testGroqBtn = document.getElementById('btn-test-groq');
  if (testGroqBtn) {
    testGroqBtn.addEventListener('click', testGroqApiKey);
  }

  // AI Provider Select Toggler
  const providerSelect = document.getElementById('setting-ai-provider');
  if (providerSelect) {
    providerSelect.addEventListener('change', (e) => {
      aiProvider = e.target.value;
      chrome.storage.local.set({ aiProvider });
      toggleApiKeyGroup(aiProvider);
      showToast(`Switched query engine to ${aiProvider === 'gemini_api' ? 'Gemini API' : 'Gemini Nano'}`);
    });
  }

  // Retention Policy Selection Change
  const retentionSelect = document.getElementById('setting-retention');
  if (retentionSelect) {
    retentionSelect.addEventListener('change', (e) => {
      retentionPolicy = e.target.value;
      chrome.storage.local.set({ retentionPolicy });
      showToast(`Data retention policy updated: ${e.target.options[e.target.selectedIndex].text}`);
    });
  }

  // JSON History Export Action
  const exportBtn = document.getElementById('btn-export-json');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportDatabaseToJson);
  }

  // Backup DB file importer trigger
  const triggerImportBtn = document.getElementById('btn-trigger-import-db');
  const dbFileInput = document.getElementById('db-file-input');
  if (triggerImportBtn && dbFileInput) {
    triggerImportBtn.addEventListener('click', () => dbFileInput.click());
    dbFileInput.addEventListener('change', importDatabaseFromJson);
  }

  // Google Takeout Drag and Drop
  const dropZone = document.getElementById('takeout-drop-zone');
  const fileInput = document.getElementById('takeout-file-input');
  if (dropZone && fileInput) {
    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => handleGoogleTakeoutImport(e.target.files[0]));

    // Drag-over hover classes
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        handleGoogleTakeoutImport(e.dataTransfer.files[0]);
      }
    });
  }

  // View All navigation click
  const viewAllBtn = document.getElementById('dash-view-all');
  if (viewAllBtn) {
    viewAllBtn.addEventListener('click', (e) => {
      e.preventDefault();
      switchView('history');
      const navItems = document.querySelectorAll('.nav-item');
      navItems.forEach(i => {
        i.classList.remove('active');
        if (i.getAttribute('data-view') === 'history') i.classList.add('active');
      });
    });
  }

  // RAG Chat Submissions
  const sendBtn = document.getElementById('chat-send-btn');
  const chatInput = document.getElementById('chat-user-input');
  if (sendBtn && chatInput) {
    sendBtn.addEventListener('click', executeChatQuery);
    chatInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') executeChatQuery();
    });
  }

  // Chip Suggestions trigger
  const suggestionChips = document.querySelectorAll('.suggestion-chip');
  suggestionChips.forEach(chip => {
    chip.addEventListener('click', () => {
      if (chatInput) {
        chatInput.value = chip.textContent;
        executeChatQuery();
      }
    });
  });

  // Real-time Dashboard filtering bar
  const searchInput = document.getElementById('dashboard-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const q = e.target.value.trim();
      if (activeView === 'dashboard') {
        renderDashboardRecentlyIndexed(q);
      } else if (activeView === 'history') {
        renderTimeline(q);
      }
    });
  }

  // Background update listener
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'databaseUpdated') {
      refreshDatabaseViews();
    }
  });
}

/**
 * Toggles Key Field visibility based on provider selection
 * @param {string} provider 
 */
function toggleApiKeyGroup(provider) {
  const geminiGroup = document.getElementById('group-api-key');
  const groqGroup = document.getElementById('group-groq-key');
  
  if (geminiGroup) {
    geminiGroup.style.display = provider === 'gemini_api' ? 'flex' : 'none';
  }
  if (groqGroup) {
    groqGroup.style.display = provider === 'groq_api' ? 'flex' : 'none';
  }
}

/**
 * Saves Gemini API Key locally
 */
function saveApiKeySettings() {
  const keyInput = document.getElementById('setting-api-key');
  if (keyInput) {
    userApiKey = keyInput.value.trim();
    chrome.storage.local.set({ geminiApiKey: userApiKey }, () => {
      showToast('API Key saved successfully!');
    });
  }
}

/**
 * Saves Groq Settings locally
 */
function saveGroqSettings() {
  const keyInput = document.getElementById('setting-groq-key');
  const modelSelect = document.getElementById('setting-groq-model');
  
  if (keyInput && modelSelect) {
    groqApiKey = keyInput.value.trim();
    groqModel = modelSelect.value;
    chrome.storage.local.set({ 
      groqApiKey: groqApiKey, 
      groqModel: groqModel 
    }, () => {
      showToast('Groq settings saved successfully!');
    });
  }
}

/**
 * Test Connection with Gemini endpoint
 */
async function testGeminiApiKey() {
  const keyInput = document.getElementById('setting-api-key');
  const testKey = keyInput ? keyInput.value.trim() : userApiKey;
  
  if (!testKey) {
    showToast('Please enter an API Key to test.', 'error');
    return;
  }

  showToast('Testing connection...');
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${testKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Hello, confirm connection status with single word OK.' }] }]
      })
    });
    
    const data = await response.json();
    if (response.ok && data.candidates) {
      showToast('Connection Successful! Gemini API active.');
    } else {
      throw new Error(data.error?.message || 'Invalid Response');
    }
  } catch (error) {
    console.error('API key test error:', error);
    showToast(`Test failed: ${error.message}`, 'error');
  }
}

/**
 * Test Connection with Groq endpoint
 */
async function testGroqApiKey() {
  const keyInput = document.getElementById('setting-groq-key');
  const modelSelect = document.getElementById('setting-groq-model');
  const testKey = keyInput ? keyInput.value.trim() : groqApiKey;
  const testModel = modelSelect ? modelSelect.value : groqModel;
  
  if (!testKey) {
    showToast('Please enter a Groq API Key to test.', 'error');
    return;
  }

  showToast('Testing Groq speed...');
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testKey}`
      },
      body: JSON.stringify({
        model: testModel,
        messages: [{ role: 'user', content: 'Ping' }],
        max_tokens: 5
      })
    });
    
    const data = await response.json();
    if (response.ok && data.choices) {
      showToast('Connection Successful! Groq LPU active.');
    } else {
      throw new Error(data.error?.message || 'Invalid Response');
    }
  } catch (error) {
    console.error('Groq test error:', error);
    showToast(`Test failed: ${error.message}`, 'error');
  }
}

/**
 * Re-reads database metrics and updates visual states
 */
async function refreshDatabaseViews() {
  try {
    const analytics = await getAnalytics();
    
    // 1. Update metric widgets
    const countVal = document.getElementById('stat-count');
    if (countVal) countVal.textContent = analytics.totalCount.toLocaleString();

    // Today count
    const countToday = document.getElementById('stat-count-today');
    if (countToday) {
      const todayCount = analytics.dailyTrend[analytics.dailyTrend.length - 1]?.views || 0;
      countToday.textContent = `▲ +${todayCount} today`;
    }

    // Disk Size estimator
    const storageVal = document.getElementById('stat-storage');
    if (storageVal) {
      if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        const mb = (estimate.usage / (1024 * 1024)).toFixed(2);
        storageVal.textContent = `${mb} MB`;
      } else {
        // Fallback mathematical multiplier
        const approxMb = ((analytics.totalCount * 1.2) / 1024).toFixed(2);
        storageVal.textContent = `${approxMb} MB`;
      }
    }

    // 2. Render cards
    renderDashboardRecentlyIndexed();

  } catch (error) {
    console.error('Error refreshing database views:', error);
  }
}

/**
 * Render standard dashboard "Recently Indexed" cards
 */
async function renderDashboardRecentlyIndexed(searchFilter = '') {
  const container = document.getElementById('recently-indexed-grid');
  if (!container) return;

  try {
    const history = await getHistory(4, 0, searchFilter);

    // If history is empty and no filter is active, fall back to beautiful mockup placeholders
    if (history.length === 0 && !searchFilter) {
      container.innerHTML = '';
      MOCK_VIDEOS.forEach(video => {
        const card = createVideoCard(video, true);
        container.appendChild(card);
      });
      
      // Update radial bar to show mock status
      updateRadialStatus(100, 'Using Demonstration Templates', 'Your local database is clean and empty. Log onto YouTube to capture activity, or upload Takeout backups in settings!');
      return;
    }

    container.innerHTML = '';
    
    if (history.length === 0) {
      container.innerHTML = '<div style="grid-column: span 4; text-align: center; padding: 24px; color: var(--text-muted); font-size: 13px;">No matching local logs found.</div>';
      return;
    }

    history.forEach(video => {
      const card = createVideoCard(video);
      container.appendChild(card);
    });

    // Reset radial bar to synced active mode
    updateRadialStatus(100, 'Watch History Synchronized', 'All logged watches are saved in secure IndexedDB storage, fully private.');

  } catch (error) {
    console.error('Failed to render dashboard cards:', error);
  }
}

/**
 * Render chronological Timeline history
 */
async function renderTimeline(searchFilter = '') {
  const container = document.getElementById('history-timeline-list');
  if (!container) return;

  try {
    const history = await getHistory(100, 0, searchFilter);
    container.innerHTML = '';

    if (history.length === 0) {
      container.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px;">No history records found. Start browsing YouTube!</div>';
      return;
    }

    history.forEach(video => {
      const item = document.createElement('div');
      item.className = 'timeline-item today';
      
      const durationFormatted = formatDuration(video.duration);
      const relativeTime = getRelativeTimeString(video.timestamp);

      item.innerHTML = `
        <div class="timeline-card">
          <div class="timeline-thumb">
            <img src="${video.thumbnail}" alt="Thumbnail">
            <span class="duration-badge">${durationFormatted}</span>
          </div>
          <div class="timeline-content">
            <a href="https://www.youtube.com/watch?v=${video.videoId}" target="_blank" class="timeline-title">${escapeHtml(video.title)}</a>
            <div class="timeline-meta">
              <a href="${video.channelUrl}" target="_blank" class="timeline-channel">${escapeHtml(video.channel)}</a>
              <div class="timeline-actions">
                <span>Watched ${relativeTime}</span>
                <button class="timeline-btn-delete" data-id="${video.id}" title="Remove entry">
                  <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      `;

      // Bind Deletion Actions
      const delBtn = item.querySelector('.timeline-btn-delete');
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = delBtn.getAttribute('data-id');
        await deleteWatchEntry(id);
        showToast('Watch log removed from local index');
        await refreshDatabaseViews();
        renderTimeline(searchFilter);
      });

      container.appendChild(item);
    });

  } catch (error) {
    console.error('Timeline render error:', error);
  }
}

/**
 * Creates a standard video card DOM element
 */
function createVideoCard(video, isMock = false) {
  const card = document.createElement('div');
  card.className = 'video-card';
  
  const durationFormatted = formatDuration(video.duration);
  const relativeTime = getRelativeTimeString(video.timestamp);

  card.innerHTML = `
    <div class="thumbnail-wrapper">
      <img class="video-thumbnail" src="${video.thumbnail}" alt="Thumbnail">
      <span class="duration-badge">${durationFormatted}</span>
      ${!isMock ? `
        <button class="delete-video-btn" data-id="${video.id}" title="Purge entry">
          <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      ` : ''}
    </div>
    <div class="video-info">
      <h4 class="video-card-title">${escapeHtml(video.title)}</h4>
      <div class="video-card-meta">
        <span class="video-card-channel">${escapeHtml(video.channel)}</span>
        <div class="video-card-subinfo">
          <span>Watched ${relativeTime}</span>
          ${isMock ? '<span style="color:var(--brand-crimson); font-weight:600; font-size:9px;">TEMPLATE</span>' : ''}
        </div>
      </div>
    </div>
  `;

  // Bind click card navigation
  card.addEventListener('click', () => {
    window.open(`https://www.youtube.com/watch?v=${video.videoId}`, '_blank');
  });

  // Bind individual delete button
  const delBtn = card.querySelector('.delete-video-btn');
  if (delBtn) {
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = delBtn.getAttribute('data-id');
      await deleteWatchEntry(id);
      showToast('Video log purged');
      await refreshDatabaseViews();
    });
  }

  return card;
}

/**
 * Handle massive Google Takeout History uploads & batch parsing
 * Parses standard takeout `watch-history.json` format
 */
async function handleGoogleTakeoutImport(file) {
  if (!file) return;

  const cardProgress = document.getElementById('takeout-progress-card');
  const barFill = document.getElementById('takeout-progress-fill');
  const percentText = document.getElementById('takeout-progress-percent');
  const statusText = document.getElementById('takeout-progress-status');

  if (cardProgress) cardProgress.style.display = 'block';
  updateRadialStatus(20, 'Importing Takeout File', 'Parsing history JSON file. Please keep this tab open.');

  try {
    const text = await readFileAsText(file);
    const parsedData = JSON.parse(text);

    if (!Array.isArray(parsedData)) {
      throw new Error('Google Takeout JSON file must be a top-level Array list of video watches.');
    }

    const totalLogs = parsedData.length;
    statusText.textContent = `Processing ${totalLogs.toLocaleString()} YouTube history entries...`;
    
    // Batch upload parameter settings
    const batchSize = 500;
    let written = 0;
    
    updateRadialStatus(40, 'Indexing Records', `Writing database index payload...`);

    // Stream/Batch process data asynchronously to prevent UI freezing
    for (let i = 0; i < parsedData.length; i += batchSize) {
      const batch = parsedData.slice(i, i + batchSize);
      
      await Promise.all(batch.map(item => {
        // Extract parameters from standard Google Takeout JSON schema:
        // { "title": "Watched ...", "titleUrl": "...", "subtitles": [{"name": "Channel", "url": "..."}], "time": "2026-05-20T..." }
        if (!item.titleUrl || !item.title) return Promise.resolve();

        // Extract video ID from link URL: youtube.com/watch?v=XXXXXX
        const urlObj = new URL(item.titleUrl);
        const videoId = urlObj.searchParams.get('v');
        if (!videoId) return Promise.resolve();

        const cleanTitle = item.title.replace(/^Watched\s+/, '');
        const channelName = item.subtitles && item.subtitles[0] ? item.subtitles[0].name : 'YouTube Creator';
        const channelUrl = item.subtitles && item.subtitles[0] ? item.subtitles[0].url : '';
        const timestamp = new Date(item.time).getTime();

        return addWatchEntry({
          videoId,
          title: cleanTitle,
          channel: channelName,
          channelUrl,
          duration: 0,
          watchTime: 0,
          timestamp,
          thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
        });
      }));

      written += batch.length;
      const progressPercent = Math.round((written / totalLogs) * 100);
      
      // Update loading stats bar
      if (barFill) barFill.style.style = `width: ${progressPercent}%`;
      if (percentText) percentText.textContent = `${progressPercent}%`;
      
      // Yield to renderer thread
      await new Promise(r => setTimeout(r, 20));
    }

    statusText.textContent = 'Import completed! Re-indexing database...';
    showToast(`Successfully imported ${written.toLocaleString()} history records!`);
    
    if (cardProgress) {
      setTimeout(() => { cardProgress.style.display = 'none'; }, 2000);
    }

    await refreshDatabaseViews();

  } catch (error) {
    console.error('Takeout import failed:', error);
    statusText.textContent = `Import Failed: ${error.message}`;
    showToast(`Failed to parse: ${error.message}`, 'error');
    updateRadialStatus(100, 'Import Failure', 'Google Takeout validation failed. Please ensure file matches watch-history.json.');
  }
}

/**
 * Export complete local history database to JSON backup
 */
async function exportDatabaseToJson() {
  showToast('Compiling data backup...');
  try {
    const history = await getHistory(100000); // Fetch complete database
    
    const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `privacy-vault-backup-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Export successful! Backup file downloaded.');
  } catch (error) {
    console.error('Database export failed:', error);
    showToast('Backup failed: ' + error.message, 'error');
  }
}

/**
 * Import custom JSON Backup DB file
 */
async function importDatabaseFromJson(e) {
  const file = e.target.files[0];
  if (!file) return;

  showToast('Reading backup package...');
  try {
    const text = await readFileAsText(file);
    const backupList = JSON.parse(text);

    if (!Array.isArray(backupList)) {
      throw new Error('Database backup must be in formatted array JSON format.');
    }

    showToast(`Restoring ${backupList.length} records...`);
    
    // Batch write
    for (const record of backupList) {
      await addWatchEntry(record);
    }

    showToast('Restoration completed! Dashboard refreshed.');
    await refreshDatabaseViews();
  } catch (error) {
    console.error('Import backup failed:', error);
    showToast(`Restore failed: ${error.message}`, 'error');
  }
}

/**
 * Handles clearing all IndexedDB local logs
 */
async function handlePurgeDatabase() {
  const confirmed = confirm('WARNING!\nThis action will permanently delete all local YouTube watch history records from your browser IndexedDB.\n\nThis cannot be undone. Do you wish to proceed?');
  if (!confirmed) return;

  showToast('Wiping local index database...');
  try {
    await clearHistory();
    showToast('All local history and database index logs wiped completely!');
    await refreshDatabaseViews();
    if (activeView === 'history') renderTimeline();
  } catch (error) {
    console.error('Failed to wipe database:', error);
    showToast('Clear failed: ' + error.message, 'error');
  }
}

/**
 * Main RAG AI Chat processing logic
 */
async function executeChatQuery() {
  const inputEl = document.getElementById('chat-user-input');
  if (!inputEl) return;
  
  const query = inputEl.value.trim();
  if (!query) return;

  // Append user bubble
  appendChatBubble(query, 'user');
  inputEl.value = '';

  // Append thinking bubble
  const thinkingId = appendChatBubble('', 'thinking');
  
  try {
    // 1. Parse time modifiers to constrain temporal search boundary
    const { fromTimestamp, toTimestamp } = parseTimeRangeFromText(query);

    // 2. Query matching local watch context using custom overlapping keyword scoring
    const searchOptions = {
      fromTimestamp,
      toTimestamp,
      limit: 15
    };
    
    const matchedVideos = await keywordSearch(query, searchOptions);

    if (matchedVideos.length === 0) {
      removeThinkingBubble(thinkingId);
      appendChatBubble("I searched your local watch history index but couldn't find any matching video entries matching those terms or date ranges. Could you try asking with different words, or verify that you've imported your Google Takeout history files?", 'assistant');
      return;
    }

    // 3. Construct Context Payload
    let contextText = '';
    matchedVideos.forEach((video, idx) => {
      const watchedDate = new Date(video.timestamp).toLocaleString();
      contextText += `[Video #${idx+1}]:\nTitle: ${video.title}\nChannel: ${video.channel}\nURL: https://www.youtube.com/watch?v=${video.videoId}\nDuration: ${formatDuration(video.duration)}\nWatched time date: ${watchedDate}\n\n`;
    });

    const systemPrompt = `You are Vault AI, an intelligent personal assistant grounded in the user's secure local YouTube watch history.
Below are the relevant video records retrieved from the user's browser database matching their query "${query}":

${contextText}

Use ONLY the provided video list to answer the user's question accurately. 
If the records contain the answer, summarize and answer detail-oriented. Be concise, professional, and helpful.
Make sure to reference specific video titles and creators.
If the records do not contain the answer, politely tell them that you found these matching video records but none contain the direct answer, and show them what you found.
Always format your response beautifully using markdown standard.`;

    // 4. Send to appropriate AI Provider
    let responseText = '';

    if (aiProvider === 'gemini_api') {
      if (!userApiKey) {
        removeThinkingBubble(thinkingId);
        appendChatBubble('⚠️ <strong>API Key Missing!</strong><br>Please go to the <strong>Privacy Lab (Settings)</strong> tab and enter your Google Gemini API key to use the RAG query engine.', 'assistant');
        return;
      }

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${userApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: systemPrompt }] }]
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error?.message || 'API request failed');
      }
      responseText = data.candidates[0].content.parts[0].text;

    } else if (aiProvider === 'groq_api') {
      if (!groqApiKey) {
        removeThinkingBubble(thinkingId);
        appendChatBubble('⚠️ <strong>Groq API Key Missing!</strong><br>Please go to the <strong>Settings</strong> tab and enter your Groq API key to use the high-speed LPU engine.', 'assistant');
        return;
      }

      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${groqApiKey}`
        },
        body: JSON.stringify({
          model: groqModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: query }
          ],
          temperature: 0.2
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error?.message || 'Groq API request failed');
      }
      responseText = data.choices[0].message.content;

    } else if (aiProvider === 'window_ai') {
      // Local Chrome Gemini Nano
      if (window.ai && window.ai.assistant) {
        const assistant = await window.ai.assistant.create({
          systemPrompt: "You are Vault AI, answering from local YouTube logs."
        });
        responseText = await assistant.prompt(systemPrompt);
      } else {
        throw new Error('Chrome Built-in AI (window.ai) is not enabled in this browser. Please enable the experimental flag, or switch provider to Gemini API in settings.');
      }
    }

    // 5. Append assistant response card
    removeThinkingBubble(thinkingId);
    appendChatBubble(responseText, 'assistant', matchedVideos);

  } catch (error) {
    console.error('Chat error:', error);
    removeThinkingBubble(thinkingId);
    appendChatBubble(`❌ <strong>Query Engine Error</strong><br>Failed to execute AI model run: ${error.message}`, 'assistant');
  }
}

/**
 * Basic Regex NLP rules-based date matching
 */
function parseTimeRangeFromText(text) {
  const lower = text.toLowerCase();
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  
  let fromTimestamp = 0;
  let toTimestamp = now;

  if (lower.includes('today')) {
    const todayStart = new Date();
    todayStart.setHours(0,0,0,0);
    fromTimestamp = todayStart.getTime();
  } else if (lower.includes('yesterday')) {
    const yesterdayStart = new Date();
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    yesterdayStart.setHours(0,0,0,0);
    fromTimestamp = yesterdayStart.getTime();
    
    const yesterdayEnd = new Date();
    yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);
    yesterdayEnd.setHours(23,59,59,999);
    toTimestamp = yesterdayEnd.getTime();
  } else if (lower.includes('last week') || lower.includes('week ago')) {
    fromTimestamp = now - 7 * ONE_DAY;
  } else if (lower.includes('last month') || lower.includes('month ago')) {
    fromTimestamp = now - 30 * ONE_DAY;
  } else if (lower.includes('this week')) {
    const d = new Date();
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday start
    const weekStart = new Date(d.setDate(diff));
    weekStart.setHours(0,0,0,0);
    fromTimestamp = weekStart.getTime();
  }

  return { fromTimestamp, toTimestamp };
}

/* Chat bubble rendering helpers */

function appendChatBubble(text, sender, citations = []) {
  const container = document.getElementById('chat-messages-container');
  if (!container) return null;

  const msgId = 'msg-' + Math.random().toString(36).substring(2, 9);
  const bubble = document.createElement('div');
  bubble.className = `chat-message ${sender}`;
  bubble.id = msgId;

  if (sender === 'thinking') {
    bubble.className = 'chat-message assistant';
    bubble.innerHTML = `
      <div class="message-avatar" style="background:var(--gradient-active)">AI</div>
      <div class="message-bubble typing-bubble">
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
      </div>
    `;
  } else {
    const avatar = sender === 'user' ? 'U' : 'AI';
    
    // Parse very basic markdown paragraph text
    const formattedText = formatMarkdown(text);

    let citationHtml = '';
    if (citations.length > 0) {
      citationHtml = `<div class="message-citations"><span class="citation-header">Indexed Sources</span>`;
      citations.forEach(cit => {
        citationHtml += `
          <a href="https://www.youtube.com/watch?v=${cit.videoId}" target="_blank" class="citation-card">
            <div class="citation-thumb">
              <img src="${cit.thumbnail}">
            </div>
            <div class="citation-info">
              <span class="citation-title">${escapeHtml(cit.title)}</span>
              <span class="citation-channel">${escapeHtml(cit.channel)}</span>
            </div>
          </a>
        `;
      });
      citationHtml += `</div>`;
    }

    bubble.innerHTML = `
      <div class="message-avatar">${avatar}</div>
      <div class="message-bubble">
        ${formattedText}
        ${citationHtml}
      </div>
    `;
  }

  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
  return msgId;
}

function removeThinkingBubble(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

/* Helper Utilities */

function formatMarkdown(text) {
  // Replace triple code blocks
  let html = text.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  // Replace double bold tags
  html = html.replace(/\*\*([\s\S]*?)\*\*/g, '<strong>$1</strong>');
  // Replace single italic tags
  html = html.replace(/\*([\s\S]*?)\*/g, '<em>$1</em>');
  // Replace bullets
  html = html.replace(/^\s*[\-\*]\s+(.*)$/gm, '<li>$1</li>');
  // Wrap list items
  html = html.replace(/(<li>.*<\/li>)/g, '<ul>$1<\/ul>');
  // Replace linebreaks
  html = html.replace(/\n/g, '<br>');
  return html;
}

function updateRadialStatus(percent, title, desc) {
  const circleFill = document.getElementById('radial-progress-bar');
  const percentText = document.getElementById('radial-progress-text');
  const statusTitle = document.getElementById('radial-status-title');
  const statusDesc = document.getElementById('radial-status-desc');
  const fillLinear = document.getElementById('linear-progress-fill');
  const textLinear = document.getElementById('linear-progress-text');

  if (circleFill) {
    const offset = 314 - (percent / 100) * 314;
    circleFill.style.strokeDashoffset = offset;
  }
  if (percentText) percentText.textContent = `${percent}%`;
  if (statusTitle) statusTitle.textContent = title;
  if (statusDesc) statusDesc.textContent = desc;

  if (fillLinear) fillLinear.style.width = `${percent}%`;
  if (textLinear) textLinear.textContent = percent === 100 ? 'Database is idle' : 'Importing Google Takeout...';
}

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast-notify');
  const msgText = document.getElementById('toast-message');
  
  if (!toast || !msgText) return;
  msgText.textContent = message;
  
  const checkIcon = toast.querySelector('svg');
  if (checkIcon) {
    checkIcon.style.stroke = type === 'success' ? '#16a34a' : '#c00000';
  }

  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

function formatDuration(seconds) {
  if (!seconds) return '00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function getRelativeTimeString(ms) {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hrs < 24) return `${hrs}h ago`;
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = (err) => reject(err);
    reader.readAsText(file);
  });
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
