import type { CodexChoice, CodexConfig } from '@cc-desk-tunnel/protocol';
import { mkdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { deviceTerms } from './device-terms.ts';
import type { Execution } from './device-terms.ts';

// One cwd per desk session keeps the native /resume picker scoped to that session.
export function codexTerminal(
  directory: string,
  session: { id: string; projectPath: string; codex?: CodexChoice },
  execution: Execution,
  sshBin: string,
  inherited: NodeJS.ProcessEnv = process.env,
  terminalDefaults?: Partial<CodexConfig>,
) {
  const cwd = join(directory, 'codex', session.id);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const terms = deviceTerms(execution, session.projectPath);
  const instructions = [
    `The project is on the user's connected ${terms.name} device at ${JSON.stringify(session.projectPath)}.`,
    'Use the session SSH wrappers to work on this project. Read the project instructions there before editing.',
    terms.script,
    terms.command,
    'If the device disconnects, report the interruption. Confirm the outcome before retrying changes.',
  ].join('\n');
  const path = [sshBin, inherited.PATH].filter(Boolean).join(delimiter);
  return {
    file: 'codex',
    instructions,
    cwd,
    args: [
      '--no-daemon',
      ...(terminalDefaults
        ? [
            '--sandbox',
            terminalDefaults.sandbox_mode ?? 'workspace-write',
            ...(session.codex?.approval
              ? [
                  '--ask-for-approval',
                  session.codex.approval === 'auto_review' ? 'on-request' : session.codex.approval,
                  '-c',
                  'approvals_reviewer=' +
                    JSON.stringify(
                      session.codex.approval === 'auto_review' ? 'auto_review' : 'user',
                    ),
                ]
              : []),
            ...(session.codex?.model ? ['--model', session.codex.model] : []),
            ...(session.codex?.effort
              ? ['-c', 'model_reasoning_effort=' + JSON.stringify(session.codex.effort)]
              : []),
          ]
        : []),
      '-c',
      'allow_login_shell=false',
      '-c',
      `shell_environment_policy.set.PATH=${JSON.stringify(path)}`,
      '-c',
      `developer_instructions=${JSON.stringify(instructions)}`,
    ],
    env: {
      ...Object.fromEntries(
        Object.entries(inherited).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined && !/^(?:ANTHROPIC_|CLAUDE_|PROXY_|FRPS_)/.test(entry[0]),
        ),
      ),
      PATH: path,
      TERM: 'xterm-256color',
    },
  };
}
