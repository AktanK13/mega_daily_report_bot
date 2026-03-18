require('dotenv').config();

const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');

const {
  TG_BOT_TOKEN,
  TG_BOT_ID, // optional: будет использоваться как fallback-чат
  TG_REPORTS_CHAT_ID, // not used yet, reserved for future use
} = process.env;

if (!TG_BOT_TOKEN) {
  console.error('Missing TG_BOT_TOKEN in environment variables.');
  process.exit(1);
}

// Пути к "БД" на файлах
const DATA_DIR = __dirname;
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const PORT = process.env.PORT || 3000;
const BOT_USERNAME = process.env.TG_BOT_USERNAME || 'your_bot_username';

// Initialize Telegram bot in polling mode
const bot = new TelegramBot(TG_BOT_TOKEN, {
  polling: true,
});

bot.on('polling_error', (err) => {
  console.error('Polling error:', err);
});

/**
 * Helpers для работы с JSON-файлами (простейшее файловое хранилище).
 */
async function readJson(filePath, defaultValue) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') {
      return defaultValue;
    }
    throw e;
  }
}

async function writeJson(filePath, value) {
  const json = JSON.stringify(value, null, 2);
  await fs.writeFile(filePath, json, 'utf8');
}

/**
 * Модель пользователей (связка токена сайта и telegram_chat_id).
 * В реальном проекте вместо этого будет своя БД.
 */
async function upsertUserByToken(token, chatId) {
  if (!token) return;

  const users = await readJson(USERS_FILE, []);
  const idx = users.findIndex((u) => u.token === token);

  const now = new Date().toISOString();

  if (idx >= 0) {
    users[idx].chat_id = chatId;
    users[idx].linked_at = now;
  } else {
    users.push({
      token,
      chat_id: chatId,
      linked_at: now,
    });
  }

  await writeJson(USERS_FILE, users);
}

async function getAllUserChatIds() {
  const users = await readJson(USERS_FILE, []);
  const ids = new Set();

  for (const u of users) {
    if (u.chat_id) {
      ids.add(u.chat_id);
    }
  }

  return Array.from(ids);
}

async function createOrUpdateLinkTokenForUser(siteUserId) {
  const users = await readJson(USERS_FILE, []);
  const now = new Date().toISOString();
  const token = crypto.randomUUID();

  const idx = users.findIndex((u) => u.user_id === siteUserId);

  if (idx >= 0) {
    users[idx].token = token;
  } else {
    users.push({
      user_id: siteUserId,
      token,
      chat_id: null,
      linked_at: null,
      created_at: now,
    });
  }

  await writeJson(USERS_FILE, users);
  return token;
}

async function findUserBySiteUserId(siteUserId) {
  const users = await readJson(USERS_FILE, []);
  return users.find((u) => u.user_id === siteUserId) || null;
}

/**
 * Модель отчётов в файловом хранилище.
 * Каждый отчёт: { chat_id, date, report_text, created_at }.
 */
async function saveReport({ chatId, date, text }) {
  const reports = await readJson(REPORTS_FILE, []);
  const idx = reports.findIndex(
    (r) => r.chat_id === chatId && r.date === date,
  );

  const now = new Date().toISOString();

  if (idx >= 0) {
    reports[idx].report_text = text;
    reports[idx].created_at = now;
  } else {
    reports.push({
      chat_id: chatId,
      date,
      report_text: text,
      created_at: now,
    });
  }

  await writeJson(REPORTS_FILE, reports);
}

async function findReportByChatAndDate(chatId, date) {
  const reports = await readJson(REPORTS_FILE, []);
  return (
    reports.find((r) => r.chat_id === chatId && r.date === date) || null
  );
}

/**
 * Даты.
 */
function getTodayDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function getYesterdayDateString() {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const year = yesterday.getFullYear();
  const month = String(yesterday.getMonth() + 1).padStart(2, '0');
  const day = String(yesterday.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/**
 * Получить текст вчерашнего отчёта для конкретного чата.
 * Если в "БД" нет отчёта за вчера — вернётся заглушка по шаблону.
 */
async function getYesterdayReportTextForChat(chatId) {
  const date = getYesterdayDateString();
  const report = await findReportByChatAndDate(chatId, date);

  if (report && report.report_text) {
    return report.report_text;
  }

  return `/done
#Отчет_${date}
- Что делал ?
 (не указано)
- Что буду делать ?
 (не указано)
- Какие проблемы?
 нет проблем`;
}

/**
 * Отправить напоминание для одного конкретного чата.
 */
async function sendDailyReminderForChat(chatId) {
  const yesterdayReport = await getYesterdayReportTextForChat(chatId);

  const reminderText =
    'Пора отправить ежедневный отчёт.\n\n' +
    'Ниже предложен вариант вчерашнего отчёта.\n' +
    'Можешь скопировать его, отредактировать и отправить в нужный чат.';

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: '📋 Скопировать',
          callback_data: 'copy_yesterday',
        },
        {
          text: '✏️ Редактировать',
          callback_data: 'edit_yesterday',
        },
      ],
    ],
  };

  // Сообщение №1: напоминание с кнопками
  await bot.sendMessage(chatId, reminderText, {
    reply_markup: keyboard,
  });

  // Сообщение №2: текст отчёта
  await bot.sendMessage(chatId, yesterdayReport, {
    disable_web_page_preview: true,
  });
}

/**
 * Рассылка напоминаний всем пользователям из файловой "БД".
 * Если пользователей ещё нет, но задан TG_BOT_ID — шлём хотя бы туда (личный режим).
 */
async function sendDailyRemindersForAllUsers() {
  try {
    const chatIds = await getAllUserChatIds();

    if (chatIds.length === 0 && TG_BOT_ID) {
      // fallback на одиночный режим
      console.log(
        'No linked users found, sending reminder only to TG_BOT_ID fallback.',
      );
      await sendDailyReminderForChat(TG_BOT_ID);
      console.log('Daily reminder sent to TG_BOT_ID.');
      return;
    }

    for (const chatId of chatIds) {
      try {
        await sendDailyReminderForChat(chatId);
        console.log(`Daily reminder sent to chat ${chatId}.`);
      } catch (error) {
        console.error(`Failed to send daily reminder to chat ${chatId}:`, error);
      }
    }
  } catch (error) {
    console.error('Failed to send daily reminders for all users:', error);
  }
}

/**
 * Обработчики Telegram.
 */

// /start или /start <token>
bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const token = match && match[1] ? match[1].trim() : null;

  try {
    if (token) {
      await upsertUserByToken(token, chatId);
      await bot.sendMessage(
        chatId,
        'Telegram успешно привязан к аккаунту на сайте. Теперь утренние напоминания будут приходить сюда.',
      );
    } else {
      await bot.sendMessage(
        chatId,
        'Привет! Я бот для ежедневных отчётов.\n' +
          'Подключи меня через сайт, чтобы я знал, к какому аккаунту тебя привязать.',
      );
    }
  } catch (error) {
    console.error('Error handling /start:', error);
    await bot.sendMessage(
      chatId,
      'Произошла ошибка при обработке команды /start. Попробуй ещё раз позже.',
    );
  }
});

// Любое сообщение с отчётом, например начинающееся с /done
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;

  // Уже обработано в onText(/start/), чтобы не дублировать.
  if (text.startsWith('/start')) {
    return;
  }

  // Простейшее правило: если сообщение начинается с /done — считаем это отчётом
  if (text.startsWith('/done')) {
    try {
      // Пытаемся вытащить дату из строки вида "#Отчет_YYYY-MM-DD"
      const match = text.match(/#Отчет_(\d{4}-\d{2}-\d{2})/i);
      const date = match ? match[1] : getTodayDateString();

      await saveReport({ chatId, date, text });

      await bot.sendMessage(
        chatId,
        `Отчёт за ${date} сохранён. Утром я смогу напомнить тебе этот текст.`,
      );
    } catch (error) {
      console.error('Error saving report:', error);
      await bot.sendMessage(
        chatId,
        'Не удалось сохранить отчёт. Попробуй ещё раз позже.',
      );
    }
  }
});

