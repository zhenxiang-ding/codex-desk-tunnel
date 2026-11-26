import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ServerMessage, Session, TerminalControl } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { Modal } from './ui.tsx';

export default function CodexTerminal({
  client,
  session,
  command,
  close,
}: {
  client: ProxyClient;
  session: Session;
  command?: string;
  close: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState('正在连接…');
  const insert = useRef<(() => void) | null>(null);
  const [inserted, setInserted] = useState(false);
  const sessionId = session.id;
  useEffect(() => {
    const socket = client.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setNotice('服务未连接。请连接后重新打开终端。');
      return;
    }
    const term = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 1000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current!);
    let terminalId: string | undefined;
    let disposed = false;
    let opening = false;
    const send = (frame: TerminalControl) => {
      if (client.socket === socket && socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(frame));
    };
    const resize = () => {
      const size = fit.proposeDimensions();
      if (!size) return;
      const cols = Math.max(20, Math.min(400, size.cols));
      const rows = Math.max(5, Math.min(160, size.rows));
      if (cols === term.cols && rows === term.rows) return;
      term.resize(cols, rows);
      if (terminalId) send({ type: 'terminal.resize', sessionId, terminalId, cols, rows });
    };
    const end = () => {
      if (terminalId && client.socket === socket && socket.readyState === WebSocket.OPEN)
        void client.request({ type: 'terminal.close', sessionId, terminalId }).catch(() => {});
      terminalId = undefined;
    };
    const receive = (message: Extract<ServerMessage, { terminalId: string }>) => {
      if (message.sessionId !== sessionId || client.socket !== socket) return;
      if (message.type === 'terminal.opened') {
        terminalId = message.terminalId;
        if (disposed) return end();
        setNotice('');
        insert.current = () => {
          if (!command || !terminalId || /[\x00-\x1f\x7f]/u.test(command)) return;
          // Paste only; Enter and all native confirmations remain with the user.
          insert.current = null;
          term.paste(command);
          setInserted(true);
          term.focus();
        };
        send({ type: 'terminal.resize', sessionId, terminalId, cols: term.cols, rows: term.rows });
        term.focus();
      } else if (message.terminalId === terminalId && !disposed) {
        if (message.type === 'terminal.data') {
          term.write(message.data, () => {
            if (disposed || terminalId !== message.terminalId) return;
            send({ type: 'terminal.ack', sessionId, terminalId, bytes: message.bytes });
            const screen = term.buffer.active;
            const prefix = screen
              .getLine(screen.baseY + screen.cursorY)
              ?.translateToString(true, 0, screen.cursorX)
              .trim();
            if (prefix === '›') insert.current?.();
          });
        } else {
          terminalId = undefined;
          setNotice(
            message.type === 'terminal.closed'
              ? `终端已退出（${message.exitCode ?? '未知'}）。`
              : message.reason === 'taken'
                ? '另一客户端已接管终端。'
                : '输出中断，请重新打开终端。',
          );
        }
      }
    };
    const lost = () => {
      terminalId = undefined;
      if (!disposed) setNotice('连接已断开。服务重连后可重新打开终端。');
    };
    socket.addEventListener('close', lost);
    client.terminalListeners.add(receive);
    const keys = term.onData((text) => {
      if (!terminalId) return;
      for (let i = 0; i < text.length;) {
        let next = Math.min(i + 8192, text.length);
        if (next < text.length && /[\uD800-\uDBFF]/u.test(text[next - 1])) next--;
        send({ type: 'terminal.input', sessionId, terminalId, data: text.slice(i, next) });
        i = next;
      }
    });
    const observer = new ResizeObserver(resize);
    observer.observe(container.current!);
    // Wait for the dialog's layout and skip a mount React has already cleaned up.
    const frame = requestAnimationFrame(() => {
      resize();
      opening = true;
      void client
        .request({
          type: 'terminal.open',
          runtime: 'codex',
          sessionId,
          cols: term.cols,
          rows: term.rows,
        })
        .catch((error: Error) => {
          if (!disposed) setNotice(error.message);
        })
        .finally(() => {
          opening = false;
          if (disposed) client.terminalListeners.delete(receive);
        });
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      socket.removeEventListener('close', lost);
      keys.dispose();
      end();
      // An open request already on the wire can still deliver its terminal ID.
      if (!opening) client.terminalListeners.delete(receive);
      term.dispose();
    };
  }, [client, sessionId, command]);
  return (
    <Modal title={`Codex · ${session.title}`} onClose={close} closeOnEscape={false}>
      {notice && <p role="status">{notice}</p>}
      {command && !notice && !inserted && (
        <button type="button" className="button" onClick={() => insert.current?.()}>
          在 Codex 提示符填入 {command}
        </button>
      )}
      {command && !notice && inserted && (
        <p role="status">
          {command === '/' ? '使用方向键选择命令，按 Enter 打开。' : '在终端中按 Enter 执行命令。'}
        </p>
      )}
      <div className="codex-terminal" ref={container} aria-label="Codex 终端" />
    </Modal>
  );
}
