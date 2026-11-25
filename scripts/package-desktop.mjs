import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { builtinModules, createRequire } from 'node:module';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { build as viteBuild } from 'vite';

// A package the program loads by name while it runs, copied with what it depends on. Compiled add-ons are
// left out: they are optional speed-ups built for the Node of the machine that installed them, not for the
// Electron of the package, and the package falls back to its JavaScript.
export function copyDependency(root, app, name, copied = new Set()) {
  if (copied.has(name)) return;
  copied.add(name);
  const source = dirname(createRequire(join(root, 'package.json')).resolve(`${name}/package.json`));
  const destination = join(app, 'node_modules', name);
  cpSync(source, destination, {
    recursive: true,
    filter: (path) =>
      !/(?:^|[\\/])(?:node_modules|test|tests|examples|build)(?:[\\/]|$)/.test(
        path.slice(source.length),
      ) && !path.endsWith('.node'),
  });
  const manifest = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8'));
  delete manifest.optionalDependencies;
  delete manifest.scripts;
  writeFileSync(join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const dependency of Object.keys(manifest.dependencies ?? {}))
    copyDependency(root, app, dependency, copied);
  return manifest.version;
}

// What a package for macOS or Linux takes beside the common part: the modules of the SSH service's own
// process, which it loads by path next to the bundled bridge, and the SSH library they use. The Windows
// package has neither: its SSH service is the bundled OpenSSH.
export const posixService = {
  files: [
    'posix-ssh-worker.mjs',
    'process-supervisor.mjs',
    'shell-environment.mjs',
    'ssh-keys.mjs',
    'ssh-channel-output.mjs',
    'ssh2-hardening.mjs',
  ],
  dependencies: ['ssh2'],
};

// Lays out what goes into the application archive, the same way for every system: the page, the connection
// bridge with what it imports bundled into one file, and the main process's own modules as written.
// `files` are the further files of apps/desktop/electron that this system's package needs; `dependencies`
// are packages a separately started process of the program loads, which no bundle holds. The SSH library is
// always one of them: the file panel's SFTP uses it in the main process (files.mjs), and it is not bundled for
// its optional native parts.
export async function stageDesktop(root, app, { description, files = [], dependencies: own = [] }) {
  const dependencies = [...new Set(['ssh2', ...own])];
  mkdirSync(app, { recursive: true });
  rmSync(join(app, 'node_modules'), { recursive: true, force: true });
  await viteBuild({
    root: join(root, 'apps/desktop'),
    build: { outDir: join(app, 'dist'), emptyOutDir: true },
  });
  await viteBuild({
    configFile: false,
    root,
    // A package is for one system, the one it is built on. With that written into the bridge, what it would
    // only do on another system falls out of the bundle: the Windows package holds nothing of the SSH
    // service of macOS and Linux, and theirs nothing of the one of Windows.
    define: { 'process.platform': JSON.stringify(process.platform) },
    ssr: { noExternal: true },
    build: {
      ssr: true,
      target: 'node24',
      outDir: join(app, 'electron'),
      emptyOutDir: true,
      rolldownOptions: {
        input: join(root, 'apps/desktop/electron/proxy-bridge.mjs'),
        external: [
          ...builtinModules,
          ...builtinModules.map((name) => `node:${name}`),
          'bufferutil',
          'utf-8-validate',
          ...dependencies,
        ],
        output: { format: 'es', entryFileNames: 'proxy-bridge.mjs', codeSplitting: false },
      },
    },
  });
  // All CommonJS modules ship as written, including helpers required by main/preload.
  // The ESM bridge and its dependencies are already in the bundle above; the release download and opening a
  // session in cxdt need only Node.
  const commonjs = readdirSync(join(root, 'apps/desktop/electron')).filter((file) =>
    file.endsWith('.cjs'),
  );
  for (const file of [...commonjs, 'release-download.mjs', 'cxdt.mjs', 'icon.png', ...files])
    cpSync(join(root, 'apps/desktop/electron', file), join(app, 'electron', file));
  // A file the main process loads by path is only missed when its feature is used, so each is looked for here.
  for (const file of commonjs)
    for (const [, name] of readFileSync(join(app, 'electron', file), 'utf8').matchAll(
      /path\.join\(__dirname, '([^']+)'\)/g,
    ))
      if (!name.startsWith('../vendor') && !existsSync(join(app, 'electron', name)))
        throw new Error(`${file} loads ${name}, which is not in the package.`);
  const versions = Object.fromEntries(
    dependencies.map((name) => [name, copyDependency(root, app, name)]),
  );
  // The staging manifest names only what was copied beside the bundle: the bridge and protocol are in it.
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify(
      {
        name: 'cc-desk-tunnel',
        productName: 'Codex Desk Tunnel',
        // The desktop workspace manifest is the single source of the client version.
        version: JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).version,
        description,
        author: 'CC Desk Tunnel contributors',
        private: true,
        main: 'electron/main.cjs',
        type: 'module',
        ...(dependencies.length ? { dependencies: versions } : {}),
      },
      null,
      2,
    ) + '\n',
  );
}

