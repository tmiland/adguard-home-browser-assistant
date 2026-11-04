'use strict';

(() => {
    const $ = (id) => document.getElementById(id);
    const api = (typeof browser !== 'undefined' && browser.runtime && typeof browser.runtime.sendMessage === 'function')
        ? browser
        : null;

    const state = {
        catalog: null,
        catalogInfo: null,
        filters: new Map(),
        selected: new Set(),
        query: '',
        busy: false,
        aghReady: false,
        aghUrl: '',
    };

    const refreshBtn = $('refreshCatalogBtn');
    const catalogMeta = $('catalogMeta');
    const sessionBanner = $('sessionBanner');
    const packsEl = $('packs');
    const packsHint = $('packsHint');
    const listsEl = $('lists');
    const listSearch = $('listSearch');
    const listCount = $('listCount');
    const importBar = $('importBar');
    const selectionCount = $('selectionCount');
    const importSelectedBtn = $('importSelectedBtn');
    const status = $('status');
    const aghLink = $('aghLink');
    const aghDot = $('aghDot');

    function setStatus(text, kind) {
        status.textContent = text || '';
        status.title = '';
        if (kind) status.dataset.state = kind;
        else delete status.dataset.state;
    }

    function formatNumber(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return '—';
        try {
            return number.toLocaleString();
        } catch (_) {
            return String(number);
        }
    }

    function formatDate(value) {
        const time = Date.parse(value || '');
        if (!Number.isFinite(time)) return '';
        try {
            return new Date(time).toLocaleString();
        } catch (_) {
            return '';
        }
    }

    function validLink(value) {
        try {
            const url = new URL(value);
            return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
        } catch (_) {
            return '';
        }
    }

    function showBanner(message, key) {
        sessionBanner.textContent = '';
        const text = document.createElement('span');
        text.textContent = message + ' ';
        sessionBanner.appendChild(text);
        if (key === 'settings') {
            const link = document.createElement('a');
            link.href = 'options.html';
            link.textContent = 'Open Settings';
            sessionBanner.appendChild(link);
        } else if (state.aghUrl) {
            const link = document.createElement('a');
            link.href = state.aghUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = 'Open AdGuard Home and log in';
            sessionBanner.appendChild(link);
        }
        sessionBanner.hidden = false;
    }

    function hideBanner() {
        sessionBanner.hidden = true;
        sessionBanner.textContent = '';
    }

    function setAghLink(url) {
        const href = validLink(url);
        if (!href) {
            aghLink.hidden = true;
            aghDot.hidden = true;
            return;
        }
        state.aghUrl = href;
        aghLink.href = href;
        aghLink.hidden = false;
        aghDot.hidden = false;
    }

    function isSubscribed(list) {
        return !!list && state.filters.has(list.url);
    }

    function renderMeta() {
        if (!state.catalog) {
            catalogMeta.textContent = 'Catalog unavailable.';
            return;
        }
        const checked = formatDate(state.catalog.health_checked_at);
        const loaded = formatDate(state.catalogInfo && state.catalogInfo.fetched_at
            ? new Date(state.catalogInfo.fetched_at).toISOString()
            : '');
        const parts = [
            state.catalog.lists.length + ' lists',
            state.catalog.packs.length + ' packs',
        ];
        if (checked) parts.push('health checked ' + checked);
        if (loaded) parts.push('loaded ' + loaded);
        if (state.catalogInfo && state.catalogInfo.stale) parts.push('cached copy (refresh failed)');
        catalogMeta.textContent = parts.join(' · ');
    }

    function renderPacks() {
        packsEl.textContent = '';
        if (!state.catalog) {
            packsHint.textContent = '';
            const empty = document.createElement('p');
            empty.className = 'rule-empty';
            empty.textContent = 'No catalog loaded.';
            packsEl.appendChild(empty);
            return;
        }

        const packs = state.catalog.packs.slice().sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
        packsHint.textContent = packs.length + ' curated packs';
        for (const pack of packs) {
            const lists = AGHBlocklistUtils.resolveSelection(state.catalog, [pack.id], []);
            const installed = lists.filter(isSubscribed).length;
            const allInstalled = lists.length > 0 && installed === lists.length;

            const card = document.createElement('article');
            card.className = 'pack-card';

            const top = document.createElement('div');
            top.className = 'pack-top';
            const title = document.createElement('h3');
            title.textContent = pack.name || pack.id;
            const risk = document.createElement('span');
            const riskLevel = String(pack.risk || 'unknown').toLowerCase();
            risk.className = 'pill ' + (riskLevel === 'low' ? 'pill-low' : riskLevel === 'high' ? 'pill-high' : 'pill-medium');
            risk.textContent = riskLevel === 'unknown' ? 'risk ?' : riskLevel + ' risk';
            if (pack.notes) risk.title = String(pack.notes);
            top.append(title, risk);

            const tagline = document.createElement('p');
            tagline.className = 'pack-tagline';
            tagline.textContent = pack.tagline || pack.description || '';

            const meta = document.createElement('div');
            meta.className = 'pack-meta';
            const entryCount = Number(pack.total_entries) ||
                lists.reduce((sum, list) => sum + (Number(list.health && list.health.entries) || 0), 0);
            meta.append(
                Object.assign(document.createElement('span'), {
                    textContent: lists.length + (lists.length === 1 ? ' list' : ' lists'),
                }),
                Object.assign(document.createElement('span'), {
                    textContent: formatNumber(entryCount) + ' domains',
                })
            );

            const actions = document.createElement('div');
            actions.className = 'pack-actions';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = allInstalled ? 'button button-secondary' : 'button button-primary';
            button.textContent = allInstalled
                ? 'Installed'
                : installed
                    ? 'Add missing (' + (lists.length - installed) + ')'
                    : 'Import pack';
            button.disabled = state.busy || allInstalled || !state.aghReady || !lists.length;
            button.addEventListener('click', () => { void importSelection([pack.id], []); });
            actions.appendChild(button);

            card.append(top, tagline, meta, actions);
            packsEl.appendChild(card);
        }
    }

    function renderLists() {
        listsEl.textContent = '';
        listCount.textContent = '';
        if (!state.catalog) {
            const empty = document.createElement('p');
            empty.className = 'rule-empty';
            empty.textContent = 'No catalog loaded.';
            listsEl.appendChild(empty);
            return;
        }

        const lists = AGHBlocklistUtils.searchLists(state.catalog.lists, state.query);
        listCount.textContent = lists.length + ' of ' + state.catalog.lists.length;
        if (!lists.length) {
            const empty = document.createElement('p');
            empty.className = 'rule-empty';
            empty.textContent = 'No lists match the search.';
            listsEl.appendChild(empty);
            return;
        }

        for (const list of lists) {
            const subscribed = isSubscribed(list);
            const row = document.createElement('div');
            row.className = 'list-row' + (subscribed ? ' is-subscribed' : '');

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = state.selected.has(list.id);
            checkbox.disabled = state.busy || subscribed || !state.aghReady;
            checkbox.setAttribute('aria-label', 'Select ' + list.name);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) state.selected.add(list.id);
                else state.selected.delete(list.id);
                updateImportBar();
            });

            const main = document.createElement('div');
            main.className = 'list-main';
            const name = document.createElement('div');
            name.className = 'list-name';
            const href = validLink(list.homepage) || validLink(list.url);
            if (href) {
                const link = document.createElement('a');
                link.href = href;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.textContent = list.name;
                name.appendChild(link);
            } else {
                const text = document.createElement('span');
                text.textContent = list.name;
                name.appendChild(text);
            }
            const desc = document.createElement('div');
            desc.className = 'list-desc';
            desc.textContent = list.description || '';
            desc.title = list.description || '';
            const topics = document.createElement('div');
            topics.className = 'list-topics';
            const topicList = Array.isArray(list.topics) ? list.topics : [];
            for (const topic of topicList.slice(0, 4)) {
                const chip = document.createElement('span');
                chip.className = 'topic';
                chip.textContent = topic;
                topics.appendChild(chip);
            }
            if (topicList.length > 4) {
                const more = document.createElement('span');
                more.className = 'topic';
                more.textContent = '+' + (topicList.length - 4);
                topics.appendChild(more);
            }
            main.append(name, desc, topics);

            const health = AGHBlocklistUtils.healthInfo(list.health);
            const healthBadge = document.createElement('span');
            healthBadge.className = 'health health-' + health.kind;
            healthBadge.textContent = health.label;
            const reasons = list.health && Array.isArray(list.health.reasons)
                ? list.health.reasons.join('; ')
                : '';
            healthBadge.title = reasons || (list.health && list.health.checkedAt
                ? 'Checked ' + formatDate(list.health.checkedAt)
                : 'No health data');

            const entries = document.createElement('span');
            entries.className = 'list-entries';
            entries.textContent = list.health && list.health.entries != null
                ? formatNumber(list.health.entries) + ' domains'
                : '—';

            const subscribedCell = document.createElement('div');
            subscribedCell.className = 'list-subscribed';
            if (subscribed) {
                const badge = document.createElement('span');
                badge.className = 'pill';
                badge.textContent = 'Subscribed';
                subscribedCell.appendChild(badge);
            }

            row.append(checkbox, main, healthBadge, entries, subscribedCell);
            listsEl.appendChild(row);
        }
    }

    function updateImportBar() {
        const count = state.selected.size;
        importBar.hidden = count === 0;
        selectionCount.textContent = count + (count === 1 ? ' list selected' : ' lists selected');
        importSelectedBtn.disabled = state.busy || !state.aghReady || count === 0;
    }

    function renderAll() {
        renderMeta();
        renderPacks();
        renderLists();
        updateImportBar();
    }

    async function loadCatalog(force) {
        const res = await api.runtime.sendMessage({ type: 'get-blocklist-catalog', force: !!force });
        if (!res || !res.ok) {
            state.catalog = null;
            state.catalogInfo = null;
            renderAll();
            setStatus((res && res.message) || 'Could not load the blocklist catalog.', 'error');
            return;
        }
        state.catalog = res.catalog;
        state.catalogInfo = res;
        state.selected.clear();
        renderAll();
        if (res.stale) {
            setStatus('Showing the cached catalog; the refresh failed: ' + (res.error || 'unknown error'), 'error');
        }
    }

    async function loadFilters() {
        const res = await api.runtime.sendMessage({ type: 'get-agh-filters' });
        if (!res) {
            state.aghReady = false;
            state.filters.clear();
            showBanner('The extension did not return AdGuard Home filters.', 'settings');
            renderAll();
            return;
        }
        if (res.agh_url) setAghLink(res.agh_url);
        if (res.configured === false) {
            state.aghReady = false;
            state.filters.clear();
            showBanner('Set the AdGuard Home URL in Settings before importing.', 'settings');
        } else if (res.session_expired) {
            state.aghReady = false;
            state.filters.clear();
            showBanner('AdGuard Home session expired. Log in and reload this page.', 'agh');
        } else if (!res.ok) {
            state.aghReady = false;
            state.filters.clear();
            showBanner(res.message || 'Could not read AdGuard Home filters.', 'settings');
        } else {
            state.aghReady = true;
            hideBanner();
            state.filters = new Map((res.filters || []).map((filter) => [filter.url, filter]));
        }
        renderAll();
    }

    async function importSelection(packIds, listIds) {
        if (state.busy) return;
        state.busy = true;
        setStatus(packIds && packIds.length ? 'Importing pack…' : 'Importing selected lists…');
        renderAll();
        try {
            const res = await api.runtime.sendMessage({
                type: 'import-blocklists',
                packIds: packIds || [],
                listIds: listIds || [],
            });
            if (!res) {
                setStatus('The extension did not return an import result.', 'error');
                return;
            }
            if (res.session_expired) {
                state.aghReady = false;
                showBanner('AdGuard Home session expired during the import. Log in and retry.', 'agh');
                setStatus(res.message || 'AdGuard Home session expired.', 'error');
                return;
            }
            if (!res.ok) {
                setStatus(res.message || 'The import failed.', 'error');
                return;
            }

            let text = res.message || 'Import finished.';
            let kind = res.failed && res.failed.length ? 'error' : 'success';
            if (res.refresh) {
                if (res.refresh.ok) {
                    text += ' AGH is refreshing its filters.';
                } else {
                    text += ' Refresh failed: ' + (res.refresh.message || 'unknown error');
                    kind = 'error';
                }
            }
            if (res.skipped && res.skipped.length) {
                text += ' ' + res.skipped.length + ' already subscribed.';
            }
            setStatus(text, kind);
            if (res.failed && res.failed.length) {
                status.title = res.failed
                    .map((item) => item.name + ': ' + item.message)
                    .join('\n');
            }
            state.selected.clear();
            await loadFilters();
        } catch (e) {
            setStatus('The import failed: ' + (e && e.message ? e.message : String(e)), 'error');
        } finally {
            state.busy = false;
            renderAll();
        }
    }

    refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        setStatus('Refreshing catalog…');
        try {
            await loadCatalog(true);
        } finally {
            refreshBtn.disabled = false;
        }
    });

    listSearch.addEventListener('input', () => {
        state.query = listSearch.value;
        renderLists();
    });

    importSelectedBtn.addEventListener('click', () => {
        void importSelection([], Array.from(state.selected));
    });

    if (!api) {
        setStatus('Extension storage is unavailable on this page.', 'error');
        renderAll();
        return;
    }

    void Promise.all([loadCatalog(false), loadFilters()]);
})();
