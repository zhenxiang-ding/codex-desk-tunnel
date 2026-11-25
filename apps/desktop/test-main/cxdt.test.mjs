import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { linkCxdt, locate, openSession, terminalCommand } from '../electron/cxdt.mjs';

test('cxdt is the client’s own, else looked for on the PATH, then where its install script puts it', () => {
  const windows = {
    platform: 'win32',
    env: { Path: 'C:\\tools;C:\\other', LOCALAPPDATA: 'C:\\L' },
  };
  const found =
    (...files) =>
    (file) =>
      files.includes(file);
  assert.equal(locate(windows, found(join('C:\\tools', 'ccdt.cmd'))), undefined);
  assert.equal(
    locate(
      windows,
      found(join('C:\\other', 'cxdt.cmd'), join('C:\\L', 'Programs', 'cxdt', 'cxdt.cmd')),
    ),
    join('C:\\other', 'cxdt.cmd'),
  );
  assert.equal(
    locate(windows, found(join('C:\\L', 'Programs', 'cxdt', 'cxdt.cmd'))),
    join('C:\\L', 'Programs', 'cxdt', 'cxdt.cmd'),
  );
  // A Mac's programs started from the Dock do not have ~/.local/bin on their PATH.
  const mac = { platform: 'darwin', env: { PATH: '/usr/bin:/bin' }, home: '/Users/me' };
  assert.equal(
    locate(mac, found(join('/Users/me', '.local', 'bin', 'cxdt'))),
    join('/Users/me', '.local', 'bin', 'cxdt'),
  );
  assert.equal(locate(mac, found()), undefined);
  // The one the client carries comes first: it is of the client's release, whatever else is installed.
  const own = join('C:\\Program Files\\CC Desk Tunnel', 'resources', 'cxdt', 'cxdt.cmd');
  assert.equal(locate({ ...windows, own }, found(own, join('C:\\other', 'cxdt.cmd'))), own);
  // A client that carries none, run from the source tree, looks further.
  assert.equal(
    locate({ ...windows, own }, found(join('C:\\other', 'cxdt.cmd'))),
    join('C:\\other', 'cxdt.cmd'),
  );
});

