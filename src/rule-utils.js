/*
 * Pure rule-building helpers for the Browser Assistant.
 *
 * Kept separate from background.js so the rule generation can be unit-tested
 * without a browser. Loaded before background.js in the manifest.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.AGHRuleUtils = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function escapeClient(value) {
        return String(value)
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/"/g, '\\"')
            .replace(/,/g, '\\,')
            .replace(/\|/g, '\\|');
    }

    function toggleRules(host, target, clientOnly, client, action) {
        const escaped = escapeClient(client);
        const blockRule = clientOnly ? `||${target}^$client='${escaped}'` : `||${target}^$important`;
        const allowRule = clientOnly ? `@@||${target}^$client='${escaped}'` : `@@||${target}^$important`;
        const hostBlockRule = clientOnly ? `||${host}^$client='${escaped}'` : `||${host}^$important`;
        const hostAllowRule = clientOnly ? `@@||${host}^$client='${escaped}'` : `@@||${host}^$important`;
        return {
            blockRule,
            allowRule,
            hostBlockRule,
            hostAllowRule,
            addRule: action === 'block' ? hostBlockRule : allowRule,
            removeRules: action === 'block'
                ? [hostAllowRule]
                : [blockRule, hostBlockRule],
        };
    }

    function durationLabel(ms) {
        const seconds = Math.max(1, Math.round(ms / 1000));
        if (seconds < 60) return seconds + ' seconds';
        const minutes = Math.round(seconds / 60);
        if (minutes < 60) return minutes + (minutes === 1 ? ' minute' : ' minutes');
        const hours = Math.round(minutes / 60);
        return hours + (hours === 1 ? ' hour' : ' hours');
    }

    return {
        escapeClient,
        toggleRules,
        durationLabel,
    };
});
