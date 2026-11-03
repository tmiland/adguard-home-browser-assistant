'use strict';

const DEFAULT_AGH = 'https://adguard.home.tmiland.com';
const BLOCKED_PAGE = 'blocked.html';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeHost(value) {
    if (typeof value !== 'string') return null;
    const host = value.toLowerCase().replace(/\.$/, '');
    if (host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) return null;
    if (host.startsWith('.') || host.includes('..')) return null;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
    const labels = host.split('.');
    if (labels.length < 2 || labels.some((l) => !l || l.length > 63)) return null;
    return host;
}

function targetFromRule(ruleText, host) {
    let t = String(ruleText || '').trim();
    if (!t || t.startsWith('/')) return host;
    t = t.replace(/^@@/, '').replace(/^\|\|/, '').replace(/^\|/, '');
    t = t.split('^')[0].split('$')[0].toLowerCase().replace(/\.$/, '');
    if (!t || t.includes('*') || t.includes('/') || t.includes(':')) return host;
    if (!/^[a-z0-9.-]+$/.test(t) || t.startsWith('.') || t.includes('..')) return host;
    if (host === t || host.endsWith('.' + t)) return t;
    return host;
}

function hostFromUrl(value) {
    try {
        const u = new URL(value);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return normalizeHost(u.hostname);
    } catch (_) {
        return null;
    }
}

function validUrl(value, fallbackHost) {
    try {
        const u = new URL(value);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        if (!normalizeHost(u.hostname)) return null;
        return u.href;
    } catch (_) {
        return fallbackHost ? `https://${fallbackHost}/` : null;
    }
}

function originOf(url) {
    try {
        return new URL(url).origin;
    } catch (_) {
        return DEFAULT_AGH;
    }
}

function escapeClient(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '\\"')
        .replace(/,/g, '\\,')
        .replace(/\|/g, '\\|');
}

async function getConfig() {
    const cfg = await browser.storage.local.get({
        aghUrl: DEFAULT_AGH,
        clientName: '',
        autoBlockPage: true,
    });
    cfg.aghUrl = String(cfg.aghUrl || DEFAULT_AGH).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(cfg.aghUrl)) cfg.aghUrl = DEFAULT_AGH;
    cfg.clientName = String(cfg.clientName || '').trim();
    cfg.autoBlockPage = cfg.autoBlockPage !== false;
    return cfg;
}

/* -------------------------------------------------------------------------
 * AGH API: try a direct extension fetch first (uses the browser cookie jar),
 * then fall back to a same-origin fetch inside an AGH UI tab. The latter is
 * reliable even when SameSite blocks the extension-origin request.
 */

async function apiDirect(cfg, path, opt) {
    const method = (opt && opt.method) || 'GET';
    const init = {
        method,
        credentials: 'include',
        redirect: 'follow',
        headers: Object.assign({}, (opt && opt.headers) || {}),
    };
    if (opt && opt.body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(opt.body);
    }
    try {
        const res = await fetch(cfg.aghUrl + path, init);
        const text = await res.text();
        if (res.redirected && /\/login\.html/i.test(res.url)) {
            return { ok: false, session_expired: true, status: res.status, text };
        }
        if (!res.ok) return { ok: false, status: res.status, text };
        /* A login page served with 200 is not a usable API response. */
        if (text.trim().startsWith('<')) return { ok: false, status: res.status, html: true, text };
        let data = null;
        if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
            try {
                data = JSON.parse(text);
            } catch (_) {
                data = null;
            }
        }
        return { ok: true, status: res.status, data, text };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

async function findBridgeTab(cfg) {
    const origin = originOf(cfg.aghUrl);
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
        if (!tab.id || !tab.url || !tab.url.startsWith(origin)) continue;
        try {
            const pong = await browser.tabs.sendMessage(tab.id, { type: 'agh-ping' });
            if (pong && pong.ok) return tab.id;
        } catch (_) {
            /* old AGH tab opened before the add-on: try the next one */
        }
    }
    return null;
}

async function waitTabComplete(tabId) {
    for (let i = 0; i < 60; i++) {
        const tab = await browser.tabs.get(tabId).catch(() => null);
        if (tab && tab.status === 'complete') return true;
        await sleep(250);
    }
    return false;
}

async function createBridgeTab(cfg) {
    const tab = await browser.tabs.create({ url: cfg.aghUrl, active: false });
    await waitTabComplete(tab.id);
    for (let i = 0; i < 20; i++) {
        try {
            const pong = await browser.tabs.sendMessage(tab.id, { type: 'agh-ping' });
            if (pong && pong.ok) return tab.id;
        } catch (_) {
            /* content script still loading */
        }
        await sleep(300);
    }
    return tab.id;
}

