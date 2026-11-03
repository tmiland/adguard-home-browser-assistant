'use strict';

(() => {
    const $ = (id) => document.getElementById(id);
    const params = new URLSearchParams(location.search);

    const host = (params.get('host') || '').toLowerCase().replace(/\.$/, '');
    let client = (params.get('client') || '').trim();
    const ruleTarget = (params.get('target') || '').trim().toLowerCase().replace(/\.$/, '');
    const reason = (params.get('reason') || '').trim();
    const rule = (params.get('rule') || '').trim();

    function httpUrl(value) {
        try {
            const u = new URL(value);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
            return u.href;
        } catch (_) {
            return null;
        }
    }

    const original = httpUrl(params.get('url')) || (host ? `https://${host}/` : '');
    const api = (typeof browser !== 'undefined' && browser.runtime && typeof browser.runtime.sendMessage === 'function')
        ? browser
        : null;

    const site = $('site');
    const clientEl = $('client');
    const noteClient = $('noteClient');
    const noteDomain = $('noteDomain');
    const status = $('status');
    const adminLink = $('adminLink');
    const btnAll = $('unblockAll');
    const btnClient = $('unblockClient');
    const btnTemp = $('unblockTemp');
    const tempDuration = $('tempDuration');
    const btnBack = $('goBack');

    function setStatus(text, state) {
        status.textContent = text;
        if (state) status.dataset.state = state;
        else delete status.dataset.state;
    }

    function setBusy(busy) {
        btnAll.disabled = busy;
        btnClient.disabled = busy;
        btnTemp.disabled = busy;
        tempDuration.disabled = busy;
        btnBack.disabled = false;
    }

    function updateClient() {
        const label = client || 'unknown — set it in options';
        clientEl.textContent = label;
        noteClient.textContent = client || 'this client';
        if (noteDomain) noteDomain.textContent = (ruleTarget || host) + ' and its subdomains';
    }

    function setSessionExpired() {
        setStatus('AdGuard Home session expired. ', 'error');
        const a = document.createElement('a');
        a.href = adminLink.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'Open AdGuard Home and log in';
        status.appendChild(a);
        status.appendChild(document.createTextNode(', then try again.'));
    }

    async function unblock(clientOnly, temporary) {
        if (!api) {
            setStatus('The extension API is unavailable on this page.', 'error');
            return;
        }
        if (!host || !original) {
            setStatus('This block page is missing the blocked URL.', 'error');
            return;
        }

        setBusy(true);
        setStatus(clientOnly
            ? `Adding an allowlist rule for ${client || 'this client'}…`
            : (temporary ? 'Adding a temporary allowlist rule…' : 'Adding an allowlist rule…'));

        try {
            const res = await api.runtime.sendMessage({
                type: 'unblock',
                host,
                url: original,
                clientOnly: !!clientOnly,
                temporary: !!temporary,
                duration: temporary ? Number(tempDuration.value) || 60000 : 0,
                client,
                target: ruleTarget || host,
            });

            if (!res || res.session_expired) {
                setSessionExpired();
                setBusy(false);
                return;
            }
            if (res.ok) {
                setStatus((res.message || (temporary ? 'Temporarily unblocked.' : 'Unblocked.')) + ' Redirecting…', 'success');
                window.setTimeout(() => location.replace(original), 4000);
                return;
            }
            if (res.pending) {
                setStatus(res.message || 'AdGuard is still rebuilding; wait a few seconds and try again.', '');
                setBusy(false);
                return;
            }
            setStatus(res.message || 'Unblock failed.', 'error');
            setBusy(false);
        } catch (e) {
            setStatus('Unblock failed: ' + (e && e.message ? e.message : String(e)), 'error');
            setBusy(false);
        }
    }

    if (!host || !original) {
        site.textContent = 'Invalid block page';
        setStatus('This block page link is incomplete.', 'error');
        setBusy(true);
        btnAll.disabled = true;
        btnClient.disabled = true;
        btnTemp.disabled = true;
        tempDuration.disabled = true;
        return;
    }

    document.title = `Blocked — ${host}`;
    site.textContent = original;
    updateClient();

    const reasonRow = $('reasonRow');
    const ruleRow = $('ruleRow');
    if (reason) {
        $('reason').textContent = reason;
        reasonRow.hidden = false;
    }
    if (rule) {
        $('rule').textContent = rule;
        ruleRow.hidden = false;
    }

    $('datetime').textContent = new Date().toLocaleString();

    if (api) {
        api.runtime.sendMessage({ type: 'get-config' }).then((cfg) => {
            if (cfg && cfg.aghUrl) adminLink.href = cfg.aghUrl;
            if (!client && cfg && cfg.clientName) {
                client = cfg.clientName;
                updateClient();
            }
        }).catch(() => {});
    }

    btnAll.addEventListener('click', () => { void unblock(false, false); });
    btnClient.addEventListener('click', () => { void unblock(true, false); });
    btnTemp.addEventListener('click', () => { void unblock(false, true); });
    btnBack.addEventListener('click', () => {
        if (history.length > 1) history.back();
        else window.close();
    });
})();
