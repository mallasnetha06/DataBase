/* ═══════════════════════════════════════════════════════════════════════════
   DataBase — js/campaign-composer-ext.js
   Chrome Extension bridge for Campaign Composer Sequential Copy Mode.

   This file is the ONLY glue between the Chrome extension and the page.
   It must be loaded AFTER campaign-composer.js.

   How it works:
     content.js (extension, ISOLATED world) cannot access window.* from
     the page's JS context. Instead it dispatches a CustomEvent on the
     shared DOM. This file catches that event and calls the page-side
     function, then fires a response event back so content.js can relay
     the value to background.js → offscreen.js → clipboard write — all
     without focusing the browser window.

   Return value contract from _ccAdvanceAndGetValue / _ccGoBackAndGetValue:
     false  → copy mode is off or done — bridge fires '' to avoid writing garbage
     null   → 'status' action chip was processed — bridge fires '' (no clipboard write)
     string → the field value to write to clipboard

   Message flow — FORWARD (Ctrl+D):
     [Global Ctrl+D]
       → background.js          (chrome.commands.onCommand)
       → content.js             (chrome.tabs.sendMessage CC_COPY_NEXT)
       → document 'cc:copy-next' CustomEvent          (DOM bridge ↓)
       → _ccAdvanceAndGetValue()                      (this file)
       → document 'cc:value-ready' CustomEvent        (DOM bridge ↑)
       → content.js             (sendResponse { value })
       → background.js          (_writeClipboard)
       → offscreen.js           (document.execCommand copy)
       → System clipboard ✓

   Message flow — BACKWARD (Ctrl+R):
     [Global Ctrl+R]
       → background.js          (chrome.commands.onCommand)
       → content.js             (chrome.tabs.sendMessage CC_COPY_PREV)
       → document 'cc:copy-prev' CustomEvent          (DOM bridge ↓)
       → _ccGoBackAndGetValue()                       (this file)
       → document 'cc:value-ready-prev' CustomEvent  (DOM bridge ↑)
       → content.js             (sendResponse { value })
       → background.js          (_writeClipboard)
       → offscreen.js           (document.execCommand copy)
       → System clipboard ✓
═══════════════════════════════════════════════════════════════════════════ */

'use strict';

(function () {
  // Guard: only wire up if the Campaign Composer core is present
  if (typeof _ccAdvanceAndGetValue !== 'function' ||
      typeof _ccGoBackAndGetValue  !== 'function') {
    console.warn('[CC-Ext] campaign-composer.js not loaded — extension bridge skipped.');
    return;
  }

  // ── FORWARD: Ctrl+D — copy next field / trigger status update ───────────────
  document.addEventListener('cc:copy-next', () => {
    const value = _ccAdvanceAndGetValue();
    // false = mode off, null = status chip processed — both send '' to clipboard
    // (offscreen.js expects a string; '' is safe and leaves clipboard unchanged)

    // Fire the value back so content.js can relay it to background.js
    document.dispatchEvent(new CustomEvent('cc:value-ready', {
      detail:     { value: (value === false || value === null) ? '' : value },
      bubbles:    false,
      cancelable: false,
    }));
  });

  // ── BACKWARD: Ctrl+R — go back one field / revert status if on status chip ────
  document.addEventListener('cc:copy-prev', () => {
    const value = _ccGoBackAndGetValue();

    // Fire the value back so content.js can relay it to background.js
    document.dispatchEvent(new CustomEvent('cc:value-ready-prev', {
      detail:     { value: (value === false || value === null) ? '' : value },
      bubbles:    false,
      cancelable: false,
    }));
  });

  console.debug('[CC-Ext] Chrome extension bridge registered (Ctrl+D forward · Ctrl+R backward · Status chip aware).');
})();
