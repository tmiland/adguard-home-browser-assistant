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
        cosmeticEnabled: true,
        cosmeticSaveToAgh: true,
    });
    cfg.aghUrl = String(cfg.aghUrl || DEFAULT_AGH).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(cfg.aghUrl)) cfg.aghUrl = DEFAULT_AGH;
    cfg.clientName = String(cfg.clientName || '').trim();
    cfg.autoBlockPage = cfg.autoBlockPage !== false;
    cfg.cosmeticEnabled = cfg.cosmeticEnabled !== false;
    cfg.cosmeticSaveToAgh = cfg.cosmeticSaveToAgh !== false;
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

const TEMP_RETRY_MS = 5 * 60 * 1000;
const tempUnblockTimers = new Map();

async function getPendingUnblocks() {
    const stored = await browser.storage.local.get({ pendingUnblocks: [] });
    return Array.isArray(stored.pendingUnblocks)
        ? stored.pendingUnblocks.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.rule === 'string')
        : [];
}

async function savePendingUnblocks(list) {
    await browser.storage.local.set({ pendingUnblocks: list });
}

async function cancelPendingForRule(rule) {
    const list = await getPendingUnblocks();
    const matching = list.filter((entry) => entry.rule === rule);
    if (!matching.length) return;
    for (const entry of matching) {
        const timer = tempUnblockTimers.get(entry.id);
        if (timer) clearTimeout(timer);
        tempUnblockTimers.delete(entry.id);
    }
    await savePendingUnblocks(list.filter((entry) => entry.rule !== rule));
}

async function removeAllowRule(rule) {
    const status = await aghApi('/control/filtering/status');
    if (status.session_expired) return { ok: false, session_expired: true };
    if (!status.ok || !status.data || !Array.isArray(status.data.user_rules)) {
        return { ok: false };
    }
    if (!status.data.user_rules.includes(rule)) return { ok: true };
    const next = status.data.user_rules.filter((line) => line !== rule);
    const post = await aghApi('/control/filtering/set_rules', {
        method: 'POST',
        body: { rules: next },
    });
    if (post.session_expired) return { ok: false, session_expired: true };
    return { ok: !!post.ok };
}

function schedulePendingUnblock(entry) {
    const existing = tempUnblockTimers.get(entry.id);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, Number(entry.until) - Date.now());
    const timer = setTimeout(() => {
        tempUnblockTimers.delete(entry.id);
        void expirePendingUnblock(entry.id);
    }, Math.min(delay, 2147483647));
    tempUnblockTimers.set(entry.id, timer);
}

async function expirePendingUnblock(id) {
    const list = await getPendingUnblocks();
    const entry = list.find((item) => item.id === id);
    if (!entry) return;
    const result = await removeAllowRule(entry.rule);
    if (!result.ok) {
        /* Keep the rule and try again; a temporary unblock must not become a
           permanent one just because the AGH session was unavailable. */
        entry.until = Date.now() + TEMP_RETRY_MS;
        entry.attempts = (Number(entry.attempts) || 0) + 1;
        await savePendingUnblocks(list);
        schedulePendingUnblock(entry);
        return;
    }
    await savePendingUnblocks(list.filter((item) => item.id !== id));
}

async function addPendingUnblock(entry) {
    await cancelPendingForRule(entry.rule);
    const list = await getPendingUnblocks();
    list.push(entry);
    await savePendingUnblocks(list);
    schedulePendingUnblock(entry);
}

async function restorePendingUnblocks() {
    const list = await getPendingUnblocks();
    for (const entry of list) schedulePendingUnblock(entry);
}