// Обработчик callback_query для inline-кнопок
bot.on('callback_query', async (query) => {
  try {
    const { id, data } = query;

    if (data === 'copy_yesterday') {
      await bot.answerCallbackQuery(id, {
        text: 'Скопируй текст отчёта из сообщения ниже и отправь его в нужный чат.',
        show_alert: false,
      });
    } else if (data === 'edit_yesterday') {
      await bot.answerCallbackQuery(id, {
        text: 'Отредактируй текст вчерашнего отчёта и отправь как новое сообщение.',
        show_alert: false,
      });
    } else {
      await bot.answerCallbackQuery(id, {
        text: 'Неизвестное действие.',
        show_alert: false,
      });
    }
  } catch (error) {
    console.error('Error handling callback_query:', error);
  }
});

// Cron schedule: every weekday (Mon–Fri) at 09:00 (server time)
cron.schedule(
  '0 9 * * 1-5',
  () => {
    console.log('Cron job triggered: sending daily reminders for all users.');
    sendDailyRemindersForAllUsers().catch((err) =>
      console.error('Unexpected error in sendDailyRemindersForAllUsers:', err),
    );
  },
  {
    timezone: undefined, // uses server time; adjust if needed
  },
);

console.log(
  'Telegram reminder bot started. Waiting for cron schedule (09:00, Mon–Fri).',
);

/**
 * HTTP API (Express) для интеграции с сайтом (Netlify).
 */

const app = express();
app.use(express.json());

// Health-check, чтобы Render видел, что сервис жив
app.get('/', (req, res) => {
  res.send('OK: mega-daily-report-bot is running');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

/**
 * POST /api/link-tg
 * Тело: { "userId": "site_user_id" }
 * Ответ: { "token": "...", "botLink": "https://t.me/<bot>?start=..." }
 */
app.post('/api/link-tg', async (req, res) => {
  try {
    const { userId } = req.body || {};

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const token = await createOrUpdateLinkTokenForUser(String(userId));

    const botLink = `https://t.me/${BOT_USERNAME}?start=${encodeURIComponent(
      token,
    )}`;

    res.json({
      token,
      botLink,
    });
  } catch (error) {
    console.error('Error in /api/link-tg:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/report
 * Тело: { "userId": "site_user_id", "text": "отчёт", "date": "YYYY-MM-DD" (опционально) }
 * Действия:
 * - находит пользователя по userId
 * - если есть chat_id, сохраняет отчёт в "БД"
 * - отправляет отчёт в Telegram с кнопками
 */
app.post('/api/report', async (req, res) => {
  try {
    const { userId, text, date } = req.body || {};

    if (!userId || !text) {
      return res.status(400).json({ error: 'userId and text are required' });
    }

    const user = await findUserBySiteUserId(String(userId));

    if (!user || !user.chat_id) {
      return res.status(400).json({
        error:
          'Telegram is not linked for this user yet. Ask user to connect Telegram first.',
      });
    }

    const reportDate = date || getTodayDateString();

    await saveReport({
      chatId: user.chat_id,
      date: reportDate,
      text,
    });

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: '📋 Скопировать',
            callback_data: 'copy_yesterday',
          },
          {
            text: '✏️ Редактировать',
            callback_data: 'edit_yesterday',
          },
        ],
      ],
    };

    await bot.sendMessage(user.chat_id, text, {
      reply_markup: keyboard,
      disable_web_page_preview: true,
    });

    res.json({
      ok: true,
      date: reportDate,
    });
  } catch (error) {
    console.error('Error in /api/report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`HTTP API server listening on port ${PORT}`);
});


