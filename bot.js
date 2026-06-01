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
const lidCache = {}; // Local memory cache for LIDs (Bypasses Meta's hidden IDs)

// --- 🛡️ THE BULLETPROOF LID-TO-PHONE RESOLVER & CACHE ---
async function resolveJidToPhone(sender) {
    if (lidCache[sender]) return lidCache[sender];

    let rawId = sender.split('@')[0];

    if (sender.endsWith('@lid')) {
        try {
            console.log(`🔍 Translating hidden ID ${sender} to real phone number...`);
            const resolved = await client.getContactLidAndPhone([sender]);
            if (resolved && resolved.length > 0 && resolved[0].pn) {
                rawId = resolved[0].pn.split('@')[0];
                console.log(`✅ Successfully translated to raw JID: ${rawId}`);
            }
        } catch (err) {
            console.error("🔴 Failed to translate hidden ID:", err.message);
        }
    }

    let cleanPhone = rawId.trim();
    if (cleanPhone.startsWith('233')) {
        cleanPhone = '0' + cleanPhone.slice(3);
    }

    lidCache[sender] = cleanPhone;
    return cleanPhone;
}

// --- 🧹 TEXT-CLEANSER: EXCLUDE 'SMM' AND 'REGULAR' ---
function cleanPlanName(name) {
    // Finds 'SMM' or 'Regular' (case-insensitive) and removes them cleanly [1]
    return name.replace(/\s*SMM\s*/gi, '').replace(/\s*Regular\s*/gi, '').trim();
}

// --- 📊 DYNAMIC PLAN PAGINATOR (PAGES OF 5) ---
async function _displayPlansForUser(sender, state) {
    const network = state.network;
    const page = state.page || 0;
    const itemsPerPage = 5;

    const plans = await db.query(
        'SELECT * FROM data_plans WHERE is_active = true AND network_name = $1 ORDER BY buying_price ASC', 
        [network]
    );

    const startIndex = page * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const pageItems = plans.rows.slice(startIndex, endIndex); 
    const hasNextPage = plans.rows.length > endIndex;
    const hasPrevPage = page > 0;

    let planMenu = `📊 *${network == 'AT' ? 'AirtelTigo' : network} Bundles* (Page ${page + 1})\n\n`;
    pageItems.forEach((p, i) => {
        // --- FIXED: USE CLEANED PLAN NAME ---
        const cleanedName = cleanPlanName(p.plan_name);
        planMenu += `*${i + 1}* - ${cleanedName} (GHS ${p.selling_price})\n`;
    });
    planMenu += `\n`;
    
    if (hasNextPage) planMenu += `*6.* ➡️ More Bundles\n`;
    if (hasPrevPage) planMenu += `*7.* ⬅️ Previous Page\n`;
    planMenu += `*0.* 🔙 Back to Networks`;

    return client.sendMessage(sender, planMenu);
}