function durationLabel(ms) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    if (seconds < 60) return seconds + ' seconds';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + (minutes === 1 ? ' minute' : ' minutes');
    const hours = Math.round(minutes / 60);
    return hours + (hours === 1 ? ' hour' : ' hours');
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
    const addRule = action === 'block' ? hostBlockRule : allowRule;
    const ruleAlreadyPresent = rules.includes(addRule);
    const temporary = action === 'unblock' && !!msg.temporary;
    let durationMs = 0;
    if (temporary) {
        durationMs = Number(msg.duration);
        if (!Number.isFinite(durationMs) || durationMs < 1000) durationMs = 60000;
        durationMs = Math.min(durationMs, 24 * 60 * 60 * 1000);
    }

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

    let temporaryUntil = 0;
    if (action === 'block') {
        await cancelPendingForRule(hostAllowRule);
    } else if (temporary) {
        const pending = await getPendingUnblocks();
        const alreadyPending = pending.some((entry) => entry.rule === allowRule);
        if (!ruleAlreadyPresent || alreadyPending) {
            temporaryUntil = Date.now() + durationMs;
            await addPendingUnblock({
                id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
                rule: allowRule,
                host,
                target,
                client,
                until: temporaryUntil,
                createdAt: Date.now(),
            });
        }
    } else {
        await cancelPendingForRule(allowRule);
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
                    temporary: temporary && temporaryUntil > 0,
                    until: temporaryUntil,
                    duration: temporary ? durationMs : 0,
                    message: action === 'block'
                        ? 'Blocked.'
                        : (temporaryUntil > 0 ? 'Unblocked for ' + durationLabel(durationMs) + '.' : 'Unblocked.'),
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
        temporary: temporary && temporaryUntil > 0,
        until: temporaryUntil,
        duration: temporary ? durationMs : 0,
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
 * Cosmetic (element hiding) rules
 *
 * AGH stores cosmetic rules in its user rules, but DNS filtering cannot apply
 * them. The assistant reads them back and injects the matching CSS in Firefox.
 * Picked rules are saved to AGH user rules when possible, otherwise locally.
 */

const COSMETIC_CACHE_TTL = 5 * 60 * 1000;
const COSMETIC_MAX_LOCAL = 500;
let cosmeticCache = null;
let cosmeticCachePromise = null;
let lastCosmeticBridgeAt = 0;

function cosmeticHost(value) {
    const host = String(value || '').trim().toLowerCase().replace(/\.$/, '');
    if (!host || host.length > 253 || /[\s/\\]/.test(host)) return '';
    return host;
}

function hasCosmeticMarker(line) {
    return line.includes('##') ||
        line.includes('#@#') ||
        line.includes('#?#') ||
        line.includes('#$#') ||
        line.includes('#@$#') ||
        line.includes('#%#') ||
        line.includes('#@%#');
}

function cosmeticRulesOnly(rules) {
    return (Array.isArray(rules) ? rules : []).filter((line) => (
        typeof line === 'string' && hasCosmeticMarker(line)
    ));
}

function cosmeticCacheFresh(cache, aghUrl) {
    return !!cache &&
        cache.aghUrl === aghUrl &&
        Array.isArray(cache.rules) &&
        Date.now() - Number(cache.fetchedAt || 0) < COSMETIC_CACHE_TTL;
}

async function rememberCosmeticRules(rules, aghUrl) {
    const cache = {
        aghUrl,
        rules: cosmeticRulesOnly(rules),
        fetchedAt: Date.now(),
    };
    cosmeticCache = cache;
    await browser.storage.local.set({ aghCosmeticCache: cache });
}

async function cosmeticFilteringStatus(cfg) {
    /* Page loads must not open an AGH tab every time. Direct fetch first; use
       the bridge at most once every five minutes if direct is blocked. */
    const direct = await apiDirect(cfg, '/control/filtering/status');
    if (direct.ok || direct.session_expired) return direct;
    if (Date.now() - lastCosmeticBridgeAt < 5 * 60 * 1000) return direct;
    lastCosmeticBridgeAt = Date.now();
    return aghApi('/control/filtering/status');
}

async function fetchAghCosmeticRules(cfg, force) {
    if (!force && cosmeticCacheFresh(cosmeticCache, cfg.aghUrl)) {
        return { rules: cosmeticCache.rules.slice(), stale: false };
    }
    if (!force && cosmeticCachePromise) return cosmeticCachePromise;

    const run = (async () => {
        const stored = await browser.storage.local.get({ aghCosmeticCache: null });
        const cached = stored.aghCosmeticCache;
        const fallback = cached && Array.isArray(cached.rules) && cached.aghUrl === cfg.aghUrl
            ? cached.rules.slice()
            : [];

        const status = await cosmeticFilteringStatus(cfg);
        if (status.ok && status.data && Array.isArray(status.data.user_rules)) {
            const rules = cosmeticRulesOnly(status.data.user_rules);
            await rememberCosmeticRules(status.data.user_rules, cfg.aghUrl);
            return { rules, stale: false };
        }
        return {
            rules: fallback,
            stale: true,
            session_expired: !!status.session_expired,
            error: status.error || '',
        };
    })();

    if (!force) cosmeticCachePromise = run;
    try {
        return await run;
    } finally {
        if (cosmeticCachePromise === run) cosmeticCachePromise = null;
    }
}

async function getCosmeticForHost(host, force) {
    const cfg = await getConfig();
    const stored = await browser.storage.local.get({ cosmeticRules: [] });
    const localRules = Array.isArray(stored.cosmeticRules)
        ? stored.cosmeticRules.filter((line) => typeof line === 'string' && line.trim())
        : [];

    let agh = { rules: [], stale: false, session_expired: false };
    if (cfg.cosmeticEnabled) {
        try {
            agh = await fetchAghCosmeticRules(cfg, !!force);
        } catch (e) {
            agh = { rules: [], stale: true, error: String(e) };
        }
    }

    const all = agh.rules.concat(localRules);
    const built = cfg.cosmeticEnabled
        ? AGHCosmeticRules.buildForHost(all, host)
        : { hide: [], style: [], ignored: 0, total: 0 };

    return {
        ok: true,
        enabled: cfg.cosmeticEnabled,
        saveToAgh: cfg.cosmeticSaveToAgh,
        rules: all,
        active: built.hide.length + built.style.length,
        hide: built.hide.length,
        style: built.style.length,
        ignored: built.ignored,
        aghCount: agh.rules.length,
        localCount: localRules.length,
        stale: !!agh.stale,
        session_expired: !!agh.session_expired,
        error: agh.error || '',
    };
}

async function handleGetCosmetic(msg) {
    const host = cosmeticHost(msg.host);
    if (!host) return { ok: false, message: 'Invalid hostname.' };
    return getCosmeticForHost(host, !!msg.force);
}

function sanitizeCosmeticSelector(value) {
    const selector = String(value || '').trim();
    if (!selector || selector.length > 400 || /[\r\n]/.test(selector)) return '';
    if (selector.includes('{') || selector.includes('}')) return '';
    return selector;
}

async function handleAddCosmetic(msg) {
    const cfg = await getConfig();
    if (!cfg.cosmeticEnabled) {
        return { ok: false, message: 'Element hiding is turned off in Settings.' };
    }
    const host = cosmeticHost(msg.host);
    const selector = sanitizeCosmeticSelector(msg.selector);
    if (!host) return { ok: false, message: 'Invalid hostname.' };
    if (!selector) return { ok: false, message: 'Invalid element selector.' };

    const rule = `${host}##${selector}`;
    let savedTo = 'local';
    let aghError = '';

    if (cfg.cosmeticSaveToAgh && normalizeHost(host)) {
        const status = await aghApi('/control/filtering/status');
        if (status.ok && status.data && Array.isArray(status.data.user_rules)) {
            const rules = status.data.user_rules.slice();
            if (rules.includes(rule)) {
                savedTo = 'agh';
            } else {
                const post = await aghApi('/control/filtering/set_rules', {
                    method: 'POST',
                    body: { rules: rules.concat(rule) },
                });
                if (post.ok) {
                    savedTo = 'agh';
                    await rememberCosmeticRules(rules.concat(rule), cfg.aghUrl);
                } else {
                    aghError = post.session_expired
                        ? 'the AdGuard Home session expired'
                        : 'AdGuard Home rejected the rule';
                }
            }
        } else {
            aghError = status.session_expired
                ? 'the AdGuard Home session expired'
                : 'AdGuard Home is unavailable';
        }
    }

    if (savedTo === 'local') {
        const stored = await browser.storage.local.get({ cosmeticRules: [] });
        const rules = Array.isArray(stored.cosmeticRules)
            ? stored.cosmeticRules.filter((line) => typeof line === 'string' && line.trim())
            : [];
        if (!rules.includes(rule)) rules.push(rule);
        await browser.storage.local.set({ cosmeticRules: rules.slice(-COSMETIC_MAX_LOCAL) });
    }

    const view = await getCosmeticForHost(host, false);
    const message = savedTo === 'agh'
        ? 'Element hidden and saved to AdGuard Home.'
        : 'Element hidden locally' + (aghError ? ` (${aghError})` : '') + '.';

    return {
        ok: true,
        savedTo,
        rule,
        message,
        rules: view.rules,
        active: view.active,
        session_expired: !!aghError && /session/i.test(aghError),
    };
}

/* Injected CSS is applied at user-origin so page CSP cannot block it. */
const cosmeticCssByTab = new Map();

function cosmeticCssKey(tabId, frameId) {
    return `${tabId}:${Number(frameId) || 0}`;
}

async function setTabCosmeticCss(tabId, frameId, css) {
    const key = cosmeticCssKey(tabId, frameId);
    const previous = cosmeticCssByTab.get(key);
    const details = {
        code: css,
        cssOrigin: 'user',
        frameId: Number(frameId) || 0,
    };

    if (previous) {
        try {
            await browser.tabs.removeCSS(tabId, {
                code: previous,
                cssOrigin: 'user',
                frameId: Number(frameId) || 0,
            });
        } catch (_) {
            /* The page may have navigated already. */
        }
    }

    if (css) {
        try {
            await browser.tabs.insertCSS(tabId, details);
        } catch (e) {
            cosmeticCssByTab.delete(key);
            return { ok: false, error: String(e) };
        }
        cosmeticCssByTab.set(key, css);
    } else {
        cosmeticCssByTab.delete(key);
    }
    return { ok: true };
}

async function handleApplyCosmeticCss(msg, sender) {
    if (!sender.tab || typeof sender.tab.id !== 'number') {
        return { ok: false, error: 'No tab for this content script.' };
    }
    const css = typeof msg.css === 'string' ? msg.css : '';
    if (css.length > 200000) return { ok: false, error: 'Cosmetic CSS is too large.' };
    return setTabCosmeticCss(sender.tab.id, sender.frameId, css);
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

browser.webNavigation.onCommitted.addListener((details) => {
    /* User-origin CSS is cleared by the navigation; drop the bookkeeping. */
    cosmeticCssByTab.delete(cosmeticCssKey(details.tabId, details.frameId));
});

browser.tabs.onRemoved.addListener((tabId) => {
    const prefix = tabId + ':';
    for (const key of Array.from(cosmeticCssByTab.keys())) {
        if (key.startsWith(prefix)) cosmeticCssByTab.delete(key);
    }
});

function rebuildCosmeticMenu() {
    if (!browser.contextMenus) return;
    browser.contextMenus.removeAll().then(() => {
        try {
            browser.contextMenus.create({
                id: 'agh-hide-element',
                title: 'Hide element with AdGuard Home Assistant',
                contexts: ['all'],
            });
        } catch (_) {
            /* Duplicate id after a reload; the existing item is fine. */
        }
    }).catch(() => {});
}

browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== 'agh-hide-element' || !tab || typeof tab.id !== 'number') return;
    void (async () => {
        const cfg = await getConfig();
        if (!cfg.cosmeticEnabled) {
            browser.runtime.openOptionsPage();
            return;
        }
        try {
            await browser.tabs.sendMessage(tab.id, { type: 'cosmetic-pick' }, { frameId: 0 });
        } catch (_) {
            /* Restricted page or the content script is not loaded. */
        }
    })();
});

