'use strict';

(() => {
    const $ = (id) => document.getElementById(id);
    const api = (typeof browser !== 'undefined' && browser.runtime && typeof browser.runtime.sendMessage === 'function')
        ? browser
        : null;

    const form = $('settingsForm');
    const aghUrl = $('aghUrl');
    const clientName = $('clientName');
    const autoBlockPage = $('autoBlockPage');
    const adminLink = $('adminLink');
    const status = $('status');
    const testBtn = $('testBtn');

    const DEFAULT_AGH = 'http://192.168.1.1:8088';

    function setStatus(text, state) {
        status.textContent = text;
        if (state) status.dataset.state = state;
        else delete status.dataset.state;
    }

    function normalizeAghUrl(value) {
        let v = String(value || '').trim();
        if (!v) return '';
        if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
        try {
            const u = new URL(v);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
            return u.origin + u.pathname.replace(/\/+$/, '');
        } catch (_) {
            return '';
        }
    }

    function updateAdminLink() {
        const value = normalizeAghUrl(aghUrl.value) || DEFAULT_AGH;
        adminLink.href = value;
    }

    async function load() {
        if (!api) {
            setStatus('Extension storage is unavailable on this page.', 'error');
            return;
        }
        const cfg = await api.storage.local.get({
            aghUrl: DEFAULT_AGH,
            clientName: '',
            autoBlockPage: true,
        });
        aghUrl.value = cfg.aghUrl || DEFAULT_AGH;
        clientName.value = cfg.clientName || '';
        autoBlockPage.checked = cfg.autoBlockPage !== false;
        updateAdminLink();
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!api) {
            setStatus('Extension storage is unavailable on this page.', 'error');
            return;
        }
        const url = normalizeAghUrl(aghUrl.value);
        if (!url) {
            setStatus('Enter a valid AdGuard Home URL, e.g. http://192.168.1.1:8088.', 'error');
            aghUrl.focus();
            return;
        }
        await api.storage.local.set({
            aghUrl: url,
            clientName: clientName.value.trim(),
            autoBlockPage: autoBlockPage.checked,
        });
        aghUrl.value = url;
        updateAdminLink();
        setStatus('Saved.', 'success');
    });

    testBtn.addEventListener('click', async () => {
        if (!api) {
            setStatus('Extension API is unavailable on this page.', 'error');
            return;
        }
        const url = normalizeAghUrl(aghUrl.value);
        if (!url) {
            setStatus('Save a valid AdGuard Home URL first.', 'error');
            return;
        }
        testBtn.disabled = true;
        setStatus('Testing AdGuard Home session…');
        try {
            /* Persist the URL currently shown so the background tests the
               same endpoint the user is looking at. */
            await api.storage.local.set({
                aghUrl: url,
                clientName: clientName.value.trim(),
                autoBlockPage: autoBlockPage.checked,
            });
            aghUrl.value = url;
            updateAdminLink();
            const res = await api.runtime.sendMessage({ type: 'test-connection' });
            if (res && res.session_expired) {
                setStatus('AdGuard Home session expired. Open AGH, log in, then test again.', 'error');
            } else if (res && res.ok) {
                setStatus('Connected to AdGuard Home with the current session.', 'success');
            } else {
                setStatus('Could not reach the AdGuard Home API' + (res && res.error ? ': ' + res.error : '.'), 'error');
            }
        } catch (err) {
            setStatus('Test failed: ' + (err && err.message ? err.message : String(err)), 'error');
        } finally {
            testBtn.disabled = false;
        }
    });

    aghUrl.addEventListener('input', updateAdminLink);
    load().catch((e) => setStatus('Could not load settings: ' + (e && e.message ? e.message : String(e)), 'error'));
})();
