# Simple Telegram Relay Bot

一个简单的 Telegram 私聊中继机器人。

## 能做什么

- 普通用户私聊机器人，机器人把消息复制给管理员。
- 管理员在 Telegram 里直接回复机器人转发来的那条消息，机器人把管理员回复复制回原用户。
- 管理员发送 `/menu` 可打开按钮菜单，查看统计、客户、审计日志、黑名单、运行状态和清空数据。
- 支持文字、图片、视频、文件、语音等 Telegram `copyMessage` 支持的消息类型。
- 用户可以发送 `/stop` 关闭会话。
- 数据保存在 SQLite：`data/relay.sqlite`，重启后仍可继续回复旧会话。
- “清空数据”会二次确认后删除客户、消息映射、已发送记录、黑名单、审计日志和临时处理记录，但保留 Telegram 轮询位置，避免旧消息重新处理。
- 处理成功后才保存 Telegram offset，避免崩溃时跳过未处理消息。
- 状态文件使用临时文件加 rename 原子替换，避免写一半损坏。
- Telegram API 请求会自动重试临时网络错误、429、5xx。
- Telegram 使用 DNS 首选 IPv4；每次 `getUpdates` 长轮询使用独立连接，并在日志中记录底层网络错误码。
- 带基础限流，避免单个用户短时间刷屏。

## 限制

- 用户必须先主动给机器人发送过 `/start` 或消息，机器人才能给他发消息。
- 这个版本只支持一个管理员。
- 只处理中继私聊消息，不处理群消息。

## 配置

复制环境变量模板：

```bash
cp .env.example .env
```

编辑 `.env`：

```bash
BOT_TOKEN=你的机器人Token
ADMIN_CHAT_ID=你的Telegram数字ID
```

获取 `ADMIN_CHAT_ID` 的简单方法：

1. 先随便填一个数字启动机器人。
2. 用你的 Telegram 账号给机器人发 `/whoami`。
3. 终端会打印你的数字 ID，把它填回 `.env`。

## 启动

```bash
npm start
```

这个项目不需要 `npm install`，服务器建议使用 Node.js 24 以上运行。

## 使用

用户给机器人发消息后，你会收到两条消息：

1. 一条会话信息，例如 `#12 from 张三`
2. 一条用户原消息的复制件

你只需要在 Telegram 里“回复第 2 条复制件”，机器人就会把你的回复发给该用户。

也可以用命令发送文字：

```text
/to 12 你好，我收到你的消息了
```

其中 `12` 是机器人给出的会话号。

## 管理命令

```text
/menu
```

打开管理员按钮菜单。

```text
/whoami
```

显示当前 Telegram 数字 ID。

```text
/sessions
```

显示最近 20 个会话。

```text
/to 12 你好
```

给会话 `#12` 发送文字。

## 稳定运行建议

服务器长期运行建议使用 `systemd`，示例服务文件已放在本目录。

服务器部署说明见 [DEPLOY.md](./DEPLOY.md)。

仓库里有一个 `relay-bot.service.example`，部署到 Linux 时可以参考：

```bash
sudo cp relay-bot.service.example /etc/systemd/system/relay-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now relay-bot
sudo systemctl status relay-bot
```

使用前需要把 service 里的 `WorkingDirectory` 改成真实部署目录，并确认 `ExecStart` 的 Node 路径正确。

## 不漏消息的处理逻辑

- 机器人从 Telegram 拉到 update 后，先处理消息。
- 只有消息成功转发、状态成功保存后，才把 `offset` 前移。
- 如果处理过程中网络失败或进程退出，下一次启动会从旧 offset 继续拉同一条 update。
- 已处理 update、已复制给管理员的用户消息、已发送给用户的管理员回复都会记录在 SQLite 里，用来降低重复投递。

极端情况下，如果 Telegram 已经收到了某次发送，但机器刚好在保存本地状态前断电，可能出现重复通知；但不会因为提前确认 offset 而直接漏掉用户消息。
