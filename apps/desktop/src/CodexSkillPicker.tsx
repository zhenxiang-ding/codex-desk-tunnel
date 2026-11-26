import { useEffect, useState } from 'react';
import type { ProxyClient } from './client.ts';
import { Modal } from './ui.tsx';
type Skill = { name: string; description: string; path: string };
export default function CodexSkillPicker({
  client,
  sessionId,
  choose,
  close,
}: {
  client: ProxyClient;
  sessionId: string;
  choose: (skill: Skill) => void;
  close: () => void;
}) {
  const [skills, setSkills] = useState<Skill[] | null>(null),
    [error, setError] = useState(''),
    [query, search] = useState('');
  useEffect(() => {
    let active = true;
    client.fetch({ type: 'codex.skills.get', sessionId }).then(
      (r) => {
        if (active) setSkills(r.skills);
      },
      (e) => {
        if (active) setError(e.message);
      },
    );
    return () => {
      active = false;
    };
  }, [client, sessionId]);
  const matches = skills?.filter((s) =>
    (s.name + ' ' + s.description).toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Modal title="选择 Codex 技能" onClose={close}>
      <input
        className="field"
        autoFocus
        aria-label="搜索技能"
        placeholder="搜索技能"
        value={query}
        onChange={(e) => search(e.target.value)}
      />
      {error ? (
        <p role="alert">{error}</p>
      ) : !matches ? (
        <p role="status">正在读取 VPS 上的技能…</p>
      ) : !matches.length ? (
        <p>没有匹配的已启用技能。</p>
      ) : (
        <div className="codex-skills">
          {matches.map((s) => (
            <button type="button" key={s.path} title={s.path} onClick={() => choose(s)}>
              <strong>{s.name}</strong>
              <small>{s.description}</small>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