rebuildCosmeticMenu();
void restorePendingUnblocks();

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return undefined;

    if (msg.type === 'get-config') {
        getConfig().then((cfg) => sendResponse({
            aghUrl: cfg.aghUrl,
            clientName: cfg.clientName,
            autoBlockPage: cfg.autoBlockPage,
            cosmeticEnabled: cfg.cosmeticEnabled,
            cosmeticSaveToAgh: cfg.cosmeticSaveToAgh,
        })).catch(() => sendResponse({
            aghUrl: DEFAULT_AGH,
            clientName: '',
            autoBlockPage: true,
            cosmeticEnabled: true,
            cosmeticSaveToAgh: true,
        }));
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

    if (msg.type === 'get-cosmetic') {
        handleGetCosmetic(msg).then(sendResponse).catch((e) => sendResponse({
            ok: false,
            message: 'Could not read element-hiding rules: ' + (e && e.message ? e.message : String(e)),
        }));
        return true;
    }

    if (msg.type === 'add-cosmetic') {
        handleAddCosmetic(msg).then(sendResponse).catch((e) => sendResponse({
            ok: false,
            message: 'Could not save the element-hiding rule: ' + (e && e.message ? e.message : String(e)),
        }));
        return true;
    }

    if (msg.type === 'apply-cosmetic-css') {
        handleApplyCosmeticCss(msg, sender).then(sendResponse).catch((e) => sendResponse({
            ok: false,
            error: String(e),
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
