// SecretStore — PAT storage generalized over operating systems, zero native deps.
//
// One interface, pluggable providers. Each provider implements
// { name, available(), get(key), set(key, value), delete(key) } and wraps an
// OS-native credential facility through tools guaranteed (or overwhelmingly
// likely) to exist on that OS — no compiled modules, nothing to approve on an
// internal registry:
//
//   env       JIRA_PAT / CONFLUENCE_PAT vars        every OS, read-only, always first
//   keychain  macOS `security` CLI                  ships with macOS
//   dpapi     Windows DPAPI via PowerShell          ships with Windows
//   libsecret Linux `secret-tool` (GNOME keyring)   common on desktop Linux
//
// Reads: env always wins (CI / locked-down override), then the first available
// platform store. Writes: first available platform store; if none, a clear
// error naming the env-var escape hatch — the tool degrades, never dies.
// Adding an OS = adding one provider object; no caller changes.
//
// Secrets never ride an argv where the OS gives us a choice: the Windows and
// Linux providers pass the value via the child's environment / stdin. macOS
// `security` accepts the value only as -w <arg> (same-user-visible for the
// milliseconds it runs) — accepted for dev machines; the HSBC target is DPAPI.
//
// See docs/spec-17-knowledge-sources-and-context-layer.md §3.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SERVICE = 'testo-harness';

function envVarFor(key) {
  // "jira:host" → JIRA_PAT, "confluence:host" → CONFLUENCE_PAT
  const source = key.split(':')[0].toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `${source}_PAT`;
}

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const hasCmd = (cmd) =>
  run(process.platform === 'win32' ? 'where' : 'which', [cmd]).status === 0;

// ── providers ──────────────────────────────────────────────────────────────

const envProvider = {
  name: 'env',
  available: () => true,
  get: (key) => process.env[envVarFor(key)] ?? null,
  set: null,          // read-only by nature
  delete: () => {},
};

const keychainProvider = {
  name: 'keychain',
  available: () => process.platform === 'darwin',
  get(key) {
    const r = run('security', ['find-generic-password', '-a', key, '-s', SERVICE, '-w']);
    return r.status === 0 && r.stdout ? r.stdout.trim() : null;   // status 44 = not found
  },
  set(key, value) {
    const r = run('security', ['add-generic-password', '-U', '-a', key, '-s', SERVICE, '-w', value]);
    if (r.status !== 0) throw new Error(`keychain write failed (exit ${r.status})`);
  },
  delete(key) { run('security', ['delete-generic-password', '-a', key, '-s', SERVICE]); },
};

const dpapiProvider = {
  name: 'dpapi',
  available: () => process.platform === 'win32',
  _dir: () => path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), SERVICE, 'secrets'),
  _file(key) { return path.join(this._dir(), key.replace(/[^a-zA-Z0-9._-]/g, '_') + '.dat'); },
  _ps: (script, extraEnv = {}) =>
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { env: { ...process.env, ...extraEnv } }),
  get(key) {
    const file = this._file(key);
    if (!fs.existsSync(file)) return null;
    const r = this._ps(
      `$ss = Get-Content -Raw '${file}' | ConvertTo-SecureString; ` +
      `$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss); ` +
      `[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)`);
    return r.status === 0 && r.stdout ? r.stdout.trim() : null;
  },
  set(key, value) {
    fs.mkdirSync(this._dir(), { recursive: true });
    // Value travels via the child's environment, never argv.
    const r = this._ps(
      `$plain = $env:TESTO_SECRET_VALUE; ` +
      `ConvertTo-SecureString -String $plain -AsPlainText -Force | ConvertFrom-SecureString | ` +
      `Set-Content '${this._file(key)}'`,
      { TESTO_SECRET_VALUE: value });
    if (r.status !== 0) throw new Error(`DPAPI write failed: ${r.stderr}`);
  },
  delete(key) { fs.rmSync(this._file(key), { force: true }); },
};

const libsecretProvider = {
  name: 'libsecret',
  available: () => process.platform === 'linux' && hasCmd('secret-tool'),
  get(key) {
    const r = run('secret-tool', ['lookup', 'service', SERVICE, 'account', key]);
    return r.status === 0 && r.stdout ? r.stdout.trim() : null;
  },
  set(key, value) {
    // secret-tool reads the value from stdin — never argv.
    const r = run('secret-tool',
      ['store', `--label=${SERVICE} ${key}`, 'service', SERVICE, 'account', key],
      { input: value });
    if (r.status !== 0) throw new Error(`libsecret write failed: ${r.stderr}`);
  },
  delete(key) { run('secret-tool', ['clear', 'service', SERVICE, 'account', key]); },
};

// Order matters: env is consulted first on reads; the rest are platform stores
// of which at most one is available on any given machine.
const PROVIDERS = [envProvider, keychainProvider, dpapiProvider, libsecretProvider];

const platformStore = () =>
  PROVIDERS.find((p) => p.set && p.available()) ?? null;

// ── public interface (unchanged for callers) ───────────────────────────────

/** Name of the store setSecret would use on this machine, or 'env-only'. */
export function secretProvider() {
  return platformStore()?.name ?? 'env-only';
}

/** → { value, from } | null. Env always wins, then the platform store. */
export function getSecret(key) {
  for (const p of PROVIDERS) {
    if (!p.available()) continue;
    const value = p.get(key);
    if (value) return { value, from: p.name };
  }
  return null;
}

/** → provider name used. Throws with the env-var escape hatch if no store exists. */
export function setSecret(key, value) {
  const store = platformStore();
  if (!store) {
    throw new Error(
      `no OS secret store available on ${process.platform} — export ${envVarFor(key)} instead`);
  }
  store.set(key, value);
  return store.name;
}

export function deleteSecret(key) {
  for (const p of PROVIDERS) if (p.available()) p.delete(key);
}
