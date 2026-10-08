require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════════════
// ⚙️ CONFIGURATION & ENVIRONMENT VARIABLES
// ═══════════════════════════════════════════════════════════════════
const BOT_TOKEN         = process.env.BOT_TOKEN;
const ADMIN_GROUP_ID    = process.env.ADMIN_GROUP_ID;

// 1. አዲሱ የ VIP / Express ፋይናንስ መከታተያ Sheet Webhook URL
const VIP_SHEET_URL     = process.env.SHEET_WEBHOOK_URL || process.env.VIP_SHEET_URL;

// 2. ዋናው የ Swap Money Apps Script URL (ዋሌት እና User ደረጃዎችን የያዘው)
const MAIN_SCRIPT_URL   = process.env.MAIN_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbxDii62Bjz7KNxIFY9deeDDxnjNx1ifHu93GRxkhmpC9srZ_ZFSAtQgttQYh8o1pXmIgQ/exec';

// ዋናው Apps Script ሚስጥራዊ ቁልፍ
const ADMIN_SECRET      = process.env.ADMIN_SECRET || 'SWAP_ADMIN_SECURE_2026';

if (!BOT_TOKEN) {
  console.error("❌ CRITICAL ERROR: BOT_TOKEN is missing in Environment Variables!");
}

// 🛡️ የቴሌግራም ቦት ማዋቀር (409 Conflict መከላከያ ያለው)
const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    autoStart: true,
    params: { timeout: 10 }
  }
});

// 409 Conflict እንዳይዘጋው እና አሮጌው ሰርቨር እስኪጠፋ በሰላም እንዲጠብቅ
bot.on('polling_error', (error) => {
  if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) {
    console.log('⚠️ ቴሌግራም ግጭት ተፈጥሯል፤ የቀድሞው ሰርቨር እስኪዘጋ ጥቂት ሰከንዶች ይጠብቃል...');
  } else {
    console.error('Polling error:', error.message);
  }
});

// 🛡️ ፎቶዎችን በ Memory (RAM) ከነ ትክክለኛ ቅጥያቸው ለመያዝ
const storage = multer.memoryStorage();
const upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ፈጣን In-Memory Cache (አፑ በቅጽበት መልስ እንዲያገኝ)
const liveStatusCache = {};

// የመነሻ ገጽ (Cannot GET / እንዳይል)
app.get('/', (req, res) => {
  res.send('🚀 Swap Money Dual-Bridge & Express Gateway Server is Live and Running!');
});

// ═══════════════════════════════════════════════════════════════════
// 🌉 DUAL SHEET API CALL HELPERS
// ═══════════════════════════════════════════════════════════════════

