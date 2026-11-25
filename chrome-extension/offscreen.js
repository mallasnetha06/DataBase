/* ═══════════════════════════════════════════════════════════════════════════
   DataBase Campaign Copier — offscreen.js

   Chrome docs explicitly state: for offscreen documents with reason CLIPBOARD,
   use document.execCommand('copy') — NOT navigator.clipboard.writeText().
   navigator.clipboard requires document focus even in offscreen contexts.
═══════════════════════════════════════════════════════════════════════════ */

'use strict';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'offscreen' || message.type !== 'CC_WRITE_CLIPBOARD') {
    return false;
  }

  const value = message.value ?? '';

  // ── Primary: document.execCommand('copy') ─────────────────────────────────
  // This is the Chrome-recommended method for offscreen CLIPBOARD documents.
  const textarea = document.createElement('textarea');
  textarea.value = value;
  // Must be visible enough for focus + select to work, but invisible to user
  textarea.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    'width:2px',
    'height:2px',
    'border:none',
    'outline:none',
    'box-shadow:none',
    'background:transparent',
    'opacity:0.01',
    'pointer-events:none',
  ].join(';');

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (execErr) {
    console.warn('[Campaign Copier / offscreen] execCommand failed:', execErr);
  }

  document.body.removeChild(textarea);

  if (ok) {
    console.debug('[Campaign Copier / offscreen] execCommand copy OK');
    sendResponse({ ok: true, method: 'execCommand' });
    return true;
  }

  // ── Fallback: navigator.clipboard ─────────────────────────────────────────
  console.warn('[Campaign Copier / offscreen] execCommand failed, trying navigator.clipboard');
  navigator.clipboard.writeText(value)
    .then(() => {
      console.debug('[Campaign Copier / offscreen] navigator.clipboard OK');
      sendResponse({ ok: true, method: 'navigator.clipboard' });
    })
    .catch(err => {
      console.error('[Campaign Copier / offscreen] Both methods failed:', err);
      sendResponse({ ok: false, error: err.message });
    });

  return true;
});
