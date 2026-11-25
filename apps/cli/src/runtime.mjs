import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Where cxdt runs from. A package (scripts/package-cli.mjs) holds cxdt.mjs with `vendor/` beside it: on Windows the
// OpenSSH and PowerShell that the SSH service for Claude's commands is made of, as the desktop installer bundles
// them. The cxdt the desktop client carries is in its resources, beside the client's own `vendor/`. From the source
// tree they are the ones prepared for the desktop client.
const here = fileURLToPath(new URL('.', import.meta.url));
const vendor =
  [join(here, 'vendor'), join(here, '..', 'vendor')].find((directory) => existsSync(directory)) ??
  fileURLToPath(new URL('../../desktop/vendor/', import.meta.url));

export const components = (env = process.env) => ({
  openssh: env.CXDT_OPENSSH_DIR ?? join(vendor, 'openssh'),
  powershell:
    env.CXDT_POWERSHELL ??
    (existsSync(join(vendor, 'pwsh', 'pwsh.exe')) ? join(vendor, 'pwsh', 'pwsh.exe') : 'pwsh.exe'),
});

// Started from Git Bash (GIT_BASH_LAUNCHER in scripts/package-desktop.mjs), cxdt has its arguments as written, which
// those variables asked MSYS2 for. They would reach all cxdt starts, its SSH service and through it Claude's commands,
// whose Git Bash has to turn paths as it always does: they go before anything is started.
export function argumentsAsWritten(env = process.env) {
  if (!env.CXDT_ARGUMENTS_AS_WRITTEN) return;
  for (const name of ['CXDT_ARGUMENTS_AS_WRITTEN', 'MSYS_NO_PATHCONV', 'MSYS2_ARG_CONV_EXCL'])
    delete env[name];
}

// The release cxdt belongs to, which is the one of the service it speaks to: the package writes it in.
export const version =
  typeof __CXDT_VERSION__ === 'string'
    ? __CXDT_VERSION__
    : JSON.parse(readFileSync(new URL('../../desktop/package.json', import.meta.url), 'utf8'))
        .version;

// cxdt runs from a package (scripts/package-cli.mjs), which it can replace with another release's, rather than from
// the source tree.
export const bundled = typeof __CXDT_VERSION__ === 'string';

// The cxdt the desktop client carries, which the client's updates replace (scripts/package-windows.mjs and the
// macOS and Linux ones).
export const desktop = typeof __CXDT_DESKTOP__ === 'boolean' && __CXDT_DESKTOP__;

// The name of the cxdt package of a release for a system, as the release page has it; undefined for a system there
// is none for.
const SYSTEMS = {
  'win32-x64': 'windows-x64',
  'darwin-arm64': 'mac-arm64',
  'darwin-x64': 'mac-x64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
};
export const packageName = (release, system = `${process.platform}-${process.arch}`) => {
  const name = SYSTEMS[system];
  return name && `cxdt-${release}-${name}.${name.startsWith('windows') ? 'zip' : 'tar.gz'}`;
};

export const releasePage = (release) =>
  `https://github.com/zhenxiang-ding/codex-desk-tunnel/releases/tag/v${release}`;
