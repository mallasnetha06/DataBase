/* ═══════════════════════════════════════════════════════════════════════════
   DataBase Campaign Copier — background.js (Service Worker)

   Flow (no window focus required):
     1. Global Ctrl+D (next) or Ctrl+W (back) fires
     2. Find the Campaign Composer tab (no focus)
     3. Ask content.js for the current/previous field value via CC_COPY_NEXT / CC_COPY_PREV
        → If content.js isn’t loaded yet, inject it programmatically then retry
     4. Write value to clipboard via hidden offscreen document using execCommand
═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const TARGET_ORIGINS    = ['http://10.22.86.75:8000', 'http://localhost:8000'];
const OFFSCREEN_DOC_URL = chrome.runtime.getURL('offscreen.html');
let   _offscreenCreating = false;

// ── Offscreen document management ─────────────────────────────────────────────
async function _ensureOffscreen() {
  // Check if our offscreen document already exists
  let existing = [];
  try {
    existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [OFFSCREEN_DOC_URL],
    });
  } catch (e) {
    // getContexts not available in older Chrome — try creating anyway
    console.warn('[Campaign Copier] getContexts unavailable, attempting create:', e.message);
  }

  if (existing.length > 0) {
    console.debug('[Campaign Copier] Offscreen document already exists.');
    return;
  }

  if (_offscreenCreating) {
    // Another call is already creating it — wait briefly
    console.debug('[Campaign Copier] Offscreen creation in progress, waiting...');
    await new Promise(r => setTimeout(r, 300));
    return;
  }

  _offscreenCreating = true;
  try {
    console.debug('[Campaign Copier] Creating offscreen document...');
    await chrome.offscreen.createDocument({
      url:           OFFSCREEN_DOC_URL,
      reasons:       ['CLIPBOARD'],
      justification: 'Write campaign field values to clipboard without focusing the browser window.',
    });
    console.debug('[Campaign Copier] Offscreen document created.');
  } catch (err) {
    // If it already exists (race condition), that's fine
    if (!err.message?.includes('already')) {
      console.error('[Campaign Copier] Failed to create offscreen document:', err);
      throw err;
    }
    console.debug('[Campaign Copier] Offscreen already existed (race condition OK).');
  } finally {
    _offscreenCreating = false;
  }
}

async function _writeClipboard(value) {
  await _ensureOffscreen();

  console.debug('[Campaign Copier] Sending CC_WRITE_CLIPBOARD to offscreen, value length:', value.length);
  const result = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type:   'CC_WRITE_CLIPBOARD',
    value,
  });

  if (result?.ok) {
    console.debug('[Campaign Copier] Clipboard write OK via', result.method);
  } else {
    console.error('[Campaign Copier] Clipboard write FAILED:', result?.error);
  }
  return result;
}

// ── Send a message to content.js, auto-injecting it if not yet loaded ──────────
// Handles the "Receiving end does not exist" error that occurs when the
// extension is reloaded without the page being refreshed.
async function _sendToContentScript(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    const isNotFound = err.message?.includes('Receiving end does not exist') ||
                       err.message?.includes('Could not establish connection');
    if (!isNotFound) throw err; // unexpected error — re-throw

    // content.js isn't running — inject it now
    console.debug('[Campaign Copier] content.js not found — injecting programmatically...');
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files:  ['content.js'],
      });
    } catch (injectErr) {
      throw new Error('Failed to inject content.js: ' + injectErr.message);
    }

    // Give content.js a moment to register its message listener
    await new Promise(r => setTimeout(r, 150));

    // Retry once
    console.debug('[Campaign Copier] Retrying message after injection...');
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  const isNext = command === 'sequential-copy-next';
  const isPrev = command === 'sequential-copy-prev';
  if (!isNext && !isPrev) return;

  const label = isNext ? 'Ctrl+D (next)' : 'Ctrl+W (back)';
  const msgType = isNext ? 'CC_COPY_NEXT' : 'CC_COPY_PREV';

  console.debug(`[Campaign Copier] Global ${label} received.`);

  try {
    // 1. Find all matching Campaign Composer tabs
    let tabs = [];
    for (const origin of TARGET_ORIGINS) {
      const matched = await chrome.tabs.query({ url: `${origin}/*` });
      tabs = tabs.concat(matched);
    }

    if (!tabs.length) {
      console.warn('[Campaign Copier] No tab found at', TARGET_ORIGINS);
      return;
    }

    const target = tabs.find(t => t.active) || tabs[0];
    console.debug('[Campaign Copier] Target tab:', target.id, target.url);

    // 2. Ask content.js to advance / rewind the copy state and return the value
    //    Auto-injects content.js if it isn't loaded yet (e.g. after ext reload)
    let response;
    try {
      response = await _sendToContentScript(target.id, { type: msgType });
    } catch (msgErr) {
      console.error('[Campaign Copier] Could not reach content.js:', msgErr.message);
      return;
    }

    console.debug('[Campaign Copier] Got value from page:', JSON.stringify(response));

    if (!response || response.value === undefined || response.value === null) {
      console.debug('[Campaign Copier] No value returned — copy mode may not be active.');
      return;
    }

    // 3. Write to clipboard via the hidden offscreen document (no window focus)
    await _writeClipboard(String(response.value));

  } catch (err) {
    console.error('[Campaign Copier] Unhandled error:', err);
  }
});
