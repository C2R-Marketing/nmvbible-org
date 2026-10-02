/* NMV support-agent chat widget (nmvbible.org).
 * - Reads NMV_CONFIG.SUPPORT_AGENT_URL. If blank/unset, the widget does NOT
 *   render at all: no broken UI on the live site until the backend is deployed.
 * - Vanilla JS, no dependencies. Accessible: focus management, Esc to close,
 *   aria roles/labels, keyboard-operable. */
(function () {
  'use strict';
  var cfg = (window.NMV_CONFIG || {});
  var API = (cfg.SUPPORT_AGENT_URL || '').replace(/\/$/, '');
  if (!API) return; // backend not configured -> stay inert

  var SESSION_KEY = 'nmv_chat_session';
  function sessionId() {
    try {
      var id = sessionStorage.getItem(SESSION_KEY);
      if (!id) {
        id = 's_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        sessionStorage.setItem(SESSION_KEY, id);
      }
      return id;
    } catch (e) { return 's_anon'; }
  }

  // --- DOM ---
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'nmv-chat-btn';
  btn.setAttribute('aria-label', 'Ask about the NMV Bible');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M4 3h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H8l-5 4V4a1 1 0 0 1 1-1z"/></svg>';

  var panel = document.createElement('div');
  panel.id = 'nmv-chat-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'NMV Bible assistant');
  panel.hidden = true;
  panel.innerHTML =
    '<div class="nmv-chat-head"><strong>NMV Bible assistant</strong>' +
    '<button type="button" class="nmv-chat-close" aria-label="Close chat">×</button></div>' +
    '<div class="nmv-chat-msgs" role="log" aria-live="polite" aria-label="Conversation"></div>' +
    '<p class="nmv-chat-note">Answers come from nmvbible.org content. Anything else, I\'ll pass to the team.</p>' +
    '<form class="nmv-chat-form"><label class="nmv-chat-sr" for="nmv-chat-input">Your question</label>' +
    '<input id="nmv-chat-input" type="text" autocomplete="off" maxlength="500" placeholder="Ask about editions, ordering, donations…">' +
    '<button type="submit" class="btn btn-primary btn-sm">Send</button></form>';

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  var msgs = panel.querySelector('.nmv-chat-msgs');
  var form = panel.querySelector('.nmv-chat-form');
  var input = panel.querySelector('#nmv-chat-input');
  var closeBtn = panel.querySelector('.nmv-chat-close');
  var opened = false;

  function addMsg(text, who) {
    var div = document.createElement('div');
    div.className = 'nmv-chat-msg ' + who;
    // textContent only: the agent reply is never rendered as HTML (injection-safe).
    div.textContent = text;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function setOpen(open) {
    opened = open;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) {
      if (!msgs.children.length) {
        addMsg('Hi! I can help with questions about the NMV translation, editions, ordering, the free chapter, and donations.', 'bot');
      }
      input.focus();
    } else { btn.focus(); }
  }

  btn.addEventListener('click', function () { setOpen(!opened); });
  closeBtn.addEventListener('click', function () { setOpen(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && opened) setOpen(false);
  });

  var busy = false;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || busy) return;
    busy = true;
    addMsg(text, 'user');
    input.value = '';
    var typing = document.createElement('div');
    typing.className = 'nmv-chat-msg bot typing';
    typing.textContent = '…';
    msgs.appendChild(typing);
    msgs.scrollTop = msgs.scrollHeight;

    fetch(API + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId(), message: text })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        typing.remove();
        addMsg(data.reply || 'Sorry — something went wrong. Please try again.', 'bot');
        if (data.type === 'escalated') {
          addMsg('Thanks — the team will follow up personally.', 'bot');
        }
      })
      .catch(function () {
        typing.remove();
        addMsg('Sorry — I could not reach the assistant right now. Please try again later.', 'bot');
      })
      .then(function () { busy = false; input.focus(); });
  });
})();
