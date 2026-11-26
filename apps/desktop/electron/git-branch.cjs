const path = require('node:path');
const { readFile, stat } = require('node:fs/promises');

// The branch a directory's working tree is on, read from the repository's own files so that it does not depend
// on git being installed: the name, a short commit for a detached HEAD, or null outside a repository.
async function gitBranch(directory) {
  let current = path.resolve(String(directory));
  for (;;) {
    try {
      let git = path.join(current, '.git');
      // A linked working tree or a submodule has a file here that names the real directory.
      if ((await stat(git)).isFile()) {
        const link = /^gitdir: (.+)$/m.exec(await readFile(git, 'utf8'));
        if (!link) return null;
        git = path.resolve(current, link[1].trim());
      }
      const head = (await readFile(path.join(git, 'HEAD'), 'utf8')).trim();
      const branch = /^ref: refs\/heads\/(.+)$/.exec(head);
      return branch ? branch[1] : head.slice(0, 7);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

const { promisify } = require('node:util');
const execGit = promisify(require('node:child_process').execFile);
async function git(directory, args) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory))
    throw Error('请选择本机项目文件夹。');
  try {
    const { stdout } = await execGit('git', ['-C', directory, ...args], {
      cwd: path.dirname(process.execPath),
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout;
  } catch (error) {
    if (error.code === 'ENOENT') throw Error('切换本地分支需要安装 Git，并将 git 加入 PATH。');
    throw Error(error.stderr?.trim() || '本机 Git 命令失败。');
  }
}

async function localBranches(directory) {
  const refs = await git(directory, [
    'for-each-ref',
    '--format=%(refname:lstrip=2)',
    'refs/heads/',
  ]);
  return refs.split(/\r?\n/).filter(Boolean);
}

async function switchBranch(directory, branch) {
  if (
    typeof branch !== 'string' ||
    branch.startsWith('-') ||
    !(await localBranches(directory)).includes(branch)
  )
    throw Error('该本地分支已不存在，请重新打开分支菜单。');
  await git(directory, ['switch', '--no-guess', '--no-overwrite-ignore', '--', branch]);
  return gitBranch(directory);
}

module.exports = { gitBranch, localBranches, switchBranch };
