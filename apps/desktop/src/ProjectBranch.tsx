import { useEffect, useState } from 'react';
import { Check, GitBranch } from 'lucide-react';
import { usePopover } from './usePopover.ts';

export default function ProjectBranch({
  path,
  running,
  disabled,
}: {
  path: string;
  running: boolean;
  disabled: boolean;
}) {
  const [branch, setBranch] = useState<string | null>(null);
  const [choices, setChoices] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const { open, setOpen, container, card } = usePopover();
  useEffect(() => {
    let active = true;
    const read = () =>
      void window.desktop!.gitBranch(path).then(
        (value) => {
          if (active) setBranch(value);
        },
        () => {
          if (active) setBranch(null);
        },
      );
    read();
    window.addEventListener('focus', read);
    return () => {
      active = false;
      window.removeEventListener('focus', read);
    };
  }, [path, running]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setError('');
    setLoading(true);
    setChoices([]);
    window
      .desktop!.gitBranches(path)
      .then(
        (items) => {
          if (active) setChoices(items);
        },
        (e) => {
          if (active) setError(e.message);
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path, open]);
  async function select(name: string) {
    if (switching || disabled || running || name === branch) return;
    setError('');
    setSwitching(true);
    try {
      setBranch(await window.desktop!.switchGitBranch(path, name));
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : '分支切换失败。');
    } finally {
      setSwitching(false);
    }
  }
  if (!branch) return null;
  return (
    <div ref={container} className="permission-control">
      <button
        type="button"
        className="chip quiet"
        title="项目当前所在的 git 分支"
        aria-label="项目 Git 分支"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
      >
        <GitBranch />
        <span>{branch}</span>
      </button>
      {open && (
        <div
          ref={card}
          className="permission-menu branch-menu"
          role="menu"
          aria-label="本地 Git 分支"
        >
          {loading && <small role="status">正在读取本地分支…</small>}
          {!loading && !choices.includes(branch) && <small>当前 HEAD · {branch}</small>}
          {choices.map((name) => (
            <button
              type="button"
              role="menuitemradio"
              key={name}
              aria-checked={name === branch}
              disabled={switching || running || disabled}
              onClick={() => (name === branch ? setOpen(false) : void select(name))}
            >
              {name === branch && <Check />}
              {name}
            </button>
          ))}
          {running && <small>本轮结束后可切换分支。</small>}
          {error && <small role="alert">{error}</small>}
        </div>
      )}
    </div>
  );
}
