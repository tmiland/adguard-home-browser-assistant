'use strict';

(() => {
    const $ = (id) => document.getElementById(id);
    const api = (typeof browser !== 'undefined' && browser.runtime && typeof browser.runtime.sendMessage === 'function')
        ? browser
        : null;

    const state = {
        tabId: null,
        url: '',
        host: '',
        blocked: false,
        client: '',
        target: '',
        aghUrl: '',
        isAgh: false,
        busy: false,
        cosmeticEnabled: true,
        cosmeticCount: 0,
        pending: [],
        pendingTimer: null,
        undo: null,
        undoTimer: null,
    };

    const siteState = $('siteState');
    const hostEl = $('host');
    const detailsEl = $('details');
    const toggleBtn = $('toggleBtn');
    const toggleClientBtn = $('toggleClientBtn');
    const siteStatus = $('siteStatus');
    const undoRow = $('undoRow');
    const undoBtn = $('undoBtn');
    const undoHint = $('undoHint');
    const protectionState = $('protectionState');
    const pauseSelect = $('pauseSelect');
    const pauseBtn = $('pauseBtn');
    const resumeBtn = $('resumeBtn');
    const protectionStatus = $('protectionStatus');
    const autoBadge = $('autoBadge');
    const cosmeticState = $('cosmeticState');
    const cosmeticHint = $('cosmeticHint');
    const pickBtn = $('pickBtn');
    const cosmeticSettingsBtn = $('cosmeticSettingsBtn');
    const cosmeticStatus = $('cosmeticStatus');
    const pendingSection = $('pendingSection');
    const pendingList = $('pendingList');
    const pendingCount = $('pendingCount');
    const pendingStatus = $('pendingStatus');

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

    function hideUndo() {
        if (state.undoTimer) {
            window.clearTimeout(state.undoTimer);
            state.undoTimer = null;
        }
        state.undo = null;
        undoRow.hidden = true;
        undoBtn.disabled = false;
        undoHint.textContent = 'Rule changed';
    }

    function showUndo(undo) {
        hideUndo();
        const expiresAt = Number(undo && undo.expiresAt) || 0;
        const remaining = expiresAt - Date.now();
        if (!undo || !undo.id || remaining <= 0) return;
        state.undo = undo;
        undoRow.hidden = false;
        undoHint.textContent = 'Rule changed';
        state.undoTimer = window.setTimeout(hideUndo, remaining);
    }

    async function loadSite(keepStatus) {
        if (!state.host || state.isAgh) return;
        if (!keepStatus) setStatus(siteStatus, 'Checking AdGuard Home…');
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
            if (keepStatus !== true) setStatus(siteStatus, '');
        } catch (e) {
            setStatus(siteStatus, 'Could not check the site: ' + (e && e.message ? e.message : String(e)), 'error');
        }
    }

    async function toggleSite(clientOnly) {
        if (state.busy || !state.host || state.isAgh || !api) return;
        hideUndo();
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
                showUndo(res.undo);
                if (state.tabId) {
                    window.setTimeout(() => {
                        api.tabs.reload(state.tabId).catch(() => {});
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

    async function undoLast() {
        if (!api || !state.undo || state.busy) return;
        const undo = state.undo;
        state.busy = true;
        undoBtn.disabled = true;
        setSiteButtons(state.blocked);
        setStatus(siteStatus, 'Restoring previous rules…');
        try {
            const res = await api.runtime.sendMessage({ type: 'undo-toggle', id: undo.id });
            if (!res || res.session_expired) {
                sessionLink(siteStatus);
                return;
            }
            if (!res.ok) {
                setStatus(siteStatus, res.message || 'Undo failed.', 'error');
                if (res.reason) hideUndo();
                return;
            }
            hideUndo();
            setStatus(siteStatus, res.message || 'Previous rules restored.', 'success');
            if (state.tabId) {
                api.tabs.reload(state.tabId).catch(() => {});
                window.setTimeout(() => {
                    if (state.host) void loadSite(true);
                }, 7000);
            }
        } catch (e) {
            setStatus(siteStatus, 'Undo failed: ' + (e && e.message ? e.message : String(e)), 'error');
        } finally {
            state.busy = false;
            undoBtn.disabled = false;
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

    async function loadCosmetic() {
        if (!api || !state.host || state.isAgh) {
            cosmeticState.textContent = '—';
            cosmeticState.className = 'badge badge-neutral';
            cosmeticHint.textContent = state.isAgh
                ? 'Not applied to the AdGuard Home interface.'
                : 'Open a website tab to hide elements.';
            pickBtn.disabled = true;
            return;
        }

        setStatus(cosmeticStatus, 'Reading element-hiding rules…');
        try {
            const res = await api.runtime.sendMessage({ type: 'get-cosmetic', host: state.host });
            if (!res || !res.ok) {
                cosmeticState.textContent = 'Unknown';
                cosmeticState.className = 'badge badge-neutral';
                cosmeticHint.textContent = 'Element-hiding rules are unavailable.';
                pickBtn.disabled = true;
                setStatus(cosmeticStatus, res && res.message ? res.message : '', 'error');
                return;
            }
            state.cosmeticEnabled = res.enabled !== false;
            state.cosmeticCount = Number(res.active) || 0;
            if (!state.cosmeticEnabled) {
                cosmeticState.textContent = 'Off';
                cosmeticState.className = 'badge badge-neutral';
                cosmeticHint.textContent = 'Element hiding is turned off in Settings.';
            } else if (state.cosmeticCount > 0) {
                cosmeticState.textContent = state.cosmeticCount + (state.cosmeticCount === 1 ? ' rule' : ' rules');
                cosmeticState.className = 'badge badge-allowed';
                cosmeticHint.textContent = 'Active CSS rules for this site, from AdGuard Home and local rules.';
            } else {
                cosmeticState.textContent = 'None';
                cosmeticState.className = 'badge badge-neutral';
                cosmeticHint.textContent = 'No element-hiding rules match this site yet.';
            }
            pickBtn.disabled = !state.cosmeticEnabled || !state.tabId;
            if (res.session_expired) {
                setStatus(cosmeticStatus, 'AGH session expired; showing cached and local rules.', 'error');
            } else if (res.stale) {
                setStatus(cosmeticStatus, 'AGH is unreachable; showing cached and local rules.');
            } else {
                setStatus(cosmeticStatus, '');
            }
        } catch (e) {
            cosmeticState.textContent = 'Unknown';
            cosmeticState.className = 'badge badge-neutral';
            pickBtn.disabled = true;
            setStatus(cosmeticStatus, 'Could not read element-hiding rules: ' + (e && e.message ? e.message : String(e)), 'error');
        }
    }

    function renderPending() {
        const now = Date.now();
        const entries = state.pending.filter((entry) => Number(entry.until) > now);
        pendingCount.textContent = String(entries.length);
        if (!entries.length) {
            pendingSection.hidden = true;
            pendingList.textContent = '';
            return;
        }
        pendingSection.hidden = false;
        pendingList.textContent = '';
        for (const entry of entries) {
            const row = document.createElement('div');
            row.className = 'pending-row';

            const host = document.createElement('span');
            host.className = 'pending-host';
            host.textContent = entry.host || entry.target || entry.rule;
            host.title = entry.rule || '';

            const time = document.createElement('span');
            time.className = 'pending-time';
            time.textContent = formatDuration(Math.max(0, Number(entry.until) - now));

            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'pending-cancel';
            cancel.textContent = 'Cancel';
            cancel.addEventListener('click', () => { void cancelPending(entry, cancel); });

            row.append(host, time, cancel);
            pendingList.appendChild(row);
        }
    }

    async function loadPending() {
        if (!api) return;
        try {
            const res = await api.runtime.sendMessage({ type: 'get-pending-unblocks' });
            if (!res || !res.ok) {
                state.pending = [];
                renderPending();
                return;
            }
            state.pending = Array.isArray(res.entries) ? res.entries : [];
            renderPending();
        } catch (_) {
            state.pending = [];
            renderPending();
        }
    }

    function tickPending() {
        if (!state.pending.length) return;
        const now = Date.now();
        if (state.pending.some((entry) => Number(entry.until) <= now)) {
            void loadPending();
            return;
        }
        renderPending();
    }

    async function cancelPending(entry, button) {
        if (!api) return;
        button.disabled = true;
        setStatus(pendingStatus, 'Cancelling…');
        try {
            const res = await api.runtime.sendMessage({
                type: 'cancel-pending-unblock',
                id: entry.id,
            });
            if (!res || res.session_expired) {
                sessionLink(pendingStatus);
                button.disabled = false;
                return;
            }
            if (!res.ok) {
                setStatus(pendingStatus, res.message || 'Could not cancel the temporary unblock.', 'error');
                button.disabled = false;
                return;
            }
            setStatus(pendingStatus, res.message || 'Temporary unblock cancelled.', 'success');
            await loadPending();
        } catch (e) {
            setStatus(pendingStatus, 'Could not cancel: ' + (e && e.message ? e.message : String(e)), 'error');
            button.disabled = false;
        }
    }

    async function pickElement() {
        if (!api || !state.tabId || state.isAgh) return;
        setStatus(cosmeticStatus, 'Starting the element picker…');
        try {
            const res = await api.tabs.sendMessage(state.tabId, { type: 'cosmetic-pick' }, { frameId: 0 });
            if (!res || !res.ok) {
                setStatus(cosmeticStatus, (res && res.message) || 'Reload the page and try again.', 'error');
                return;
            }
            window.close();
        } catch (e) {
            setStatus(cosmeticStatus, 'Could not start the picker. Reload the page and try again.', 'error');
        }
    }

    function openCosmeticSettings() {
        if (api.runtime.openOptionsPage) {
            const opening = api.runtime.openOptionsPage();
            if (opening && typeof opening.catch === 'function') opening.catch(() => {});
        } else {
            window.open('options.html', '_blank');
        }
    }

    function setLinks(aghUrl, autoBlockPage) {
        state.aghUrl = aghUrl || '';
        const configured = !!state.aghUrl;
        const querylogLink = $('querylogLink');
        const aghLink = $('aghLink');
        querylogLink.hidden = !configured;
        aghLink.hidden = !configured;
        querylogLink.href = configured ? state.aghUrl + '/#querylog' : '#';
        aghLink.href = configured ? state.aghUrl + '/' : '#';
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
        let cfg = {
            aghUrl: '',
            clientName: '',
            autoBlockPage: true,
            cosmeticEnabled: true,
            cosmeticSaveToAgh: true,
        };
        try {
            cfg = await api.runtime.sendMessage({ type: 'get-config' }) || cfg;
        } catch (_) {}
        setLinks(cfg.aghUrl, cfg.autoBlockPage);
        state.client = cfg.clientName || '';
        state.cosmeticEnabled = cfg.cosmeticEnabled !== false;

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

        if (!cfg.aghUrl) {
            hostEl.textContent = state.host || 'No site';
            siteState.textContent = 'Setup';
            siteState.className = 'badge badge-neutral';
            detailsEl.textContent = 'Set your AdGuard Home URL in Settings.';
            setStatus(siteStatus, 'Open Settings to connect to AdGuard Home.', 'error');
            toggleBtn.disabled = true;
            toggleClientBtn.disabled = true;
            cosmeticState.textContent = 'Setup';
            cosmeticState.className = 'badge badge-neutral';
            cosmeticHint.textContent = 'Set your AGH URL first.';
            pickBtn.disabled = true;
            protectionState.textContent = 'Setup';
            protectionState.className = 'badge badge-neutral';
            pauseBtn.disabled = true;
            resumeBtn.hidden = true;
            $('version').textContent = '—';
            pendingSection.hidden = true;
            return;
        }

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

        await Promise.all([loadProtection(), loadStats(), loadCosmetic(), loadPending()]);
        if (!state.pendingTimer) {
            state.pendingTimer = window.setInterval(tickPending, 1000);
        }
    }

    toggleBtn.addEventListener('click', () => { void toggleSite(false); });
    toggleClientBtn.addEventListener('click', () => { void toggleSite(true); });
    undoBtn.addEventListener('click', () => { void undoLast(); });
    pickBtn.addEventListener('click', () => { void pickElement(); });
    cosmeticSettingsBtn.addEventListener('click', openCosmeticSettings);
    pauseBtn.addEventListener('click', () => { void setProtectionState(false, Number(pauseSelect.value) || 30000); });
    resumeBtn.addEventListener('click', () => { void setProtectionState(true, 0); });

    init().catch((e) => {
        setStatus(siteStatus, 'Assistant failed to load: ' + (e && e.message ? e.message : String(e)), 'error');
    });
})();
