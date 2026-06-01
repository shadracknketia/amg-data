// ==========================================
//    AMG AFFORDABLE DATA - WHATSAPP BOT
// ==========================================
require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const { sendDataRoundRobin } = require('./providers');
const { db, getOrCreateUser } = require('./helpers');
const { setState, getState, clearState } = require('./redisClient');

const lidCache = {};

// --- HELPER FUNCTIONS ---
async function resolveJidToPhone(sender) {
    if (lidCache[sender]) return lidCache[sender];
    let rawId = sender.split('@')[0];
    if (sender.endsWith('@lid')) {
        try {
            const resolved = await client.getContactLidAndPhone([sender]);
            if (resolved && resolved.length > 0 && resolved[0].pn) {
                rawId = resolved[0].pn.split('@')[0];
            }
        } catch (err) { console.error("🔴 LID Error:", err.message); }
    }
    let cleanPhone = rawId.trim();
    if (cleanPhone.startsWith('233')) cleanPhone = '0' + cleanPhone.slice(3);
    lidCache[sender] = cleanPhone;
    return cleanPhone;
}

function cleanPlanName(name) {
    return name.replace(/\s*SMM\s*/gi, '').replace(/\s*Regular\s*/gi, '').trim();
}

async function _displayPlansForUser(sender, state) {
    const { network, page = 0 } = state;
    const itemsPerPage = 5;
    const plans = await db.query(
        'SELECT * FROM data_plans WHERE is_active = true AND network_name = $1 ORDER BY buying_price ASC', 
        [network]
    );
    const startIndex = page * itemsPerPage;
    const pageItems = plans.rows.slice(startIndex, startIndex + itemsPerPage);
    const hasNextPage = plans.rows.length > (startIndex + itemsPerPage);
    const hasPrevPage = page > 0;

    let planMenu = `📊 *${network == 'AT' ? 'AirtelTigo' : network} Bundles* (Page ${page + 1})\n\n`;
    pageItems.forEach((p, i) => {
        planMenu += `*${i + 1}* - ${cleanPlanName(p.plan_name)} (GHS ${p.selling_price})\n`;
    });
    if (hasNextPage) planMenu += `*6.* ➡️ More\n`;
    if (hasPrevPage) planMenu += `*7.* ⬅️ Previous\n`;
    planMenu += `*0.* 🔙 Back`;
    return client.sendMessage(sender, planMenu);
}

const triggerMoMoFlow = async (sender, state) => {
    const { plan, payer, recipient } = state;
    await client.sendMessage(sender, `⏳ Requesting GHS ${plan.selling_price} from *${payer}*...`);
    
    const metadata = { type: 'DIRECT_PURCHASE', customer_phone: recipient, payer_phone: payer, plan_id: plan.idata_plan_id, network_id: plan.network_name.toLowerCase() };
    
    const pay = await axios.post('https://api.paystack.co/transaction/initialize', {
        email: 'customer@amgdata.com', amount: Math.round(plan.selling_price * 100), currency: "GHS", metadata, channels: ['mobile_money', 'card']
    }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }).catch(() => null);

    const checkoutUrl = pay?.data?.data?.authorization_url || null;
    const paystackReference = pay?.data?.data?.reference || 'PROMPT_BUY';

    await db.query(
        'INSERT INTO transactions (user_phone, amount, network, data_volume, status, platform, reference, checkout_url, plan_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [payer, plan.selling_price, plan.network_name, plan.plan_name, 'PROCESSING', 'WHATSAPP', paystackReference, checkoutUrl, plan.id]
    );
    
    await client.sendMessage(sender, `🔔 *Payment Instructions*\n1. Authorize prompt.\n2. Or pay here: ${checkoutUrl || 'N/A'}`);
    await clearState(sender);
};

// --- INITIALIZE WHATSAPP CLIENT (NATIVE VERSION) ---
const client = new Client({
    authStrategy: new LocalAuth({ clientId: "amg-bot-live" }),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version-checker/master/remote/2.2413.51-v2.html',
    },
    puppeteer: {
        headless: true, 
        args:[
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // Sometimes needed for low-memory VPS
            '--disable-gpu'
        ],
    }
});