// cxdt, the terminal client, with what it imports bundled into one cxdt.mjs in `outDir`, and the scripts of its SSH
// service that it loads by path beside it. `desktop`: the cxdt the desktop package carries, run by the desktop's own
// program and updated with it rather than by itself.
export async function bundleCxdt(root, outDir, { version, desktop = false }) {
  const windows = process.platform === 'win32';
  await viteBuild({
    configFile: false,
    root,
    logLevel: 'warn',
    // As for the desktop bridge: a package is for the system it is built on, and holds only what that one runs.
    define: {
      'process.platform': JSON.stringify(process.platform),
      __CXDT_VERSION__: JSON.stringify(version),
      __CXDT_DESKTOP__: JSON.stringify(desktop),
    },
    ssr: { noExternal: true },
    build: {
      ssr: true,
      target: 'node24',
      outDir,
      emptyOutDir: false,
      rolldownOptions: {
        input: join(root, 'apps/cli/bin/cxdt.mjs'),
        external: [
          ...builtinModules,
          ...builtinModules.map((name) => `node:${name}`),
          'bufferutil',
          'utf-8-validate',
          // The file panel's SFTP client, which the bridge loads only when the panel is used; cxdt has no panel.
          'ssh2',
          ...(windows ? [] : posixService.dependencies),
        ],
        output: { format: 'es', entryFileNames: 'cxdt.mjs', codeSplitting: false },
      },
    },
  });
  const electron = join(root, 'apps/desktop/electron');
  for (const file of windows ? ['prepare-ssh.ps1', 'component-host.ps1'] : posixService.files)
    cpSync(join(electron, file), join(outDir, file));
}

// cxdt as a package lays it out in `directory`, on its own (scripts/package-cli.mjs) or inside a desktop package
// (`desktop`): cxdt.mjs with the files of its SSH service, the Node it runs with, and what starts it. On Windows that
// is cxdt.cmd, and `cxdt` for Git Bash; elsewhere bin/cxdt, with the modules of the SSH service. `arch`: of the
// package, whose Node it gets.
export async function stageCxdt(
  root,
  directory,
  { version, desktop = false, arch = process.arch },
) {
  mkdirSync(directory, { recursive: true });
  for (const name of ['LICENSE', 'NOTICE']) cpSync(join(root, name), join(directory, name));
  await bundleCxdt(root, directory, { version, desktop });
  if (process.platform === 'win32') {
    writeFileSync(join(directory, 'cxdt.cmd'), WINDOWS_LAUNCHER);
    writeFileSync(join(directory, 'cxdt'), GIT_BASH_LAUNCHER);
  } else {
    for (const name of posixService.dependencies) copyDependency(root, directory, name);
    mkdirSync(join(directory, 'bin'), { recursive: true });
    writeFileSync(join(directory, 'bin', 'cxdt'), POSIX_LAUNCHER);
    chmodSync(join(directory, 'bin', 'cxdt'), 0o755);
  }
  await addNode(root, directory, arch);
}

// The staged cxdt as an electron-builder resource. electron-builder leaves out the node_modules at the root of
// what it copies, which would drop the SSH library: it copies from the parent, keeping only cxdt.
export function cxdtResource(directory) {
  return { from: dirname(directory), to: '.', filter: [`${basename(directory)}/**/*`] };
}

// Git Bash, which a Windows agent may run its commands in, as Claude Code does.
function gitBash() {
  const program = process.env.ProgramFiles ?? 'C:\\Program Files';
  return [
    join(program, 'Git', 'bin', 'bash.exe'),
    join(program, 'Git', 'usr', 'bin', 'bash.exe'),
  ].find((path) => existsSync(path));
}

