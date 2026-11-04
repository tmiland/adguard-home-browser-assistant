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

    function sameRuleSet(left, right) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
        const a = left.slice().sort();
        const b = right.slice().sort();
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    function planUndo(snapshot, currentRules, now) {
        if (!snapshot
            || !Array.isArray(snapshot.priorRules)
            || !Array.isArray(snapshot.appliedRules)
            || !Number.isFinite(Number(snapshot.expiresAt))) {
            return { ok: false, reason: 'missing' };
        }
        if (Number(now) >= Number(snapshot.expiresAt)) {
            return { ok: false, reason: 'expired' };
        }
        if (!sameRuleSet(currentRules, snapshot.appliedRules)) {
            return { ok: false, reason: 'changed' };
        }

        const rules = snapshot.priorRules.slice();
        const pending = snapshot.cancelledPending;
        let restorePending = null;
        if (pending && typeof pending.rule === 'string' && pending.rule) {
            if (Number(pending.until) > Number(now)) {
                restorePending = pending;
            } else {
                /* The temporary unblock would have expired during the undo
                   window. Do not resurrect it as a permanent allow rule. */
                const index = rules.indexOf(pending.rule);
                if (index !== -1) rules.splice(index, 1);
            }
        }
        return { ok: true, rules, restorePending };
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
        planUndo,
        durationLabel,
    };
});