// ሀ. ከአዲሱ የፋይናንስ Sheet ጋር መገናኛ
async function callVipSheet(payload) {
  if (!VIP_SHEET_URL) return null;
  try {
    const res = await fetch(VIP_SHEET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (e) {
    console.error('❌ VIP Sheet Call Error:', e.message);
    return null;
  }
}

// ለ. ከዋናው Swap Money Apps Script ጋር መገናኛ
async function callMainSheet(payload) {
  if (!MAIN_SCRIPT_URL) return null;
  try {
    const res = await fetch(MAIN_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (e) {
    console.error('❌ Main Sheet Call Error:', e.message);
    return null;
  }
}

// 🛡️ ቴሌግራም HTML እንዳይበላሽ ማጣሪያ
function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ═══════════════════════════════════════════════════════════════════
// 1. የክፍያ ጥያቄ መቀበያ (SUBMIT VIP & EXPRESS PAYMENTS)
// ═══════════════════════════════════════════════════════════════════
app.post('/api/submit-vip-payment', upload.single('receiptPhoto'), async (req, res) => {
  try {
    const { userId, username, vipTier, amount, txId, fullSms, method } = req.body;
    const file = req.file;

    const rawTier = String(vipTier || 'VIP').toUpperCase();
    const cleanMethod = String(method || 'CBE Bank');
    const isExpress = rawTier.includes('EXPRESS') || (fullSms && fullSms.includes('EXPRESS'));
    const tierName = isExpress ? 'EXPRESS PASS' : rawTier;

    // 1. Cache ላይ Pending አድርገን እንይዛለን
    liveStatusCache[userId] = { 
      status: 'pending', 
      tier: tierName, 
      amount: amount || 100, 
      txId: txId || 'PROOF' 
    };

    // 2. VIP Sheet ላይ መመዝገብ
    callVipSheet({
      action: 'record_pending',
      userId: userId,
      username: username || 'User',
      tier: tierName,
      amount: amount || 100,
      method: cleanMethod,
      txId: txId || 'N/A'
    });

    // 3. ወደ ቴሌግራም አድሚን ግሩፕ ማዘጋጀት
    let caption = '';

    if (isExpress) {
      // ⚡ ለአዲሱ Swap Express Gateway የሚዘጋጅ ልዩ ሰማያዊ መልዕክት
      caption = 
        `⚡ <b>አዲስ የ SWAP EXPRESS ፈጣን ክፍያ ጥያቄ!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>ተጠቃሚ:</b> @${escapeHtml(username || 'N/A')} (ID: <code>${userId}</code>)\n` +
        `🎫 <b>ጥቅል:</b> <b>⚡ 100 ETB Express Pass</b>\n` +
        `🏦 <b>የከፈለበት መንገድ:</b> ${cleanMethod}\n` +
        `🧾 <b>TxID:</b> <code>${escapeHtml(txId || 'PHOTO_PROOF')}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📱 <b>የመረጃ ዝርዝር & SMS:</b>\n<i>${fullSms ? escapeHtml(fullSms.slice(0, 220)) : 'የደረሰኝ ፎቶ ብቻ ተያይዟል'}</i>\n\n` +
        `👇 <i>ደረሰኙን ካረጋገጡ በኋላ አንዱን ይምረጡ፦</i>`;
    } else {
      // 💎 ለዋናው አፕ (PRO፣ VIP፣ PREMIUM) የሚዘጋጅ መልዕክት
      caption = 
        `💎 <b>አዲስ የ ${tierName} ክፍያ ጥያቄ ደርሷል!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>ተጠቃሚ:</b> @${escapeHtml(username || 'N/A')} (ID: <code>${userId}</code>)\n` +
        `📦 <b>ጥቅል:</b> <b>${tierName}</b> (${amount} ETB)\n` +
        `🏦 <b>የክፍያ መንገድ:</b> ${cleanMethod}\n` +
        `🧾 <b>TxID:</b> <code>${escapeHtml(txId || 'PHOTO_PROOF')}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📱 <b>የ SMS መልዕክት:</b>\n<i>${fullSms ? escapeHtml(fullSms.slice(0, 160)) + '...' : 'የደረሰኝ ፎቶ ብቻ ተያይዟል'}</i>\n\n` +
        `👇 <i>ክፍያውን ካረጋገጡ በኋላ አንዱን ይምረጡ፦</i>`;
    }

    // 🛡️ የቴሌግራም 64-byte limit እንዳይሰበር አጭር callback_data
    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: `✅ Approve (${amount || 100} ETB)`, callback_data: `v_app:${userId}:${isExpress ? 'PRO' : rawTier}:${amount || 100}` },
          { text: `❌ Reject`, callback_data: `v_rej:${userId}` }
        ]
      ]
    };

    // 4. 🚀 ቴሌግራም ላይ ፎቶውን መላክ (ከነ Fail-Safe መከላከያው)
    let sentSuccess = false;

    if (file && file.buffer) {
      try {
        await bot.sendPhoto(ADMIN_GROUP_ID, file.buffer, {
          caption: caption,
          parse_mode: 'HTML',
          reply_markup: inlineKeyboard
        }, {
          filename: 'receipt.jpg',
          contentType: file.mimetype || 'image/jpeg'
        });
        sentSuccess = true;
      } catch (photoErr) {
        console.error('⚠️ Photo upload to Telegram failed, falling back to text:', photoErr.message);
      }
    }

    // ፎቶ ከሌለ ወይም ቴሌግራም ፎቶውን ካልተቀበለ በቀጥታ በጽሁፍ ይልካል (አፑ አይቆምም!)
    if (!sentSuccess) {
      await bot.sendMessage(ADMIN_GROUP_ID, caption, {
        parse_mode: 'HTML',
        reply_markup: inlineKeyboard
      });
    }

    res.json({ 
      status: 'success', 
      message: 'ክፍያዎ ወደ አድሚን ግሩፕ ተልኳል! በደቂቃዎች ውስጥ ይረጋገጣል።' 
    });

  } catch (error) {
    console.error('Submit Error:', error.response?.body || error.message);
    res.status(500).json({ status: 'error', message: 'ክፍያውን ማድረስ አልተቻለም' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 2. አድሚን በቴሌግራም ሲጫን (APPROVE / REJECT)
// ═══════════════════════════════════════════════════════════════════
bot.on('callback_query', async (query) => {
  const data = query.data;
  const adminTag = query.from.username ? `@${query.from.username}` : (query.from.first_name || 'Admin');

  // ─────────────────────────────────────────────────────────────
  // ✅ አድሚኑ APPROVE ሲጫን
  // ─────────────────────────────────────────────────────────────
  if (data.startsWith('v_app:')) {
    const [_, userId, tier, amount] = data.split(':');

    bot.answerCallbackQuery(query.id, { text: `✅ ${tier} ጸድቋል!` }).catch(() => {});

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 30);
    const expiryStr = expiryDate.toISOString().split('T')[0];

    // 1. Live Cache
    liveStatusCache[userId] = {
      status: 'approved',
      tier: tier.toUpperCase(),
      expiry: expiryStr
    };

    // 2. መልዕክቱን ማዘመን
    const originalText = query.message.caption || query.message.text || '';
    const updatedCaption = originalText + `\n\n✅ <b>በ ${adminTag} ጸድቋል! (APPROVED)</b>`;

    if (query.message.photo) {
      bot.editMessageCaption(updatedCaption, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      }).catch(() => {});
    } else {
      bot.editMessageText(updatedCaption, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      }).catch(() => {});
    }

    // 3. VIP Sheet ማዘመን (ለፋይናንስ ኦዲት)
    callVipSheet({
      action: 'approve_vip',
      userId: userId,
      approvedBy: adminTag
    });

    // 4. 🛡️ ዋናው Sheet ላይ በ Users ሺት አምድ 9 (VIP_Tier) መመዝገብ
    callMainSheet({
      action: 'approvevip',
      adminKey: ADMIN_SECRET,
      userId: String(userId).trim(),
      vipTier: tier.toUpperCase(),
      txId: ''
    });

    // 5. ለተጠቃሚው በቦቱ ማሳወቅ
    try {
      const isExpress = tier.toUpperCase().includes('EXPRESS') || originalText.includes('EXPRESS');
      const userMsg = isExpress
        ? `⚡ <b>እንኳን ደስ አለዎት!</b>\n\nየ <b>100 ETB Swap Express Pass</b> ጥያቄዎ በአድሚን ጸድቋል!\n🚀 ገንዘብዎ በ 2-4 ሰዓታት ውስጥ ወደ መረጡት አካውንት ይተላለፋል።`
        : `🎉 <b>እንኳን ደስ አለዎት!</b>\n\nየ <b>${tier} አባልነትዎ</b> በተሳካ ሁኔታ ጸድቋል!\n🌟 አሁኑኑ አፑን ከፍተው በልዩ ጥቅማጥቅሞች ይደሰቱ!\n📅 የሚያበቃበት ቀን: <b>${expiryStr}</b>`;

      await bot.sendMessage(userId, userMsg, { parse_mode: 'HTML' });
    } catch (e) {}
  }

  // ─────────────────────────────────────────────────────────────
  // ❌ አድሚኑ REJECT ሲጫን
  // ─────────────────────────────────────────────────────────────
  else if (data.startsWith('v_rej:')) {
    const [_, userId] = data.split(':');

    bot.answerCallbackQuery(query.id, { text: `❌ ውድቅ ተደርጓል!` }).catch(() => {});

    liveStatusCache[userId] = { status: 'rejected' };

    callVipSheet({
      action: 'reject_vip',
      userId: userId,
      rejectedBy: adminTag
    });

    callMainSheet({
      action: 'rejectvip',
      adminKey: ADMIN_SECRET,
      userId: userId,
      reason: 'የላኩት ደረሰኝ ወይም TxID ትክክል አይደለም'
    });

    const originalText = query.message.caption || query.message.text || '';
    const updatedCaption = originalText + `\n\n❌ <b>በ ${adminTag} ውድቅ ተደርጓል (REJECTED)!</b>`;

    if (query.message.photo) {
      bot.editMessageCaption(updatedCaption, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      }).catch(() => {});
    } else {
      bot.editMessageText(updatedCaption, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      }).catch(() => {});
    }

    try {
      await bot.sendMessage(userId, 
        `⚠️ <b>የክፍያ ማሳሰቢያ፦</b>\n` +
        `ያስገቡት የክፍያ ደረሰኝ ወይም TxID ትክክል ስላልሆነ በአድሚን ውድቅ ተደርጓል። እባክዎ ትክክለኛውን ደረሰኝ ይላኩ።`, 
        { parse_mode: 'HTML' }
      );
    } catch (e) {}
  }
});

