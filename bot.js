// ==========================================
//    AMG AFFORDABLE DATA - WHATSAPP BOT
// ==========================================
require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const { sendDataRoundRobin } = require('./providers');
const { db, getOrCreateUser } = require('./helpers');
const { setState, getState, clearState, setLock, releaseLock, setRecipientCooldown } = require('./redisClient');

const lidCache = {};

console.log("🚀 Booting up WhatsApp Engine (Stealth Mode)...");

const client = new Client({
    authStrategy: new LocalAuth({ clientId: "amg-bot-live" }),
    // 🛡️ ANTI-BAN 1: Force a real human User-Agent so Meta doesn't see "HeadlessChrome"
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    puppeteer: {
        headless: true, 
        dumpio: false, 
        args:[
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            // 🛡️ ANTI-BAN 2: Hide the "Automation" flags from WhatsApp's security scanners
            '--disable-blink-features=AutomationControlled' 
        ],
    }
});

// ==========================================
// 🛡️ ANTI-BAN HUMANIZER FUNCTION
// ==========================================
async function sendHumanMessage(sender, text) {
    try {
        // 1. Get the chat
        const chat = await client.getChatById(sender);
        // 2. Show "typing..." indicator on user's phone
        await chat.sendStateTyping();
        // 3. Wait a random amount of time between 1.5 and 3 seconds
        const delayMs = Math.floor(Math.random() * 1500) + 1500;
        await new Promise(resolve => setTimeout(resolve, delayMs));
        
        // 4. Send the message WITH LINK PREVIEWS DISABLED 🛡️
        return await client.sendMessage(sender, text, { linkPreview: false });
    } catch (err) {
        // Fallback just in case
        return await client.sendMessage(sender, text, { linkPreview: false });
    }
}

// --- WHATSAPP STATUS TRACKERS ---
client.on('loading_screen', (percent, message) => {
    console.log(`⏳ LOADING WHATSAPP: ${percent}% - ${message}`);
});

client.on('qr', (qr) => {
    console.log('\n✅ QR CODE RECEIVED! Scan it with your phone now:\n');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('🔒 Authenticated successfully!');
});

client.on('auth_failure', (msg) => {
    console.error('🔴 Authentication failed:', msg);
});

client.on('ready', () => {
    console.log('🌟 AMG Bot is completely online and ready to read messages!');
});

client.on('disconnected', (reason) => {
    console.error('🔴 Bot was disconnected:', reason);
    if (reason === 'LOGOUT') {
        console.log('🔄 Restarting Node process to clear broken browser cache...');
        client.destroy().catch(() => {});
        setTimeout(() => { process.exit(1); }, 2000);
    }
});

// --- HELPER FUNCTIONS ---
async function resolveJidToPhone(sender) {
    if (lidCache[sender]) return lidCache[sender];
    let rawId = sender.split('@')[0];
    if (sender.endsWith('@lid')) {
        try {
            const resolved = await client.getContactLidAndPhone([sender]);
            if (resolved && resolved.length > 0 && resolved[0].pn) rawId = resolved[0].pn.split('@')[0];
        } catch (err) {}
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
    const plans = await db.query('SELECT * FROM data_plans WHERE is_active = true AND network_name = $1 ORDER BY buying_price ASC', [network]);
    const startIndex = page * 5;
    const pageItems = plans.rows.slice(startIndex, startIndex + 5);
    
    let planMenu = `📊 *${network == 'AT' ? 'AirtelTigo' : network} Bundles* (Page ${page + 1})\n\n`;
    pageItems.forEach((p, i) => {
        planMenu += `*${i + 1}* - ${cleanPlanName(p.plan_name)} (GHS ${p.selling_price})\n`;
    });
    if (plans.rows.length > (startIndex + 5)) planMenu += `*6.* ➡️ More\n`;
    if (page > 0) planMenu += `*7.* ⬅️ Previous\n`;
    planMenu += `\n*#* Back  |  *0* Cancel`;
    
    return sendHumanMessage(sender, planMenu); // 🛡️ Humanized
}

const chargeMoMoDirect = async (phone, amount, network, metadata) => {
    try {
        let net = network.toLowerCase();
        let provider = 'mtn'; 
        if (net.includes('telecel') || net.includes('vod')) provider = 'vod';
        else if (net.includes('at') || net.includes('airtel') || net.includes('tigo')) provider = 'tigo';

        let cleanPhone = phone.trim();
        if (cleanPhone.startsWith('233')) cleanPhone = '0' + cleanPhone.slice(3);

        const response = await axios.post('https://api.paystack.co/charge', {
            email: "customer@amgdata.com", amount: Math.round(amount * 100), currency: "GHS", metadata: metadata,
            mobile_money: { phone: cleanPhone, provider: provider }
        }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } });
        return response.data;
    } catch (err) { return null; }
};

