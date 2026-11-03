'use strict';

(() => {
    const $ = (id) => document.getElementById(id);
    const api = (typeof browser !== 'undefined' && browser.runtime && typeof browser.runtime.sendMessage === 'function')
        ? browser
        : null;

    const DEFAULT_AGH = 'https://adguard.home.tmiland.com';
    const state = {
        tabId: null,
        url: '',
        host: '',
        blocked: false,
        client: '',
        target: '',
        aghUrl: DEFAULT_AGH,
        isAgh: false,
        busy: false,
    };

    const siteState = $('siteState');
    const hostEl = $('host');
    const detailsEl = $('details');
    const toggleBtn = $('toggleBtn');
    const toggleClientBtn = $('toggleClientBtn');
    const siteStatus = $('siteStatus');
    const protectionState = $('protectionState');
    const pauseSelect = $('pauseSelect');
    const pauseBtn = $('pauseBtn');
    const resumeBtn = $('resumeBtn');
    const protectionStatus = $('protectionStatus');
    const autoBadge = $('autoBadge');

    function setStatus(el, text, kind) {
        el.textContent = text;
        if (kind) el.dataset.state = kind;
        else delete el.dataset.state;
    }

    function sessionLink(statusEl) {
        setStatus(statusEl, 'AdGuard Home session expired. ', 'error');
        const a = document.createElement('a');
        a.href = state.aghUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'Open AdGuard Home and log in';
        statusEl.appendChild(a);
    }

    function hostOf(value) {
        try {
            const u = new URL(value);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
            return u.hostname.toLowerCase().replace(/\.$/, '');
        } catch (_) {
            return '';
        }
    }

    function setSiteBadge(blocked) {
        siteState.textContent = blocked ? 'Blocked' : 'Allowed';
        siteState.className = 'badge ' + (blocked ? 'badge-blocked' : 'badge-allowed');
    }

    function setSiteButtons(blocked) {
        toggleBtn.textContent = blocked ? 'Unblock' : 'Block';
        toggleClientBtn.textContent = blocked ? 'Unblock for this client only' : 'Block for this client only';
        toggleBtn.disabled = state.busy || !state.host || state.isAgh;
        toggleClientBtn.disabled = state.busy || !state.host || state.isAgh;
    }

    function updateSite(info) {
        state.blocked = !!info.blocked;
        state.client = info.client || state.client || '';
        state.target = info.target || state.host;
        setSiteBadge(state.blocked);
        setSiteButtons(state.blocked);
        const rows = [];
        if (info.reason) rows.push(info.reason);
        if (info.rule) rows.push(info.rule);
        if (state.target && state.target !== state.host) rows.push('unblocks ' + state.target + ' and subdomains');
        if (state.client) rows.push('client ' + state.client);
        detailsEl.textContent = rows.join(' · ');
    }

    async function loadSite() {
        if (!state.host || state.isAgh) return;
        setStatus(siteStatus, 'Checking AdGuard Home…');
        try {
            const res = await api.runtime.sendMessage({
                type: 'get-site',
                host: state.host,
                client: state.client,
            });
            if (!res || res.session_expired) {
                siteState.textContent = 'Unknown';
                siteState.className = 'badge badge-neutral';
                sessionLink(siteStatus);
                return;
            }
            if (!res.ok) {
                setStatus(siteStatus, res.message || 'Could not check the site.', 'error');
                return;
            }
            updateSite(res);
            setStatus(siteStatus, '');
        } catch (e) {
            setStatus(siteStatus, 'Could not check the site: ' + (e && e.message ? e.message : String(e)), 'error');
        }
    }

    async function toggleSite(clientOnly) {
        if (state.busy || !state.host || state.isAgh || !api) return;
        state.busy = true;
        setSiteButtons(state.blocked);
        const action = state.blocked ? 'unblock' : 'block';
        setStatus(siteStatus, action === 'block' ? 'Blocking…' : 'Unblocking…');
        try {
            const res = await api.runtime.sendMessage({
                type: 'toggle-site',
                host: state.host,
                action,
                clientOnly: !!clientOnly,
                client: state.client,
                target: state.target || state.host,
            });
            if (!res || res.session_expired) {
                sessionLink(siteStatus);
                state.busy = false;
                setSiteButtons(state.blocked);
                return;
            }
            if (res.ok) {
                state.blocked = !!res.blocked;
                setSiteBadge(state.blocked);
                setStatus(siteStatus, res.message || (state.blocked ? 'Blocked.' : 'Unblocked.'), 'success');
                setSiteButtons(state.blocked);
                if (state.tabId) {
                    window.setTimeout(() => {
                        api.tabs.reload(state.tabId).catch(() => {});
                        window.setTimeout(() => window.close(), 500);
                    }, 350);
                }
                return;
            }
            setStatus(siteStatus, res.message || 'The rule update failed.', 'error');
        } catch (e) {
            setStatus(siteStatus, 'Rule update failed: ' + (e && e.message ? e.message : String(e)), 'error');
        } finally {
            state.busy = false;
            setSiteButtons(state.blocked);
        }
    }

    function formatDuration(ms) {
        const s = Math.max(0, Math.round(ms / 1000));
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        const r = s % 60;
        return r ? `${m}m ${r}s` : `${m}m`;
    }

    function setProtection(enabled, remainingMs) {
        if (enabled) {
            protectionState.textContent = 'On';
            protectionState.className = 'badge badge-allowed';
            pauseBtn.hidden = false;
            resumeBtn.hidden = true;
            setStatus(protectionStatus, '');
        } else {
            protectionState.textContent = 'Paused';
            protectionState.className = 'badge badge-blocked';
            pauseBtn.hidden = true;
            resumeBtn.hidden = false;
            setStatus(protectionStatus, remainingMs > 0 ? `Paused for ${formatDuration(remainingMs)}` : 'Paused');
        }
    }

    async function loadProtection() {
        if (!api) return;
        try {
            const res = await api.runtime.sendMessage({ type: 'get-protection' });
            if (!res || res.session_expired) {
                protectionState.textContent = 'Unknown';
                protectionState.className = 'badge badge-neutral';
                sessionLink(protectionStatus);
                return;
            }
            if (!res.ok) {
                setStatus(protectionStatus, res.message || 'Could not read protection.', 'error');
                return;
            }
            setProtection(!!res.enabled, Number(res.remaining_ms) || 0);
            if (res.version) $('version').textContent = res.version;
            pauseBtn.disabled = false;
        } catch (e) {
            setStatus(protectionStatus, 'Could not read protection.', 'error');
        }
    }

    async function setProtectionState(enabled, duration) {
        if (!api) return;
        pauseBtn.disabled = true;
        resumeBtn.disabled = true;
        setStatus(protectionStatus, enabled ? 'Resuming…' : 'Pausing…');
        try {
            const res = await api.runtime.sendMessage({
                type: 'set-protection',
                enabled,
                duration: enabled ? 0 : duration,
            });
            if (!res || res.session_expired) {
                sessionLink(protectionStatus);
            } else if (!res.ok) {
                setStatus(protectionStatus, res.message || 'Protection change failed.', 'error');
            }
            await loadProtection();
        } catch (e) {
            setStatus(protectionStatus, 'Protection change failed.', 'error');
            pauseBtn.disabled = false;
            resumeBtn.disabled = false;
        }
    }

    function formatNumber(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '—';
        try {
            return n.toLocaleString();
        } catch (_) {
            return String(n);
        }
    }

    async function loadStats() {
        if (!api) return;
        try {
            const res = await api.runtime.sendMessage({ type: 'get-stats' });
            if (res && res.ok) {
                $('queries').textContent = formatNumber(res.queries);
                $('blocked').textContent = formatNumber(res.blocked);
            } else if (res && res.session_expired) {
                $('queries').textContent = '—';
                $('blocked').textContent = '—';
            }
        } catch (_) {
            /* leave dashes */
        }
    }

    function setLinks(aghUrl, autoBlockPage) {
        state.aghUrl = aghUrl || DEFAULT_AGH;
        $('querylogLink').href = state.aghUrl + '/#querylog';
        $('aghLink').href = state.aghUrl + '/';
        autoBadge.textContent = autoBlockPage ? 'auto block page' : 'auto off';
        autoBadge.className = 'badge ' + (autoBlockPage ? 'badge-allowed' : 'badge-neutral');
    }

    async function init() {
        if (!api) {
            setStatus(siteStatus, 'Extension API is unavailable on this page.', 'error');
            hostEl.textContent = 'No site';
            siteState.textContent = 'Unavailable';
            siteState.className = 'badge badge-neutral';
            return;
        }

        const params = new URLSearchParams(location.search);
        const debugHost = (params.get('host') || '').toLowerCase().replace(/\.$/, '');
        let cfg = { aghUrl: DEFAULT_AGH, clientName: '', autoBlockPage: true };
        try {
            cfg = await api.runtime.sendMessage({ type: 'get-config' }) || cfg;
        } catch (_) {}
        setLinks(cfg.aghUrl, cfg.autoBlockPage);
        state.client = cfg.clientName || '';

        let tab = null;
        try {
            [tab] = await api.tabs.query({ active: true, currentWindow: true });
        } catch (_) {}
        state.tabId = tab && tab.id ? tab.id : null;
        state.url = debugHost ? `https://${debugHost}/` : ((tab && tab.url) || '');
        state.host = debugHost || hostOf(state.url) || '';
        state.target = state.host;

        const aghHost = hostOf(state.aghUrl);
        state.isAgh = !!state.host && state.host === aghHost;

        if (!state.host) {
            hostEl.textContent = 'No site';
            siteState.textContent = '—';
            siteState.className = 'badge badge-neutral';
            detailsEl.textContent = 'Open a website tab to check or block it.';
        } else if (state.isAgh) {
            hostEl.textContent = 'AdGuard Home UI';
            siteState.textContent = 'Assistant';
            siteState.className = 'badge badge-neutral';
            detailsEl.textContent = 'This is the AdGuard Home web interface.';
        } else {
            hostEl.textContent = state.host;
            await loadSite();
        }

        await Promise.all([loadProtection(), loadStats()]);
    }

    toggleBtn.addEventListener('click', () => { void toggleSite(false); });
    toggleClientBtn.addEventListener('click', () => { void toggleSite(true); });
    pauseBtn.addEventListener('click', () => { void setProtectionState(false, Number(pauseSelect.value) || 30000); });
    resumeBtn.addEventListener('click', () => { void setProtectionState(true, 0); });

    init().catch((e) => {
        setStatus(siteStatus, 'Assistant failed to load: ' + (e && e.message ? e.message : String(e)), 'error');
    });
})();