let bridgeTabPromise = null;

async function ensureBridgeTab(cfg) {
    if (bridgeTabPromise) return bridgeTabPromise;
    bridgeTabPromise = (async () => {
        const existing = await findBridgeTab(cfg);
        if (existing) return existing;
        return createBridgeTab(cfg);
    })();
    try {
        return await bridgeTabPromise;
    } finally {
        bridgeTabPromise = null;
    }
}

async function apiBridge(cfg, path, opt) {
    const tabId = await ensureBridgeTab(cfg);
    for (let i = 0; i < 5; i++) {
        try {
            const result = await browser.tabs.sendMessage(tabId, {
                type: 'agh-api',
                path,
                method: (opt && opt.method) || 'GET',
                body: opt ? opt.body : undefined,
                headers: (opt && opt.headers) || {},
            });
            if (result) return result;
        } catch (_) {
            /* tab may still be loading or was closed */
        }
        await sleep(300);
    }
    return { ok: false, error: 'AdGuard Home bridge unavailable' };
}

async function aghApi(path, opt) {
    const cfg = await getConfig();
    const direct = await apiDirect(cfg, path, opt);
    if (direct.ok) {
        const method = (opt && opt.method) || 'GET';
        if (method !== 'GET' || direct.data !== null) return direct;
    }
    if (direct.session_expired) {
        /* The direct request had no usable SameSite session; a same-origin
           tab fetch may still work. */
    }
    return apiBridge(cfg, path, opt);
}

async function queryLog(host) {
    const r = await aghApi('/control/querylog?search=' + encodeURIComponent(host) + '&limit=20');
    if (!r.ok || !r.data || !Array.isArray(r.data.data)) return [];
    return r.data.data;
}

async function findBlockInfo(host) {
    const [check, entries] = await Promise.all([
        aghApi('/control/filtering/check_host?name=' + encodeURIComponent(host)),
        queryLog(host),
    ]);

    let blocked = false;
    let reason = '';
    let rule = '';
    let client = '';

    const checkReason = (check.ok && check.data && check.data.reason) || '';
    if (checkReason === 'NotFilteredWhiteList') {
        /* An explicit allowlist rule wins; do not let an older query-log
           blocked entry resurrect the block page after Unblock. */
        return { blocked: false, reason: '', rule: '', client: '', target: host };
    }
    if (/^Filtered/.test(checkReason)) {
        blocked = true;
        reason = checkReason;
        rule = (check.data.rules && check.data.rules[0] && check.data.rules[0].text) || '';
    }

    /* Use the latest exact-host query-log entry. This supplies the client for
       "this client only" and covers CNAME/IP blocks that check_host does not
       report. A newer non-filtered entry must not be overridden by an older
       blocked one (e.g. after the user already unblocked it). */
    let latest = null;
    for (const entry of entries) {
        const name = (entry.question && entry.question.name ? entry.question.name : '')
            .toLowerCase()
            .replace(/\.$/, '');
        if (name !== host) continue;
        const t = Date.parse(entry.time || '') || 0;
        if (!latest || t > latest.t) {
            latest = { t, client: entry.client || '', reason: entry.reason || '', rule: entry.rule || '' };
        }
    }
    if (latest) {
        const recent = Date.now() - latest.t < 120000;
        client = latest.client;
        if (latest.client) {
            const clientCheck = await aghApi(
                '/control/filtering/check_host?name=' + encodeURIComponent(host) +
                '&client=' + encodeURIComponent(latest.client),
            );
            if (clientCheck.ok && clientCheck.data && clientCheck.data.reason === 'NotFilteredWhiteList') {
                return { blocked: false, reason: '', rule: '', client: latest.client, target: host };
            }
        }
        if (!blocked && recent && /^Filtered/.test(latest.reason || '')) {
            blocked = true;
            reason = latest.reason;
            rule = latest.rule;
        }
    }
    return { blocked, reason, rule, client, target: targetFromRule(rule, host) };
}

async function resolveClient(host, cfg) {
    if (cfg.clientName) return cfg.clientName;
    const entries = await queryLog(host);
    let best = null;
    for (const entry of entries) {
        const name = (entry.question && entry.question.name ? entry.question.name : '')
            .toLowerCase()
            .replace(/\.$/, '');
        if (name !== host) continue;
        const t = Date.parse(entry.time || '') || 0;
        const c = entry.client || '';
        if (c && (!best || t > best.t)) best = { t, client: c };
    }
    return best ? best.client : '';
}