const triggerMoMoFlow = async (sender, state) => {
    const { plan, payer, recipient } = state;
    await sendHumanMessage(sender, `⏳ Requesting GHS ${plan.selling_price} from *${payer}*...`); // 🛡️ Humanized
    
    const metadata = { type: 'DIRECT_PURCHASE', customer_phone: recipient, payer_phone: payer, plan_id: plan.idata_plan_id, network_id: plan.network_name.toLowerCase() };
    
    const pay = await axios.post('https://api.paystack.co/transaction/initialize', {
        email: 'customer@amgdata.com', amount: Math.round(plan.selling_price * 100), currency: "GHS", metadata, channels: ['mobile_money', 'card']
    }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }).catch(() => null);

    const checkoutUrl = pay?.data?.data?.authorization_url || null;
    let referenceToSave = pay?.data?.data?.reference || 'PROMPT_BUY';

    const charge = await chargeMoMoDirect(payer, plan.selling_price, plan.network_name.toLowerCase(), metadata);
    if (charge && charge.data && charge.data.reference) referenceToSave = charge.data.reference;

    await db.query(
        'INSERT INTO transactions (user_phone, recipient_phone, amount, network, data_volume, status, platform, reference, checkout_url, plan_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [payer, recipient, plan.selling_price, plan.network_name, plan.plan_name, 'PROCESSING', 'WHATSAPP', referenceToSave, checkoutUrl, plan.id]
    );
    
    await sendHumanMessage(sender, `🔔 *Payment Instructions*\n1. Authorize the prompt on your phone.\n2. *MTN:* Dial *170# -> 6 -> 3* (Approvals) if no prompt appears.\n3. Or pay via web here: ${checkoutUrl || 'N/A'}`); // 🛡️ Humanized
    await clearState(sender);
};

