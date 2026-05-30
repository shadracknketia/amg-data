// ==========================================
//    AMG AFFORDABLE DATA - WHATSAPP BOT ONLY
// ==========================================
require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { Pool } = require('pg');
const axios = require('axios');
const { sendDataRoundRobin } = require('./providers'); // Shares our rotating provider engine

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const userStates = {}; 

// --- 🛡️ THE BULLETPROOF LID-TO-PHONE RESOLVER & CACHE ---
const lidCache = {}; // Stores mapped LIDs (e.g. "202018...@lid": "0241963319")

async function resolveJidToPhone(sender) {
    // 1. Check local cache first (Instant & completely safe!)
    if (lidCache[sender]) {
        return lidCache[sender];
    }

    let rawId = sender.split('@')[0];

    // 2. If it's a hidden WhatsApp LID, ask the system to translate it
    if (sender.endsWith('@lid')) {
        try {
            console.log(`🔍 Translating hidden ID ${sender} to real phone number...`);
            const resolved = await client.getContactLidAndPhone([sender]); // Library's official translator!
            
            if (resolved && resolved.length > 0 && resolved[0].pn) {
                rawId = resolved[0].pn.split('@')[0]; // Extracted JID (e.g., 233241963319)
                console.log(`✅ Successfully translated to: ${rawId}`);
            }
        } catch (err) {
            console.error("🔴 Failed to translate hidden ID:", err.message);
        }
    }

    // 3. Format to standard 10-digit Ghana format (024...)
    let cleanPhone = rawId.trim();
    if (cleanPhone.startsWith('233')) {
        cleanPhone = '0' + cleanPhone.slice(3);
    }

    // 4. Save to cache so we never have to run this API call for this user again
    lidCache[sender] = cleanPhone;
    return cleanPhone;
}

// --- DATABASE HELPER ---
async function getOrCreateUser(phone) {
    let cleanPhone = phone.trim();
    if (cleanPhone.startsWith('233')) cleanPhone = '0' + cleanPhone.slice(3);
    const result = await db.query('SELECT * FROM users WHERE phone_number = $1', [cleanPhone]);
    if (result.rows.length > 0) return result.rows[0];
    const newUser = await db.query('INSERT INTO users (phone_number, wallet_balance) VALUES ($1, $2) RETURNING *', [cleanPhone, 0.00]);
    return newUser.rows[0];
}

// --- PAYSTACK HELPERS ---
const startPaystackPayment = async (email, amount, metadata) => {
    try {
        let phone = metadata.payer_phone || metadata.customer_phone || "";
        if (phone.startsWith('0')) phone = '233' + phone.slice(1);
        const response = await axios.post('https://api.paystack.co/transaction/initialize', {
            email: email, amount: Math.round(amount * 100), currency: "GHS", metadata: metadata,
            channels: ['mobile_money', 'card']
        }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
        return response.data;
    } catch (err) { return null; }
};

const chargeMoMoDirect = async (phone, amount, network, metadata) => {
    try {
        let provider = 'mtn';
        if (network.includes('telecel') || network.includes('vod')) provider = 'vod';
        if (network.includes('at') || network.includes('airtel')) provider = 'atl';
        let cleanPhone = phone.trim();
        if (cleanPhone.startsWith('233')) cleanPhone = '0' + cleanPhone.slice(3);
        const response = await axios.post('https://api.paystack.co/charge', {
            email: "customer@amgdata.com", amount: Math.round(amount * 100), currency: "GHS", metadata: metadata,
            mobile_money: { phone: cleanPhone, provider: provider }
        }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } });
        return response.data;
    } catch (err) { return null; }
};

// --- INITIALIZE WHATSAPP CLIENT (FIXED: NO WEB CACHE CLASH) ---
const client = new Client({
    authStrategy: new LocalAuth({ clientId: "amg-bot-live" }),
    // REMOVED webVersionCache ENTIRELY [1]
    puppeteer: {
        headless: true, 
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', 
            '--disable-accelerated-2d-canvas', 
            '--disable-gpu'
        ],
    }
});


const triggerMoMoFlow = async (sender, state) => {
    const plan = state.plan;
    await client.sendMessage(sender, `⏳ Requesting GHS ${plan.selling_price} from *${state.payer}*...`);
    const metadata = { type: 'DIRECT_PURCHASE', customer_phone: state.recipient, payer_phone: state.payer, plan_id: plan.idata_plan_id, network_id: plan.network_name.toLowerCase() };
    
    // Generate Web Link Fallback
    const pay = await startPaystackPayment('customer@amgdata.com', plan.selling_price, metadata);
    const checkoutUrl = pay && pay.status ? pay.data.authorization_url : null;

    // Force Direct STK Push
    const charge = await chargeMoMoDirect(state.payer, plan.selling_price, plan.network_name.toLowerCase(), metadata);

    if (charge && charge.status) {
        // --- 🧾 SAVES THE ACTUAL CHARGE REFERENCE COMPATIBLE WITH WEBHOOKS ---
        const actualReference = charge.data.reference; 

        await db.query(
            'INSERT INTO transactions (user_phone, amount, network, data_volume, status, platform, reference, checkout_url, plan_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [state.payer, plan.selling_price, plan.network_name, plan.plan_name, 'PROCESSING', 'MOMO', actualReference, checkoutUrl, plan.id]
        );
        await client.sendMessage(sender, `🔔 *Payment Instructions*\n1. Authorize on your phone.\n2. *MTN:* Dial *170# -> 6 -> 10 if no prompt.\n3. Or pay here: ${checkoutUrl}`);
    } else {
        await client.sendMessage(sender, "❌ Payment system down. Try later.");
    }
    delete userStates[sender];
};

