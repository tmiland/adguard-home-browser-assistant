'use strict';

/*
 * Same-origin AGH API bridge.
 *
 * Runs only inside the AdGuard Home web UI origins (see manifest.json).
 * The background page uses it when its direct extension-origin fetch cannot
 * carry the AGH session cookie (SameSite=Lax) or is blocked by CORS.
 */
(() => {
    if (window.__aghUnblockBridge) return;
    window.__aghUnblockBridge = true;

    browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || (msg.type !== 'agh-ping' && msg.type !== 'agh-api')) {
            return undefined;
        }
        if (msg.type === 'agh-ping') {
            sendResponse({ ok: true });
            return undefined;
        }

        (async () => {
            try {
                const init = {
                    method: msg.method || 'GET',
                    credentials: 'same-origin',
                    headers: Object.assign({}, msg.headers || {}),
                };
                if (msg.body !== undefined && msg.body !== null) {
                    init.headers['Content-Type'] = 'application/json';
                    init.body = JSON.stringify(msg.body);
                }
                const res = await fetch(msg.path, init);
                if (res.redirected && /\/login\.html/i.test(res.url)) {
                    sendResponse({ ok: false, session_expired: true, status: res.status });
                    return;
                }
                const text = await res.text();
                if (!res.ok) {
                    sendResponse({ ok: false, status: res.status, text });
                    return;
                }
                if (text.trim().startsWith('<')) {
                    sendResponse({
                        ok: false,
                        session_expired: /login|username|password/i.test(text),
                        status: res.status,
                        text,
                    });
                    return;
                }
                let data = null;
                if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
                    try {
                        data = JSON.parse(text);
                    } catch (_) {
                        data = null;
                    }
                }
                sendResponse({ ok: true, status: res.status, data, text: data === null ? text : undefined });
            } catch (e) {
                sendResponse({ ok: false, error: String(e) });
            }
        })();

        return true;
    });
})();