// --- MAIN MESSAGE LOGIC ---
client.on('message', async (msg) => {
    try {
        const sender = msg.from;
        const userMessage = msg.body.trim();

        // Log incoming message for debugging
        console.log(`📩 Message from ${sender}: ${userMessage}`);

        const formattedSender = await resolveJidToPhone(sender);
        
        if (['0', 'reset', 'menu'].includes(userMessage.toLowerCase())) {
            await clearState(sender);
            return client.sendMessage(sender, "🔄 Reset. Reply '1' for Main Menu.");
        }

        let state = await getState(sender);

        if (!state) {
            state = { step: 'MAIN_MENU' };
            await setState(sender, state);
            return client.sendMessage(sender, `🌟 *Welcome to AMG Affordable Data*\n\n1. 🛒 Buy Data\n2. 💰 Check Wallet\n3. 📖 Instructions\n4. 📞 Support`);
        }

        if (state.step === 'MAIN_MENU') {
            if (userMessage === '1') {
                state.step = 'SELECTING_NETWORK';
                await setState(sender, state);
                return client.sendMessage(sender, `📊 *Select Network*\n1. MTN\n2. Telecel\n3. AirtelTigo\n*0. Back*`);
            } else if (userMessage === '2') {
                const user = await getOrCreateUser(formattedSender);
                await clearState(sender);
                return client.sendMessage(sender, user.pin ? `💰 *Balance:* GHS ${user.wallet_balance}` : `❌ No wallet found.`);
            } else if (userMessage === '3') {
                await clearState(sender);
                return client.sendMessage(sender, `📖 *Instructions:*\n1. Pick 1 to Buy.\n2. Follow steps.\n3. Verify with PIN or MoMo.`);
            } else if (userMessage === '4') {
                await clearState(sender);
                return client.sendMessage(sender, "📞 *Support:* 0539743087");
            }
        }

        if (state.step === 'SELECTING_NETWORK') {
            const netMap = { '1': 'MTN', '2': 'Telecel', '3': 'AT' };
            if (netMap[userMessage]) {
                state.network = netMap[userMessage];
                state.step = 'CHOOSING_PLAN';
                state.page = 0;
                await setState(sender, state);
                return _displayPlansForUser(sender, state);
            }
        }

        if (state.step === 'CHOOSING_PLAN') {
            const choice = parseInt(userMessage);
            if (choice === 0) { state.step = 'MAIN_MENU'; await setState(sender, state); return client.sendMessage(sender, "Back to menu."); }
            
            const plans = await db.query('SELECT * FROM data_plans WHERE is_active = true AND network_name = $1 ORDER BY buying_price ASC', [state.network]);
            const pageItems = plans.rows.slice(state.page * 5, (state.page * 5) + 5);
            
            if (choice === 6) { state.page++; await setState(sender, state); return _displayPlansForUser(sender, state); }
            if (choice === 7) { state.page--; await setState(sender, state); return _displayPlansForUser(sender, state); }
            
            if (choice >= 1 && choice <= pageItems.length) {
                state.plan = pageItems[choice - 1];
                state.step = 'ENTERING_RECIPIENT';
                await setState(sender, state);
                return client.sendMessage(sender, `✅ Selected: ${cleanPlanName(state.plan.plan_name)}\nEnter recipient number (1 for your number):`);
            }
        }

        if (state.step === 'ENTERING_RECIPIENT') {
            state.recipient = userMessage === '1' ? formattedSender : userMessage;
            state.step = 'ENTERING_PAYER';
            await setState(sender, state);
            return client.sendMessage(sender, `📱 Data for: ${state.recipient}\nWhich number is paying? (1 for same):`);
        }

        if (state.step === 'ENTERING_PAYER') {
            state.payer = userMessage === '1' ? state.recipient : userMessage;
            const user = await getOrCreateUser(formattedSender);
            state.hasEnoughBalance = parseFloat(user.wallet_balance) >= parseFloat(state.plan.selling_price);
            state.step = 'CONFIRMING_ORDER';
            await setState(sender, state);
            
            let msg = `📝 *Summary*\nBundle: ${state.plan.plan_name}\nCost: GHS ${state.plan.selling_price}\n\n`;
            msg += state.hasEnoughBalance ? `1. Wallet\n2. MoMo` : `1. MoMo`;
            return client.sendMessage(sender, msg);
        }

        if (state.step === 'CONFIRMING_ORDER') {
            if (userMessage === '1' && state.hasEnoughBalance) {
                state.step = 'VERIFYING_PIN';
                await setState(sender, state);
                return client.sendMessage(sender, "Enter your 4-digit PIN:");
            } else {
                await triggerMoMoFlow(sender, state);
            }
        }

        if (state.step === 'VERIFYING_PIN') {
            const user = await getOrCreateUser(formattedSender);
            if (user.pin === userMessage) {
                await db.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE phone_number = $2', [state.plan.selling_price, formattedSender]);
                const res = await sendDataRoundRobin(state.plan.network_name.toLowerCase(), state.recipient, state.plan.idata_plan_id);
                if (res.success) client.sendMessage(sender, "✅ Success!");
                else {
                    await db.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone_number = $2', [state.plan.selling_price, formattedSender]);
                    client.sendMessage(sender, "⚠️ Failed. Refunded.");
                }
            } else {
                client.sendMessage(sender, "❌ Incorrect PIN.");
            }
            await clearState(sender);
            
        }

        } catch (err) {
        console.error("🔴 CRITICAL BOT ERROR:", err);
        // Optional: Notify the user so they know something went wrong
        // await client.sendMessage(msg.from, "❌ Sorry, an error occurred. Please try again.");
    }
    
});

client.initialize();