require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

// ১. এনভায়রনমেন্ট ভ্যালিডেশন
const REQUIRED_ENV = ['BOT_TOKEN', 'API_KEY', 'BASE_URL', 'OTP_GROUP_ID'];
for (const envVar of REQUIRED_ENV) {
    if (!process.env[envVar]) {
        console.error(`[FATAL ERROR] Missing environment variable: ${envVar}`);
        process.exit(1);
    }
}

const CONFIG = {
    botToken: process.env.BOT_TOKEN,
    apiKey: process.env.API_KEY,
    baseUrl: process.env.BASE_URL,
    groupId: process.env.OTP_GROUP_ID,
    pollingInterval: parseInt(process.env.POLLING_INTERVAL_MS, 10) || 5000,
    maxAttempts: parseInt(process.env.MAX_POLLING_ATTEMPTS, 10) || 60
};

// ২. অ্যাক্টিভ পোলিং ট্র্যাকিং (Mem Leak Protection)
const activePolls = new Map();

// ৩. Axios HTTP ইনস্ট্যান্স
const apiClient = axios.create({
    baseURL: CONFIG.baseUrl,
    headers: {
        'mknetwork-key': CONFIG.apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    },
    timeout: 12000
});

// API Helper
async function fetchApi(endpoint, params = {}) {
    try {
        const response = await apiClient.get(endpoint, { params });
        return response.data;
    } catch (error) {
        const errorDetails = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error(`[API ERROR] ${endpoint} ->${errorDetails}`);
        return null;
    }
}

// ৪. কলাম বাটন লেআউট জেনারেটর (2-Column Grid Layout)
function buildColumnKeyboard(items, itemsPerRow = 2) {
    const buttons = [];
    for (let i = 0; i < items.length; i += itemsPerRow) {
        const row = items.slice(i, i + itemsPerRow).map(item => {
            const title = item.name || item.service_name || `Service #${item.id || item.service_id}`;
            const id = item.id || item.service_id;
            return Markup.button.callback(title, `buy_service_${id}`);
        });
        buttons.push(row);
    }
    buttons.push([Markup.button.callback('❌ মেনু বন্ধ করুন', 'close_menu')]);
    return Markup.inlineKeyboard(buttons);
}

// ৫. বট ইনস্ট্যান্স তৈরি
const bot = new Telegraf(CONFIG.botToken);

// মেইন রিফ্রেশেবল কিবোর্ড
function getMainMenu() {
    return Markup.keyboard([
        ['📱 নাম্বার নিন (Get Number)', '📊 ব্যালেন্স চেক'],
        ['📋 অ্যাক্টিভ অর্ডার', 'ℹ️ সাহায্য & নির্দেশিকা']
    ]).resize();
}

// --- COMMAND & EVENT HANDLERS ---

// /start Command
bot.start((ctx) => {
    const name = ctx.from.first_name ? ctx.from.first_name.replace(/[*_`\[\]]/g, '') : 'User';
    const text = `👋 **হ্যালো ${name}!**\n\n` +
                 `MKNETWORKBD অটোমেটেড ওটিপি বক্সে আপনাকে স্বাগতম।\n` +
                 `নিচের কিবোর্ড থেকে আপনার প্রয়োজনীয় সার্ভিস সিলেক্ট করুন।`;
    
    return ctx.replyWithMarkdown(text, getMainMenu());
});

// Balance Check
bot.hears('📊 ব্যালেন্স চেক', async (ctx) => {
    const loadingMsg = await ctx.reply('⏳ ব্যালেন্স স্টেটমেন্ট আনা হচ্ছে...');
    const data = await fetchApi('/user/balance');
    
    if (data && (data.balance !== undefined || data.data?.balance !== undefined)) {
        const balance = data.balance ?? data.data.balance;
        const currency = data.currency || 'BDT';
        await ctx.telegram.editMessageText(
            ctx.chat.id, 
            loadingMsg.message_id, 
            null, 
            `💰 **আপনার বর্তমান ব্যালেন্স:** \`${balance}\` ${currency}`, 
            { parse_mode: 'Markdown' }
        );
    } else {
        await ctx.telegram.editMessageText(
            ctx.chat.id, 
            loadingMsg.message_id, 
            null, 
            '⚠️ ব্যালেন্স লোড করা সম্ভব হয়নি। এপিআই কী অথবা সার্ভার কানেকশন চেক করুন।'
        );
    }
});

