# `cxdt` 终端客户端

在本机终端里打开 VPS 上的 Codex CLI。Codex 可以通过 SSH 操作当前电脑上的项目。与图形客户端共用会话：终端里接着图形客户端的对话，终端里聊的内容结束后也记入会话。设计见[设计记录](../../docs/research/standalone-cli.md)。

开发阶段从源码运行，需要 Node.js 24；Windows 上还需要 `npm run prepare:windows` 准备的 OpenSSH 组件。

```bash
node apps/cli/bin/cxdt.mjs login      # 地址和证书指纹取自图形客户端；也可以写 login <wss 地址> --fingerprint <指纹>
cd D:\work\my-project
node apps/cli/bin/cxdt.mjs            # 接着这个项目最近的会话；没有就新建
node apps/cli/bin/cxdt.mjs -r         # 从这个项目的会话里选一个
```

窗口打开期间，客户端会在网络中断后尝试重连。退出 Codex 或关闭窗口即可结束终端。运行 `cxdt --help` 查看全部命令。

程序和其他 agent 用 `cxdt -p` 与跟进命令（`tasks.mjs`）或 `cxdt acp`（`acp.mjs`）把任务交给服务端上的 Claude；两者共用 `agent.mjs`：经服务端自己的对话发消息，从会话事件里跟到 Claude 停下等人或这一轮结束。用法见 [docs/cli.md](../../docs/cli.md#供程序和其他-agent-使用)。
