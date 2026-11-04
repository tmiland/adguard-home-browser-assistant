/*
 * Pure helpers for the DNS blocklist catalog panel.
 *
 * Kept separate from the background and page so the validation and selection
 * logic can be unit-tested without a browser. Loaded by background.js,
 * blocklists.html and the Node test runner.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.AGHBlocklistUtils = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function fail(message) {
        return { ok: false, message };
    }

    function isHttpUrl(value) {
        try {
            const url = new URL(value);
            return url.protocol === 'http:' || url.protocol === 'https:';
        } catch (_) {
            return false;
        }
    }

    function validateCatalog(data) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return fail('The catalog is not an object.');
        }
        if (data.schema !== 1) {
            return fail('Unsupported catalog schema: ' + String(data.schema));
        }
        if (!Array.isArray(data.lists) || data.lists.length === 0) {
            return fail('The catalog has no lists.');
        }

        const listIds = new Set();
        for (const list of data.lists) {
            if (!list || typeof list !== 'object') return fail('A catalog list is not an object.');
            if (typeof list.id !== 'string' || !list.id.trim()) return fail('A catalog list has no id.');
            if (listIds.has(list.id)) return fail('Duplicate list id: ' + list.id);
            listIds.add(list.id);
            if (typeof list.name !== 'string' || !list.name.trim()) return fail('List ' + list.id + ' has no name.');
            if (typeof list.url !== 'string' || !isHttpUrl(list.url)) {
                return fail('List ' + list.id + ' has an invalid URL.');
            }
        }

        if (!Array.isArray(data.packs)) return fail('The catalog has no packs array.');
        const packIds = new Set();
        for (const pack of data.packs) {
            if (!pack || typeof pack !== 'object') return fail('A catalog pack is not an object.');
            if (typeof pack.id !== 'string' || !pack.id.trim()) return fail('A catalog pack has no id.');
            if (packIds.has(pack.id)) return fail('Duplicate pack id: ' + pack.id);
            packIds.add(pack.id);
            if (!Array.isArray(pack.lists)) return fail('Pack ' + pack.id + ' has no lists.');
            for (const member of pack.lists) {
                if (!listIds.has(member)) return fail('Pack ' + pack.id + ' references an unknown list: ' + member);
            }
        }

        return { ok: true, catalog: data };
    }

    function resolveSelection(catalog, packIds, listIds) {
        const wanted = new Set(Array.isArray(listIds) ? listIds : []);
        const packs = catalog && Array.isArray(catalog.packs) ? catalog.packs : [];
        for (const packId of Array.isArray(packIds) ? packIds : []) {
            const pack = packs.find((item) => item && item.id === packId);
            if (!pack || !Array.isArray(pack.lists)) continue;
            for (const member of pack.lists) wanted.add(member);
        }
        const lists = catalog && Array.isArray(catalog.lists) ? catalog.lists : [];
        return lists.filter((list) => list && wanted.has(list.id));
    }

    function partitionImport(lists, existingUrls) {
        const existing = new Set((Array.isArray(existingUrls) ? existingUrls : []).filter(Boolean));
        const toAdd = [];
        const skipped = [];
        for (const list of Array.isArray(lists) ? lists : []) {
            if (!list) continue;
            if (existing.has(list.url)) {
                skipped.push(list);
            } else {
                existing.add(list.url);
                toAdd.push(list);
            }
        }
        return { toAdd, skipped };
    }

    function searchLists(lists, query) {
        if (!Array.isArray(lists)) return [];
        const needle = String(query == null ? '' : query).trim().toLowerCase();
        if (!needle) return lists.slice();
        return lists.filter((list) => {
            if (!list) return false;
            const topics = Array.isArray(list.topics) ? list.topics : [];
            const haystack = [
                list.id,
                list.name,
                list.description,
                list.maintainer,
                list.region,
                ...topics,
            ].filter(Boolean).join(' ').toLowerCase();
            return haystack.includes(needle);
        });
    }

    function healthInfo(health) {
        const status = health && health.status;
        if (status === 'ok') return { label: 'Healthy', kind: 'ok' };
        if (status === 'warn') return { label: 'Warning', kind: 'warn' };
        if (status === 'fail') return { label: 'Failing', kind: 'fail' };
        return { label: 'Unknown', kind: 'unknown' };
    }

    return {
        validateCatalog,
        resolveSelection,
        partitionImport,
        searchLists,
        healthInfo,
    };
});
