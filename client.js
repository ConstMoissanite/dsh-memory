window.__ModuleLoader__.load({
  id: 'dsh-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'dsh-memory';

    const zh = {
      barSummary: 'Memory · {count} 条待处理',
      barFiles: '{count} 个文件异常',
      approve: '接受',
      delete: '删除',
      confirmDelete: '确认删除',
      retry: '重试',
      rebuild: '重建',
      confirmRebuild: '确认重建',
      old: '上次可信',
      new: '当前',
      empty: '（空）',
      removed: '（已删除）',
      modified: '已修改',
      added: '新增',
      renamed: '已更名',
      parseError: '解析失败',
      failed: '操作失败',
    };

    const en = {
      barSummary: 'Memory · {count} pending',
      barFiles: '{count} file error(s)',
      approve: 'Approve',
      delete: 'Delete',
      confirmDelete: 'Confirm delete',
      retry: 'Retry',
      rebuild: 'Rebuild',
      confirmRebuild: 'Confirm rebuild',
      old: 'last good',
      new: 'current',
      empty: '(empty)',
      removed: '(removed)',
      modified: 'modified',
      added: 'added',
      renamed: 'renamed',
      parseError: 'parse error',
      failed: 'Action failed',
    };

    const CSS = `
.dm-bar {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid var(--dsw-alias-border-l1, #3a3a3d);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2, #1f1f22);
  color: var(--dsw-alias-label-primary, #f2f3f5);
  font-size: 12px;
  line-height: 1.45;
  overflow: hidden;
}
.dm-bar-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 12px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dm-bar-icon { flex: none; width: 15px; height: 15px; color: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dm-bar-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.dm-bar-chevron { flex: none; color: var(--dsw-alias-label-secondary, #a0a0a6); font-size: 11px; }
.dm-bar-body { display: flex; flex-direction: column; gap: 8px; max-height: 42vh; overflow: auto; padding: 0 12px 10px; }
.dm-anomaly { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1, #3a3a3d); }
.dm-anomaly-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dm-scope { flex: none; padding: 0 5px; border-radius: 4px; background: var(--dsw-alias-bg-layer-1, #2a2a2e); color: var(--dsw-alias-label-secondary, #a0a0a6); font-size: 10px; line-height: 16px; text-transform: uppercase; letter-spacing: 0.03em; }
.dm-heading { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.dm-reason { flex: none; color: var(--dsw-alias-state-warn-primary, #f59e0b); font-size: 11px; }
.dm-diff { display: flex; flex-direction: column; gap: 6px; }
.dm-diff-col { min-width: 0; }
.dm-diff-label { margin-bottom: 2px; color: var(--dsw-alias-label-secondary, #a0a0a6); font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
.dm-pre { box-sizing: border-box; margin: 0; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l1, #3a3a3d); border-radius: 6px; background: var(--dsw-alias-bg-base, #151517); color: var(--dsw-alias-label-primary, #f2f3f5); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow: auto; }
.dm-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.dm-btn { appearance: none; padding: 3px 9px; border: 1px solid var(--dsw-alias-border-l2, #4a4a4e); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #2a2a2e); color: var(--dsw-alias-label-primary, #f2f3f5); font: inherit; font-size: 11px; line-height: 18px; cursor: pointer; }
.dm-btn:hover { background: var(--dsw-alias-bg-layer-2, #343438); }
.dm-btn:disabled { opacity: 0.5; cursor: default; }
.dm-btn-danger { color: var(--dsw-alias-state-error-primary, #f87171); }
.dm-error { color: var(--dsw-alias-state-error-primary, #f87171); font-size: 11px; }
`;

    function WarningIcon({ className }) {
      return h('svg', {
        className,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M12 3.5 21 19.5H3L12 3.5Z' }),
        h('path', { d: 'M12 9v4.2' }),
        h('circle', { cx: 12, cy: 16.5, r: 0.9, fill: 'currentColor', stroke: 'none' }),
      );
    }

    async function api(path, init) {
      const response = await fetch(path, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...init,
      });
      const value = await response.json().catch(() => null);
      if (!response.ok || !value || value.ok !== true) {
        throw new Error(value?.message || `HTTP ${response.status}`);
      }
      return value;
    }

    function AnomalyRow({ anomaly, tr, busy, confirming, setConfirming, act }) {
      const key = `${anomaly.scope}:${anomaly.heading ?? ''}:${anomaly.kind}`;
      const isFile = anomaly.kind === 'file';
      const isRename = anomaly.reason === 'renamed' && typeof anomaly.fromHeading === 'string' && anomaly.fromHeading !== '';
      const actionKey = (action) => `${action}:${key}`;
      const disabled = busy !== '';
      const reason = isFile ? tr('parseError') : tr(anomaly.reason || 'modified');
      const title = isRename ? `${anomaly.fromHeading} → ${anomaly.heading}` : isFile ? anomaly.path : anomaly.heading;
      const confirmKey = isFile ? 'rebuild' : 'delete';
      const confirmingThis = confirming === `${confirmKey}:${key}`;
      return h('div', { className: 'dm-anomaly' },
        h('div', { className: 'dm-anomaly-head' },
          h('span', { className: 'dm-scope' }, anomaly.scope),
          h('span', { className: 'dm-heading', title }, title),
          h('span', { className: 'dm-reason' }, reason),
        ),
        isFile
          ? h('pre', { className: 'dm-pre' }, anomaly.error ?? reason)
          : h('div', { className: 'dm-diff' },
            h('div', { className: 'dm-diff-col' },
              h('div', { className: 'dm-diff-label' }, tr('old')),
              h('pre', { className: 'dm-pre' }, anomaly.old || tr('empty')),
            ),
            h('div', { className: 'dm-diff-col' },
              h('div', { className: 'dm-diff-label' }, tr('new')),
              h('pre', { className: 'dm-pre' }, anomaly.new == null ? tr('removed') : (anomaly.new || tr('empty'))),
            ),
          ),
        h('div', { className: 'dm-actions' },
          !isFile && anomaly.new != null
            ? h('button', {
              type: 'button',
              className: 'dm-btn',
              disabled: disabled || busy === actionKey('approve'),
              onClick: () => act('approve', anomaly),
            }, tr('approve'))
            : null,
          isFile
            ? h('button', {
              type: 'button',
              className: 'dm-btn',
              disabled: disabled || busy === actionKey('retry'),
              onClick: () => act('retry', anomaly),
            }, tr('retry'))
            : null,
          h('button', {
            type: 'button',
            className: 'dm-btn dm-btn-danger',
            disabled: disabled || busy === actionKey(confirmKey),
            onClick: () => {
              if (confirmingThis) {
                setConfirming('');
                void act(confirmKey, anomaly);
              } else {
                setConfirming(`${confirmKey}:${key}`);
              }
            },
          }, confirmingThis ? tr(confirmKey === 'rebuild' ? 'confirmRebuild' : 'confirmDelete') : tr(confirmKey === 'rebuild' ? 'rebuild' : 'delete')),
        ),
      );
    }

    function MemoryBar({ sessionId, t }) {
      const tr = typeof t === 'function' ? t : (key) => key;
      const [data, setData] = React.useState(null);
      const [expanded, setExpanded] = React.useState(false);
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [confirming, setConfirming] = React.useState('');

      const load = React.useCallback(async () => {
        if (sessionId === undefined || sessionId === null || sessionId === '') return;
        try {
          const value = await api(`/dsh-memory/anomalies?sessionId=${encodeURIComponent(String(sessionId))}`);
          setData(value);
          setError('');
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        }
      }, [sessionId]);

      React.useEffect(() => {
        setData(null);
        setExpanded(false);
        setError('');
        setConfirming('');
        if (sessionId === undefined || sessionId === null || sessionId === '') return undefined;
        void load();
        const timer = setInterval(() => { void load(); }, 10_000);
        return () => clearInterval(timer);
      }, [sessionId, load]);

      const act = React.useCallback(async (action, anomaly) => {
        if (sessionId === undefined || sessionId === null || sessionId === '') return;
        setBusy(`${action}:${anomaly.scope}:${anomaly.heading ?? ''}:${anomaly.kind}`);
        setError('');
        try {
          const value = await api('/dsh-memory/anomalies', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              action,
              scope: anomaly.scope,
              heading: anomaly.heading,
              ...(anomaly.fromHeading === undefined ? {} : { fromHeading: anomaly.fromHeading }),
            }),
          });
          setData(value);
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy('');
        }
      }, [sessionId]);

      const anomalies = Array.isArray(data?.anomalies) ? data.anomalies : [];
      if (anomalies.length === 0) return null;
      const files = anomalies.filter((item) => item.kind === 'file').length;
      const summary = tr('barSummary', { count: anomalies.length }) + (files > 0 ? ` · ${tr('barFiles', { count: files })}` : '');

      return h(React.Fragment, null,
        h('style', null, CSS),
        h('div', { className: 'dm-bar', 'data-expanded': expanded ? 'true' : 'false' },
          h('button', {
            type: 'button',
            className: 'dm-bar-head',
            'aria-expanded': expanded,
            onClick: () => setExpanded((value) => !value),
          },
            h(WarningIcon, { className: 'dm-bar-icon' }),
            h('span', { className: 'dm-bar-title' }, summary),
            h('span', { className: 'dm-bar-chevron', 'aria-hidden': true }, expanded ? '⌃' : '⌄'),
          ),
          expanded
            ? h('div', { className: 'dm-bar-body' },
              error !== '' ? h('div', { className: 'dm-error' }, `${tr('failed')}: ${error}`) : null,
              anomalies.map((anomaly, index) => h(AnomalyRow, {
                key: `${anomaly.kind}:${anomaly.scope}:${anomaly.heading ?? ''}:${index}`,
                anomaly,
                tr,
                busy,
                confirming,
                setConfirming,
                act,
              })),
            )
            : null,
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-memory:locales');
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'memory',
          order: 15,
          locale: NS,
        }, (props) => h(MemoryBar, { ...props })));
      },
    };
  },
});