test('the terminal window runs cxdt quoted for the shell that reads it, and waits on an error', () => {
  const args = ['open', '11111111-2222-4333-8444-555555555555', '--server', 'wss://a.test/ws'];
  const windows = terminalCommand(
    { platform: 'win32', env: { ComSpec: 'C:\\cmd.exe' } },
    'C:\\P F\\cxdt.cmd',
    args,
    'D:\\项目',
  );
  assert.equal(windows.file, 'C:\\cmd.exe');
  assert.deepEqual(windows.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(
    windows.args[3],
    `""C:\\P F\\cxdt.cmd" "open" "${args[1]}" "--server" "wss://a.test/ws" || pause"`,
  );
  assert.equal(windows.options.windowsVerbatimArguments, true);
  const mac = terminalCommand(
    { platform: 'darwin', env: {} },
    "/Users/o'neil/.local/bin/cxdt",
    args,
    '/Users/o\'neil/项目 "x"',
  );
  assert.equal(mac.file, 'open');
  assert.deepEqual(mac.args.slice(0, 2), ['-a', 'Terminal']);
  assert.equal(mac.args[2], mac.script.path);
  assert.match(mac.script.path, /\.command$/);
  assert.equal(
    mac.script.text,
    `#!/bin/sh\nrm -f "$0"\ncd '/Users/o'\\''neil/项目 "x"' && '/Users/o'\\''neil/.local/bin/cxdt' 'open' '${args[1]}' '--server' 'wss://a.test/ws' || read -r _\n`,
  );
  const linux = terminalCommand(
    { platform: 'linux', env: { PATH: '/usr/bin' } },
    '/home/me/.local/bin/cxdt',
    args,
    '/home/me',
    (file) => file === join('/usr/bin', 'konsole'),
  );
  assert.equal(linux.file, join('/usr/bin', 'konsole'));
  assert.deepEqual(linux.args.slice(0, 3), ['-e', 'sh', '-c']);
  assert.throws(
    () =>
      terminalCommand(
        { platform: 'linux', env: { PATH: '/usr/bin' } },
        'cxdt',
        args,
        '/',
        () => false,
      ),
    /没有找到可以打开的终端程序/,
  );
});

test('an address, session or fingerprint that would mean more to a shell is never passed on', async () => {
  const request = {
    url: 'wss://a.test/ws',
    fingerprint: 'AB:CD',
    token: 't',
    sessionId: '11111111-2222-4333-8444-555555555555',
  };
  const system = { version: '0.3.9', platform: 'linux', env: { PATH: '' }, home: '/nowhere' };
  for (const bad of [
    { url: 'wss://a.test/ws" & calc' },
    { url: 'wss://a.test/%PATH%' },
    { url: 'https://a.test/' },
    { sessionId: '1 && calc' },
    { fingerprint: 'AB;rm' },
  ])
    await assert.rejects(openSession({ ...request, ...bad }, system), /不能交给 cxdt/);
  assert.deepEqual(await openSession(request, system), { status: 'missing' });
});

// A terminal window of the system's really opened, on GitHub's macOS machine and on its Linux one under xvfb with
// xterm: what the strings above only describe. Not run on a developer's computer, to open no window there.
test(
  'on macOS and Linux a window of the terminal runs cxdt in the project, after cxdt was signed in',
  {
    skip:
      process.platform === 'win32' ||
      !process.env.CI ||
      (process.platform === 'linux' && !process.env.DISPLAY),
  },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'cxdt-open-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, 'bin');
    const project = join(root, "项目 'x'");
    mkdirSync(bin);
    mkdirSync(project);
    const log = join(root, 'log');
    // A cxdt of this release that keeps what it was asked, and what it read for a login.
    writeFileSync(
      join(bin, 'cxdt'),
      `#!/bin/sh
case "$1" in
  --version) echo 'cxdt 9.9.9' ;;
  login) printf '%s|%s\\n' "$*" "$(cat)" >> '${log}' ;;
  *) printf '%s|%s\\n' "$*" "$(pwd)" >> '${log}' ;;
esac
`,
      { mode: 0o755 },
    );
    const sessionId = '11111111-2222-4333-8444-555555555555';
    const opened = await openSession(
      { url: 'wss://a.test/ws', fingerprint: '', token: 'secret', sessionId, projectPath: project },
      { version: '9.9.9', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, home: root },
    );
    assert.deepEqual(opened, { status: 'opened' });
    const lines = async () => {
      for (let i = 0; i < 300; i++) {
        const text = (() => {
          try {
            return readFileSync(log, 'utf8');
          } catch {
            return '';
          }
        })();
        if (text.split('\n').filter(Boolean).length >= 2) return text.split('\n').filter(Boolean);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail(`the terminal ran no cxdt open: ${readFileSync(log, 'utf8')}`);
    };
    const [login, open] = await lines();
    assert.equal(login, 'login wss://a.test/ws --token-stdin --no-verify|secret');
    const [words, folder] = open.split('|');
    assert.equal(words, `open ${sessionId} --server wss://a.test/ws`);
    assert.equal(realpathSync(folder), realpathSync(project));
  },
);

test(
  'the cxdt a macOS or Linux client carries becomes the user’s cxdt, in place of one installed on its own',
  { skip: process.platform === 'win32' && 'links of a POSIX home' },
  (t) => {
    const home = mkdtempSync(join(tmpdir(), 'cxdt-home-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const own = join(home, 'opt', 'CC Desk Tunnel', 'resources', 'cxdt', 'bin', 'cxdt');
    mkdirSync(dirname(own), { recursive: true });
    writeFileSync(own, '#!/bin/sh\n');
    const link = join(home, '.local', 'bin', 'cxdt');
    const linux = { platform: 'linux', home, own, env: { PATH: '/usr/bin' }, shell: '/bin/bash' };
    // None yet: made, and ~/.local/bin goes on the PATH of the shells started from now on, once.
    assert.deepEqual(linkCxdt(linux), { linked: true, path: link });
    assert.equal(readlinkSync(link), own);
    linkCxdt(linux);
    assert.equal(
      readFileSync(join(home, '.bashrc'), 'utf8'),
      '\n# cxdt\nexport PATH="$HOME/.local/bin:$PATH"\n',
    );
    // Where the session already has it on the PATH, nothing is written.
    rmSync(join(home, '.bashrc'));
    linkCxdt({ ...linux, env: { PATH: `${join(home, '.local', 'bin')}:/usr/bin` } });
    assert.equal(existsSync(join(home, '.bashrc')), false);
    // A cxdt installed on its own, or a link to one that is gone: taken over.
    const alone = join(home, '.local', 'share', 'cxdt', 'bin', 'cxdt');
    mkdirSync(dirname(alone), { recursive: true });
    writeFileSync(alone, '#!/bin/sh\n');
    for (const target of [alone, join(home, 'gone', 'cxdt')]) {
      rmSync(link);
      symlinkSync(target, link);
      assert.equal(linkCxdt(linux).linked, true);
      assert.equal(readlinkSync(link), own);
    }
    // The user's own: a link elsewhere, or a file, is left alone.
    const mine = join(home, 'src', 'cxdt');
    mkdirSync(dirname(mine), { recursive: true });
    writeFileSync(mine, '#!/bin/sh\n');
    rmSync(link);
    symlinkSync(mine, link);
    assert.deepEqual(linkCxdt(linux), { linked: false, reason: 'taken', path: link });
    assert.equal(readlinkSync(link), mine);
    rmSync(link);
    writeFileSync(link, '#!/bin/sh\n');
    assert.equal(linkCxdt(linux).reason, 'taken');
    // A Mac client links only from the Applications folder, and writes the PATH for the user's shell.
    rmSync(link);
    const mac = { ...linux, platform: 'darwin', shell: '/bin/zsh' };
    for (const application of [
      undefined,
      '/Volumes/CC Desk Tunnel/CC Desk Tunnel.app',
      '/private/var/folders/x/AppTranslocation/1/d/CC Desk Tunnel.app',
    ])
      assert.equal(linkCxdt({ ...mac, application }).reason, 'not-in-applications');
    assert.equal(existsSync(link), false);
    assert.equal(
      linkCxdt({ ...mac, application: join(home, 'Applications', 'CC Desk Tunnel.app') }).linked,
      true,
    );
    assert.match(readFileSync(join(home, '.zshrc'), 'utf8'), /export PATH="\$HOME\/\.local\/bin/);
    // Windows, or a package without cxdt: nothing.
    assert.equal(linkCxdt({ ...linux, platform: 'win32' }).linked, false);
    assert.equal(linkCxdt({ ...linux, own: join(home, 'none') }).linked, false);
  },
);
