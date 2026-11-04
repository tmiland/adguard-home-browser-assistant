/*
 * Pure list helpers for the Browser Assistant.
 *
 * Kept separate from the pages so filtering can be unit-tested without a
 * browser. Loaded by options.html and the Node test runner.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.AGHListUtils = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function filterRules(rules, query) {
        if (!Array.isArray(rules)) return [];
        const needle = String(query == null ? '' : query).trim().toLowerCase();
        const list = rules.filter((rule) => typeof rule === 'string' && rule);
        if (!needle) return list;
        return list.filter((rule) => rule.toLowerCase().includes(needle));
    }

    return { filterRules };
});
