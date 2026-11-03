/*
 * AdGuard cosmetic-rule parsing for the Browser Assistant.
 *
 * AGH stores cosmetic rules in its user rules, but a DNS server cannot apply
 * them. The assistant reads those rules back and injects the matching CSS into
 * Firefox. This module is also loaded in Node for tests.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.AGHCosmeticRules = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const MARKERS = [
        { marker: '#@$#', type: 'style-exception' },
        { marker: '#@%#', type: 'script-exception' },
        { marker: '#@?#', type: 'exception' },
        { marker: '#@#', type: 'exception' },
        { marker: '#$#', type: 'style' },
        { marker: '#%#', type: 'script' },
        { marker: '#?#', type: 'hide' },
        { marker: '##', type: 'hide' },
    ];

    function normalizeHost(value) {
        return String(value || '').trim().toLowerCase().replace(/\.$/, '');
    }

    function parseRule(raw) {
        const text = String(raw || '').trim();
        if (!text || text.startsWith('!') || text.startsWith('[')) return null;
        /* AGH comment/separator lines start with # but are not cosmetic rules. */
        if (/^#+$/.test(text) || /^#\s/.test(text)) return null;

        let found = null;
        for (const item of MARKERS) {
            const index = text.indexOf(item.marker);
            if (index < 0) continue;
            if (!found || index < found.index) {
                found = { index, marker: item.marker, type: item.type };
            }
        }
        if (!found) return null;

        const prefix = text.slice(0, found.index).trim();
        const body = text.slice(found.index + found.marker.length).trim();
        if (!body) return null;

        const domains = parseDomains(prefix);
        if (found.type === 'script' || found.type === 'script-exception') {
            return {
                raw: text,
                type: found.type,
                selector: body,
                body: '',
                includes: domains.includes,
                excludes: domains.excludes,
            };
        }

        if (found.type === 'style' || found.type === 'style-exception') {
            const style = parseStyle(body);
            if (!style) return null;
            return {
                raw: text,
                type: found.type,
                selector: style.selector,
                body: style.body,
                includes: domains.includes,
                excludes: domains.excludes,
            };
        }

        return {
            raw: text,
            type: found.type,
            selector: body,
            body: '',
            includes: domains.includes,
            excludes: domains.excludes,
        };
    }

    const EXTENDED_NAMES = new Set(['has-text', 'contains', 'matches-css', 'upward', 'remove', 'style']);

    function findMatchingParen(text, openIndex) {
        let depth = 0;
        let quote = '';
        let escape = false;
        for (let i = openIndex; i < text.length; i++) {
            const ch = text[i];
            if (escape) {
                escape = false;
                continue;
            }
            if (ch === '\\') {
                escape = true;
                continue;
            }
            if (quote) {
                if (ch === quote) quote = '';
                continue;
            }
            if (ch === '"' || ch === "'") {
                quote = ch;
                continue;
            }
            if (ch === '(') {
                depth++;
            } else if (ch === ')') {
                depth--;
                if (depth === 0) return i;
            }
        }
        return -1;
    }

    function containsExtended(value) {
        return /:(?:has-text|contains|matches-css|upward|remove|style)\(/i.test(value);
    }

    function parseExtendedSelector(selector) {
        const text = String(selector || '').trim();
        if (!text) return null;

        let base = '';
        const tokens = [];
        let i = 0;
        let bracket = 0;
        let quote = '';

        while (i < text.length) {
            const ch = text[i];
            if (quote) {
                base += ch;
                if (ch === quote) quote = '';
                i++;
                continue;
            }
            if (ch === '"' || ch === "'") {
                quote = ch;
                base += ch;
                i++;
                continue;
            }
            if (ch === '\\') {
                base += ch + (text[i + 1] || '');
                i += 2;
                continue;
            }
            if (ch === '[') {
                bracket++;
                base += ch;
                i++;
                continue;
            }
            if (ch === ']') {
                bracket = Math.max(0, bracket - 1);
                base += ch;
                i++;
                continue;
            }
            if (ch === ':' && bracket === 0) {
                const match = /^:([a-zA-Z-]+)/.exec(text.slice(i));
                if (match) {
                    const name = match[1].toLowerCase();
                    const nameEnd = i + match[0].length;
                    let arg = null;
                    let end = nameEnd;
                    if (text[nameEnd] === '(') {
                        const close = findMatchingParen(text, nameEnd);
                        if (close < 0) return null;
                        arg = text.slice(nameEnd + 1, close);
                        end = close + 1;
                    }

                    if (EXTENDED_NAMES.has(name)) {
                        tokens.push({
                            type: name === 'contains' ? 'has-text' : name,
                            arg: arg || '',
                            raw: text.slice(i, end),
                        });
                        i = end;
                        continue;
                    }

                    if (name === 'not' && arg !== null && containsExtended(arg)) {
                        const inner = parseExtendedSelector(arg);
                        if (!inner || inner.base || inner.tokens.length !== 1) return null;
                        const token = inner.tokens[0];
                        if (token.type === 'has-text') {
                            tokens.push({ type: 'not-has-text', arg: token.arg, raw: text.slice(i, end) });
                        } else if (token.type === 'matches-css') {
                            tokens.push({ type: 'not-matches-css', arg: token.arg, raw: text.slice(i, end) });
                        } else {
                            return null;
                        }
                        i = end;
                        continue;
                    }

                    base += text.slice(i, end);
                    i = end;
                    continue;
                }
            }
            base += ch;
            i++;
        }

        if (!tokens.length) return null;
        const style = tokens
            .filter((token) => token.type === 'style')
            .map((token) => token.arg.trim())
            .filter(Boolean)
            .join('; ');
        return {
            base: base.trim(),
            tokens,
            action: tokens.some((token) => token.type === 'style') ? 'style' : 'hide',
            style,
        };
    }

    function parseDomains(prefix) {
        const includes = [];
        const excludes = [];
        if (!prefix || prefix === '*') return { includes, excludes };
        for (const part of prefix.split(',')) {
            let domain = part.trim().toLowerCase();
            if (!domain || domain === '*') continue;
            if (domain.startsWith('~')) {
                domain = domain.slice(1).trim();
                if (domain) excludes.push(domain);
            } else {
                includes.push(domain);
            }
        }
        return { includes, excludes };
    }

    function parseStyle(body) {
        const text = String(body || '').trim();
        const open = text.indexOf('{');
        const close = text.lastIndexOf('}');
        if (open < 1 || close <= open) return null;
        const selector = text.slice(0, open).trim();
        const declarations = text.slice(open + 1, close).trim();
        if (!selector || !declarations) return null;
        return { selector, body: declarations };
    }

    function matchesDomain(host, pattern) {
        const h = normalizeHost(host);
        let p = normalizeHost(pattern);
        if (!h || !p) return false;
        if (p === '*') return true;
        if (p.startsWith('*.')) p = p.slice(2);
        if (p.startsWith('.')) p = p.slice(1);
        if (!p) return true;
        if (p.endsWith('.*')) {
            /* example.* matches example.com and its subdomains, but not
               badexample.com. */
            const base = p.slice(0, -2);
            const hostLabels = h.split('.');
            const baseLabels = base.split('.');
            for (let i = 0; i + baseLabels.length < hostLabels.length; i++) {
                if (hostLabels.slice(i, i + baseLabels.length).join('.') === base) return true;
            }
            return false;
        }
        return h === p || h.endsWith('.' + p);
    }

    function ruleAppliesToHost(rule, host) {
        if (!rule) return false;
        if (rule.excludes.some((domain) => matchesDomain(host, domain))) return false;
        if (rule.includes.length === 0) return true;
        return rule.includes.some((domain) => matchesDomain(host, domain));
    }

    function buildForHost(rawRules, host) {
        const rules = [];
        for (const raw of Array.isArray(rawRules) ? rawRules : []) {
            const rule = parseRule(raw);
            if (rule) rules.push(rule);
        }

        const hide = new Map();
        const hideExceptions = new Set();
        const styles = new Map();
        const styleExceptions = new Set();
        const extended = [];

        for (const rule of rules) {
            if (!ruleAppliesToHost(rule, host)) continue;
            if (rule.type === 'hide' || rule.type === 'style') {
                const ext = parseExtendedSelector(rule.selector);
                if (ext) {
                    extended.push({
                        selector: rule.selector,
                        raw: rule.raw,
                        action: ext.action,
                        style: ext.style,
                        extended: ext,
                    });
                } else if (rule.type === 'hide') {
                    hide.set(rule.selector, rule);
                } else {
                    styles.set(rule.selector, rule);
                }
            } else if (rule.type === 'exception') {
                hideExceptions.add(rule.selector);
            } else if (rule.type === 'style-exception') {
                styleExceptions.add(rule.selector);
            }
        }

        for (const selector of hideExceptions) hide.delete(selector);
        for (const selector of styleExceptions) styles.delete(selector);
        const extendedRules = extended.filter((rule) => (
            rule.action === 'style'
                ? !styleExceptions.has(rule.selector)
                : !hideExceptions.has(rule.selector)
        ));

        return {
            hide: Array.from(hide.values()).map((rule) => ({
                selector: rule.selector,
                raw: rule.raw,
            })),
            style: Array.from(styles.values()).map((rule) => ({
                selector: rule.selector,
                body: rule.body,
                raw: rule.raw,
            })),
            extended: extendedRules,
            ignored: rules.filter((rule) => rule.type === 'script' || rule.type === 'script-exception').length,
            total: rules.length,
        };
    }

    function toCss(built) {
        const lines = [];
        for (const rule of built.hide) {
            lines.push(rule.selector + ' { display: none !important; }');
        }
        for (const rule of built.style) {
            lines.push(rule.selector + ' { ' + rule.body + ' }');
        }
        return lines.join('\n');
    }

    return {
        parseRule,
        parseDomains,
        matchesDomain,
        ruleAppliesToHost,
        parseExtendedSelector,
        buildForHost,
        toCss,
    };
});