// Active Orders Status
bot.hears('📋 অ্যাক্টিভ অর্ডার', async (ctx) => {
    if (activePolls.size === 0) {
        return ctx.reply('ℹ️ বর্তমানে আপনার কোনো পেন্ডিং ওটিপি অর্ডার নেই।');
    }
    
    let report = `📋 **আপনার বর্তমান অ্যাক্টিভ অর্ডার তালিকা (${activePolls.size}):**\n\n`;
    for (const [orderId, pollInfo] of activePolls.entries()) {
        if (pollInfo.userId === ctx.from.id) {
            report += `🆔 Order: \`${orderId}\` | 📱 Phone: \`${pollInfo.phone}\`\n`;
        }
    }
    return ctx.replyWithMarkdown(report);
});

// Help Command
bot.hears('ℹ️ সাহায্য & নির্দেশিকা', (ctx) => {
    const helpText = `ℹ️ **সহায়তা কেন্দ্র:**\n\n` +
                     `1. "📱 নাম্বার নিন" বাটনে ক্লিক করে সার্ভিস নির্বাচন করুন।\n` +
                     `2. নাম্বার পাওয়ার সাথে সাথে আপনার নির্দিষ্ট প্লাটফর্মে ব্যবহার করুন।\n` +
                     `3. ওটিপি আসা মাত্রই বট আপনাকে জানাবে এবং ওটিপি গ্রুপে অটো রিলে করবে।`;
    return ctx.replyWithMarkdown(helpText);
});

// Service List Fetching & Render (2-Column Grid)
bot.hears('📱 নাম্বার নিন (Get Number)', async (ctx) => {
    const loadingMsg = await ctx.reply('🔄 সার্ভিস ক্যাটালগ লোড করা হচ্ছে...');
    const response = await fetchApi('/services');
    
    const serviceList = response?.services || response?.data || response;

    if (Array.isArray(serviceList) && serviceList.length > 0) {
        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
        await ctx.reply(
            '📱 **নিচের তালিকা থেকে আপনার কাঙ্ক্ষিত সার্ভিসটি নির্বাচন করুন:**',
            {
                parse_mode: 'Markdown',
                ...buildColumnKeyboard(serviceList, 2)
            }
        );
    } else {
        await ctx.telegram.editMessageText(
            ctx.chat.id, 
            loadingMsg.message_id, 
            null, 
            '❌ সার্ভিস লিস্ট এই মুহূর্তে খালি অথবা পাওয়া যাচ্ছে না।'
        );
    }
});

// Buy Number Action Handler
bot.action(/^buy_service_(.+)$/, async (ctx) => {
    const serviceId = ctx.match[1];
    await ctx.answerCbQuery('নাম্বার রিকোয়েস্ট প্রসেস করা হচ্ছে...');
    
    await ctx.editMessageText(`⏳ **Service ID: ${serviceId}** এর জন্য নাম্বার বরাদ্দ করা হচ্ছে...`);

    const orderData = await fetchApi('/order/get', { service: serviceId });
    const order = orderData?.order || orderData?.data || orderData;

    if (order && (order.phone || order.number) && (order.id || order.order_id)) {
        const phone = order.phone || order.number;
        const orderId = order.id || order.order_id;

        const successText = `✅ **নাম্বার সফলভাবে বরাদ্দ করা হয়েছে!**\n\n` +
                            `📱 **নাম্বার:** \`${phone}\`\n` +
                            `🆔 **অর্ডার আইডি:** \`${orderId}\`\n\n` +
                            `⏱️ *ওটিপির জন্য অপেক্ষা করা হচ্ছে... (অটোমেটিক আপডেট হবে)*`;

        const cancelKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🚫 অর্ডার বাতিল করুন', `cancel_order_${orderId}`)]
        ]);

        await ctx.replyWithMarkdown(successText, cancelKeyboard);

        // ওটিপি পোলিং প্রসেস শুরু
        executeOtpPolling(ctx, orderId, phone);

    } else {
        const errorMsg = orderData?.message || 'এই মুহূর্তে এই সার্ভিসের কোনো নাম্বার এভেলেবল নেই।';
        await ctx.reply(`❌ **অনুরোধ ব্যর্থ হয়েছে:** ${errorMsg}`);
    }
});

