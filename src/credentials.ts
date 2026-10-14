/**
 * Provider-credential availability, never credential values.
 *
 * Where a key is configured (environment, the DSH credentials store, or the
 * runtime selection) is what a driver needs to explain a missing-model failure;
 * the secret itself is never read out, returned, or logged. Feeds
 * `dsh_credential_status` and the `credentialRefs` input of the structured
 * result schema.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CredentialStatus {
  credentialAvailable: boolean;
  credentialRef: string;
  credentialSource: 'env' | 'credentials_store' | 'runtime' | 'none';
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
const YAML_KEY = /^([A-Za-z_][\w.-]*)\s*:/;
/** Lower rank wins when the same ref is configured in several places. */
const SOURCE_RANK: Record<CredentialStatus['credentialSource'], number> = {
  env: 0,
  credentials_store: 1,
  runtime: 2,
  none: 3,
};

function collectCredentialKeysFromYaml(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = trimmed.match(YAML_KEY);
    if (match?.[1]) keys.push(match[1]);
  }
  return keys;
}

function upsertCredential(
  byRef: Map<string, CredentialStatus>,
  ref: string,
  source: CredentialStatus['credentialSource'],
  available: boolean,
): void {
  if (!available) return;
  const next: CredentialStatus = { credentialAvailable: true, credentialRef: ref, credentialSource: source };
  const existing = byRef.get(ref);
  if (existing === undefined || SOURCE_RANK[source] < SOURCE_RANK[existing.credentialSource]) {
    byRef.set(ref, next);
  }
}

/** Inspect availability of provider credentials without returning secret values. */
export function inspectCredentials(input: {
  env?: Record<string, string | undefined>;
  dshHome?: string;
  runtimeKeyConfigured?: boolean;
}): CredentialStatus[] {
  const byRef = new Map<string, CredentialStatus>();
  const env = input.env ?? {};

  for (const ref of ENV_CREDENTIAL_REFS) {
    const value = env[ref];
    upsertCredential(byRef, ref, 'env', typeof value === 'string' && value.trim() !== '');
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
      const keys = collectCredentialKeysFromYaml(text);
      let named = false;
      for (const key of keys) {
        if (STORE_NAMED_REFS.has(key)) {
          upsertCredential(byRef, key, 'credentials_store', true);
          named = true;
        }
      }
      if (!named && keys.length > 0) {
        upsertCredential(byRef, 'PROVIDER_API_KEY', 'credentials_store', true);
      }
    }
  }

  if (input.runtimeKeyConfigured === true) {
    upsertCredential(byRef, 'RUNTIME_API_KEY', 'runtime', true);
  }

  const results = [...byRef.values()];
  if (results.length === 0) {
    return [{ credentialAvailable: false, credentialRef: 'PROVIDER_API_KEY', credentialSource: 'none' }];
  }
  return results;
}