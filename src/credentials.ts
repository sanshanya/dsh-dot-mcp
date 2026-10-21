/**
 * Provider-credential status, plaintext values included.
 *
 * The bridge keeps no redaction posture (see README, "Security posture"): the
 * caller already holds the machine's permissions, so hiding the secret adds
 * friction, not security. Each configured ref comes back with availability,
 * source and the value itself. Feeds `dsh_credential_status`; the structured
 * result schema still consumes only the refs (`credentialRefs`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CredentialStatus {
  credentialAvailable: boolean;
  credentialRef: string;
  credentialSource: 'env' | 'credentials_store' | 'runtime' | 'none';
  /** Plaintext secret when the winning source can be read; never redacted. */
  credentialValue?: string;
}

/** Refs a driver can act on: the provider keys DSH itself can be configured with. */
const ENV_CREDENTIAL_REFS = [
  'NUBE_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DSH_API_KEY',
] as const;

const STORE_NAMED_REFS = new Set<string>(ENV_CREDENTIAL_REFS);
const YAML_PAIR = /^([A-Za-z_][\w.-]*)\s*:\s*(.*?)\s*$/;
/** Lower rank wins when the same ref is configured in several places. */
const SOURCE_RANK: Record<CredentialStatus['credentialSource'], number> = {
  env: 0,
  credentials_store: 1,
  runtime: 2,
  none: 3,
};

function collectCredentialEntriesFromYaml(text: string): { ref: string; value?: string }[] {
  const entries: { ref: string; value?: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = trimmed.match(YAML_PAIR);
    if (match === null) continue;
    const raw = (match[2] ?? '').trim();
    const unquoted = raw.replace(/^(["'])(.*)\1$/, '$2');
    entries.push({ ref: match[1] as string, ...(unquoted === '' ? {} : { value: unquoted }) });
  }
  return entries;
}

function upsertCredential(
  byRef: Map<string, CredentialStatus>,
  ref: string,
  source: CredentialStatus['credentialSource'],
  value: string | undefined,
): void {
  const next: CredentialStatus = {
    credentialAvailable: true,
    credentialRef: ref,
    credentialSource: source,
    ...(value === undefined ? {} : { credentialValue: value }),
  };
  const existing = byRef.get(ref);
  if (existing === undefined || SOURCE_RANK[source] < SOURCE_RANK[existing.credentialSource]) {
    byRef.set(ref, next);
  }
}

/** Inspect provider credentials, returning the plaintext value of each readable ref. */
export function inspectCredentials(input: {
  env?: Record<string, string | undefined>;
  dshHome?: string;
  runtimeKeyConfigured?: boolean;
}): CredentialStatus[] {
  const byRef = new Map<string, CredentialStatus>();
  const env = input.env ?? {};

  for (const ref of ENV_CREDENTIAL_REFS) {
    const value = env[ref];
    if (typeof value === 'string' && value.trim() !== '') {
      upsertCredential(byRef, ref, 'env', value.trim());
    }
  }

  const home = input.dshHome?.trim() ?? '';
  if (home !== '') {
    const candidates = [
      join(home, 'credentials.yaml'),
      join(home, '.credentials.yaml'),
      join(home, 'credentials.yml'),
      join(home, '.credentials.yml'),
    ];
    for (const file of candidates) {
      if (!existsSync(file)) continue;
      let text = '';
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const entries = collectCredentialEntriesFromYaml(text);
      let named = false;
      for (const entry of entries) {
        if (STORE_NAMED_REFS.has(entry.ref)) {
          upsertCredential(byRef, entry.ref, 'credentials_store', entry.value);
          named = true;
        }
      }
      // No named ref: report the generic shape; the value cannot be mapped.
      if (!named && entries.length > 0) {
        upsertCredential(byRef, 'PROVIDER_API_KEY', 'credentials_store', undefined);
      }
    }
  }

  if (input.runtimeKeyConfigured === true) {
    // The runtime store hands a yes/no, not the value itself.
    upsertCredential(byRef, 'RUNTIME_API_KEY', 'runtime', undefined);
  }

  const results = [...byRef.values()];
  if (results.length === 0) {
    return [{ credentialAvailable: false, credentialRef: 'PROVIDER_API_KEY', credentialSource: 'none' }];
  }
  return results;
}
