/* In-room chat with emotes, shared by the multiplayer games. Phone-first: a floating 💬 button, an unread badge,
   short message toasts, and a bottom sheet (with quick emotes and quick phrases) that stays above the on-screen keyboard.
   Everything is built with textContent (no innerHTML), so names and messages can never inject markup.

   Chat.useSSE({ session: () => ({ code, token }) | null, bottom: 84 })   games with an HTTP + SSE server
   Chat.mount({ send: payload => Promise<{ ok, error }>, bottom: 84 })    games with their own transport (WebSockets):
     then feed it with Chat.setMe(key), Chat.setLog(list), Chat.receive(msg), Chat.setActive(bool), Chat.fail(text). */
(function () {
  'use strict';
  var EMOTES = ['😂', '😮', '😭', '👏', '🔥', '😈', '👍', '❤️', '🤔', '😎', '🙏', '🎉'];
  var PHRASES = ['gg', 'Nice!', 'Oops', 'Hurry up ⏱️', 'Rematch?'];
  var CSS = [
    '#cht-root{--cht-bg:#14171fee;--cht-fg:#f2f4f8;--cht-dim:#9aa3b2;--cht-line:#ffffff1f;--cht-acc:#4f8cff;--cht-bottom:84px;font:15px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--cht-fg);-webkit-tap-highlight-color:transparent}',
    ':where(#cht-root) *{box-sizing:border-box}',
    '#cht-root [hidden]{display:none!important}',
    // :where() has zero specificity, so every .cht-* rule below wins over this reset AND over each game's own button/input styling
    ':where(#cht-root) button{font:inherit;color:inherit;cursor:pointer;border:0;background:none;touch-action:manipulation;padding:0;margin:0;min-width:0;min-height:0;width:auto;height:auto;box-shadow:none;text-transform:none;letter-spacing:normal;border-radius:0;text-shadow:none;filter:none}',
    ':where(#cht-root) input{margin:0;box-shadow:none;text-transform:none;letter-spacing:normal}',
    '.cht-fab{position:fixed;right:max(10px,env(safe-area-inset-right));bottom:calc(var(--cht-bottom) + env(safe-area-inset-bottom));z-index:900;width:48px;height:48px;border-radius:50%;background:var(--cht-bg)!important;border:1px solid var(--cht-line)!important;font-size:22px;box-shadow:0 4px 14px #0007;display:grid;place-items:center}',
    '.cht-fab{touch-action:none;user-select:none;-webkit-user-select:none}',
    '.cht-fab:active{transform:scale(.94)}',
    '#cht-root.cht-left .cht-fab{right:auto;left:max(10px,env(safe-area-inset-left))}',
    '#cht-root.cht-left .cht-toasts{right:auto;left:calc(max(10px,env(safe-area-inset-left)) + 56px);align-items:flex-start}',
    '#cht-root.cht-left .cht-pop{right:auto;left:calc(max(10px,env(safe-area-inset-left)) + 4px)}',
    '.cht-badge{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#e5484d;color:#fff;font-size:12px;font-weight:700;line-height:20px;text-align:center}',
    '.cht-toasts{position:fixed;right:calc(max(10px,env(safe-area-inset-right)) + 56px);bottom:calc(var(--cht-bottom) + env(safe-area-inset-bottom));z-index:899;display:flex;flex-direction:column;align-items:flex-end;gap:6px;pointer-events:none;max-width:min(300px,calc(100vw - 90px))}',
    '.cht-toast{background:var(--cht-bg);border:1px solid var(--cht-line);border-radius:14px;padding:6px 11px;font-size:14px;box-shadow:0 4px 14px #0006;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;animation:cht-in .18s ease-out}',
    '.cht-toast b{margin-right:6px}',
    '.cht-pop{position:fixed;right:calc(max(10px,env(safe-area-inset-right)) + 4px);bottom:calc(var(--cht-bottom) + 52px + env(safe-area-inset-bottom));z-index:899;font-size:46px;pointer-events:none;animation:cht-float 2s ease-out forwards;text-shadow:0 2px 8px #0008}',
    '.cht-pop small{display:block;font-size:12px;text-align:center;color:#fff;text-shadow:0 1px 3px #000}',
    '@keyframes cht-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
    '@keyframes cht-float{0%{opacity:0;transform:translateY(0) scale(.6)}15%{opacity:1;transform:translateY(-14px) scale(1.15)}100%{opacity:0;transform:translateY(-120px) scale(1)}}',
    '.cht-scrim{position:fixed;inset:0;z-index:940;background:#0006}',
    '.cht-panel{position:fixed;left:0;right:0;bottom:0;z-index:950;display:flex;flex-direction:column;height:min(70vh,560px);max-height:calc(100vh - 16px);background:var(--cht-bg);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid var(--cht-line);border-bottom:0;border-radius:18px 18px 0 0;box-shadow:0 -8px 30px #0008;padding-bottom:env(safe-area-inset-bottom)}',
    '.cht-head{display:flex;align-items:center;gap:4px;padding:6px 6px 6px 16px;border-bottom:1px solid var(--cht-line);flex:none}',
    '.cht-head b{flex:1;font-size:16px}',
    '.cht-head button{width:44px;height:44px;border-radius:12px;font-size:18px}',
    '.cht-list{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;margin:0;padding:10px 12px;list-style:none;display:flex;flex-direction:column;gap:3px}',
    '.cht-empty{margin:auto;color:var(--cht-dim);text-align:center;padding:0 24px}',
    '.cht-row{display:flex;flex-direction:column;align-items:flex-start;max-width:86%}',
    '.cht-row.me{align-self:flex-end;align-items:flex-end}',
    '.cht-row.first{margin-top:8px}',
    '.cht-name{font-size:12px;font-weight:700;margin:0 6px 2px}',
    '.cht-bub{background:#ffffff14;border-radius:16px 16px 16px 4px;padding:7px 12px;word-break:break-word;overflow-wrap:anywhere;white-space:pre-wrap}',
    '.cht-row.me .cht-bub{background:var(--cht-acc);color:#fff;border-radius:16px 16px 4px 16px}',
    '.cht-bub.emote{background:none!important;font-size:38px;line-height:1.15;padding:0 4px}',
    '.cht-note{align-self:center;color:var(--cht-dim);font-size:13px;margin:4px 0}',
    '.cht-chips{display:flex;gap:6px;overflow-x:auto;padding:6px 10px;flex:none;scrollbar-width:none;-webkit-overflow-scrolling:touch;border-top:1px solid var(--cht-line)}',
    '.cht-chips::-webkit-scrollbar{display:none}',
    '.cht-chips button{flex:none;min-width:44px;height:44px;border-radius:22px;background:#ffffff14!important;padding:0 12px}',
    '.cht-chips .em{font-size:24px;padding:0}',
    '.cht-chips button:active{background:#ffffff30!important}',
    '.cht-form{display:flex;gap:8px;padding:8px 10px 10px;flex:none}',
    '.cht-form input{flex:1;min-width:0;height:46px;border-radius:23px;border:1px solid var(--cht-line);background:#0b0d12;color:var(--cht-fg);padding:0 16px;font:inherit;font-size:16px;outline:none}', /* 16px stops iOS zooming on focus */
    '.cht-form input:focus{border-color:var(--cht-acc)}',
    '.cht-form button{flex:none;height:46px;padding:0 18px;border-radius:23px;background:var(--cht-acc)!important;color:#fff;font-weight:700}',
    '.cht-form button:disabled{opacity:.45}',
    '@media (min-width:700px){.cht-scrim{display:none}.cht-panel{left:auto;right:14px;bottom:14px;width:370px;height:min(520px,calc(100vh - 28px));border:1px solid var(--cht-line);border-radius:18px;padding-bottom:0}}',
    '@media (prefers-reduced-motion:reduce){.cht-toast,.cht-pop{animation:none}.cht-pop{opacity:1}}'
  ].join('\n');

  var root, fab, badge, toasts, panel, scrim, list, form, input, sendBtn, muteBtn, emptyEl;
  var opts = null, me = '', unread = 0, lastN = 0, open = false, muted = false, active = false, mounted = false, lastFocus = null;
  var rows = [];
  var pos = { side: 'right', bottom: null }, drag = null, dragged = false;

  try { muted = localStorage.getItem('chat-mute') === '1'; var sp = JSON.parse(localStorage.getItem('chat-pos') || 'null'); if (sp && (sp.side === 'left' || sp.side === 'right') && (sp.bottom == null || isFinite(sp.bottom))) pos = sp; } catch (e) { /* storage blocked */ }

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function hue(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }

  function mount(o) {
    if (mounted) return;
    mounted = true; opts = o || {};
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    root = el('div'); root.id = 'cht-root'; root.hidden = true;
    if (opts.bottom != null) root.style.setProperty('--cht-bottom', typeof opts.bottom === 'number' ? opts.bottom + 'px' : opts.bottom);

    fab = el('button', 'cht-fab', '💬'); fab.type = 'button'; fab.setAttribute('aria-label', 'Open chat');
    badge = el('span', 'cht-badge'); badge.hidden = true; fab.appendChild(badge);
    toasts = el('div', 'cht-toasts'); toasts.setAttribute('aria-hidden', 'true');

    scrim = el('div', 'cht-scrim'); scrim.hidden = true;
    panel = el('section', 'cht-panel'); panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Chat');
    var head = el('div', 'cht-head');
    muteBtn = el('button'); muteBtn.type = 'button';
    var close = el('button', null, '✕'); close.type = 'button'; close.setAttribute('aria-label', 'Close chat');
    head.appendChild(el('b', null, 'Chat')); head.appendChild(muteBtn); head.appendChild(close);

    list = el('ol', 'cht-list'); list.setAttribute('role', 'log'); list.setAttribute('aria-live', 'polite'); list.setAttribute('aria-label', 'Chat messages');
    emptyEl = el('li', 'cht-empty', 'No messages yet. Say hi, or tap an emote!');
    list.appendChild(emptyEl);

    var chips = el('div', 'cht-chips'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', 'Quick emotes and phrases');
    EMOTES.forEach(function (e) { var b = el('button', 'em', e); b.type = 'button'; b.setAttribute('aria-label', 'Send ' + e); b.addEventListener('click', function () { post({ emote: e }); }); chips.appendChild(b); });
    PHRASES.forEach(function (p) { var b = el('button', null, p); b.type = 'button'; b.addEventListener('click', function () { post({ text: p }); }); chips.appendChild(b); });

    form = el('form', 'cht-form'); form.setAttribute('autocomplete', 'off');
    input = el('input'); input.type = 'text'; input.maxLength = 200; input.placeholder = 'Message…'; input.setAttribute('aria-label', 'Message');
    input.setAttribute('enterkeyhint', 'send'); input.setAttribute('autocapitalize', 'sentences'); input.setAttribute('autocomplete', 'off'); input.setAttribute('spellcheck', 'true');
    sendBtn = el('button', null, 'Send'); sendBtn.type = 'submit';
    form.appendChild(input); form.appendChild(sendBtn);

    panel.appendChild(head); panel.appendChild(list); panel.appendChild(chips); panel.appendChild(form);
    root.appendChild(fab); root.appendChild(toasts); root.appendChild(scrim); root.appendChild(panel);
    document.body.appendChild(root);

    applyPos();
    // The button can be dragged to either edge and any height, so it never has to cover a game's own controls.
    fab.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, y: e.clientY, id: e.pointerId, b: window.innerHeight - fab.getBoundingClientRect().bottom, moved: false }; });
    fab.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved) { if (Math.hypot(dx, dy) < 8) return; drag.moved = true; try { fab.setPointerCapture(drag.id); } catch (x) { /* ignore */ } }
      var bottom = Math.min(window.innerHeight - 64, Math.max(8, drag.b - dy));
      root.style.setProperty('--cht-bottom', Math.round(bottom) + 'px');
      fab.style.transform = 'translateX(' + Math.round(dx) + 'px)';
    });
    var endDrag = function (e) {
      if (!drag) return;
      var d = drag; drag = null;
      if (!d.moved) return;
      dragged = true; setTimeout(function () { dragged = false; }, 60); // swallow the click that follows a drag
      fab.style.transform = '';
      pos.side = e.clientX < window.innerWidth / 2 ? 'left' : 'right';
      pos.bottom = parseFloat(root.style.getPropertyValue('--cht-bottom')) || null;
      applyPos();
      try { localStorage.setItem('chat-pos', JSON.stringify(pos)); } catch (x) { /* ignore */ }
    };
    fab.addEventListener('pointerup', endDrag);
    fab.addEventListener('pointercancel', endDrag);
    fab.addEventListener('click', function () { if (!dragged) setOpen(!open); });
    close.addEventListener('click', function () { setOpen(false); });
    scrim.addEventListener('click', function () { setOpen(false); });
    muteBtn.addEventListener('click', function () { muted = !muted; try { localStorage.setItem('chat-mute', muted ? '1' : '0'); } catch (e) { /* ignore */ } paintMute(); });
    form.addEventListener('submit', function (e) { e.preventDefault(); var t = input.value.trim(); if (!t) return; input.value = ''; post({ text: t }); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && open) setOpen(false); });
    if (window.visualViewport) {
      var fit = function () { if (open) fitKeyboard(); };
      window.visualViewport.addEventListener('resize', fit);
      window.visualViewport.addEventListener('scroll', fit);
    }
    paintMute();
  }

  function applyPos() {
    root.classList.toggle('cht-left', pos.side === 'left');
    if (pos.bottom != null) root.style.setProperty('--cht-bottom', Math.min(pos.bottom, Math.max(8, window.innerHeight - 64)) + 'px');
  }

  function paintMute() {
    muteBtn.textContent = muted ? '🔕' : '🔔';
    muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    muteBtn.setAttribute('aria-label', muted ? 'Notifications off. Turn on' : 'Notifications on. Turn off');
    muteBtn.title = muted ? 'Message pop-ups are off' : 'Message pop-ups are on';
  }

  // Keep the sheet above the on-screen keyboard (iOS keeps fixed elements behind it).
  function fitKeyboard() {
    var vv = window.visualViewport;
    if (!vv) return;
    var kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    panel.style.bottom = window.matchMedia('(min-width:700px)').matches ? '' : kb + 'px';
    panel.style.maxHeight = Math.max(200, Math.round(vv.height - 12)) + 'px';
  }

  function setOpen(on) {
    if (!mounted || on === open) return;
    open = on;
    panel.hidden = !on;
    scrim.hidden = !on;
    fab.setAttribute('aria-label', on ? 'Close chat' : 'Open chat');
    if (on) {
      lastFocus = document.activeElement;
      unread = 0; paintBadge(); toasts.textContent = '';
      fitKeyboard();
      scrollDown(true);
      if (window.matchMedia('(min-width:700px)').matches) setTimeout(function () { input.focus(); }, 30); // on phones the keyboard only opens when you tap the box
    } else {
      panel.style.bottom = ''; panel.style.maxHeight = '';
      try { input.blur(); } catch (e) { /* ignore */ }
      if (lastFocus && lastFocus.focus) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
  }

  function paintBadge() {
    badge.hidden = unread <= 0;
    badge.textContent = unread > 9 ? '9+' : String(unread);
    fab.setAttribute('aria-label', (open ? 'Close chat' : 'Open chat') + (unread ? ', ' + unread + ' unread' : ''));
  }

  function nearBottom() { return list.scrollHeight - list.scrollTop - list.clientHeight < 90; }
  function scrollDown(force) { if (force || nearBottom()) list.scrollTop = list.scrollHeight; }

  function render(msg) {
    var mine = !!me && msg.key === me;
    var prev = rows.length ? rows[rows.length - 1] : null;
    var same = prev && prev.key === msg.key && (msg.at - prev.at) < 90000;
    var li = el('li', 'cht-row' + (mine ? ' me' : '') + (same ? '' : ' first'));
    if (!mine && !same) { var nm = el('span', 'cht-name', msg.from || 'Player'); nm.style.color = 'hsl(' + hue(String(msg.key || msg.from)) + ',80%,72%)'; li.appendChild(nm); }
    li.appendChild(el('span', 'cht-bub' + (msg.emote ? ' emote' : ''), msg.emote || msg.text || ''));
    return li;
  }

  function append(msg) {
    if (emptyEl.parentNode) list.removeChild(emptyEl);
    var stick = nearBottom() || (me && msg.key === me);
    list.appendChild(render(msg));
    rows.push(msg);
    while (rows.length > 100) { rows.shift(); if (list.firstChild) list.removeChild(list.firstChild); }
    if (open && stick) scrollDown(true);
  }

  function toast(msg) {
    if (open || muted || document.hidden) return;
    if (msg.emote) {
      var p = el('div', 'cht-pop', msg.emote); p.appendChild(el('small', null, msg.from || ''));
      root.appendChild(p); setTimeout(function () { if (p.parentNode) p.parentNode.removeChild(p); }, 2100);
      return;
    }
    var t = el('div', 'cht-toast'); t.appendChild(el('b', null, msg.from || 'Player')); t.appendChild(document.createTextNode(msg.text || ''));
    toasts.appendChild(t);
    while (toasts.children.length > 3) toasts.removeChild(toasts.firstChild);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 4500);
  }

  function receive(msg) {
    if (!mounted || !msg || typeof msg.n !== 'number' || msg.n <= lastN) return; // replays / duplicates are ignored
    lastN = msg.n;
    append(msg);
    var mine = !!me && msg.key === me;
    if (!mine) {
      if (!open) { unread++; paintBadge(); }
      toast(msg);
    }
  }

  function setLog(listIn) {
    if (!mounted) return;
    rows = []; unread = 0; paintBadge();
    while (list.firstChild) list.removeChild(list.firstChild);
    list.appendChild(emptyEl);
    lastN = 0;
    (listIn || []).forEach(function (m) { if (m && typeof m.n === 'number') { lastN = Math.max(lastN, m.n); append(m); } });
    if (open) scrollDown(true);
  }

  function fail(text) {
    if (!mounted) return;
    if (emptyEl.parentNode) list.removeChild(emptyEl);
    var n = el('li', 'cht-note', text || "Couldn't send"); list.appendChild(n);
    if (open) scrollDown(true);
    setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, 3500);
  }

  function post(payload) {
    if (!opts || !opts.send) return;
    Promise.resolve(opts.send(payload)).then(function (r) { if (r && r.ok === false) fail(r.error || "Couldn't send"); }, function () { fail("Couldn't send. Check your connection"); });
  }

  function setActive(on) {
    if (!mounted) return;
    active = !!on; root.hidden = !active;
    if (!active) { setOpen(false); }
  }
  function setMe(k) { me = k || ''; }

  // HTTP + SSE transport used by most games. It polls the game's session so it follows create / join / leave by itself.
  function useSSE(o) {
    o = o || {};
    mount({
      bottom: o.bottom,
      send: function (payload) {
        var s = o.session && o.session();
        if (!s) return Promise.resolve({ ok: false, error: 'Not in a room' });
        return fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ code: s.code, token: s.token }, payload)) })
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, error: j.error }; }); });
      }
    });
    var es = null, cur = '', retryAt = 0;
    setInterval(function () {
      var s = null; try { s = o.session && o.session(); } catch (e) { s = null; }
      var k = s && s.code && s.token ? s.code + ':' + s.token : '';
      if (k !== cur) {
        cur = k;
        if (es) { es.close(); es = null; }
        setLog([]); setMe('');
        if (!k) { setActive(false); return; }
        retryAt = 0;
      }
      if (!k || es || Date.now() < retryAt) return;
      es = new EventSource('/api/chat/events?code=' + encodeURIComponent(s.code) + '&token=' + encodeURIComponent(s.token));
      es.addEventListener('hello', function (e) { try { setMe(JSON.parse(e.data).you); setActive(true); } catch (x) { /* ignore */ } });  // the button only appears once the server has confirmed the seat
      es.addEventListener('log', function (e) { try { setLog(JSON.parse(e.data)); } catch (x) { /* ignore */ } });
      es.addEventListener('msg', function (e) { try { receive(JSON.parse(e.data)); } catch (x) { /* ignore */ } });
      es.onerror = function () { if (es && es.readyState === 2) { es.close(); es = null; retryAt = Date.now() + 5000; setActive(false); } }; // closed for good (room gone): try again later
    }, 1000);
  }

  window.Chat = { EMOTES: EMOTES, mount: mount, useSSE: useSSE, receive: receive, setLog: setLog, setMe: setMe, setActive: setActive, fail: fail,
    open: function () { setOpen(true); }, close: function () { setOpen(false); }, isOpen: function () { return open; } };
})();