async function handleToggle(msg) {
    const action = msg.action === 'block' ? 'block' : 'unblock';
    const host = normalizeHost(msg.host);
    if (!host) return { ok: false, message: 'Invalid hostname.' };

    const cfg = await getConfig();
    let client = '';
    if (msg.clientOnly) {
        client = String(msg.client || '').trim() || cfg.clientName || (await resolveClient(host, cfg));
        if (!client) {
            return { ok: false, message: 'Set this client in the extension options, or open a query for it first.' };
        }
    }

    const status = await aghApi('/control/filtering/status');
    if (status.session_expired) {
        return { ok: false, session_expired: true, message: 'AdGuard Home session expired. Log in and try again.' };
    }
    if (!status.ok || !status.data || !Array.isArray(status.data.user_rules)) {
        return { ok: false, message: 'Could not read AdGuard Home filtering rules.' };
    }

    let target = host;
    if (action === 'unblock') {
        const requested = normalizeHost(msg.target);
        if (requested && (host === requested || host.endsWith('.' + requested))) {
            target = requested;
        } else {
            const info = await findBlockInfo(host);
            target = info.target || host;
        }
    }

    const rules = status.data.user_rules.slice();
    const escaped = escapeClient(client);
    const blockRule = msg.clientOnly ? `||${target}^$client='${escaped}'` : `||${target}^$important`;
    const allowRule = msg.clientOnly ? `@@||${target}^$client='${escaped}'` : `@@||${target}^$important`;
    const hostBlockRule = msg.clientOnly ? `||${host}^$client='${escaped}'` : `||${host}^$important`;
    const hostAllowRule = msg.clientOnly ? `@@||${host}^$client='${escaped}'` : `@@||${host}^$important`;

    let removeRules;
    if (action === 'block') {
        removeRules = [hostAllowRule];
    } else {
        removeRules = [blockRule, hostBlockRule];
    }
    const next = rules.filter((r) => !removeRules.includes(r));
    if (!next.includes(addRule)) next.push(addRule);

    if (JSON.stringify(next) !== JSON.stringify(rules)) {
        const post = await aghApi('/control/filtering/set_rules', { method: 'POST', body: { rules: next } });
        if (post.session_expired) {
            return { ok: false, session_expired: true, message: 'AdGuard Home session expired. Log in and try again.' };
        }
        if (!post.ok) {
            return { ok: false, message: 'AdGuard Home rejected the rule update.' };
        }
    }

    const checkPath = '/control/filtering/check_host?name=' + encodeURIComponent(host) +
        (msg.clientOnly ? '&client=' + encodeURIComponent(client) : '');

    for (let i = 0; i < 20; i++) {
        const r = await aghApi(checkPath);
        if (r.ok && r.data) {
            const filtered = /^Filtered/.test(r.data.reason || '');
            if ((action === 'block' && filtered) || (action === 'unblock' && !filtered)) {
                return {
                    ok: true,
                    blocked: action === 'block',
                    client,
                    target,
                    message: action === 'block' ? 'Blocked.' : 'Unblocked.',
                };
            }
        }
        await sleep(1500);
    }
    return {
        ok: false,
        pending: true,
        client,
        target,
        message: 'AdGuard is still rebuilding its filters. Wait a few seconds and try again.',
    };
}

async function handleUnblock(msg) {
    return handleToggle(Object.assign({}, msg, { action: 'unblock' }));
}

async function handleGetSite(msg) {
    const host = normalizeHost(msg.host);
    if (!host) return { ok: false, message: 'Invalid hostname.' };
    const cfg = await getConfig();
    const check = await aghApi('/control/filtering/check_host?name=' + encodeURIComponent(host));
    if (check.session_expired) {
        return { ok: false, session_expired: true, message: 'AdGuard Home session expired. Log in and try again.' };
    }
    const info = await findBlockInfo(host);
    return {
        ok: true,
        blocked: !!info.blocked,
        reason: info.reason || '',
        rule: info.rule || '',
        client: info.client || cfg.clientName || '',
        target: info.target || host,
    };
}

async function handleGetProtection() {
    const r = await aghApi('/control/status');
    if (r.session_expired) {
        return { ok: false, session_expired: true, message: 'AdGuard Home session expired. Log in and try again.' };
    }
    if (!r.ok || !r.data) return { ok: false, message: 'Could not read AdGuard Home status.' };
    return {
        ok: true,
        enabled: r.data.protection_enabled !== false,
        remaining_ms: Number(r.data.protection_disabled_duration) || 0,
        version: r.data.version || '',
        running: r.data.running !== false,
    };
}