// ==========================================
//        MAIN MESSAGE LOGIC
// ==========================================
client.on('message', async (msg) => {
    try {

        // 🛡️ ANTI-GHOST FIX: Ignore messages older than 2 minutes
        const now = Math.floor(Date.now() / 1000);
        if (msg.timestamp < now - 120) {
            console.log(`[IGNORE] Skipped old history message.`);
            return;
        }

        // 🛡️ IGNORE GROUPS & STATUS UPDATES
        if (msg.from === 'status@broadcast' || msg.from.includes('@g.us')) {
            return;
        }

        const sender = msg.from;
        const userMessage = msg.body.trim();
        const formattedSender = await resolveJidToPhone(sender);
        
        let state = await getState(sender);

        // 👑 GLOBAL RESET
        if (state && ['0', 'cancel', 'reset', 'menu'].includes(userMessage.toLowerCase())) {
            await clearState(sender);
            return sendHumanMessage(sender, "🚫 *Transaction Cancelled.*\n\nReply *1* to see the Main Menu."); // 🛡️ Humanized
        }

        // --- INITIAL WELCOME ---
        if (!state) {
            if (['0', 'reset', 'menu', 'cancel'].includes(userMessage.toLowerCase())) return;

            state = { step: 'MAIN_MENU' };
            await setState(sender, state);
            
            let welcome = `🌟 *Welcome to AMG Affordable Data* 🌟\n\n`;
            welcome += `📌 *Please save this number as "AMG Data" to ensure fast delivery and avoid network blocks.*\n\n`;
            welcome += `1. 🛒 Buy Data\n`;
            welcome += `2. 💰 Check Wallet Balance\n`;
            welcome += `3. 📖 Instructions\n`;
            welcome += `4. 📞 Support\n\n`;
            welcome += `*Reply with a number (1, 2, 3, or 4):*`;
            
            return sendHumanMessage(sender, welcome); // 🛡️ Humanized
        }

        // --- STEP 1: MAIN MENU ---
        if (state.step === 'MAIN_MENU') {
            if (userMessage === '1') {
                state.step = 'SELECTING_NETWORK';
                await setState(sender, state);
                return sendHumanMessage(sender, `📊 *Select Network*\n\n1. MTN\n2. Telecel\n3. AirtelTigo\n\n*0* Cancel`);
            } else if (userMessage === '2') {
                const userRes = await db.query('SELECT * FROM users WHERE phone_number = $1', [formattedSender]);
                await clearState(sender);
                if (userRes.rows.length === 0 || !userRes.rows[0].pin) {
                    return sendHumanMessage(sender, `❌ *No Wallet Found*\n\nPlease download our *Mobile App* to create an account.\n\n*0* Menu`);
                }
                return sendHumanMessage(sender, `💰 *AMG Wallet Balance*\n\nAccount: *${formattedSender}*\nBalance: *GHS ${userRes.rows[0].wallet_balance}*\n\n*0* Menu`);
            } else if (userMessage === '3') {
                await clearState(sender);
                return sendHumanMessage(sender, `📖 *How to Buy Data*\n\n1. Reply '1' to Buy.\n2. Choose network/bundle.\n3. Enter details.\n4. Authorize.\n\n*0* Menu`);
            } else if (userMessage === '4') {
                await clearState(sender);
                return sendHumanMessage(sender, "📞 *AMG Support*\nNeed help? Contact *0539743087*.\n\n*0* Menu");
            }
        }

        // --- STEP 2: SELECTING NETWORK ---
        if (state.step === 'SELECTING_NETWORK') {
            if (userMessage === '#') {
                state.step = 'MAIN_MENU';
                await setState(sender, state);
                return sendHumanMessage(sender, `🌟 *Welcome to AMG Affordable Data* 🌟\n\n1. 🛒 Buy Data\n2. 💰 Check Wallet Balance\n3. 📖 Instructions\n4. 📞 Support\n\n*Reply with a number:*`);
            }

            const netMap = { '1': 'MTN', '2': 'Telecel', '3': 'AT' };
            if (netMap[userMessage]) {
                state.network = netMap[userMessage];
                state.step = 'CHOOSING_PLAN';
                state.page = 0;
                await setState(sender, state);
                return _displayPlansForUser(sender, state);
            }
        }

        // --- STEP 3: CHOOSING PLAN ---
        if (state.step === 'CHOOSING_PLAN') {
            if (userMessage === '#') {
                state.step = 'SELECTING_NETWORK';
                await setState(sender, state);
                return sendHumanMessage(sender, `📊 *Select Network*\n\n1. MTN\n2. Telecel\n3. AirtelTigo\n\n*#* Back  |  *0* Cancel`);
            }

            const choice = parseInt(userMessage);
            const plans = await db.query('SELECT * FROM data_plans WHERE is_active = true AND network_name = $1 ORDER BY buying_price ASC', [state.network]);
            const pageItems = plans.rows.slice(state.page * 5, (state.page * 5) + 5);

            if (choice === 6) { state.page++; await setState(sender, state); return _displayPlansForUser(sender, state); }
            if (choice === 7) { state.page--; await setState(sender, state); return _displayPlansForUser(sender, state); }
            
            if (choice >= 1 && choice <= pageItems.length) {
                state.plan = pageItems[choice - 1];
                state.step = 'ENTERING_RECIPIENT';
                await setState(sender, state);
                return sendHumanMessage(sender, `✅ Selected: *${cleanPlanName(state.plan.plan_name)}*\n\nWhich number should *RECEIVE* the data?\n\n*1.* My number (${formattedSender})\n*OR* Type the 10-digit number:\n\n*#* Back  |  *0* Cancel`);
            }
        }

        // --- STEP 4: ENTERING RECIPIENT ---
        if (state.step === 'ENTERING_RECIPIENT') {
            if (userMessage === '#') {
                state.step = 'CHOOSING_PLAN';
                await setState(sender, state);
                return _displayPlansForUser(sender, state); 
            }

            state.recipient = userMessage === '1' ? formattedSender : userMessage;
            state.step = 'ENTERING_PAYER';
            await setState(sender, state);
            return sendHumanMessage(sender, `📱 Data for: *${state.recipient}*\n\nWhich number is *PAYING*?\n\n*1.* My number (${formattedSender})\n*OR* Type the MoMo number:\n\n*#* Back  |  *0* Cancel`);
        }

        // --- STEP 5: ENTERING PAYER ---
        if (state.step === 'ENTERING_PAYER') {
            if (userMessage === '#') {
                state.step = 'ENTERING_RECIPIENT';
                await setState(sender, state);
                return sendHumanMessage(sender, `✅ Selected: *${cleanPlanName(state.plan.plan_name)}*\n\nWhich number should *RECEIVE* the data?\n\n*1.* My number (${formattedSender})\n*OR* Type the 10-digit number:\n\n*#* Back  |  *0* Cancel`);
            }

            let payer = userMessage === '1' ? formattedSender : userMessage;
            if (payer.startsWith('233')) payer = '0' + payer.slice(3);
            
            state.payer = payer;
            const user = await getOrCreateUser(formattedSender);
            
            const balance = parseFloat(user.wallet_balance || 0);
            const cost = parseFloat(state.plan.selling_price || 0);
            
            state.hasEnoughBalance = balance >= cost;
            state.step = 'CONFIRMING_ORDER';
            await setState(sender, state);
            
            let summary = `📝 *Summary*\n`;
            summary += `📦 *Bundle:* ${state.plan.network_name} ${state.plan.plan_name}\n`;
            summary += `📱 *Recipient:* ${state.recipient}\n`;
            summary += `💳 *Payer Number:* ${state.payer}\n`;
            summary += `💰 *Cost:* GHS ${state.plan.selling_price}\n\n`;
            
            if (state.hasEnoughBalance) {
                summary += `*1.* ✅ Pay with AMG Wallet (GHS ${balance.toFixed(2)})\n`;
                summary += `*2.* 💳 Pay with MoMo Prompt\n`;
            } else {
                summary += `*1.* 💳 Pay with MoMo Prompt\n`;
            }
            
            return sendHumanMessage(sender, summary + `\n*#* Back  |  *0* Cancel`);
        }

        // --- STEP 6: CONFIRMING ORDER ---
        if (state.step === 'CONFIRMING_ORDER') {
            if (userMessage === '#') {
                state.step = 'ENTERING_PAYER';
                await setState(sender, state);
                return sendHumanMessage(sender, `📱 Data for: *${state.recipient}*\n\nWhich number is *PAYING*?\n\n*1.* My number (${formattedSender})\n*OR* Type the MoMo number:\n\n*#* Back  |  *0* Cancel`);
            }

            if (userMessage === '1' && state.hasEnoughBalance) {
                state.step = 'VERIFYING_PIN';
                await setState(sender, state);
                return sendHumanMessage(sender, `🔒 *Security Check*\nEnter your 4-digit AMG PIN:\n\n*#* Back  |  *0* Cancel`);
            } else {
                await triggerMoMoFlow(sender, state);
            }
        }

        // --- STEP 7: VERIFYING PIN ---
        if (state.step === 'VERIFYING_PIN') {
            if (!state.plan || !state.plan.selling_price) {
                await clearState(sender);
                return sendHumanMessage(sender, "❌ *Session Error:* Order details were lost. Please start again by replying *1*.");
            }

            if (userMessage === '#') {
                state.step = 'CONFIRMING_ORDER';
                await setState(sender, state);
                
                const user = await getOrCreateUser(formattedSender);
                const balance = parseFloat(user.wallet_balance || 0);
                
                let summary = `📝 *Summary*\n📦 *Bundle:* ${state.plan.network_name} ${state.plan.plan_name}\n📱 *Recipient:* ${state.recipient}\n💳 *Payer:* ${state.payer}\n💰 *Cost:* GHS ${state.plan.selling_price}\n\n`;
                if (state.hasEnoughBalance) summary += `*1.* ✅ Pay with AMG Wallet (GHS ${balance.toFixed(2)})\n*2.* 💳 Pay with MoMo Prompt\n`;
                else summary += `*1.* 💳 Pay with MoMo Prompt\n`;
                
                return sendHumanMessage(sender, summary + `\n*#* Back  |  *0* Cancel`);
            }

            const hasLock = await setLock(sender, 20);
            if (!hasLock) return sendHumanMessage(sender, "⏳ Please wait... processing.");

            try {
                const user = await getOrCreateUser(formattedSender);
                
                if (user.pin === userMessage) {
                    const canProceed = await setRecipientCooldown(state.recipient, 5);
                    if (!canProceed) {
                        await clearState(sender);
                        return sendHumanMessage(sender, `⏳ *Telco Spam Protection Active*\n\nPlease wait *5 minutes* before sending another bundle to *${state.recipient}*.\n\nYour wallet has *NOT* been deducted.`);
                    }

                    await db.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE phone_number = $2', [state.plan.selling_price, formattedSender]);
                    
                    const res = await sendDataRoundRobin(state.plan.network_name.toLowerCase(), state.recipient, state.plan.idata_plan_id, state.plan.size_mb, state.plan.swiftdata_plan_id);
                    
                    if (res.success) {
                        await db.query(
                            'INSERT INTO transactions (user_phone, recipient_phone, amount, network, data_volume, status, platform, provider, provider_order_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
                            [formattedSender, state.recipient, state.plan.selling_price, state.plan.network_name, state.plan.plan_name, 'PROCESSING', 'WHATSAPP', res.provider, res.order_id]
                        );
                        
                        // 🛡️ Safe Link Injection: Sent only after high trust interaction
                        let successMsg = `✅ *Success!* Order sent to provider.\n\n`;
                        successMsg += `📲 *Want faster payments & history tracking?*\n`;
                        successMsg += `Download our App: amg-data-api.duckdns.org/download-app`;
                        
                        sendHumanMessage(sender, successMsg);
                    } else {

                        await db.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone_number = $2', [state.plan.selling_price, formattedSender]);
                        
                        let errorMessage = "Delivery failed.";
                        const apiError = (res.error || "").toLowerCase();
                        if (apiError.includes('balance') || apiError.includes('fund')) errorMessage = "Network nodes are currently busy.";
                        
                        sendHumanMessage(sender, `⚠️ *${errorMessage}*\n\nYour GHS ${state.plan.selling_price} was refunded.`);
                    }
                } else {
                    sendHumanMessage(sender, "❌ Incorrect PIN.");
                }
                
                await clearState(sender);

            } finally {
                await releaseLock(sender); 
            }
            return; 
        }

    } catch (err) {
        console.error("🔴 Bot Error:", err);
    }
});

client.initialize();