// The check of a packaged cxdt: it starts, says its version, and fails a sign-in to nowhere with a message instead
// of an error of its own; that loads the bundled connection. Its separately loaded POSIX SSH worker must
// also load, even when no connection has yet asked it to start. On Windows it is started from Git Bash too,
// where there is one, by the name alone.
export function checkCxdt(launcher, version) {
  const windows = process.platform === 'win32';
  const run = (args, input) =>
    execFileSync(windows ? 'cmd.exe' : launcher, windows ? ['/d', '/c', launcher, ...args] : args, {
      input,
      encoding: 'utf8',
      env: { ...process.env, CXDT_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'cxdt-check-')) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const reported = run(['--version']).trim();
  if (reported !== `cxdt ${version}`) throw new Error(`The package's cxdt reports "${reported}".`);
  if (!windows) {
    // Outside the checkout, a missing dependency cannot be borrowed from its node_modules. Started without
    // an IPC channel, the worker only loads its modules and exits.
    const directory = mkdtempSync(join(tmpdir(), 'cxdt-worker-check-'));
    try {
      cpSync(dirname(dirname(launcher)), directory, { recursive: true });
      execFileSync(join(directory, 'node'), [join(directory, 'posix-ssh-worker.mjs')], {
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, NODE_PATH: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(
        `The packaged cxdt SSH worker could not load:\n${error.stderr ?? error.message}`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const bash = windows && gitBash();
  if (bash) {
    const folder = execFileSync(bash, ['-c', 'cygpath -u "$1"', '_', dirname(launcher)], {
      encoding: 'utf8',
    }).trim();
    const said = execFileSync(bash, ['-lc', 'PATH="$1:$PATH" cxdt --version', '_', folder], {
      encoding: 'utf8',
      env: { ...process.env, CXDT_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'cxdt-check-')) },
    }).trim();
    if (said !== `cxdt ${version}`) throw new Error(`cxdt in Git Bash reports "${said}".`);
  }
  try {
    run(['login', 'wss://127.0.0.1:9/ws', '--token-stdin'], 'x'.repeat(32));
    throw new Error('A sign-in to nowhere succeeded.');
  } catch (error) {
    if (error.status !== 1 || /Error:|at .+\(/.test(String(error.stderr)))
      throw new Error(`The packaged sign-in failed badly:\n${error.stderr ?? error.message}`);
  }
}

// What starts cxdt on Windows: its Node, beside it, running cxdt.mjs.
export const WINDOWS_LAUNCHER =
  '@echo off\r\n"%~dp0node.exe" "%~dp0cxdt.mjs" %*\r\nexit /b %errorlevel%\r\n';

// The same for Git Bash and the other shells of MSYS2 on Windows, which find cxdt.cmd only by its whole name. Their
// runtime would turn an argument that looks like a path into a Windows one, a task such as "/review" among them: the
// arguments go as written, and cxdt takes back the variables that said so before anything it starts sees them
// (apps/cli/src/runtime.mjs). A program without a console of its own needs winpty where the shell gives it none
// (`disable_pcon`), as Git for Windows has it for node; winpty would break a pipe, so only in a terminal.
export const GIT_BASH_LAUNCHER = `#!/bin/sh
dir=$(dirname "$0")
script=$(cygpath -w "$dir/cxdt.mjs")
run=
case "\${MSYS:-}" in
*disable_pcon*) [ -t 0 ] && [ -t 1 ] && command -v winpty >/dev/null && run=winpty ;;
esac
CXDT_ARGUMENTS_AS_WRITTEN=1 MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' exec $run "$dir/node.exe" "$script" "$@"
`;

// What starts cxdt elsewhere: bin/cxdt, which finds the package through the link it is reached by.
export const POSIX_LAUNCHER =
  '#!/bin/sh\n# cxdt with the Node it was packaged with, wherever the command is linked from.\nself=$(readlink -f "$0" 2>/dev/null || realpath "$0")\ndir=$(dirname "$(dirname "$self")")\nexec "$dir/node" "$dir/cxdt.mjs" "$@"\n';

// The Node cxdt runs with, of a pinned release, wherever cxdt is packaged: on its own and in the Windows desktop
// installer alike. From https://nodejs.org/dist/v24.22.2/SHASUMS256.txt.
const NODE = '24.22.2';
export const nodeRuntimes = {
  'win32-x64': ['win-x64.zip', 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2'],
  'darwin-arm64': [
    'darwin-arm64.tar.gz',
    'aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a',
  ],
  'darwin-x64': [
    'darwin-x64.tar.gz',
    'd5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52',
  ],
  'linux-x64': [
    'linux-x64.tar.gz',
    '361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9',
  ],
  'linux-arm64': [
    'linux-arm64.tar.gz',
    '95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2',
  ],
};

// Puts that Node, checked against the hash above, into `directory` as node.exe or node; the download is kept in
// .tools for the next build.
export async function addNode(root, directory, arch = process.arch) {
  const windows = process.platform === 'win32';
  // The system's own tar, which reads .zip on Windows; a shell may put another one first on the PATH.
  const tar = windows
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  const [suffix, sha256] = nodeRuntimes[`${process.platform}-${arch}`];
  const name = `node-v${NODE}-${suffix}`;
  const cached = join(root, '.tools', name);
  if (!existsSync(cached)) {
    const response = await fetch(`https://nodejs.org/dist/v${NODE}/${name}`);
    if (!response.ok) throw new Error(`Node download failed: ${response.status}`);
    mkdirSync(join(root, '.tools'), { recursive: true });
    writeFileSync(cached, Buffer.from(await response.arrayBuffer()));
  }
  if (createHash('sha256').update(readFileSync(cached)).digest('hex') !== sha256)
    throw new Error(`Checksum mismatch for ${name}`);
  const extracted = mkdtempSync(join(tmpdir(), 'cxdt-node-'));
  const inside = `${name.replace(/\.(zip|tar\.gz)$/, '')}/${windows ? 'node.exe' : 'bin/node'}`;
  execFileSync(tar, ['-xf', cached, '-C', extracted, inside]);
  cpSync(join(extracted, inside), join(directory, windows ? 'node.exe' : 'node'));
  rmSync(extracted, { recursive: true, force: true });
}
