/**
 * Web settings tab for dsh-dot-mcp: registers into `settings.plugins.tab`,
 * shows the live MCP service status (polled from the bridge's own /status),
 * offers stop/restart/resume over the volatile `enabled` switch, and edits the
 * volatile Config fields through the host's official configForms/settings
 * mirror. Defaults come from src/shared/defaults.ts, the same module the host
 * schema consumes — never drift.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { CONFIG_DEFAULTS } from '../shared/defaults.js';
import { en, zh, type DotMcpLocaleKey } from './locales.js';
import type { ClientContextFace, ConfigFormFace } from './types.js';

/** Loader row id + settings namespace owned by the host half. */
export const NS = 'dot-mcp';

/**
 * Services this entry reads from the browser context. DSH 0.2.1-rc.2's
 * client-side Cordis proxy rejects undeclared service access
 * ("cannot get property X without inject"), so keep this in sync with the
 * properties `apply` actually touches.
 */
export const inject = ['locale', 'configForms', 'slots'];

type FieldKey =
  | 'resultMaxChars' | 'resultMaxItems' | 'sessionMaxItems' | 'sessionMaxChars'
  | 'logLevel' | 'autoApproveEscalations' | 'surface';

interface FieldSpec {
  key: FieldKey;
  labelKey: DotMcpLocaleKey;
  kind: 'number' | 'boolean' | 'enum';
  options?: readonly string[];
}

const EDITABLE_FIELDS: readonly FieldSpec[] = [
  { key: 'resultMaxChars', labelKey: 'fieldResultMaxChars', kind: 'number' },
  { key: 'resultMaxItems', labelKey: 'fieldResultMaxItems', kind: 'number' },
  { key: 'sessionMaxItems', labelKey: 'fieldSessionMaxItems', kind: 'number' },
  { key: 'sessionMaxChars', labelKey: 'fieldSessionMaxChars', kind: 'number' },
  { key: 'logLevel', labelKey: 'fieldLogLevel', kind: 'enum', options: ['debug', 'info', 'warn', 'error'] },
  { key: 'autoApproveEscalations', labelKey: 'fieldAutoApprove', kind: 'boolean' },
  { key: 'surface', labelKey: 'fieldSurface', kind: 'enum', options: ['core', 'full'] },
];

/** The fields the status card polls from GET <endpoint>/status. */
interface BridgeStatus {
  enabled: boolean;
  state: 'running' | 'disabled';
  health: {
    bridge: { name: string; version: string; started_at: string };
    dsh: { version: string };
    runtime: { pid: number; uptimeMs: number };
    sessions: { live: number; persisted: number; active: number };
  };
}

type StatusFetch =
  | { phase: 'loading' }
  | { phase: 'ok'; data: BridgeStatus }
  | { phase: 'error' };

/* ── DeepSeek-native design tokens (theme-agnostic via currentColor) ── */

const ACCENT = '#4d6bfe';
const DANGER = '#d9403f';
const OK = '#12a35c';

