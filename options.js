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
    const cosmeticEnabled = $('cosmeticEnabled');
    const cosmeticSaveToAgh = $('cosmeticSaveToAgh');
    const cosmeticRules = $('cosmeticRules');
    const aghRulesEl = $('aghRules');
    const aghRulesStatus = $('aghRulesStatus');
    const refreshRulesBtn = $('refreshRulesBtn');
    const rulesFilter = $('rulesFilter');
    const adminLink = $('adminLink');
    const status = $('status');
    const testBtn = $('testBtn');

    let allAghRules = [];


    function parseLocalRules(text) {
        return String(text || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('!'))
            .slice(0, 500);
    }

    function setStatus(text, state) {
        status.textContent = text;
        if (state) status.dataset.state = state;
        else delete status.dataset.state;
    }

    function setRulesStatus(text, state) {
        aghRulesStatus.textContent = text;
        if (state) aghRulesStatus.dataset.state = state;
        else delete aghRulesStatus.dataset.state;
    }

    function displayableRule(rule) {
        const text = String(rule || '').trim();
        return !!text && !text.startsWith('!') && !/^#+$/.test(text);
    }

    function renderAghRules(rules) {
        allAghRules = (Array.isArray(rules) ? rules : []).filter(displayableRule);
        const query = rulesFilter ? rulesFilter.value : '';
        const list = (typeof AGHListUtils !== 'undefined')
            ? AGHListUtils.filterRules(allAghRules, query)
            : allAghRules;
        aghRulesEl.textContent = '';
        if (!list.length) {
            const empty = document.createElement('p');
            empty.className = 'rule-empty';
            empty.textContent = query.trim()
                ? 'No rules match the filter.'
                : 'No cosmetic rules in AdGuard Home user rules.';
            aghRulesEl.appendChild(empty);
            return;
        }
        for (const rule of list) {
            const row = document.createElement('div');
            row.className = 'rule-row';
            const code = document.createElement('code');
            code.textContent = rule;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'rule-remove';
            button.textContent = 'Remove';
            button.addEventListener('click', () => { void removeAghRule(rule, button); });
            row.appendChild(code);
            row.appendChild(button);
            aghRulesEl.appendChild(row);
        }
    }

    async function loadAghRules(force) {
        if (!api) return;
        refreshRulesBtn.disabled = true;
        setRulesStatus('Reading AdGuard Home rules…');
        try {
            const res = await api.runtime.sendMessage({
                type: 'get-cosmetic-rules',
                force: !!force,
            });
            if (!res || !res.ok) {
                setRulesStatus((res && res.message) || 'Could not read AdGuard Home rules.', 'error');
                return;
            }
            if (res.configured === false) {
                renderAghRules([]);
                setRulesStatus('Set the AdGuard Home URL above to load rules.', 'error');
                return;
            }
            const displayRules = (Array.isArray(res.aghRules) ? res.aghRules : []).filter(displayableRule);
            renderAghRules(displayRules);
            const count = displayRules.length;
            if (res.session_expired) {
                setRulesStatus('AdGuard Home session expired; showing cached rules.', 'error');
            } else if (res.stale) {
                setRulesStatus('AdGuard Home is unreachable; showing cached rules.');
            } else {
                setRulesStatus(count + (count === 1 ? ' rule from AdGuard Home.' : ' rules from AdGuard Home.'));
            }
        } catch (e) {
            setRulesStatus('Could not read AdGuard Home rules: ' + (e && e.message ? e.message : String(e)), 'error');
        } finally {
            refreshRulesBtn.disabled = false;
        }
    }

    async function removeAghRule(rule, button) {
        button.disabled = true;
        setRulesStatus('Removing from AdGuard Home…');
        try {
            const res = await api.runtime.sendMessage({
                type: 'remove-cosmetic',
                source: 'agh',
                rule,
            });
            const error = !res || !res.ok
                ? ((res && res.message) || 'Could not remove the rule.')
                : '';
            /* Always re-read the real AGH state; a cache or a partial failure
               must not leave the list showing a rule that is already gone. */
            await loadAghRules(true);
            if (error) {
                setRulesStatus(error, 'error');
                button.disabled = false;
            }
        } catch (e) {
            setRulesStatus('Could not remove the rule: ' + (e && e.message ? e.message : String(e)), 'error');
            button.disabled = false;
        }
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
        const value = normalizeAghUrl(aghUrl.value);
        if (!value) {
            adminLink.href = '#';
            adminLink.hidden = true;
            return;
        }
        adminLink.href = value;
        adminLink.hidden = false;
    }

    async function load() {
        if (!api) {
            setStatus('Extension storage is unavailable on this page.', 'error');
            return;
        }
        const cfg = await api.storage.local.get({
            aghUrl: '',
            clientName: '',
            autoBlockPage: true,
            cosmeticEnabled: true,
            cosmeticSaveToAgh: true,
            cosmeticRules: [],
        });
        aghUrl.value = cfg.aghUrl || '';
        clientName.value = cfg.clientName || '';
        autoBlockPage.checked = cfg.autoBlockPage !== false;
        cosmeticEnabled.checked = cfg.cosmeticEnabled !== false;
        cosmeticSaveToAgh.checked = cfg.cosmeticSaveToAgh !== false;
        cosmeticRules.value = (Array.isArray(cfg.cosmeticRules) ? cfg.cosmeticRules : []).join('\n');
        updateAdminLink();
        await loadAghRules(false);
    }

    if (rulesFilter) {
        rulesFilter.addEventListener('input', () => renderAghRules(allAghRules));
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!api) {
            setStatus('Extension storage is unavailable on this page.', 'error');
            return;
        }
        const url = normalizeAghUrl(aghUrl.value);
        if (!url) {
            setStatus('Enter a valid AdGuard Home URL, e.g. https://adguard.example.com.', 'error');
            aghUrl.focus();
            return;
        }
        await api.storage.local.set({
            aghUrl: url,
            clientName: clientName.value.trim(),
            autoBlockPage: autoBlockPage.checked,
            cosmeticEnabled: cosmeticEnabled.checked,
            cosmeticSaveToAgh: cosmeticSaveToAgh.checked,
            cosmeticRules: parseLocalRules(cosmeticRules.value),
        });
        aghUrl.value = url;
        updateAdminLink();
        setStatus('Saved.', 'success');
        await api.runtime.sendMessage({ type: 'refresh-agh-content' }).catch(() => {});
        void loadAghRules(true);
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
                cosmeticEnabled: cosmeticEnabled.checked,
                cosmeticSaveToAgh: cosmeticSaveToAgh.checked,
                cosmeticRules: parseLocalRules(cosmeticRules.value),
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
    refreshRulesBtn.addEventListener('click', () => { void loadAghRules(true); });
    load().catch((e) => setStatus('Could not load settings: ' + (e && e.message ? e.message : String(e)), 'error'));
})();
