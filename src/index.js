import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setDefaultResultOrder } from 'node:dns';
import { setDefaultAutoSelectFamily } from 'node:net';

setDefaultResultOrder('ipv4first');
setDefaultAutoSelectFamily(false);

const config = loadConfig();
const dbPath = resolve(process.cwd(), config.dbFile);
await mkdir(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
initDb();

let shuttingDown = false;
const rateBuckets = new Map();

console.log('Relay bot starting...');
console.log(`Admin chat id: ${config.adminChatId}`);
console.log(`Database file: ${dbPath}`);

await api('sendMessage', {
  chat_id: config.adminChatId,
  text: 'Relay bot 已启动。发送 /menu 打开管理菜单。',
}).catch((error) => console.error(`启动提醒发送失败：${formatErrorDetails(error)}`));

process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

while (!shuttingDown) {
  try {
    const updates = await api('getUpdates', {
      offset: Number(getState('offset', '0')),
      timeout: config.pollTimeoutSeconds,
      allowed_updates: ['message', 'callback_query'],
    }, (config.pollTimeoutSeconds + 10) * 1000);

    for (const update of updates) {
      if (shuttingDown) break;
      await processUpdate(update);
    }
  } catch (error) {
    console.error(`轮询失败：${formatErrorDetails(error)}`);
    await sleep(3000);
  }
}

db.close();
console.log('Relay bot stopped.');

async function processUpdate(update) {
  const updateId = update.update_id;
  try {
    if (isProcessedUpdate(updateId)) {
      setOffset(updateId + 1);
      return;
    }
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
    markProcessedUpdate(updateId);
    pruneProcessedUpdates();
    setOffset(updateId + 1);
  } catch (error) {
    console.error(`处理 update ${updateId} 失败，保留 offset 等待重试：${error.message}`);
    throw error;
  }
}

async function handleMessage(message) {
  const chatId = String(message.chat?.id ?? '');
  if (!chatId || message.chat?.type !== 'private') return;
  if (chatId === config.adminChatId) return handleAdminMessage(message);
  return handleUserMessage(message);
}

async function handleUserMessage(message) {
  const chatId = String(message.chat.id);
  const text = message.text?.trim();

  if (text === '/start') {
    const customer = ensureCustomer(message.from, chatId);
    logAudit('user_start', customer.id, chatId, '用户启动机器人');
    if (customer.blocked && customer.block_source === 'admin') {
      logAudit('blocked_user_start', customer.id, chatId, '拉黑用户尝试启动机器人');
      await sendBlockedNotice(chatId);
      return;
    }
    setCustomerBlocked(customer.id, false, null);
    await api('sendMessage', {
      chat_id: chatId,
      text: '你好，直接发送消息即可。我会把消息转交给管理员。发送 /stop 可关闭会话。',
    });
    return;
  }

  if (text === '/stop') {
    const customer = ensureCustomer(message.from, chatId);
    setCustomerBlocked(customer.id, true, 'user_stop');
    logAudit('user_stop', customer.id, chatId, '用户关闭会话');
    await api('sendMessage', { chat_id: chatId, text: '已关闭会话。之后如需重新联系，请发送 /start 或任意消息。' });
    await api('sendMessage', {
      chat_id: config.adminChatId,
      text: `会话 #${customer.id} 已由用户关闭。`,
      reply_markup: adminMenuKeyboard(),
    });
    return;
  }

  if (!allowRate(`user:${chatId}`, config.userMessageLimitPerMinute)) {
    incrementCounter('rate_limited');
    logAudit('rate_limited', null, chatId, '用户消息频率过高');
    await maybeNotifyRateLimited(chatId);
    return;
  }

  const inboundKey = `${chatId}:${message.message_id}`;
  const existing = getInbound(inboundKey);
  if (existing?.admin_copied_message_id) {
    ensureRoute(existing.admin_copied_message_id, existing.customer_id, chatId, message.message_id);
    return;
  }

  const customer = ensureCustomer(message.from, chatId);
  if (customer.blocked && customer.block_source === 'admin') {
    incrementCounter('blocked_user_messages');
    logAudit('blocked_user_message', customer.id, chatId, messageSummary(message));
    await sendBlockedNotice(chatId);
    return;
  }
  setCustomerBlocked(customer.id, false, null);
  incrementCustomerMessages(customer.id, 'user');
  insertInbound(inboundKey, customer.id, chatId, message.message_id);
  logAudit('user_message', customer.id, chatId, messageSummary(message));

  await deliverInboundToAdmin(customer, message, inboundKey, chatId);
}

async function handleAdminMessage(message) {
  const text = message.text?.trim() ?? '';
  if (text === '/start' || text === '/menu' || text === '/admin') return sendAdminPanel(message.chat.id);
  if (text === '/whoami') {
    await api('sendMessage', {
      chat_id: config.adminChatId,
      text: `你的 Telegram 数字 ID 是：${message.chat.id}`,
      reply_markup: adminMenuKeyboard(),
    });
    return;
  }
  if (text === '/sessions') return sendCustomersPanel(message.chat.id, 0);
  if (text.startsWith('/to ')) {
    if (!await allowAdminRate(message)) return;
    return sendCommandReply(message, text);
  }

  const replyToId = message.reply_to_message?.message_id;
  if (!replyToId) {
    await api('sendMessage', {
      chat_id: config.adminChatId,
      text: '请回复某条用户消息，或使用 /menu 打开管理菜单。',
      reply_to_message_id: message.message_id,
      reply_markup: adminMenuKeyboard(),
    });
    return;
  }

  const route = getRoute(replyToId);
  if (!route) {
    await api('sendMessage', {
      chat_id: config.adminChatId,
      text: '找不到这条消息对应的用户。请回复机器人复制给你的用户消息，或用 /menu 查看客户。',
      reply_to_message_id: message.message_id,
      reply_markup: adminMenuKeyboard(),
    });
    return;
  }

  const customer = getCustomerByChatId(route.user_chat_id);
  if (customer?.blocked) {
    await api('sendMessage', {
      chat_id: config.adminChatId,
      text: `会话 #${customer.id} 已关闭，未发送。`,
      reply_to_message_id: message.message_id,
    });
    return;
  }

  if (!await allowAdminRate(message)) return;
  await copyAdminMessageToUser(message, route.user_chat_id, customer?.id ?? route.customer_id);
}

async function deliverInboundToAdmin(customer, message, inboundKey, chatId) {
  try {
    const sent = await sendSingleAdminMessage(customer, message, chatId);
    setInboundCopied(inboundKey, sent.message_id);
    ensureRoute(sent.message_id, customer.id, chatId, message.message_id);
  } catch (error) {
    if (isRetryableTelegramError(error)) throw error;
    incrementCounter('copy_failed');
    logAudit('copy_failed', customer.id, chatId, error.message);
    const fallback = await api('sendMessage', {
      chat_id: config.adminChatId,
      text: `${adminInboundPrefix(customer, chatId)}\n\n[消息转发失败]\n${error.message}`,
    });
    setInboundCopied(inboundKey, fallback.message_id);
    ensureRoute(fallback.message_id, customer.id, chatId, message.message_id);
  }
}

async function sendSingleAdminMessage(customer, message, chatId) {
  const prefix = adminInboundPrefix(customer, chatId);
  if (message.text) {
    return api('sendMessage', {
      chat_id: config.adminChatId,
      text: `${prefix}\n\n${message.text}`,
    });
  }
  if (message.caption && canCopyWithCaption(message)) {
    return api('copyMessage', {
      chat_id: config.adminChatId,
      from_chat_id: chatId,
      message_id: message.message_id,
      caption: trim(`${prefix}\n\n${message.caption}`, 1000),
    });
  }
  if (canCopyWithoutLosingBody(message)) {
    return api('copyMessage', {
      chat_id: config.adminChatId,
      from_chat_id: chatId,
      message_id: message.message_id,
      caption: trim(prefix, 1000),
    });
  }
  return api('sendMessage', {
    chat_id: config.adminChatId,
    text: `${prefix}\n\n${messageSummary(message)}`,
  });
}

function adminInboundPrefix(customer, chatId) {
  return [
    `客户 #${customer.id}`,
    `昵称：${cleanDisplayName(customer)}`,
    `用户名：${customer.username ? `@${customer.username}` : '-'}`,
    `user_id：${chatId}`,
  ].join('\n');
}

function canCopyWithCaption(message) {
  return Boolean(message.photo || message.video || message.document || message.audio || message.animation);
}

function canCopyWithoutLosingBody(message) {
  return Boolean(message.photo || message.video || message.document || message.audio || message.animation || message.sticker);
}

async function handleCallback(callback) {
  const fromId = String(callback.from?.id ?? '');
  if (fromId !== config.adminChatId) {
    await api('answerCallbackQuery', { callback_query_id: callback.id, text: '无权限', show_alert: true });
    return;
  }
  await api('answerCallbackQuery', { callback_query_id: callback.id });

  const chatId = callback.message?.chat?.id ?? config.adminChatId;
  const messageId = callback.message?.message_id;
  const data = callback.data ?? '';

  if (data === 'menu') return editPanel(chatId, messageId, adminHomeText(), adminMenuKeyboard());
  if (data === 'stats') return editPanel(chatId, messageId, statsText(), backKeyboard());
  if (data === 'status') return editPanel(chatId, messageId, statusText(), backKeyboard());
  if (data === 'reset_confirm') return editPanel(chatId, messageId, resetConfirmText(), resetConfirmKeyboard());
  if (data === 'reset_all') {
    resetAllData();
    return editPanel(chatId, messageId, [
      '已清空全部业务数据，可以重新开始。',
      '',
      '客户：0',
      '消息映射：0',
      '黑名单：0',
      '审计日志：0',
      '编号已从 #1 重新开始。',
    ].join('\n'), adminMenuKeyboard());
  }
  if (data.startsWith('customers:')) return sendCustomersPanel(chatId, Number(data.split(':')[1] || 0), messageId);
  if (data.startsWith('logs:')) return sendLogsPanel(chatId, Number(data.split(':')[1] || 0), messageId);
  if (data.startsWith('blocked:')) return sendBlockedPanel(chatId, Number(data.split(':')[1] || 0), messageId);
  if (data.startsWith('customer:')) return sendCustomerDetail(chatId, Number(data.split(':')[1]), messageId);
  if (data.startsWith('block:')) return toggleBlock(chatId, Number(data.split(':')[1]), true, messageId);
  if (data.startsWith('unblock:')) return toggleBlock(chatId, Number(data.split(':')[1]), false, messageId);
  return editPanel(chatId, messageId, '未知菜单操作。', backKeyboard());
}

async function sendCommandReply(message, text) {
  const sentKey = `admin:${message.chat.id}:${message.message_id}`;
  if (isSentAdminMessage(sentKey)) return;
  const match = text.match(/^\/to\s+(\d+)\s+([\s\S]+)/u);
  if (!match) {
    await api('sendMessage', { chat_id: config.adminChatId, text: '格式：/to 会话号 内容', reply_to_message_id: message.message_id });
    return;
  }
  const customer = getCustomerById(Number(match[1]));
  if (!customer) {
    await api('sendMessage', { chat_id: config.adminChatId, text: `找不到客户 #${match[1]}。`, reply_to_message_id: message.message_id });
    return;
  }
  if (customer.blocked) {
    await api('sendMessage', { chat_id: config.adminChatId, text: `会话 #${customer.id} 已关闭，未发送。`, reply_to_message_id: message.message_id });
    return;
  }
  await api('sendMessage', { chat_id: customer.user_chat_id, text: match[2] });
  markSentAdminMessage(sentKey, customer.id, customer.user_chat_id);
  incrementCustomerMessages(customer.id, 'admin');
  logAudit('admin_reply', customer.id, customer.user_chat_id, `/to ${customer.id}`);
  await api('sendMessage', {
    chat_id: config.adminChatId,
    text: `✓ #${customer.id}`,
    reply_to_message_id: message.message_id,
  });
}

async function copyAdminMessageToUser(message, userChatId, customerId) {
  const sentKey = `admin:${message.chat.id}:${message.message_id}`;
  if (isSentAdminMessage(sentKey)) return;
  try {
    await api('copyMessage', { chat_id: userChatId, from_chat_id: config.adminChatId, message_id: message.message_id });
    markSentAdminMessage(sentKey, customerId, userChatId);
    incrementCustomerMessages(customerId, 'admin');
    logAudit('admin_reply', customerId, userChatId, messageSummary(message));
    await api('sendMessage', {
      chat_id: config.adminChatId,
      text: `✓ #${customerId ?? userChatId}`,
      reply_to_message_id: message.message_id,
    });
  } catch (error) {
    incrementCounter('send_failed');
    logAudit('send_failed', customerId, userChatId, error.message);
    await api('sendMessage', {
      chat_id: config.adminChatId,
      text: `发送失败：${error.message}`,
      reply_to_message_id: message.message_id,
    });
  }
}

async function sendAdminPanel(chatId) {
  await api('sendMessage', { chat_id: chatId, text: adminHomeText(), reply_markup: adminMenuKeyboard() });
}

async function sendCustomersPanel(chatId, page = 0, messageId) {
  const limit = 8;
  const rows = db.prepare('SELECT * FROM customers ORDER BY datetime(last_seen_at) DESC LIMIT ? OFFSET ?').all(limit, page * limit);
  const total = db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  const body = rows.length ? rows.map(customerLine).join('\n\n') : '暂无客户。';
  const keyboard = rows.map((row) => [{ text: `#${row.id} 详情`, callback_data: `customer:${row.id}` }]);
  keyboard.push(pagerRow('customers', page, total, limit), [{ text: '返回菜单', callback_data: 'menu' }]);
  await editPanel(chatId, messageId, `👥 最近客户 ${total ? `(共 ${total})` : ''}\n\n${body}`, { inline_keyboard: keyboard });
}

async function sendLogsPanel(chatId, page = 0, messageId) {
  const limit = 8;
  const rows = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, page * limit);
  const total = db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n;
  const body = rows.length ? rows.map((row) => `${formatTime(row.created_at)} ${row.type}${row.customer_id ? ` #${row.customer_id}` : ''}\n${row.detail}`).join('\n\n') : '暂无日志。';
  await editPanel(chatId, messageId, `🧾 审计日志 ${total ? `(共 ${total})` : ''}\n\n${body}`, {
    inline_keyboard: [pagerRow('logs', page, total, limit), [{ text: '返回菜单', callback_data: 'menu' }]],
  });
}

async function sendBlockedPanel(chatId, page = 0, messageId) {
  const limit = 8;
  const rows = db.prepare("SELECT * FROM customers WHERE blocked = 1 AND block_source = 'admin' ORDER BY datetime(last_seen_at) DESC LIMIT ? OFFSET ?").all(limit, page * limit);
  const total = db.prepare("SELECT COUNT(*) AS n FROM customers WHERE blocked = 1 AND block_source = 'admin'").get().n;
  const body = rows.length ? rows.map(customerLine).join('\n\n') : '暂无黑名单。';
  const keyboard = rows.map((row) => [{ text: `解除 #${row.id}`, callback_data: `unblock:${row.id}` }]);
  keyboard.push(pagerRow('blocked', page, total, limit), [{ text: '返回菜单', callback_data: 'menu' }]);
  await editPanel(chatId, messageId, `🚫 黑名单 ${total ? `(共 ${total})` : ''}\n\n${body}`, { inline_keyboard: keyboard });
}

async function sendCustomerDetail(chatId, customerId, messageId) {
  const customer = getCustomerById(customerId);
  if (!customer) return editPanel(chatId, messageId, `找不到客户 #${customerId}`, backKeyboard());
  const logs = db.prepare('SELECT * FROM audit_logs WHERE customer_id = ? ORDER BY id DESC LIMIT 5').all(customerId);
  const text = [
    `👤 客户 #${customer.id}`,
    `名称：${customer.display_name}`,
    `用户名：${customer.username ? `@${customer.username}` : '-'}`,
    `user_id：${customer.user_chat_id}`,
    `状态：${customer.blocked ? blockStatusText(customer) : '正常'}`,
    `用户消息：${customer.user_messages}`,
    `管理员回复：${customer.admin_messages}`,
    `首次联系：${formatTime(customer.first_seen_at)}`,
    `最近活跃：${formatTime(customer.last_seen_at)}`,
    '',
    '最近日志：',
    logs.length ? logs.map((row) => `${formatTime(row.created_at)} ${row.type}\n${row.detail}`).join('\n\n') : '暂无',
    '',
    `发送文字：/to ${customer.id} 你的内容`,
  ].join('\n');
  await editPanel(chatId, messageId, text, {
    inline_keyboard: [
      [customer.blocked ? { text: '解除拉黑', callback_data: `unblock:${customer.id}` } : { text: '拉黑/关闭', callback_data: `block:${customer.id}` }],
      [{ text: '客户列表', callback_data: 'customers:0' }, { text: '返回菜单', callback_data: 'menu' }],
    ],
  });
}

async function toggleBlock(chatId, customerId, blocked, messageId) {
  const customer = getCustomerById(customerId);
  if (!customer) return editPanel(chatId, messageId, `找不到客户 #${customerId}`, backKeyboard());
  setCustomerBlocked(customer.id, blocked, blocked ? 'admin' : null);
  logAudit(blocked ? 'admin_block' : 'admin_unblock', customer.id, customer.user_chat_id, blocked ? '管理员拉黑/关闭' : '管理员解除拉黑');
  await sendCustomerDetail(chatId, customer.id, messageId);
}

async function sendBlockedNotice(chatId) {
  await api('sendMessage', {
    chat_id: chatId,
    text: '当前会话已关闭，消息未转发。',
  }).catch((error) => console.error(`拉黑提示发送失败：${error.message}`));
}

async function editPanel(chatId, messageId, text, replyMarkup) {
  if (messageId) {
    try {
      await api('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: replyMarkup });
      return;
    } catch (error) {
      if (String(error.message).includes('message is not modified')) return;
      console.error(`编辑菜单失败：${error.message}`);
    }
  }
  await api('sendMessage', { chat_id: chatId, text, reply_markup: replyMarkup });
}

function adminHomeText() {
  const stats = getStats();
  return ['管理菜单', '', `今日用户消息：${stats.todayUserMessages}`, `今日管理员回复：${stats.todayAdminReplies}`, `总客户数：${stats.totalCustomers}`, `活跃客户：${stats.activeCustomers}`, '', '选择下面按钮查看详情。'].join('\n');
}

function statsText() {
  const stats = getStats();
  return ['📊 数据统计', '', `今日用户消息：${stats.todayUserMessages}`, `今日管理员回复：${stats.todayAdminReplies}`, `今日新增客户：${stats.todayNewCustomers}`, `总客户数：${stats.totalCustomers}`, `正常客户：${stats.activeCustomers}`, `管理员拉黑：${stats.adminBlockedCustomers}`, `用户关闭：${stats.userStoppedCustomers}`, `总用户消息：${stats.totalUserMessages}`, `总管理员回复：${stats.totalAdminReplies}`, `限流次数：${getCounter('rate_limited')}`, `拉黑拦截：${getCounter('blocked_user_messages')}`, `复制失败：${getCounter('copy_failed')}`, `发送失败：${getCounter('send_failed')}`].join('\n');
}

function statusText() {
  return ['⚙️ 运行状态', '', `数据库：${dbPath}`, `offset：${getState('offset', '0')}`, `轮询超时：${config.pollTimeoutSeconds}s`, 'Telegram网络：IPv4优先 / 独立轮询连接', `API重试：${config.apiRetries}`, `用户限流：${config.userMessageLimitPerMinute}/分钟`, `管理员限流：${config.adminReplyLimitPerMinute}/分钟`, `Node：${process.version}`, `进程：${process.pid}`].join('\n');
}

function getStats() {
  const today = startOfTodayIso();
  const totals = db.prepare('SELECT COALESCE(SUM(user_messages), 0) AS user_messages, COALESCE(SUM(admin_messages), 0) AS admin_messages FROM customers').get();
  return {
    totalCustomers: db.prepare('SELECT COUNT(*) AS n FROM customers').get().n,
    activeCustomers: db.prepare('SELECT COUNT(*) AS n FROM customers WHERE blocked = 0').get().n,
    adminBlockedCustomers: db.prepare("SELECT COUNT(*) AS n FROM customers WHERE blocked = 1 AND block_source = 'admin'").get().n,
    userStoppedCustomers: db.prepare("SELECT COUNT(*) AS n FROM customers WHERE blocked = 1 AND block_source = 'user_stop'").get().n,
    todayNewCustomers: db.prepare('SELECT COUNT(*) AS n FROM customers WHERE first_seen_at >= ?').get(today).n,
    todayUserMessages: db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE type = 'user_message' AND created_at >= ?").get(today).n,
    todayAdminReplies: db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE type = 'admin_reply' AND created_at >= ?").get(today).n,
    totalUserMessages: totals.user_messages,
    totalAdminReplies: totals.admin_messages,
  };
}

function adminMenuKeyboard() {
  return { inline_keyboard: [[{ text: '📊 统计', callback_data: 'stats' }, { text: '👥 客户', callback_data: 'customers:0' }], [{ text: '🧾 日志', callback_data: 'logs:0' }, { text: '🚫 黑名单', callback_data: 'blocked:0' }], [{ text: '⚙️ 状态', callback_data: 'status' }, { text: '清空数据', callback_data: 'reset_confirm' }]] };
}

function resetConfirmText() {
  return [
    '确认清空全部数据？',
    '',
    '会删除：客户、消息映射、已发送记录、黑名单、审计日志、临时处理记录。',
    '不会删除：机器人配置、Token、管理员ID、Telegram轮询位置。',
    '',
    '清空后无法从按钮恢复，请确认。'
  ].join('\n');
}

function resetConfirmKeyboard() {
  return { inline_keyboard: [[{ text: '确认清空全部数据', callback_data: 'reset_all' }], [{ text: '取消', callback_data: 'menu' }]] };
}

function backKeyboard() {
  return { inline_keyboard: [[{ text: '返回菜单', callback_data: 'menu' }]] };
}

function customerKeyboard(customerId) {
  return { inline_keyboard: [[{ text: `客户 #${customerId}`, callback_data: `customer:${customerId}` }, { text: '菜单', callback_data: 'menu' }]] };
}

function pagerRow(prefix, page, total, limit) {
  const row = [];
  if (page > 0) row.push({ text: '上一页', callback_data: `${prefix}:${page - 1}` });
  if ((page + 1) * limit < total) row.push({ text: '下一页', callback_data: `${prefix}:${page + 1}` });
  return row.length ? row : [{ text: '刷新', callback_data: `${prefix}:${page}` }];
}

async function allowAdminRate(message) {
  if (allowRate('admin', config.adminReplyLimitPerMinute)) return true;
  await api('sendMessage', { chat_id: config.adminChatId, text: '发送太快了，稍等几秒再试。', reply_to_message_id: message.message_id });
  return false;
}

function ensureCustomer(user, userChatId) {
  const existing = getCustomerByChatId(userChatId);
  const now = new Date().toISOString();
  const username = user?.username ?? null;
  const displayName = displayNameOnly(user);
  if (existing) {
    db.prepare('UPDATE customers SET username = ?, display_name = ?, last_seen_at = ? WHERE id = ?').run(username, displayName, now, existing.id);
    return getCustomerById(existing.id);
  }
  const result = db.prepare('INSERT INTO customers (user_chat_id, username, display_name, blocked, user_messages, admin_messages, first_seen_at, last_seen_at) VALUES (?, ?, ?, 0, 0, 0, ?, ?)').run(userChatId, username, displayName, now, now);
  const customer = getCustomerById(Number(result.lastInsertRowid));
  logAudit('customer_created', customer.id, userChatId, displayName);
  return customer;
}

function getCustomerByChatId(userChatId) {
  return db.prepare('SELECT * FROM customers WHERE user_chat_id = ?').get(String(userChatId));
}

function getCustomerById(customerId) {
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
}

function setCustomerBlocked(customerId, blocked, source) {
  db.prepare('UPDATE customers SET blocked = ?, block_source = ?, last_seen_at = ? WHERE id = ?').run(blocked ? 1 : 0, blocked ? source : null, new Date().toISOString(), customerId);
}

function incrementCustomerMessages(customerId, side) {
  const column = side === 'admin' ? 'admin_messages' : 'user_messages';
  db.prepare(`UPDATE customers SET ${column} = ${column} + 1, last_seen_at = ? WHERE id = ?`).run(new Date().toISOString(), customerId);
}

function insertInbound(key, customerId, userChatId, originalMessageId) {
  db.prepare('INSERT OR IGNORE INTO inbound_messages (inbound_key, customer_id, user_chat_id, original_message_id, created_at) VALUES (?, ?, ?, ?, ?)').run(key, customerId, userChatId, originalMessageId, new Date().toISOString());
  pruneTable('inbound_messages', config.messageMapKeep, 'created_at');
}

function getInbound(key) {
  return db.prepare('SELECT * FROM inbound_messages WHERE inbound_key = ?').get(key);
}

function setInboundHeader(key, messageId) {
  db.prepare('UPDATE inbound_messages SET admin_header_message_id = ? WHERE inbound_key = ?').run(messageId, key);
}

function setInboundCopied(key, messageId) {
  db.prepare('UPDATE inbound_messages SET admin_copied_message_id = ? WHERE inbound_key = ?').run(messageId, key);
}

function ensureRoute(adminMessageId, customerId, userChatId, originalMessageId) {
  db.prepare('INSERT OR IGNORE INTO admin_message_routes (admin_message_id, customer_id, user_chat_id, original_message_id, created_at) VALUES (?, ?, ?, ?, ?)').run(String(adminMessageId), customerId, userChatId, originalMessageId, new Date().toISOString());
  pruneTable('admin_message_routes', config.messageMapKeep, 'created_at');
}

function getRoute(adminMessageId) {
  return db.prepare('SELECT * FROM admin_message_routes WHERE admin_message_id = ?').get(String(adminMessageId));
}

function isSentAdminMessage(key) {
  return Boolean(db.prepare('SELECT 1 FROM sent_admin_messages WHERE sent_key = ?').get(key));
}

function markSentAdminMessage(key, customerId, userChatId) {
  db.prepare('INSERT OR IGNORE INTO sent_admin_messages (sent_key, customer_id, user_chat_id, created_at) VALUES (?, ?, ?, ?)').run(key, customerId ?? null, String(userChatId), new Date().toISOString());
  pruneTable('sent_admin_messages', config.messageMapKeep, 'created_at');
}

function isProcessedUpdate(updateId) {
  return Boolean(db.prepare('SELECT 1 FROM processed_updates WHERE update_id = ?').get(updateId));
}

function markProcessedUpdate(updateId) {
  db.prepare('INSERT OR IGNORE INTO processed_updates (update_id, created_at) VALUES (?, ?)').run(updateId, new Date().toISOString());
}

function pruneProcessedUpdates() {
  db.prepare('DELETE FROM processed_updates WHERE update_id NOT IN (SELECT update_id FROM processed_updates ORDER BY update_id DESC LIMIT ?)').run(config.processedUpdateKeep);
}

function pruneTable(table, keep, orderColumn) {
  db.prepare(`DELETE FROM ${table} WHERE rowid NOT IN (SELECT rowid FROM ${table} ORDER BY ${orderColumn} DESC LIMIT ?)`).run(keep);
}

function logAudit(type, customerId, userChatId, detail) {
  db.prepare('INSERT INTO audit_logs (type, customer_id, user_chat_id, detail, created_at) VALUES (?, ?, ?, ?, ?)').run(type, customerId ?? null, userChatId ? String(userChatId) : null, String(detail ?? ''), new Date().toISOString());
  pruneTable('audit_logs', config.auditLogKeep, 'id');
}

function resetAllData() {
  const offset = getState('offset', '0');
  const reset = db.transaction(() => {
    db.prepare('DELETE FROM customers').run();
    db.prepare('DELETE FROM inbound_messages').run();
    db.prepare('DELETE FROM admin_message_routes').run();
    db.prepare('DELETE FROM sent_admin_messages').run();
    db.prepare('DELETE FROM processed_updates').run();
    db.prepare('DELETE FROM audit_logs').run();
    db.prepare('DELETE FROM app_state WHERE key != ?').run('offset');
    db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('customers', 'audit_logs')").run();
    setState('offset', offset);
  });
  reset();
  console.log('全部业务数据已清空');
}

function incrementCounter(name) {
  setState(`counter:${name}`, String(Number(getState(`counter:${name}`, '0')) + 1));
}

function getCounter(name) {
  return Number(getState(`counter:${name}`, '0'));
}

function getState(key, fallback = null) {
  return db.prepare('SELECT value FROM app_state WHERE key = ?').get(key)?.value ?? fallback;
}

function setState(key, value) {
  db.prepare('INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, String(value), new Date().toISOString());
}

function setOffset(offset) {
  setState('offset', String(offset));
}

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_chat_id TEXT NOT NULL UNIQUE,
      username TEXT,
      display_name TEXT NOT NULL,
      blocked INTEGER NOT NULL DEFAULT 0,
      block_source TEXT,
      user_messages INTEGER NOT NULL DEFAULT 0,
      admin_messages INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inbound_messages (
      inbound_key TEXT PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      user_chat_id TEXT NOT NULL,
      original_message_id INTEGER NOT NULL,
      admin_header_message_id INTEGER,
      admin_copied_message_id INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_message_routes (
      admin_message_id TEXT PRIMARY KEY,
      customer_id INTEGER,
      user_chat_id TEXT NOT NULL,
      original_message_id INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sent_admin_messages (
      sent_key TEXT PRIMARY KEY,
      customer_id INTEGER,
      user_chat_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS processed_updates (update_id INTEGER PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      customer_id INTEGER,
      user_chat_id TEXT,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_customers_last_seen ON customers(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_customers_blocked ON customers(blocked);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_customer ON audit_logs(customer_id);
  `);
  ensureColumn('customers', 'block_source', 'TEXT');
  db.prepare("UPDATE customers SET block_source = 'admin' WHERE blocked = 1 AND block_source IS NULL").run();
}

function customerLine(row) {
  return `#${row.id} ${row.display_name} [${row.blocked ? blockStatusText(row) : '正常'}]\n消息 ${row.user_messages} / 回复 ${row.admin_messages} / ${formatTime(row.last_seen_at)}`;
}

function blockStatusText(row) {
  return row.block_source === 'user_stop' ? '用户关闭' : '管理员拉黑';
}

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function messageSummary(message) {
  if (message.text) return trim(message.text, 120);
  if (message.caption) return trim(message.caption, 120);
  if (message.photo) return '[photo]';
  if (message.video) return '[video]';
  if (message.document) return `[document] ${message.document.file_name ?? ''}`.trim();
  if (message.voice) return '[voice]';
  if (message.audio) return '[audio]';
  if (message.sticker) return '[sticker]';
  return '[message]';
}

function formatUser(user) {
  if (!user) return 'unknown';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  const username = user.username ? `@${user.username}` : '';
  return [name, username].filter(Boolean).join(' ') || String(user.id);
}

function displayNameOnly(user) {
  if (!user) return 'unknown';
  return [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || (user.username ? `@${user.username}` : String(user.id));
}

function cleanDisplayName(customer) {
  const username = customer.username ? `@${customer.username}` : '';
  if (!username) return customer.display_name;
  return customer.display_name.replace(username, '').trim() || username;
}

async function api(method, body, timeoutMs = 35_000) {
  let lastError;
  for (let attempt = 1; attempt <= config.apiRetries; attempt += 1) {
    try {
      return await apiOnce(method, body, timeoutMs);
    } catch (error) {
      lastError = error;
      if (!isRetryableTelegramError(error) || attempt === config.apiRetries) break;
      const delayMs = config.retryBaseMs * attempt;
      console.error(`Telegram API ${method} 失败，第 ${attempt}/${config.apiRetries} 次：${formatErrorDetails(error)}，${delayMs}ms 后重试`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function apiOnce(method, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'content-type': 'application/json' };
    if (method === 'getUpdates') headers.connection = 'close';
    const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      const error = new Error(payload.description || `Telegram HTTP ${response.status}`);
      error.status = response.status;
      error.errorCode = payload.error_code;
      throw error;
    }
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

function loadConfig() {
  loadDotEnv();
  const botToken = process.env.BOT_TOKEN?.trim();
  const adminChatId = process.env.ADMIN_CHAT_ID?.trim();
  if (!botToken) throw new Error('缺少 BOT_TOKEN，请先配置 .env');
  if (!adminChatId) throw new Error('缺少 ADMIN_CHAT_ID，请先配置 .env');
  return {
    botToken,
    adminChatId,
    dbFile: process.env.DB_FILE?.trim() || './data/relay.sqlite',
    pollTimeoutSeconds: Number(process.env.POLL_TIMEOUT_SECONDS || 25),
    apiRetries: Number(process.env.API_RETRIES || 5),
    retryBaseMs: Number(process.env.RETRY_BASE_MS || 1200),
    processedUpdateKeep: Number(process.env.PROCESSED_UPDATE_KEEP || 2000),
    messageMapKeep: Number(process.env.MESSAGE_MAP_KEEP || 10000),
    auditLogKeep: Number(process.env.AUDIT_LOG_KEEP || 20000),
    userMessageLimitPerMinute: Number(process.env.USER_MESSAGE_LIMIT_PER_MINUTE || 20),
    adminReplyLimitPerMinute: Number(process.env.ADMIN_REPLY_LIMIT_PER_MINUTE || 60),
  };
}

function loadDotEnv() {
  try {
    const envText = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of envText.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^"(.*)"$/u, '$1');
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // .env is optional when variables are provided by systemd.
  }
}

function allowRate(key, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return true;
  const now = Date.now();
  const bucket = rateBuckets.get(key) ?? { resetAt: now + 60_000, count: 0, warnedAt: 0 };
  if (now >= bucket.resetAt) {
    bucket.resetAt = now + 60_000;
    bucket.count = 0;
    bucket.warnedAt = 0;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  return bucket.count <= limit;
}

async function maybeNotifyRateLimited(chatId) {
  const key = `user:${chatId}`;
  const bucket = rateBuckets.get(key);
  const now = Date.now();
  if (!bucket || now - bucket.warnedAt < 30_000) return;
  bucket.warnedAt = now;
  await api('sendMessage', { chat_id: chatId, text: '消息太频繁了，请稍等一下再发送。' })
    .catch((error) => console.error(`限流提醒发送失败：${error.message}`));
}

function isRetryableTelegramError(error) {
  if (error.name === 'AbortError') return true;
  if (!error.status) return true;
  return error.status === 429 || error.status >= 500;
}

function formatErrorDetails(error) {
  const details = [];
  if (error?.message) details.push(error.message);
  if (error?.name && !['Error', 'TypeError'].includes(error.name)) details.push(`name=${error.name}`);

  const causes = [error?.cause, ...(Array.isArray(error?.cause?.errors) ? error.cause.errors : [])]
    .filter(Boolean);
  for (const cause of causes) {
    if (cause.code) details.push(`code=${cause.code}`);
    if (cause.errno && cause.errno !== cause.code) details.push(`errno=${cause.errno}`);
    if (cause.syscall) details.push(`syscall=${cause.syscall}`);
    if (cause.address) details.push(`address=${cause.address}`);
    if (cause.port) details.push(`port=${cause.port}`);
    if (cause.message && cause.message !== error?.message) details.push(`cause=${cause.message}`);
  }

  return [...new Set(details)].join(' | ').slice(0, 500) || String(error);
}

function startOfTodayIso() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

function formatTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function trim(value, length) {
  const text = String(value ?? '');
  return text.length > length ? `${text.slice(0, length - 1)}...` : text;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function requestShutdown(signal) {
  console.log(`收到 ${signal}，正在退出...`);
  shuttingDown = true;
}