const wrap: React.CSSProperties = { maxWidth: 680, padding: '16px 14px 24px', fontSize: 13, lineHeight: 1.55 };
const card: React.CSSProperties = {
  border: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
  borderRadius: 12,
  padding: '14px 16px',
  marginBottom: 14,
  background: 'color-mix(in srgb, currentColor 2%, transparent)',
};
const sectionTitle: React.CSSProperties = { margin: 0, fontSize: 13, fontWeight: 600, opacity: 0.85, letterSpacing: 0.2 };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid color-mix(in srgb, currentColor 8%, transparent)' };
const rowLast: React.CSSProperties = { ...row, borderBottom: 'none' };
const label: React.CSSProperties = { flex: 1, fontSize: 13, opacity: 0.8 };
const readOnlyBox: React.CSSProperties = { fontSize: 13, opacity: 0.6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' };
const badge: React.CSSProperties = { fontSize: 11, padding: '1px 7px', borderRadius: 999, background: 'color-mix(in srgb, currentColor 10%, transparent)' };
const hint: React.CSSProperties = { fontSize: 12, opacity: 0.55, margin: '10px 0 0' };
const warnText: React.CSSProperties = { ...hint, color: '#b45309', opacity: 1 };
const dot = (color: string): React.CSSProperties => ({
  width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0,
  boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 22%, transparent)`,
});
const mono: React.CSSProperties = { fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', opacity: 0.75 };
const buttonBase: React.CSSProperties = {
  fontSize: 12.5, borderRadius: 8, padding: '6px 14px', cursor: 'pointer',
  border: '1px solid color-mix(in srgb, currentColor 16%, transparent)', background: 'transparent', color: 'inherit',
  transition: 'opacity .15s ease',
};
const buttonPrimary: React.CSSProperties = { ...buttonBase, background: ACCENT, borderColor: ACCENT, color: '#fff' };
const buttonDanger: React.CSSProperties = { ...buttonBase, borderColor: `color-mix(in srgb, ${DANGER} 45%, transparent)`, color: DANGER };
const buttonGhost: React.CSSProperties = { ...buttonBase, padding: '3px 9px', fontSize: 12 };
const statCell: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 };
const statNum: React.CSSProperties = { fontSize: 17, fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 };
const statName: React.CSSProperties = { fontSize: 11.5, opacity: 0.55 };

function fmtUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

/** Whether the raw user layer carries an override for one field (presence, not value). */
function hasOverride(user: unknown, key: FieldKey): boolean {
  return user !== null && typeof user === 'object' && !Array.isArray(user)
    && Object.hasOwn(user as Record<string, unknown>, key);
}

function useBridgeStatus(statusUrl: string, refreshKey: number): StatusFetch {
  const [state, setState] = useState<StatusFetch>({ phase: 'loading' });
  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(statusUrl, { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const data: BridgeStatus = await res.json();
        if (alive) setState({ phase: 'ok', data });
      } catch {
        if (alive) setState({ phase: 'error' });
      }
    };
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [statusUrl, refreshKey]);
  return state;
}

export interface DotMcpTabProps {
  t: (key: DotMcpLocaleKey) => string;
  form: ConfigFormFace;
}

/* ── status card: live state + endpoint + stop/restart/resume ── */

function StatusCard({ t, form, endpoint, statusUrl, onChanged }: {
  t: (key: DotMcpLocaleKey) => string;
  form: ConfigFormFace;
  endpoint: string;
  statusUrl: string;
  onChanged: () => void;
}): React.JSX.Element {
  const snap = useSyncExternalStore(form.subscribe.bind(form), form.getSnapshot.bind(form));
  const [refreshKey, setRefreshKey] = useState(0);
  const status = useBridgeStatus(statusUrl, refreshKey);
  const [busy, setBusy] = useState<'restart' | 'toggle' | null>(null);
  const [copied, setCopied] = useState(false);

  const enabled = snap.status === 'ready' ? Boolean(snap.value?.enabled ?? CONFIG_DEFAULTS.enabled) : true;
  const liveState: 'running' | 'stopped' | 'unreachable' | 'loading' =
    status.phase === 'loading' ? 'loading'
      : status.phase === 'error' ? 'unreachable'
        : status.data.enabled && enabled ? 'running' : 'stopped';
  const stateColor = liveState === 'running' ? OK : liveState === 'stopped' ? DANGER : liveState === 'loading' ? '#8a8f99' : '#b45309';
  const stateText = liveState === 'running' ? t('stateRunning') : liveState === 'stopped' ? t('stateStopped') : liveState === 'unreachable' ? t('stateUnreachable') : t('stateLoading');

  const copyEndpoint = (): void => {
    void navigator.clipboard?.writeText(endpoint).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const toggle = async (): Promise<void> => {
    setBusy('toggle');
    try {
      await form.set('enabled', !enabled);
      setTimeout(() => setRefreshKey((k) => k + 1), 500);
    } finally {
      setBusy(null);
    }
  };
  const restart = async (): Promise<void> => {
    setBusy('restart');
    try {
      await form.set('enabled', false);
      await new Promise((resolve) => setTimeout(resolve, 800));
      await form.set('enabled', true);
      setTimeout(() => { setRefreshKey((k) => k + 1); onChanged(); }, 500);
    } finally {
      setBusy(null);
    }
  };

  const health = status.phase === 'ok' ? status.data.health : undefined;
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={dot(stateColor)} />
        <h3 style={sectionTitle}>{t('sectionStatus')}</h3>
        <span style={{ ...badge, color: stateColor, background: `color-mix(in srgb, ${stateColor} 14%, transparent)` }}>{stateText}</span>
        <span style={{ flex: 1 }} />
        <button type="button" style={buttonPrimary} disabled={busy !== null} onClick={() => void restart()}>
          {busy === 'restart' ? t('restarting') : t('restartService')}
        </button>
        <button
          type="button"
          style={enabled ? buttonDanger : { ...buttonBase, color: OK, borderColor: `color-mix(in srgb, ${OK} 45%, transparent)` }}
          disabled={busy !== null}
          onClick={() => void toggle()}
        >
          {enabled ? t('stopService') : t('resumeService')}
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
        <span style={{ ...label, flex: 'none' }}>{t('endpoint')}</span>
        <span style={mono}>{endpoint}</span>
        <button type="button" style={buttonGhost} onClick={copyEndpoint}>{copied ? t('copied') : t('copy')}</button>
      </div>

      {health !== undefined && (
        <>
          <div style={{ display: 'flex', gap: 18, margin: '12px 0 4px' }}>
            <div style={statCell}><span style={statNum}>{health.sessions.live}</span><span style={statName}>{t('liveSessions')}</span></div>
            <div style={statCell}><span style={statNum}>{health.sessions.active}</span><span style={statName}>{t('runningTasks')}</span></div>
            <div style={statCell}><span style={statNum}>{health.sessions.persisted}</span><span style={statName}>{t('persistedSessions')}</span></div>
            <div style={statCell}><span style={statNum}>{fmtUptime(health.runtime.uptimeMs)}</span><span style={statName}>{t('uptime')}</span></div>
          </div>
          <div style={{ ...mono, marginTop: 8 }}>
            {t('bridgeVersion')} v{health.bridge.version} · {t('dshVersion')} {health.dsh.version} · {t('pid')} {health.runtime.pid}
          </div>
        </>
      )}
      {liveState === 'stopped' && <p style={warnText}>{t('stoppedHint')}</p>}
      {liveState === 'unreachable' && <p style={hint}>{t('unreachableHint')}</p>}
    </div>
  );
}

/* ── volatile config editor ── */

function EditableRow({ spec, t, form }: { spec: FieldSpec; t: (key: DotMcpLocaleKey) => string; form: ConfigFormFace }): React.JSX.Element {
  const snap = useSyncExternalStore(form.subscribe.bind(form), form.getSnapshot.bind(form));
  const value = snap.value?.[spec.key] ?? CONFIG_DEFAULTS[spec.key];
  const overridden = hasOverride(snap.user, spec.key);
  const disabled = !snap.writable;

  const write = (next: unknown): void => {
    void form.set(spec.key, next);
  };
  const reset = (): void => {
    void form.unset(spec.key);
  };

  const inputStyle: React.CSSProperties = {
    fontSize: 13, borderRadius: 7, padding: '4px 8px', width: 110,
    border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
    background: 'transparent', color: 'inherit',
  };

  return (
    <div style={rowLast}>
      <span style={label}>{t(spec.labelKey)}</span>
      {spec.kind === 'number' && (
        <input
          key={`${spec.key}:${String(value)}`}
          type="number"
          defaultValue={Number(value)}
          disabled={disabled}
          onBlur={(event) => {
            const next = Number(event.currentTarget.value);
            if (event.currentTarget.validity.valid && Number.isFinite(next)) write(next);
          }}
          style={inputStyle}
        />
      )}
      {spec.kind === 'boolean' && (
        <input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(event) => write(event.currentTarget.checked)} />
      )}
      {spec.kind === 'enum' && (
        <select value={String(value)} disabled={disabled} onChange={(event) => write(event.currentTarget.value)} style={{ ...inputStyle, width: 'auto' }}>
          {spec.options!.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      )}
      {overridden
        ? <button type="button" onClick={reset} disabled={disabled} style={{ ...buttonGhost, fontSize: 12 }}>{t('overridden')} · {t('reset')}</button>
        : <span style={badge}>{String(CONFIG_DEFAULTS[spec.key])}</span>}
    </div>
  );
}

function ConfigCard({ t, form }: { t: (key: DotMcpLocaleKey) => string; form: ConfigFormFace }): React.JSX.Element {
  const snap = useSyncExternalStore(form.subscribe.bind(form), form.getSnapshot.bind(form));
  return (
    <>
      <div style={card}>
        <h3 style={sectionTitle}>{t('sectionBind')}</h3>
        <div style={{ ...row, marginTop: 6 }}><span style={label}>{t('fieldTransport')}</span><span style={readOnlyBox}>{CONFIG_DEFAULTS.transport}</span></div>
        <div style={row}><span style={label}>{t('fieldHost')}</span><span style={readOnlyBox}>{CONFIG_DEFAULTS.host}</span></div>
        <div style={rowLast}><span style={label}>{t('fieldPort')}</span><span style={readOnlyBox}>{CONFIG_DEFAULTS.port}</span></div>
        <p style={hint}>{t('readonlyHint')}</p>
      </div>

      <div style={card}>
        <h3 style={sectionTitle}>{t('sectionBudgets')}</h3>
        {snap.status === 'loading' && <p style={hint}>{t('loading')}</p>}
        {snap.status === 'unavailable' && <p style={hint}>{t('unavailable')}</p>}
        {snap.status === 'ready' && EDITABLE_FIELDS.filter((spec) => spec.kind === 'number').map((spec) => (
          <EditableRow key={spec.key} spec={spec} t={t} form={form} />
        ))}
      </div>

      <div style={card}>
        <h3 style={sectionTitle}>{t('sectionBehavior')}</h3>
        {snap.status === 'ready' && EDITABLE_FIELDS.filter((spec) => spec.kind !== 'number').map((spec) => (
          <EditableRow key={spec.key} spec={spec} t={t} form={form} />
        ))}
        {snap.status === 'ready' && Boolean((snap.value)?.autoApproveEscalations) && (
          <p style={warnText}>{t('autoApproveWarn')}</p>
        )}
        {snap.status === 'ready' && <p style={hint}>{t('volatileHint')}</p>}
      </div>
    </>
  );
}

export function DotMcpTab({ t, form }: DotMcpTabProps): React.JSX.Element {
  const snap = useSyncExternalStore(form.subscribe.bind(form), form.getSnapshot.bind(form));
  const host = typeof snap.value?.host === 'string' ? String(snap.value.host) : CONFIG_DEFAULTS.host;
  const port = typeof snap.value?.port === 'number' ? Number(snap.value.port) : CONFIG_DEFAULTS.port;
  const endpoint = `http://${host}:${port}/mcp`;

  return (
    <div style={wrap}>
      <StatusCard
        t={t}
        form={form}
        endpoint={endpoint}
        statusUrl={`http://${host}:${port}/status`}
        onChanged={() => undefined}
      />
      <ConfigCard t={t} form={form} />
    </div>
  );
}

/** Browser half entry, loaded by the GUI module loader as package row `dot-mcp`. */
export function apply(ctx: unknown): void {
  const context = ctx as ClientContextFace;
  context.effect(() => context.locale.register(NS, { zh, en }), 'dsh-dot-mcp: dictionaries');
  const t = context.locale.bind(NS) as (key: DotMcpLocaleKey) => string;
  const form = context.configForms.get(NS);
  context.effect(() => context.configForms.whileServed([NS], () =>
    context.slots.inject('settings.plugins.tab', () => context.slots.register({
      name: 'settings.plugins.tab',
      id: NS,
      order: 20,
      label: () => t('tab'),
      locale: NS,
      inject: () => ({ t, form }),
    }, DotMcpTab)) ?? (() => {})), 'dsh-dot-mcp: settings tab');
}
