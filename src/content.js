/*
 * AdGuard Home Browser Assistant — content script for the AdGuard Home web UI.
 *
 * Injects Unblock buttons into the AGH query log and a floating Quick
 * unblock widget. Unblocking is delegated to the background handler (the same
 * one used by the popup and block page), which adds the allow rule, clears
 * AGH's DNS cache, and verifies via check_host.
 *
 * Robustness notes (AGH rows are React-rendered and churn constantly):
 *   - click handling uses EVENT DELEGATION (one listener on document,
 *     capture phase) so buttons survive row re-renders; it also stops the
 *     row's own click (which opens the detail modal on small screens).
 *   - re-injection is guarded by button PRESENCE, not a row marker.
 *   - every action also logs to the console and updates the widget status.
 */
(() => {
    'use strict';

    const ROW_SEL = '[data-testid="querylog_cell"]';
    const BLOCKED_CLASS = 'logs__row--red';
    const BTN_CLASS = 'aqu-unblock-btn';
    const DOMAIN_CELL_SEL = '.logs__cell--domain';
    const TOAST_MS = 8000;

    const api = (typeof browser !== 'undefined' && browser.runtime && typeof browser.runtime.sendMessage === 'function')
        ? browser
        : null;

    const dbg = (msg) => console.log('[AGH Assistant]', msg);

    /* --------------------------- unblock workflow ---------------------------- */

    async function runUnblock(domain, btn, onState) {
        const toast = new StatusToast();
        const report = (kind, text) => {
            toast.state(kind, text);
            if (typeof onState === 'function') onState(kind, text);
        };
        dbg(`unblocking ${domain}`);
        setButtonBusy(btn, true);
        report('running', `Unblocking ${domain}…`);

        try {
            if (!api) throw new Error('Extension API is unavailable.');
            const res = await api.runtime.sendMessage({
                type: 'unblock',
                host: domain,
                clientOnly: false,
                temporary: false,
            });
            if (!res) throw new Error('No response from the background.');

            if (res.session_expired) {
                setButtonUnblocked(btn, false);
                report('error', 'AGH session expired — log in and try again.');
                return;
            }
            if (res.ok) {
                setButtonUnblocked(btn, true);
                const target = res.target && res.target !== domain
                    ? ` (${res.target} and its subdomains)`
                    : '';
                report(
                    'success',
                    `Unblocked ${domain}${target}. If the client still shows it blocked, flush its ` +
                        'DNS cache; old blocked answers can persist for up to 10 s.',
                );
                return;
            }

            setButtonUnblocked(btn, false);
            report('error', res.message || `Failed to unblock ${domain}.`);
        } catch (e) {
            dbg('unblock failed', e && e.message ? e.message : e);
            setButtonUnblocked(btn, false);
            report('error', `Failed to unblock ${domain}: ${e && e.message ? e.message : e}`);
        } finally {
            setButtonBusy(btn, false);
        }
    }

    /* ----------------------------- row injection ----------------------------- */

    function getDomain(row) {
        const cell = row.querySelector(DOMAIN_CELL_SEL);
        if (!cell) {
            return null;
        }
        const titled = cell.querySelector('[title]');
        if (titled) {
            return titled.getAttribute('title');
        }
        return (cell.textContent || '').trim();
    }

    function makeButton(domain) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = BTN_CLASS;
        btn.textContent = 'Unblock';
        btn.dataset.domain = domain;
        btn.title = 'Unblock this domain for all devices (clears AGH cache and verifies)';
        return btn;
    }

    function injectRowButton(row) {
        if (row.querySelector(`.${BTN_CLASS}`)) {
            return;
        }
        const domain = getDomain(row);
        if (!domain) {
            return;
        }
        row.appendChild(makeButton(domain));
    }

    function scan() {
        const rows = document.querySelectorAll(`${ROW_SEL}.${BLOCKED_CLASS}`);
        for (const row of rows) {
            injectRowButton(row);
        }
    }

    /* ------------------------------- UI helpers ------------------------------ */

    function setButtonBusy(btn, busy) {
        if (btn) {
            btn.disabled = busy;
            btn.textContent = busy ? '…' : 'Unblock';
        }
    }

    function setButtonUnblocked(btn, ok) {
        if (btn) {
            btn.classList.remove('aqu-unblock-btn--ok', 'aqu-unblock-btn--fail');
            btn.classList.add(ok ? 'aqu-unblock-btn--ok' : 'aqu-unblock-btn--fail');
        }
    }

    // Delegate ALL clicks on the document (capture phase: runs before the
    // row's own bubble-phase handler, so we reliably stop modal opening and
    // survive React re-renders that would have killed per-button listeners).
    document.addEventListener(
        'click',
        (e) => {
            const btn = e.target.closest && e.target.closest(`.${BTN_CLASS}`);
            if (!btn || !btn.dataset.domain) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            runUnblock(
                btn.dataset.domain,
                btn,
                btn.id === 'aqu-widget-submit' ? updateWidgetStatus : undefined,
            );
        },
        true,
    );

    class StatusToast {
        constructor() {
            this.el = document.createElement('div');
            this.el.className = 'aqu-toast';
            this.el.hidden = true;
            document.body.appendChild(this.el);
        }

        state(kind, text) {
            if (!this.el) {
                return;
            }
            this.el.hidden = false;
            this.el.className = `aqu-toast aqu-toast--${kind}`;
            this.el.textContent = text;
            clearTimeout(this._t);
            if (kind === 'success') {
                this._t = setTimeout(() => {
                    this.el.hidden = true;
                }, TOAST_MS);
            }
        }
    }

    function updateWidgetStatus(kind, text) {
        const el = document.getElementById('aqu-widget-status');
        if (!el) return;
        el.dataset.state = kind;
        el.textContent = kind === 'success' ? 'Unblocked.' : text;
    }

    /* ------------------------------- floating widget ------------------------- */

    const COLLAPSE_KEY = 'agh-assistant-widget-collapsed';

    function buildWidget() {
        if (document.getElementById('aqu-widget')) {
            return;
        }
        const wrap = document.createElement('div');
        wrap.id = 'aqu-widget';
        wrap.className = 'aqu-widget';

        const head = document.createElement('div');
        head.className = 'aqu-widget__head';

        const brand = document.createElement('div');
        brand.className = 'aqu-widget__brand';
        const mark = document.createElement('span');
        mark.className = 'aqu-widget__mark';
        mark.textContent = 'A';
        mark.setAttribute('aria-hidden', 'true');
        const titles = document.createElement('div');
        titles.className = 'aqu-widget__titles';
        const title = document.createElement('div');
        title.className = 'aqu-widget__title';
        title.textContent = 'AdGuard Home Browser Assistant';
        const sub = document.createElement('div');
        sub.className = 'aqu-widget__sub';
        sub.textContent = 'Quick unblock';
        titles.append(title, sub);
        brand.append(mark, titles);

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'aqu-widget__toggle';
        toggle.setAttribute('aria-label', 'Minimize quick unblock');
        toggle.title = 'Minimize';
        head.append(brand, toggle);

        const body = document.createElement('div');
        body.className = 'aqu-widget__body';

        const form = document.createElement('form');
        form.className = 'aqu-widget__form';

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'example.com';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('aria-label', 'Domain to unblock');

        const btn = document.createElement('button');
        btn.type = 'submit';
        btn.className = BTN_CLASS;
        btn.textContent = 'Unblock';
        btn.id = 'aqu-widget-submit';
        btn.setAttribute('aria-label', 'Unblock domain for all devices');

        const status = document.createElement('div');
        status.id = 'aqu-widget-status';
        status.className = 'aqu-widget__status';
        status.textContent = 'Allow a domain for every device.';

        const normalizeDomain = (value) => {
            let domain = String(value || '').trim().toLowerCase();
            domain = domain
                .replace(/^https?:\/\//i, '')
                .replace(/^[^/]*@/, '')
                .split(/[/?#]/)[0]
                .replace(/:\d+$/, '')
                .replace(/\.$/, '');
            if (!domain || domain.length > 253) return '';
            if (!/^[a-z0-9.-]+$/.test(domain)) return '';
            if (domain.startsWith('.') || domain.includes('..')) return '';
            const labels = domain.split('.');
            if (labels.length < 2 || labels.some((label) => !label || label.length > 63)) return '';
            return domain;
        };

        const syncBtnDomain = () => {
            const domain = normalizeDomain(input.value);
            btn.dataset.domain = domain;
            btn.disabled = !domain;
        };
        input.addEventListener('input', syncBtnDomain);
        syncBtnDomain();

        const setCollapsed = (collapsed) => {
            wrap.classList.toggle('aqu-widget--collapsed', collapsed);
            toggle.textContent = collapsed ? '+' : '−';
            toggle.title = collapsed ? 'Expand quick unblock' : 'Minimize';
            toggle.setAttribute('aria-label', collapsed ? 'Expand quick unblock' : 'Minimize quick unblock');
            toggle.setAttribute('aria-expanded', String(!collapsed));
            title.textContent = collapsed ? 'AdGuard Assistant' : 'AdGuard Home Browser Assistant';
            try {
                localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
            } catch (_) {
                /* Storage can be unavailable in private windows. */
            }
        };

        let collapsed = false;
        try {
            collapsed = localStorage.getItem(COLLAPSE_KEY) === '1';
        } catch (_) {
            /* Keep expanded. */
        }
        setCollapsed(collapsed);
        toggle.addEventListener('click', () => {
            setCollapsed(!wrap.classList.contains('aqu-widget--collapsed'));
        });

        form.append(input, btn);
        body.append(form, status);
        wrap.append(head, body);
        document.body.appendChild(wrap);

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const domain = normalizeDomain(input.value);
            if (!domain) {
                status.dataset.state = 'error';
                status.textContent = 'Enter a valid domain, e.g. example.com.';
                input.focus();
                return;
            }
            input.value = domain;
            btn.dataset.domain = domain;
            runUnblock(domain, btn, updateWidgetStatus).finally(() => {
                btn.disabled = false;
                btn.textContent = 'Unblock';
                syncBtnDomain();
            });
        });
    }

    /* -------------------------------- bootstrap ------------------------------ */

    function boot() {
        if (!window.location.origin.match(/^https?:\/\//)) {
            return;
        }
        buildWidget();
        dbg('ready on', window.location.origin);

        const observer = new MutationObserver(() => {
            scan();
            if (!document.getElementById('aqu-widget')) {
                buildWidget();
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        scan();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();