// Cancel Order Handler
bot.action(/^cancel_order_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    await ctx.answerCbQuery('ক্যানসেল রিকোয়েস্ট পাঠানো হচ্ছে...');

    // অ্যাক্টিভ ইন্টারভাল ক্লিয়ার করা
    if (activePolls.has(orderId)) {
        clearInterval(activePolls.get(orderId).timer);
        activePolls.delete(orderId);
    }

    const cancelRes = await fetchApi('/order/cancel', { order_id: orderId });
    
    if (cancelRes && (cancelRes.status === 'success' || cancelRes.success === true)) {
        await ctx.editMessageText(`❌ **অর্ডার #${orderId} বাতিল করা হয়েছে।**`);
    } else {
        await ctx.reply(`⚠️ **অর্ডার #${orderId}** বাতিল করা সম্ভব হয়নি অথবা আগেই সময় পার হয়ে গেছে।`);
    }
});

// Menu Close Action
bot.action('close_menu', (ctx) => {
    ctx.answerCbQuery();
    return ctx.deleteMessage().catch(() => {});
});

// --- OTP POLLING ENGINE & DISPATCHER ---

function executeOtpPolling(ctx, orderId, phone) {
    let attempts = 0;
    const userId = ctx.from.id;
    const userName = ctx.from.first_name ? ctx.from.first_name.replace(/[*_`\[\]]/g, '') : 'User';

    // আগের কোনো পোলিং সক্রিয় থাকলে তা ক্লিয়ার করা
    if (activePolls.has(orderId)) {
        clearInterval(activePolls.get(orderId).timer);
    }

    const timer = setInterval(async () => {
        attempts++;

        const response = await fetchApi('/order/status', { order_id: orderId });
        const otp = response?.sms || response?.otp || response?.data?.sms || response?.data?.otp;

        if (otp) {
            // ১. পোলিং টাইমার বন্ধ করা
            clearInterval(timer);
            activePolls.delete(orderId);

            // ২. ইউজার ইনবক্সে ওটিপি ডেলিভারি
            const userMsg = `🎉 **নতুন ওটিপি চলে এসেছে!**\n\n` +
                            `📱 **নাম্বার:** \`${phone}\`\n` +
                            `🔑 **OTP CODE:** \`${otp}\`\n` +
                            `🆔 **অর্ডার আইডি:** \`${orderId}\``;

            await ctx.replyWithMarkdown(userMsg).catch(err => {
                console.error(`[DELIVERY ERROR] Failed to send OTP to User ${userId}:`, err.message);
            });

            // ৩. ওটিপি গ্রুপে ব্রডকাস্ট পাঠানো
            const groupMsg = `📢 **LIVE OTP DISPATCH**\n\n` +
                             `👤 **ব্যবহারকারী:** [${userName}](tg://user?id=${userId})\n` +
                             `📱 **নাম্বার:** \`${phone}\`\n` +
                             `🔑 **OTP CODE:** \`${otp}\`\n` +
                             `🆔 **অর্ডার আইডি:** \`${orderId}\``;

            await bot.telegram.sendMessage(CONFIG.groupId, groupMsg, { parse_mode: 'Markdown' })
                .catch(err => {
                    console.error(`[GROUP DISPATCH ERROR] Group ID ${CONFIG.groupId}:`, err.message);
                });

        } else if (attempts >= CONFIG.maxAttempts) {
            // সর্বোচ্চ চেষ্টার পর ক্লিয়ারেন্স
            clearInterval(timer);
            activePolls.delete(orderId);

            await ctx.replyWithMarkdown(
                `⏰ **সময়সীমা পার হয়ে গেছে!**\nঅর্ডার আইডি \`${orderId}\` (নাম্বার: \`${phone}\`) এর ওটিপি প্রাপ্তি সময় পার হয়েছে।`
            ).catch(() => {});
        }
    }, CONFIG.pollingInterval);

    // মেমরিতে প্রসেস ট্র্যাক করে রাখা
    activePolls.set(orderId, { timer, userId, phone });
}

// --- BOT LAUNCH & LIFECYCLE ---

bot.catch((err, ctx) => {
    console.error(`[TELEGRAF ERROR] Context: ${ctx.updateType}`, err);
});

bot.launch({
    allowedUpdates: ['message', 'callback_query']
}).then(() => {
    console.log('🤖 MKNETWORKBD Production Engine active and running.');
}).catch((err) => {
    console.error('[CRITICAL] Bot launch failed:', err.message);
    process.exit(1);
});

// Graceful Shutdown System
const shutdown = (signal) => {
    console.log(`\n[SHUTDOWN] Received ${signal}. Cleaning up polling timers...`);
    for (const [orderId, poll] of activePolls.entries()) {
        clearInterval(poll.timer);
    }
    activePolls.clear();
    bot.stop(signal);
    process.exit(0);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