// ═══════════════════════════════════════════════════════════════════
// 3. አፑ በጀርባ ፈጣን ሁኔታውን የሚጠይቅበት (POLLING ENDPOINT)
// ═══════════════════════════════════════════════════════════════════
app.get('/api/check-vip-status', (req, res) => {
  const userId = req.query.userId;
  const user = liveStatusCache[userId];
  if (user) {
    res.json(user);
  } else {
    res.json({ status: 'none' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 4. በቴሌግራም አድሚን ግሩፕ ውስጥ የሚሰራ የፋይናንስ ሪፖርት (/stats)
// ═══════════════════════════════════════════════════════════════════
bot.onText(/\/stats|\/dashboard/, async (msg) => {
  if (String(msg.chat.id) !== String(ADMIN_GROUP_ID)) return;

  const waitMsg = await bot.sendMessage(msg.chat.id, '⏳ ከ Google Sheet መረጃዎችን በማስላት ላይ...');
  const stats = await callVipSheet({ action: 'get_stats' });

  if (!stats || stats.status !== 'success') {
    return bot.editMessageText('❌ መረጃዎችን ከ VIP Sheet ማምጣት አልተቻለም።', {
      chat_id: msg.chat.id,
      message_id: waitMsg.message_id
    });
  }

  const report = 
    `📊 <b>SWAP MONEY VIP & EXPRESS FINANCIAL DASHBOARD</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 <b>ጠቅላላ የጸደቀ ገቢ፦</b> <b>${stats.totalRevenue.toLocaleString()} ETB</b>\n` +
    `📱 <b>በ Telebirr የገባ፦</b> ${stats.telebirrTotal.toLocaleString()} ETB\n` +
    `🏦 <b>በ CBE Bank የገባ፦</b> ${stats.cbeTotal.toLocaleString()} ETB\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👑 <b>ንቁ VIP አባላት፦</b> ${stats.activeVips} ሰዎች\n` +
    `⏳ <b>በጥበቃ ላይ ያሉ፦</b> ${stats.pendingCount} ጥያቄዎች\n` +
    `❌ <b>ውድቅ የተደረጉ፦</b> ${stats.rejectedCount} ጥያቄዎች\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚡ <i>መረጃው በቀጥታ ከኦፊሴላዊው የ VIP Sheet የተወሰደ ነው።</i>`;

  bot.editMessageText(report, {
    chat_id: msg.chat.id,
    message_id: waitMsg.message_id,
    parse_mode: 'HTML'
  });
});

// 🔍 ማንም ሰው ግሩፕ ውስጥ መልዕክት ሲጽፍ ትክክለኛውን Chat ID በሎግ ላይ ያወጣል
bot.on('message', (msg) => {
  console.log(`📩 Message from Chat ID: ${msg.chat.id}, Title: ${msg.chat.title || 'Private'}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Swap Unified Express Server live on port ${PORT}`));
