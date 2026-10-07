# 服务器部署说明

这个机器人部署在服务器上跑。它使用 Telegram long polling，不需要域名、不需要 HTTPS、不需要开放公网端口。服务器只需要能主动访问 `https://api.telegram.org`。

数据使用 SQLite，默认文件是：

```text
/opt/simple-relay-bot/data/relay.sqlite
```

## 响应速度

正常网络下基本是实时的，通常 1 秒内到几秒内。`POLL_TIMEOUT_SECONDS=25` 不是延迟 25 秒，而是 Telegram 长轮询最多挂起 25 秒；一有新消息会立刻返回。

## 服务器要求

- Linux 服务器
- Node.js 24 或更高版本
- 能访问 Telegram API
- 不需要 Nginx、域名、证书、开放端口

检查 Node：

```bash
node -v
```

如果服务器没有 Node 24，可以用 NodeSource 安装：

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

## 部署步骤

下面以部署目录 `/opt/simple-relay-bot` 为例。

### 1. 上传代码

在服务器上创建目录：

```bash
sudo mkdir -p /opt/simple-relay-bot
sudo chown "$USER":"$USER" /opt/simple-relay-bot
```

把本目录里的文件上传到服务器 `/opt/simple-relay-bot`。如果从本机上传，可以在本机执行：

```bash
rsync -av --exclude '.env' /Users/xiaoshuo/Desktop/simple-relay-bot/ user@你的服务器IP:/opt/simple-relay-bot/
```

### 2. 配置机器人

在服务器上：

```bash
cd /opt/simple-relay-bot
cp .env.example .env
nano .env
```

填入：

```bash
BOT_TOKEN=你的机器人Token
ADMIN_CHAT_ID=你的Telegram数字ID
DB_FILE=./data/relay.sqlite
```

保护配置：

```bash
chmod 600 /opt/simple-relay-bot/.env
```

### 3. 创建低权限运行用户

```bash
sudo useradd --system --home /opt/simple-relay-bot --shell /usr/sbin/nologin relaybot || true
sudo mkdir -p /opt/simple-relay-bot/data
sudo chown -R relaybot:relaybot /opt/simple-relay-bot
sudo chmod 700 /opt/simple-relay-bot/data
sudo chmod 600 /opt/simple-relay-bot/.env
```

### 4. 安装 systemd 服务

确认 Node 路径：

```bash
which node
```

如果不是 `/usr/bin/node`，先编辑 `relay-bot.service.example` 里的 `ExecStart`。

安装并启动：

```bash
sudo cp /opt/simple-relay-bot/relay-bot.service.example /etc/systemd/system/relay-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now relay-bot
sudo systemctl status relay-bot
```

看实时日志：

```bash
sudo journalctl -u relay-bot -f
```

重启：

```bash
sudo systemctl restart relay-bot
```

停止：

```bash
sudo systemctl stop relay-bot
```

## 使用

管理员给机器人发送：

```text
/menu
```

会出现按钮菜单：

- 统计
- 客户
- 日志
- 黑名单
- 状态

普通用户给机器人发消息后，管理员直接回复机器人转来的消息即可回给用户。

## 安全建议

这个程序不监听端口，攻击面比 Webhook/Web 后台小。重点保护：

- `.env` 里的 `BOT_TOKEN`
- 服务器 SSH
- Telegram 管理员账号
- `data/relay.sqlite` 数据库文件

建议：

- 不要用 root 运行，使用示例里的 `relaybot` 用户。
- 防火墙默认拒绝入站，只保留 SSH。
- SSH 使用密钥登录，尽量禁用密码登录。
- `.env` 权限保持 `600`。
- 定期备份 `data/relay.sqlite`。
- `BOT_TOKEN` 泄露后立即去 BotFather 重新生成。

## 不漏消息逻辑

程序只有在消息处理成功后，才推进 Telegram offset。进程崩溃时，同一条 update 会在下次启动后重新处理。

这会优先保证“不漏”。极端断电场景下，可能出现重复通知，但不会因为提前确认 offset 而直接跳过消息。