async function handleSetProtection(msg) {
    const body = { enabled: !!msg.enabled };
    if (!msg.enabled) {
        const duration = Number(msg.duration);
        if (duration > 0) body.duration = duration;
    }
    const r = await aghApi('/control/protection', { method: 'POST', body });
    if (r.session_expired) {
        return { ok: false, session_expired: true, message: 'AdGuard Home session expired. Log in and try again.' };
    }
    if (!r.ok) return { ok: false, message: 'AdGuard Home rejected the protection change.' };
    return { ok: true };
}

async function handleGetStats() {
    const r = await aghApi('/control/stats');
    if (r.session_expired) {
        return { ok: false, session_expired: true, message: 'AdGuard Home session expired. Log in and try again.' };
    }
    if (!r.ok || !r.data) return { ok: false, message: 'Could not read AdGuard Home stats.' };
    return {
        ok: true,
        queries: Number(r.data.num_dns_queries) || 0,
        blocked: Number(r.data.num_blocked_filtering) || 0,
        avg_ms: Math.round((Number(r.data.avg_processing_time) || 0) * 1000),
    };
}

/* -------------------------------------------------------------------------
 * Automatic block page
 */

const lastHandled = new Map();

async function handleNavigationError(details) {
    if (details.frameId !== 0 || !details.url) return;
    if (!/^https?:/i.test(details.url)) return;
    if (details.error === 'NS_ERROR_ABORT') return;

    const cfg = await getConfig();
    if (!cfg.autoBlockPage) return;

    const host = hostFromUrl(details.url);
    if (!host) return;
    console.debug('[AGQuery] navigation error', details.error, details.url);
    if (originOf(details.url) === originOf(cfg.aghUrl)) return;

    const key = details.tabId + ':' + host;
    const now = Date.now();
    if (lastHandled.has(key) && now - lastHandled.get(key) < 5000) return;
    lastHandled.set(key, now);

    const info = await findBlockInfo(host);
    console.debug('[AGQuery] block check', host, info.blocked, info.reason, info.client);
    if (!info.blocked) return;

    const params = new URLSearchParams({
        url: details.url,
        host,
        target: info.target || host,
        client: info.client || '',
        reason: info.reason || '',
        rule: info.rule || '',
    });
    const page = browser.runtime.getURL(BLOCKED_PAGE) + '?' + params.toString();
    try {
        await browser.tabs.update(details.tabId, { url: page });
    } catch (_) {
        /* tab closed */
    }
}

browser.webNavigation.onErrorOccurred.addListener((details) => {
    void handleNavigationError(details);
});

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return undefined;

    if (msg.type === 'get-config') {
        getConfig().then((cfg) => sendResponse({
            aghUrl: cfg.aghUrl,
            clientName: cfg.clientName,
            autoBlockPage: cfg.autoBlockPage,
        })).catch(() => sendResponse({ aghUrl: DEFAULT_AGH, clientName: '', autoBlockPage: true }));
        return true;
    }

    if (msg.type === 'unblock') {
        handleUnblock(msg).then(sendResponse).catch((e) => sendResponse({
            ok: false,
            message: 'Unblock failed: ' + (e && e.message ? e.message : String(e)),
        }));
        return true;
    }

    if (msg.type === 'toggle-site') {
        handleToggle(msg).then(sendResponse).catch((e) => sendResponse({
            ok: false,
            message: 'Rule update failed: ' + (e && e.message ? e.message : String(e)),
        }));
        return true;
    }

    if (msg.type === 'get-site') {
        handleGetSite(msg).then(sendResponse).catch((e) => sendResponse({
            ok: false,
            message: 'Could not check the site: ' + (e && e.message ? e.message : String(e)),
        }));
        return true;
    }

    if (msg.type === 'get-protection') {
        handleGetProtection().then(sendResponse).catch((e) => sendResponse({
            ok: false,
            message: 'Could not read protection: ' + (e && e.message ? e.message : String(e)),
        }));
        return true;
    }

    if (msg.type === 'set-protection') {
        handleSetProtection(msg).then(sendResponse).catch((e) => sendResponse({
            ok: false,
            message: 'Could not change protection: ' + (e && e.message ? e.message : String(e)),
        }));
        return true;
    }

    if (msg.type === 'get-stats') {
        handleGetStats().then(sendResponse).catch((e) => sendResponse({
            ok: false,
            message: 'Could not read stats: ' + (e && e.message ? e.message : String(e)),
        }));
        return true;
    }

    if (msg.type === 'test-connection') {
        aghApi('/control/status').then((r) => sendResponse({
            ok: !!r.ok,
            session_expired: !!r.session_expired,
            status: r.status || 0,
            error: r.error || '',
        })).catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;
    }

    return undefined;
});
