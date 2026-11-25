/* ═══════════════════════════════════════════════════════════════════════════
   DataBase Campaign Copier — content.js
   Injected into the page (runs in ISOLATED world).

   ⚠️  Content scripts cannot access window.* set by page scripts (different
       JS sandbox). Bridge is via CustomEvents on the shared DOM.

   Message flow — FORWARD (Ctrl+D):
     background.js  →  content.js (CC_COPY_NEXT)
     content.js     →  page via CustomEvent('cc:copy-next')
     page           →  content.js via CustomEvent('cc:value-ready', { detail: { value } })
     content.js     →  background.js via sendResponse({ value })
     background.js  →  offscreen.js  →  clipboard.writeText(value)

   Message flow — BACKWARD (Ctrl+W):
     background.js  →  content.js (CC_COPY_PREV)
     content.js     →  page via CustomEvent('cc:copy-prev')
     page           →  content.js via CustomEvent('cc:value-ready-prev', { detail: { value } })
     content.js     →  background.js via sendResponse({ value })
     background.js  →  offscreen.js  →  clipboard.writeText(value)
═══════════════════════════════════════════════════════════════════════════ */

'use strict';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  // ── FORWARD: Ctrl+D ─────────────────────────────────────────────────────────
  if (message.type === 'CC_COPY_NEXT') {
    // One-shot listener: wait for the page to fire back the current value
    document.addEventListener('cc:value-ready', (e) => {
      sendResponse({ value: e.detail?.value ?? '' });
    }, { once: true });

    // Tell the page script to advance state and return the value
    document.dispatchEvent(new CustomEvent('cc:copy-next', { bubbles: false }));

    return true; // Keep the message channel open for the async sendResponse
  }

  // ── BACKWARD: Ctrl+W ────────────────────────────────────────────────────────
  if (message.type === 'CC_COPY_PREV') {
    // One-shot listener: wait for the page to fire back the previous value
    document.addEventListener('cc:value-ready-prev', (e) => {
      sendResponse({ value: e.detail?.value ?? '' });
    }, { once: true });

    // Tell the page script to step back and return the value
    document.dispatchEvent(new CustomEvent('cc:copy-prev', { bubbles: false }));

    return true; // Keep the message channel open for the async sendResponse
  }

  return false;
});