// --- DATABASE HELPER ---
async function getOrCreateUser(phone) {
    let cleanPhone = phone.trim();
    if (cleanPhone.startsWith('233')) cleanPhone = '0' + cleanPhone.slice(3);
    try {
        const result = await db.query('SELECT * FROM users WHERE phone_number = $1', [cleanPhone]);
        if (result.rows.length > 0) return result.rows[0];
        const newUser = await db.query('INSERT INTO users (phone_number, wallet_balance) VALUES ($1, $2) RETURNING *', [cleanPhone, 0.00]);
        return newUser.rows[0];
    } catch (err) {
        throw err;
    }
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

// --- INITIALIZE WHATSAPP CLIENT (NATIVE VERSION) ---
const client = new Client({
    authStrategy: new LocalAuth({ clientId: "amg-bot-live" }),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version-checker/master/remote/2.2413.51-v2.html',
    },
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
    const paystackReference = pay && pay.status ? pay.data.reference : 'PROMPT_BUY';

    // Force Direct STK Push
    const charge = await chargeMoMoDirect(state.payer, plan.selling_price, plan.network_name.toLowerCase(), metadata);

    if (charge && charge.status) {
        const actualReference = charge.data.reference; 

        await db.query(
            'INSERT INTO transactions (user_phone, amount, network, data_volume, status, platform, reference, checkout_url, plan_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [state.payer, plan.selling_price, plan.network_name, plan.plan_name, 'PROCESSING', 'WHATSAPP', paystackReference, checkoutUrl, plan.id]
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

    // Resolve real phone number
    const formattedSender = await resolveJidToPhone(sender); 

    // --- 🚨 THE GLOBAL RESET INTERCEPTOR ---
    // If the user types 0, reset, or menu, we clear their state and force the Main Menu
    if (userMessage === '0' || userMessage.toLowerCase() === 'reset' || userMessage.toLowerCase() === 'menu') {
        delete userStates[sender]; // Forget what the user was doing
        userStates[sender] = { step: 'MAIN_MENU' }; // Force back to Main Menu
        
        // Return the Main Menu immediately and STOP further processing
        return client.sendMessage(sender, `🌟 *Welcome back to AMG Affordable Data* 🌟\n\n1. 🛒 Buy Data\n2. 💰 Check Wallet Balance\n3. 📖 Instructions\n4. 📞 Support\n\n*Reply with a number:*`);
    }

    // --- STEP 1: MAIN MENU (CATCH-ALL) ---
    if (!userStates[sender]) {
        userStates[sender] = { step: 'MAIN_MENU' };
        
        let welcome = `🌟 *Welcome to AMG Affordable Data* 🌟\n\n`;
        welcome += `1. 🛒 Buy Data\n`;
        welcome += `2. 💰 Check Wallet Balance\n`;
        welcome += `3. 📖 Instructions\n`;
        welcome += `4. 📞 Support\n\n`;
        welcome += `📲 *Download our Mobile App* for full transaction history, instant wallet top-ups, and auto-login:\n`;
        welcome += `https://amg-data-api.duckdns.org/download-app\n\n`;
        welcome += `*Reply with a number (1, 2, 3, or 4):*`;
        
        return client.sendMessage(sender, welcome);
    }

    // --- STEP 2: MAIN MENU SELECTIONS ---
    if (userStates[sender].step === 'MAIN_MENU') {
        if (userMessage === '1') {
            userStates[sender] = { step: 'SELECTING_NETWORK' };
            return client.sendMessage(sender, `📊 *Select Network*\n\n1. MTN\n2. Telecel\n3. AirtelTigo\n\n*0. Back*`);
        } else if (userMessage === '2') {
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
            return client.sendMessage(sender, help); // FIXED: Added sender argument
            
        } else if (userMessage === '4') {
            delete userStates[sender];
            return client.sendMessage(sender, "📞 *AMG Support*\nNeed help? WhatsApp or Call our agent on *0539743087*.\n\n*0. Menu*");
            
        } else {
            return client.sendMessage(sender, `❌ *Invalid Selection*\n\nPlease reply with *1*, *2*, *3*, or *4*:\n\n1. 🛒 Buy Data\n2. 💰 Check Wallet Balance\n3. 📖 Instructions\n4. 📞 Support`);
        }
    }

    // --- STEP 3: SELECTING NETWORK ---
    if (userStates[sender]?.step === 'SELECTING_NETWORK') {
        if (userMessage === '0') {
            delete userStates[sender];
            return client.sendMessage(sender, "❌ Order cancelled.");
        }

        let network = '';
        if (userMessage === '1') network = 'MTN';
        else if (userMessage === '2') network = 'Telecel';
        else if (userMessage === '3') network = 'AT';
        else return client.sendMessage(sender, "❌ Invalid network selection. Please reply with 1, 2, 3, or 0.");

        userStates[sender] = { step: 'CHOOSING_PLAN', network: network, page: 0 };
        return _displayPlansForUser(sender, userStates[sender]);
    }

    // --- STEP 4: CHOOSING PLAN (PAGINATED) ---
    if (userStates[sender]?.step === 'CHOOSING_PLAN') {
        const state = userStates[sender];
        const network = state.network;
        const page = state.page || 0;
        const itemsPerPage = 5;

        const plans = await db.query(
            'SELECT * FROM data_plans WHERE is_active = true AND network_name = $1 ORDER BY buying_price ASC', 
            [network]
        );

        const startIndex = page * itemsPerPage;
        const endIndex = startIndex + itemsPerPage;
        const pageItems = plans.rows.slice(startIndex, endIndex);
        const hasNextPage = plans.rows.length > endIndex;
        const hasPrevPage = page > 0;

        const choice = parseInt(userMessage);

        if (choice === 0) {
            userStates[sender] = { step: 'SELECTING_NETWORK' };
            return client.sendMessage(sender, `📊 *Select Network*\n\n1. MTN\n2. Telecel\n3. AirtelTigo\n\n*0. Back*`);
        } 
        else if (choice === 6 && hasNextPage) {
            userStates[sender].page = page + 1;
            return _displayPlansForUser(sender, userStates[sender]);
        } 
        else if (choice === 7 && hasPrevPage) {
            userStates[sender].page = page - 1;
            return _displayPlansForUser(sender, userStates[sender]);
        } 
        else if (choice >= 1 && choice <= pageItems.length) {
            const selectedPlan = pageItems[choice - 1];
            // FIXED: Clean the plan name before showing [1]
            const cleanedName = cleanPlanName(selectedPlan.plan_name);

            userStates[sender] = { step: 'ENTERING_RECIPIENT', plan: selectedPlan };
            return client.sendMessage(sender, `✅ Selected: *${cleanedName}*\n\nWhich number should *RECEIVE* the data?\n\n*1.* My number (${formattedSender})\n*OR* Type the 10-digit number:`);
        } else {
            return client.sendMessage(sender, "❌ Invalid selection. Please pick a number from the menu, or press 0 to go back.");
        }
    }

    // --- STEP 5: ENTERING RECIPIENT ---
    if (userStates[sender]?.step === 'ENTERING_RECIPIENT') {
        if (userMessage === '0') { delete userStates[sender]; return; }
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
        if (userMessage === '0') { 
            delete userStates[sender]; 
            return client.sendMessage(sender, "❌ Order cancelled.");
        }

        // Logic: 
        // If user types '1', they are paying with their OWN WhatsApp number.
        // If they type a number, that number is the payer.
        let payer = userMessage === '1' ? formattedSender : userMessage;
        
        if (payer.startsWith('233')) payer = '0' + payer.slice(3);

        if (payer.length >= 10) {
            const plan = state.plan; // Ensure 'state' is available
            const recipient = userStates[sender].recipient;
            
            userStates[sender].payer = payer;
            userStates[sender].step = 'CONFIRMING_ORDER';
            
            // Fetch balance for the person actually paying (the WhatsApp user)
            const user = await getOrCreateUser(formattedSender);
            const balance = parseFloat(user.wallet_balance);
            const price = parseFloat(plan.selling_price);
            userStates[sender].hasEnoughBalance = (balance >= price);

            let summary = `📝 *Summary*\n`;
            summary += `📦 *Bundle:* ${plan.network_name} ${plan.plan_name}\n`;
            summary += `📱 *Recipient:* ${recipient}\n`;
            summary += `💳 *Payer Number:* ${payer}\n`;
            summary += `💰 *Cost:* GHS ${price}\n\n`;
            
            if (userStates[sender].hasEnoughBalance) {
                summary += `*1.* ✅ Pay with AMG Wallet (GHS ${balance})\n`;
                summary += `*2.* 💳 Pay with MoMo Prompt\n`;
            } else {
                summary += `*1.* 💳 Pay with MoMo Prompt\n`;
            }
            return client.sendMessage(sender, summary + `*0.* Cancel`);
        } else {
            return client.sendMessage(sender, "❌ Invalid number. Please enter a 10-digit number.");
        }
    }

    // --- STEP 6: CONFIRMING ORDER ---
    if (userStates[sender]?.step === 'CONFIRMING_ORDER') {
        const state = userStates[sender]; // Defined here for this block
        const plan = state.plan;           // Defined here for this block

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
        return; 
    }

    // --- STEP 7: PIN VERIFICATION (FOR WALLET) ---
    if (userStates[sender]?.step === 'VERIFYING_PIN') {
        if (userMessage === '0') {
            delete userStates[sender];
            return client.sendMessage(sender, "❌ Transaction cancelled.");
        }

        // --- FIXED: REDEFINED 'state' HERE SO IT IS DEFINED ---
        const state = userStates[sender]; 
        const plan = state.plan;
        const enteredPin = userMessage;

        const user = await getOrCreateUser(formattedSender); 

        if (user.pin === enteredPin) {
            await client.sendMessage(sender, `⏳ PIN Verified. Deducting GHS ${plan.selling_price} from Wallet...`);
            
            await db.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE phone_number = $2', [plan.selling_price, formattedSender]);
            
            const result = await sendDataRoundRobin(plan.network_name.toLowerCase(), state.recipient, plan.idata_plan_id);
            
            if (result && result.success) {
                await db.query(
                    'INSERT INTO transactions (user_phone, amount, network, data_volume, status, platform, provider, provider_order_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
                    [formattedSender, plan.selling_price, plan.network_name, plan.plan_name, 'SUCCESS', 'WHATSAPP', result.provider, result.order_id]
                );
                client.sendMessage(sender, `✅ *Success!* ${plan.plan_name} has been sent to ${state.recipient}.`);
            } else {
                await db.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone_number = $2', [plan.selling_price, formattedSender]);
                await db.query(
                    'INSERT INTO transactions (user_phone, amount, network, data_volume, status, platform) VALUES ($1, $2, $3, $4, $5, $6)',
                    [formattedSender, plan.selling_price, plan.network_name, plan.plan_name, 'FAILED', 'WHATSAPP']
                );
                client.sendMessage(sender, `⚠️ Delivery failed. Your GHS ${plan.selling_price} has been refunded to your wallet.`);
            }
            delete userStates[sender];
        } else {
            client.sendMessage(sender, "❌ Incorrect PIN. Wallet payment cancelled.");
            delete userStates[sender];
        }
        return;
    }
});

// START THE BOT
client.initialize();