client.on('qr', (qr) => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('✅ AMG Bot is online and stable!'));

// ==========================================
//        4. THE BOT MESSAGE LOGIC
// ==========================================

client.on('message', async (msg) => {
    const userMessage = msg.body.trim();
    const sender = msg.from;

    // --- 🛡️ RESOLVE REAL PHONE NUMBER (LID TO JID) ---
    // This fetches your actual, physical 10-digit Ghana number [1.1.2]
    const formattedSender = await resolveJidToPhone(sender); 

    // GLOBAL RESET: Press 0 at any point to start over
    if (userMessage === '0' || userMessage.toLowerCase() === 'reset' || userMessage.toLowerCase() === 'menu') {
        delete userStates[sender];
    }

    // --- STEP 1: MAIN MENU (CATCH-ALL) ---
    if (!userStates[sender]) {
        userStates[sender] = { step: 'MAIN_MENU' };
        return client.sendMessage(sender, `🌟 *Welcome to AMG Affordable Data* 🌟\n\n1. 🛒 Buy Data\n2. 💰 Check Wallet Balance\n3. 📖 Instructions\n4. 📞 Support\n\n*Reply with a number (1, 2, 3, or 4):*`);
    }

    // --- STEP 2: MAIN MENU SELECTIONS ---
    if (userStates[sender].step === 'MAIN_MENU') {
        if (userMessage === '1') {
            const plans = await db.query('SELECT * FROM data_plans WHERE is_active = true');
            let planMenu = `📊 *Select Data Bundle*\n\n`;
            plans.rows.forEach((p, i) => planMenu += `*${i + 1}* - ${p.network_name} ${p.plan_name} (GHS ${p.selling_price})\n`);
            userStates[sender] = { step: 'CHOOSING_PLAN' };
            return client.sendMessage(sender, planMenu + `\n*0. Back*`);
            
        } else if (userMessage === '2') {
            // FIXED: Searches using the clean formattedSender [1.1.2]
            const userRes = await db.query('SELECT * FROM users WHERE phone_number = $1', [formattedSender]);
            
            if (userRes.rows.length === 0 || !userRes.rows[0].pin) {
                delete userStates[sender];
                return client.sendMessage(sender, `❌ *No Wallet Found*\n\nThis phone number (${formattedSender}) is not registered on our platform.\n\nPlease download our *Mobile App* to create an account and fund your wallet.\n\n*0. Menu*`);
            }
            
            const user = userRes.rows[0];
            delete userStates[sender];
            return client.sendMessage(sender, `💰 *AMG Wallet Balance*\n\nAccount: *${formattedSender}*\nBalance: *GHS ${user.wallet_balance}*\n\n*0. Menu*`);
            
        } else if (userMessage === '3') {
            delete userStates[sender];
            let help = `📖 *How to Buy Data*\n\n`;
            help += `1. Reply '1' to Buy Data.\n`;
            help += `2. Choose your network and bundle size.\n`;
            help += `3. Enter the recipient and payer numbers.\n`;
            help += `4. Enter your PIN (if using Wallet) or authorize the MoMo prompt.\n\n`;
            help += `*Delivery:* Data arrives in less than 10 minutes. If it does not arrive after 10 hours, contact support.\n\n`;
            help += `*0. Menu*`;
            return client.sendMessage(sender, help);
            
        } else if (userMessage === '4') {
            delete userStates[sender];
            return client.sendMessage(sender, "📞 *AMG Support*\nNeed help? WhatsApp or Call our agent on *0241963319*.\n\n*0. Menu*");
            
        } else {
            return client.sendMessage(sender, `❌ *Invalid Selection*\n\nPlease reply with *1*, *2*, *3*, or *4*:\n\n1. 🛒 Buy Data\n2. 💰 Check Wallet Balance\n3. 📖 Instructions\n4. 📞 Support`);
        }
    }

    // --- STEP 3: CHOOSING PLAN ---
    if (userStates[sender]?.step === 'CHOOSING_PLAN') {
        const choice = parseInt(userMessage) - 1;
        const plans = await db.query('SELECT * FROM data_plans WHERE is_active = true');
        if (plans.rows[choice]) {
            userStates[sender] = { step: 'ENTERING_RECIPIENT', plan: plans.rows[choice] };
            return client.sendMessage(sender, `✅ Selected: *${plans.rows[choice].plan_name}*\n\nWhich number should *RECEIVE* the data?\n\n*1.* My number (${formattedSender})\n*OR* Type the 10-digit number:`);
        } else {
            return client.sendMessage(sender, "❌ Invalid choice. Please select a number from the menu above.");
        }
    }

    // --- STEP 4: ENTERING RECIPIENT ---
    if (userStates[sender]?.step === 'ENTERING_RECIPIENT') {
        if (userMessage === '0') { delete userStates[sender]; return; }
        // FIXED: Replaced senderClean with formattedSender
        let recipient = userMessage === '1' ? formattedSender : userMessage;
        if (recipient.startsWith('233')) recipient = '0' + recipient.slice(3);
        if (recipient.length >= 10) {
            userStates[sender].recipient = recipient;
            userStates[sender].step = 'ENTERING_PAYER';
            return client.sendMessage(sender, `📱 Data for: *${recipient}*\n\nWhich number is *PAYING*?\n\n*1.* Same as recipient\n*OR* Type the MoMo number:`);
        } else {
            return client.sendMessage(sender, "❌ Please enter a valid 10-digit number starting with 0.");
        }
    }

    // --- STEP 5: ENTERING PAYER ---
    if (userStates[sender]?.step === 'ENTERING_PAYER') {
        if (userMessage === '0') { delete userStates[sender]; return; }
        let payer = userMessage === '1' ? userStates[sender].recipient : userMessage;
        if (payer.startsWith('233')) payer = '0' + payer.slice(3);
        if (payer.length >= 10) {
            const plan = userStates[sender].plan;
            
            // FIXED: Replaced senderClean with formattedSender
            const userRes = await db.query('SELECT * FROM users WHERE phone_number = $1', [formattedSender]);
            const user = userRes.rows[0];
            const balance = user ? parseFloat(user.wallet_balance) : 0.00;
            const price = parseFloat(plan.selling_price);

            userStates[sender].payer = payer;
            userStates[sender].step = 'CONFIRMING_ORDER';
            userStates[sender].hasEnoughBalance = (user && balance >= price);

            let summary = `📝 *Summary*\n📦 ${plan.network_name} ${plan.plan_name}\n📱 Recipient: ${userStates[sender].recipient}\n💰 Cost: GHS ${price}\n🏦 Wallet: GHS ${balance}\n\n`;
            
            if (userStates[sender].hasEnoughBalance) {
                summary += `*1.* ✅ Pay with AMG Wallet\n*2.* 💳 Pay with MoMo\n`;
            } else {
                summary += `*1.* 💳 Pay with MoMo\n`;
            }
            return client.sendMessage(sender, summary + `*0.* Cancel`);
        } else {
            return client.sendMessage(sender, "❌ Please enter a valid 10-digit number.");
        }
    }

    // --- STEP 6: CONFIRMING ORDER ---
    if (userStates[sender]?.step === 'CONFIRMING_ORDER') {
        const state = userStates[sender];
        const plan = state.plan;

        if (userMessage === '1') {
            if (state.hasEnoughBalance) {
                userStates[sender].step = 'VERIFYING_PIN';
                return client.sendMessage(sender, `🔒 *Security Check*\n\nPlease reply with your *4-digit AMG PIN* to authorize this GHS ${plan.selling_price} wallet transaction:\n\n*0. Cancel*`);
            } else {
                await triggerMoMoFlow(sender, state);
            }
        } else if (userMessage === '2' && state.hasEnoughBalance) {
            await triggerMoMoFlow(sender, state);
        } else if (userMessage === '0') {
            delete userStates[sender];
            return client.sendMessage(sender, "❌ Order cancelled.");
        } else {
            return client.sendMessage(sender, "❌ Invalid selection. Press 1, 2, or 0.");
        }
    }

    // --- STEP 7: PIN VERIFICATION (FOR WALLET) ---
    if (userStates[sender]?.step === 'CONFIRMING_ORDER') {
        const state = userStates[sender];
        const plan = state.plan;

        if (userMessage === '1') {
            if (state.hasEnoughBalance) {
                userStates[sender].step = 'VERIFYING_PIN';
                return client.sendMessage(sender, `🔒 *Security Check*\n\nPlease reply with your *4-digit AMG PIN* to authorize this GHS ${plan.selling_price} wallet transaction:\n\n*0. Cancel*`);
            } else {
                await triggerMoMoFlow(sender, state);
            }
        } else if (userMessage === '2' && state.hasEnoughBalance) {
            await triggerMoMoFlow(sender, state);
        } else if (userMessage === '0') {
            // FIXED: Handles Cancel option
            delete userStates[sender];
            return client.sendMessage(sender, "❌ Order cancelled.");
        } else {
            // FIXED: Handles Invalid selections instead of staying silent
            return client.sendMessage(sender, "❌ Invalid selection. Please reply with *1* to Pay, *2* to use MoMo, or *0* to Cancel.");
        }
        return;
    }
});

// START THE BOT
client.initialize();