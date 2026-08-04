// ==========================================
//    AMG AFFORDABLE DATA - WHATSAPP BOT
// ==========================================
require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const { sendDataRoundRobin } = require('./providers');
const { db, getOrCreateUser } = require('./helpers');
const { setState, getState, clearState, setLock, releaseLock, setRecipientCooldown} = require('./redisClient');

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

// FORCES DIRECT MOMO PROMPT (STK PUSH) ON PHONE
const chargeMoMoDirect = async (phone, amount, network, metadata) => {
    try {
        let net = network.toLowerCase();
        let provider = 'mtn'; // Default
        
        // Exact Paystack Ghana Provider Mappings
        if (net.includes('telecel') || net.includes('vod')) {
            provider = 'vod';
        } else if (net.includes('at') || net.includes('airtel') || net.includes('tigo')) {
            provider = 'tigo'; // 🛡️ FIXED: Paystack strictly requires 'tigo', not 'atl'
        }

        let cleanPhone = phone.trim();
        if (cleanPhone.startsWith('233')) cleanPhone = '0' + cleanPhone.slice(3);

        console.log(`⚡ FORCING DIRECT STK PUSH: ${provider} on ${cleanPhone} for GHS ${amount}`);

        const response = await axios.post('https://api.paystack.co/charge', {
            email: "customer@amgdata.com",
            amount: Math.round(amount * 100), 
            currency: "GHS",
            metadata: metadata,
            mobile_money: {
                phone: cleanPhone,
                provider: provider
            }
        }, {
            headers: { 
                Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        return response.data;
    } catch (err) {
        console.error("🔴 Paystack Charge API Error:", err.response?.data || err.message);
        return null;
    }
};

// --- UPDATED: TRIGGER FLOW ---
const triggerMoMoFlow = async (sender, state) => {
    const { plan, payer, recipient } = state;
    await client.sendMessage(sender, `⏳ Requesting GHS ${plan.selling_price} from *${payer}*...`);
    
    const metadata = { type: 'DIRECT_PURCHASE', customer_phone: recipient, payer_phone: payer, plan_id: plan.idata_plan_id, network_id: plan.network_name.toLowerCase() };
    
    // 1. Generate Web Link Fallback
    const pay = await axios.post('https://api.paystack.co/transaction/initialize', {
        email: 'customer@amgdata.com', amount: Math.round(plan.selling_price * 100), currency: "GHS", metadata, channels: ['mobile_money', 'card']
    }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }).catch(() => null);

    const checkoutUrl = pay?.data?.data?.authorization_url || null;
    let referenceToSave = pay?.data?.data?.reference || 'PROMPT_BUY';

    // 2. Trigger the actual MoMo Prompt (STK Push)
    const charge = await chargeMoMoDirect(payer, plan.selling_price, plan.network_name.toLowerCase(), metadata);
    
    // 3. Fix: We MUST save the STK Push reference so the Webhook finds it when the user approves on their phone
    if (charge && charge.data && charge.data.reference) {
        referenceToSave = charge.data.reference;
    }

    // 4. Save to Database
    await db.query(
        'INSERT INTO transactions (user_phone, recipient_phone, amount, network, data_volume, status, platform, reference, checkout_url, plan_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [payer, recipient, plan.selling_price, plan.network_name, plan.plan_name, 'PROCESSING', 'WHATSAPP', referenceToSave, checkoutUrl, plan.id]
    );
    
    await client.sendMessage(sender, `🔔 *Payment Instructions*\n1. Authorize the prompt on your phone.\n2. *MTN:* Dial *170# -> 6 -> 3* (Approvals) if no prompt appears.\n3. Or pay via web here: ${checkoutUrl || 'N/A'}`);
    await clearState(sender);
};

// --- INITIALIZE WHATSAPP CLIENT ---
const client = new Client({
    authStrategy: new LocalAuth({ clientId: "amg-bot-live" }),
    // REMOVED the old remotePath webVersionCache so it fetches the live version!
    puppeteer: {
        headless: true, 
        args:[
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', 
            '--disable-gpu'
        ],
    }
});

// --- MAIN MESSAGE LOGIC ---
client.on('message', async (msg) => {
    try {
        const sender = msg.from;
        const userMessage = msg.body.trim();
        const formattedSender = await resolveJidToPhone(sender);
        
        // 1. Fetch the state from Redis
        let state = await getState(sender);

        // 👑 THE KING: Global Reset/Cancel
        // This MUST be checked before ANY step-specific logic
        if (state && ['0', 'cancel', 'reset', 'menu'].includes(userMessage.toLowerCase())) {
            await clearState(sender);
            return client.sendMessage(sender, "🚫 *Transaction Cancelled.*\n\nReply *1* to see the Main Menu.");
        }

        // 3. INITIAL WELCOME
        if (!state) {
            if (['0', 'reset', 'menu', 'cancel'].includes(userMessage.toLowerCase())) return;

            state = { step: 'MAIN_MENU' };
            await setState(sender, state);
            
            let welcome = `🌟 *Welcome to AMG Affordable Data* 🌟\n\n`;
            welcome += `1. 🛒 Buy Data\n`;
            welcome += `2. 💰 Check Wallet Balance\n`;
            welcome += `3. 📖 Instructions\n`;
            welcome += `4. 📞 Support\n\n`;
            welcome += `📲 *Download our Mobile App*:\nhttps://amg-data-api.duckdns.org/download-app\n\n`;
            welcome += `*Reply with a number (1, 2, 3, or 4):*`;
            
            return client.sendMessage(sender, welcome);
        }

        // --- STEP 1: MAIN MENU ---
        if (state.step === 'MAIN_MENU') {
            if (userMessage === '1') {
                state.step = 'SELECTING_NETWORK';
                await setState(sender, state);
                return client.sendMessage(sender, `📊 *Select Network*\n\n1. MTN\n2. Telecel\n3. AirtelTigo\n\n*0* Cancel`);
            } else if (userMessage === '2') {
                const userRes = await db.query('SELECT * FROM users WHERE phone_number = $1', [formattedSender]);
                if (userRes.rows.length === 0 || !userRes.rows[0].pin) {
                    await clearState(sender);
                    return client.sendMessage(sender, `❌ *No Wallet Found*\n\nPlease download our *Mobile App* to create an account.\n\n*0* Menu`);
                }
                const user = userRes.rows[0];
                await clearState(sender);
                return client.sendMessage(sender, `💰 *AMG Wallet Balance*\n\nAccount: *${formattedSender}*\nBalance: *GHS ${user.wallet_balance}*\n\n*0* Menu`);
            } else if (userMessage === '3') {
                await clearState(sender);
                return client.sendMessage(sender, `📖 *How to Buy Data*\n\n1. Reply '1' to Buy.\n2. Choose network/bundle.\n3. Enter details.\n4. Authorize.\n\n*0* Menu`);
            } else if (userMessage === '4') {
                await clearState(sender);
                return client.sendMessage(sender, "📞 *AMG Support*\nNeed help? Contact *0278592168*.\n\n*0* Menu");
            }
        }

        // --- STEP 2: SELECTING NETWORK ---
        if (state.step === 'SELECTING_NETWORK') {
            if (userMessage === '#') {
                state.step = 'MAIN_MENU';
                await setState(sender, state);
                return client.sendMessage(sender, `🌟 *Welcome to AMG Affordable Data* 🌟\n\n1. 🛒 Buy Data\n2. 💰 Check Wallet Balance\n3. 📖 Instructions\n4. 📞 Support\n\n*Reply with a number:*`);
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
                return client.sendMessage(sender, `📊 *Select Network*\n\n1. MTN\n2. Telecel\n3. AirtelTigo\n\n*#* Back  |  *0* Cancel`);
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
                return client.sendMessage(sender, `✅ Selected: *${cleanPlanName(state.plan.plan_name)}*\n\nWhich number should *RECEIVE* the data?\n\n*1.* My number (${formattedSender})\n*OR* Type the 10-digit number:\n\n*#* Back  |  *0* Cancel`);
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
            
            // FIXED TEXT HERE:
            return client.sendMessage(sender, `📱 Data for: *${state.recipient}*\n\nWhich number is *PAYING*?\n\n*1.* My number (${formattedSender})\n*OR* Type the MoMo number:\n\n*#* Back  |  *0* Cancel`);
        }

        // --- STEP 5: ENTERING PAYER ---
        if (state.step === 'ENTERING_PAYER') {
            if (userMessage === '#') {
                state.step = 'ENTERING_RECIPIENT';
                await setState(sender, state);
                return client.sendMessage(sender, `✅ Selected: *${cleanPlanName(state.plan.plan_name)}*\n\nWhich number should *RECEIVE* the data?\n\n*1.* My number (${formattedSender})\n*OR* Type the 10-digit number:\n\n*#* Back  |  *0* Cancel`);
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
            
            return client.sendMessage(sender, summary + `\n*#* Back  |  *0* Cancel`);
        }

        // --- STEP 6: CONFIRMING ORDER ---
        if (state.step === 'CONFIRMING_ORDER') {
            if (userMessage === '#') {
                state.step = 'ENTERING_PAYER';
                await setState(sender, state);
                
                // FIXED TEXT HERE:
                return client.sendMessage(sender, `📱 Data for: *${state.recipient}*\n\nWhich number is *PAYING*?\n\n*1.* My number (${formattedSender})\n*OR* Type the MoMo number:\n\n*#* Back  |  *0* Cancel`);
            }

            if (userMessage === '1' && state.hasEnoughBalance) {
                state.step = 'VERIFYING_PIN';
                await setState(sender, state);
                return client.sendMessage(sender, `🔒 *Security Check*\nEnter your 4-digit AMG PIN:\n\n*#* Back  |  *0* Cancel`);
            } else {
                await triggerMoMoFlow(sender, state);
            }
        }

        // --- STEP 7: VERIFYING PIN ---
        if (state.step === 'VERIFYING_PIN') {
            
            // 🛡️ SANITY GUARD: If plan is missing, don't crash, just reset.
            if (!state.plan || !state.plan.selling_price) {
                console.error(`⚠️ Data loss detected for ${sender}. Resetting state.`);
                await clearState(sender);
                return client.sendMessage(sender, "❌ *Session Error:* Order details were lost. Please start again by replying *1*.");
            }

            // Handle Back Button
            if (userMessage === '#') {
                state.step = 'CONFIRMING_ORDER';
                await setState(sender, state);
                
                const user = await getOrCreateUser(formattedSender);
                const balance = parseFloat(user.wallet_balance || 0);
                
                let summary = `📝 *Summary*\n📦 *Bundle:* ${state.plan.network_name} ${state.plan.plan_name}\n📱 *Recipient:* ${state.recipient}\n💳 *Payer:* ${state.payer}\n💰 *Cost:* GHS ${state.plan.selling_price}\n\n`;
                if (state.hasEnoughBalance) {
                    summary += `*1.* ✅ Pay with AMG Wallet (GHS ${balance.toFixed(2)})\n*2.* 💳 Pay with MoMo Prompt\n`;
                } else {
                    summary += `*1.* 💳 Pay with MoMo Prompt\n`;
                }
                return client.sendMessage(sender, summary + `\n*#* Back  |  *0* Cancel`);
            }

            // 🛡️ SPAM LOCK: Prevent double-taps
            const hasLock = await setLock(sender, 20);
            if (!hasLock) return client.sendMessage(sender, "⏳ Please wait... processing.");

            try {
                const user = await getOrCreateUser(formattedSender);
                
                if (user.pin === userMessage) {
                    // Check Cooldown
                    const canProceed = await setRecipientCooldown(state.recipient, 5);
                    if (!canProceed) {
                        await clearState(sender);
                        return client.sendMessage(sender, `⏳ *Telco Spam Protection Active*\n\nPlease wait *5 minutes* before sending another bundle to *${state.recipient}*.\n\nYour wallet has *NOT* been deducted.`);
                    }

                    // 💰 Deduct Wallet
                    await db.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE phone_number = $2', [state.plan.selling_price, formattedSender]);
                    
                    // 📡 Call Provider
                    const res = await sendDataRoundRobin(
                        state.plan.network_name.toLowerCase(), 
                        state.recipient, 
                        state.plan.idata_plan_id, 
                        state.plan.size_mb,
                        state.plan.swiftdata_plan_id
                    );
                    
                    if (res.success) {
                        await db.query(
                            'INSERT INTO transactions (user_phone, recipient_phone, amount, network, data_volume, status, platform, provider, provider_order_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
                            [formattedSender, state.recipient, state.plan.selling_price, state.plan.network_name, state.plan.plan_name, 'PROCESSING', 'WHATSAPP', res.provider, res.order_id]
                        );
                        client.sendMessage(sender, `✅ *Success!* Order sent to provider.`);
                    } else {
                        // Refund
                        await db.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone_number = $2', [state.plan.selling_price, formattedSender]);
                        
                        let errorMessage = "Delivery failed.";
                        const apiError = (res.error || "").toLowerCase();
                        if (apiError.includes('balance') || apiError.includes('fund')) {
                            errorMessage = "Network nodes are currently busy.";
                        }
                        client.sendMessage(sender, `⚠️ *${errorMessage}*\n\nYour GHS ${state.plan.selling_price} was refunded.`);
                    }
                } else {
                    client.sendMessage(sender, "❌ Incorrect PIN.");
                }
                
                await clearState(sender); // End session

            } finally {
                await releaseLock(sender); // Always release lock
            }
            return; // Exit listener for this message
        }

    } catch (err) {
        console.error("🔴 Bot Error:", err);
    }
});

client.initialize();