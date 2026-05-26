require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const crypto = require('crypto');
const { sendDataRoundRobin } = require('./providers'); // Rotating providers engine
const cron = require('node-cron'); 

const app = express();
app.use(cors());
app.use(bodyParser.json());
const userStates = {}; 

// Logger Middleware for absolute visibility
app.use((req, res, next) => {
    console.log(`\n--- 📥 NEW REQUEST ---`);
    console.log(`Path: ${req.path}`);
    console.log(`Method: ${req.method}`);
    console.log(`Body:`, JSON.stringify(req.body, null, 2));
    next();
});

// ==========================================
//        1. DATABASE SETUP
// ==========================================
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
});

db.connect((err) => {
    if (err) console.error('Database connection error!', err.stack);
    else console.log('Successfully connected to the Database!');
});

// ==========================================
//        2. HELPER FUNCTIONS
// ==========================================

async function getOrCreateUser(phone) {
    let cleanPhone = phone.trim();
    if (cleanPhone.startsWith('233')) cleanPhone = '0' + cleanPhone.slice(3);

    try {
        let userResult = await db.query('SELECT * FROM users WHERE phone_number = $1', [cleanPhone]);
        if (userResult.rows.length > 0) {
            return userResult.rows[0];
        } else {
            console.log(`New user created: ${cleanPhone}`);
            let newUser = await db.query(
                'INSERT INTO users (phone_number, wallet_balance) VALUES ($1, $2) RETURNING *', 
                [cleanPhone, 0.00]
            );
            return newUser.rows[0];
        }
    } catch (err) {
        console.error("DB Error:", err);
        throw err;
    }
}

const startPaystackPayment = async (email, amount, metadata) => {
    try {
        // Use payer_phone if available, otherwise use customer_phone
        let phoneToClean = metadata.payer_phone || metadata.customer_phone || "";
        
        let phone = phoneToClean.trim();
        if (phone.startsWith('0')) phone = '233' + phone.slice(1);

        const response = await axios.post('https://api.paystack.co/transaction/initialize', {
            email: email,
            amount: Math.round(amount * 100),
            currency: "GHS",
            metadata: metadata,
            channels: ['mobile_money', 'card'] 
        }, {
            headers: { 
                Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data;
    } catch (err) {
        console.error("🔴 Paystack Init Error:", err.response?.data || err.message);
        return null;
    }
};

// FORCES DIRECT MOMO PROMPT (STK PUSH) ON PHONE
const chargeMoMoDirect = async (phone, amount, network, metadata) => {
    try {
        let provider = 'mtn';
        if (network.includes('telecel') || network.includes('vod')) provider = 'vod';
        if (network.includes('at') || network.includes('airtel')) provider = 'atl';

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

// ==========================================
//        3. EXPRESS API ROUTES
// ==========================================

app.get('/', (req, res) => res.send("AMG Data Backend is Running!"));

app.get('/api/test-idata-connection', async (req, res) => {
    try {
        console.log("Testing idata connection...");
        const response = await axios.get('https://idatagh.com/wp-json/custom/v1/wallet-balance', {
            headers: {
                'Authorization': `Bearer ${process.env.IDATA_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        res.json({ 
            success: true,
            message: "Connection Successful!", 
            idata_balance: response.data.balance 
        });
    } catch (err) {
        console.error("idata Test Error:", err.response?.data || err.message);
        res.status(500).json({ error: "Connection Failed" });
    }
});

app.get('/api/plans', async (req, res) => {
    try {
        const plans = await db.query('SELECT * FROM data_plans WHERE is_active = true ORDER BY network_name ASC');
        res.json(plans.rows);
    } catch (err) { res.status(500).json({ error: "Failed to fetch plans" }); }
});

app.get('/api/user/:phone', async (req, res) => {
    try {
        const phone = req.params.phone;
        const pinProvided = req.query.pin; 
        
        const user = await getOrCreateUser(phone);
        
        if (!user.pin) {
            return res.json({ status: "NEW_USER", message: "Please set a 4-digit PIN" });
        }

        if (user.pin === pinProvided) {
            return res.status(200).json(user);
        } else {
            return res.status(401).json({ status: "WRONG_PIN", message: "Incorrect PIN" });
        }
    } catch (err) {
        res.status(500).json({ error: "Server Error" });
    }
});

app.post('/api/user/set-pin', async (req, res) => {
    const { phone, pin } = req.body;
    await db.query('UPDATE users SET pin = $1 WHERE phone_number = $2', [pin, phone]);
    res.json({ success: true });
});

app.get('/api/history/:phone', async (req, res) => {
    try {
        const phone = req.params.phone;
        const history = await db.query('SELECT * FROM transactions WHERE user_phone = $1 ORDER BY created_at DESC LIMIT 20', [phone]);
        res.json(history.rows);
    } catch (err) { res.status(500).json({ error: "Failed to fetch history" }); }
});

app.post('/api/topup', async (req, res) => {
    try {
        const { phone, amount, method } = req.body;

        const metadata = { type: 'WALLET_TOPUP', customer_phone: phone };

        let checkoutUrl = null;
        let reference = 'TOPUP_INIT';

        if (method === 'MOMO_WEB') {
            const payment = await startPaystackPayment('customer@amgdata.com', amount, metadata);
            checkoutUrl = payment?.data?.authorization_url;
            reference = payment?.data?.reference;
        } else {
            const charge = await chargeMoMoDirect(phone, amount, 'mtn', metadata);
            checkoutUrl = charge?.data?.authorization_url;
            reference = charge?.data?.reference;
        }

        if (reference) {
            // Log the top-up attempt in transactions
            await db.query(
                'INSERT INTO transactions (user_phone, amount, network, data_volume, status, platform, reference, checkout_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
                [phone, amount, 'WALLET', 'DEPOSIT', 'PROCESSING', 'MOMO', reference, checkoutUrl]
            );
            res.json({ success: true, checkout_url: checkoutUrl });
        } else {
            res.status(400).json({ success: false, message: "Payment failed to start" });
        }
    } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.post('/api/purchase-wallet', async (req, res) => {
    let cost = 0; let phone = '';
    try {
        const { plan_id, recipient, phone: userPhone } = req.body;
        phone = userPhone;

        const planRes = await db.query('SELECT * FROM data_plans WHERE idata_plan_id = $1', [plan_id]);
        if (planRes.rows.length === 0) return res.status(404).json({ success: false, message: "Plan not found" });
        
        const plan = planRes.rows[0];
        const user = await getOrCreateUser(phone);
        cost = parseFloat(plan.selling_price);

        if (parseFloat(user.wallet_balance) < cost) return res.status(400).json({ success: false, message: "Insufficient balance" });

        // 1. Deduct from wallet immediately
        await db.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE phone_number = $2', [cost, phone]);
        
        // 2. Fulfill using rotating provider
        const result = await sendDataRoundRobin(plan.network_name.toLowerCase(), recipient, plan.idata_plan_id);

        if (result.success) {
            // 3. Save as PROCESSING and store the provider_order_id
            await db.query(
                'INSERT INTO transactions (user_phone, amount, network, data_volume, status, platform, provider, provider_order_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
                [phone, cost, plan.network_name, plan.plan_name, 'PROCESSING', 'APP', result.provider, result.order_id]
            );
            return res.json({ success: true, message: "Order placed! Processing..." });
        } else {
            throw new Error(result.error || "Provider failed");
        }
    } catch (err) {
        if (cost > 0 && phone !== '') {
            await db.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone_number = $2', [cost, phone]);
        }
        res.status(500).json({ success: false, message: "Transaction failed. Wallet refunded." });
    }
});

app.post('/api/purchase-direct', async (req, res) => {
    try {
        const { payer, recipient, plan_id, network, method } = req.body;
        
        const planRes = await db.query('SELECT * FROM data_plans WHERE idata_plan_id = $1', [plan_id]);
        if (planRes.rows.length === 0) return res.status(404).json({ success: false, message: "Plan not found" });
        const plan = planRes.rows[0];

        const metadata = {
            type: 'DIRECT_PURCHASE',
            customer_phone: recipient,
            payer_phone: payer,
            plan_id: plan_id,
            network_id: network
        };

        let checkoutUrl = null;
        let paystackReference = '';

        if (method === 'MOMO_WEB') {
            // MODE A: Initialize a web transaction & get its reference
            const payment = await startPaystackPayment('customer@amgdata.com', plan.selling_price, metadata);
            checkoutUrl = payment && payment.status ? payment.data.authorization_url : null;
            paystackReference = payment && payment.status ? payment.data.reference : 'WEB_BUY';
        } else {
            // MODE B: Trigger direct STK Push & get its unique charge reference
            const charge = await chargeMoMoDirect(payer, plan.selling_price, network, metadata);
            paystackReference = charge && charge.status ? charge.data.reference : 'PROMPT_BUY';
            checkoutUrl = charge && charge.status ? charge.data.authorization_url : null;
        }

        // --- 🧾 FIXED: WE NOW SAVE THE CORRECT MATCHING REFERENCE ---
        await db.query(
            'INSERT INTO transactions (user_phone, amount, network, data_volume, status, platform, reference, checkout_url, plan_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [payer, plan.selling_price, plan.network_name, plan.plan_name, 'PROCESSING', 'MOMO', paystackReference, checkoutUrl, plan_id]
        );

        res.json({ 
            success: true, 
            message: method === 'MOMO_WEB' ? "Web link generated!" : "Prompt sent!", 
            checkout_url: checkoutUrl 
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});

app.post('/payment/webhook', async (req, res) => {
    console.log("--- 🔔 WEBHOOK RECEIVED FROM PAYSTACK ---");
    
    // Secure the door
    const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(JSON.stringify(req.body)).digest('hex');
    if (hash !== req.headers['x-paystack-signature']) {
        console.log("🚫 SECURITY ALERT: Fake Webhook Attempt Blocked!");
        return res.sendStatus(400);
    }

    const event = req.body;
    if (event.event === 'charge.success') {
        const metadata = event.data.metadata; 
        const amountPaid = event.data.amount / 100; 
        const phone = metadata.customer_phone;
        const reference = event.data.reference; 
        
        console.log(`Verified payment of GHS ${amountPaid} for ${phone}`);

        if (metadata.type === 'WALLET_TOPUP') {
            const update = await db.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone_number = $2 RETURNING wallet_balance', [amountPaid, phone]);
            await db.query(
                'INSERT INTO transactions (user_phone, amount, network, data_volume, status, reference, platform) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [phone, amountPaid, 'WALLET', 'DEPOSIT', 'TOPUP', reference, 'APP']
            );
            console.log(`✅ WALLET UPDATED! New Balance: GHS ${update.rows[0].wallet_balance}`);
            
        } else if (metadata.type === 'DIRECT_PURCHASE') {
            console.log(`Direct Purchase: Sending Plan to ${phone}...`);
            
            // Fulfill the order
            const result = await sendDataRoundRobin(metadata.network_id.toLowerCase(), phone, metadata.plan_id);
            
            if (result.success) {
                // --- 🧾 FIXED: UPDATE THE EXISTING ROW INSTEAD OF INSERTING A NEW ONE ---
                await db.query(
                    'UPDATE transactions SET status = $1, provider = $2, provider_order_id = $3 WHERE reference = $4',
                    ['SUCCESS', result.provider, result.order_id, reference]
                );
                console.log(`✅ Webhook: Updated Transaction Reference ${reference} to SUCCESS!`);
            } else {
                console.log("❌ Data delivery failed. Updating status to FAILED.");
                // Update the existing row to FAILED
                await db.query('UPDATE transactions SET status = $1 WHERE reference = $2', ['FAILED', reference]);
            }
        }
    }
    res.sendStatus(200);
});

// 8. ADMIN: REPORT A FAILED TRANSACTION
app.post('/api/report-transaction', async (req, res) => {
    try {
        const { transaction_id, phone } = req.body;
        // Update the status to 'REPORTED'
        await db.query(
            "UPDATE transactions SET status = 'REPORTED' WHERE id = $1 AND user_phone = $2", 
            [transaction_id, phone]
        );
        console.log(`⚠️ REPORTED: Transaction ID ${transaction_id} was reported by ${phone}`);
        res.json({ success: true, message: "Issue reported to Admin." });
    } catch (err) {
        res.status(500).json({ error: "Failed to report transaction" });
    }
});

// 9. CANCEL / REFUND A TRANSACTION
app.post('/api/cancel-transaction', async (req, res) => {
    try {
        const { transaction_id, phone } = req.body;
        console.log(`Cancelling transaction: ${transaction_id} for ${phone}`);

        const txRes = await db.query('SELECT * FROM transactions WHERE id = $1 AND user_phone = $2', [transaction_id, phone]);
        if (txRes.rows.length === 0) return res.status(404).json({ success: false, message: "Not found" });
        
        const tx = txRes.rows[0];

        if (tx.status === 'PROCESSING') {
            await db.query("UPDATE transactions SET status = 'FAILED' WHERE id = $1", [transaction_id]);
            
            // Refund if they used App Wallet
            if (tx.platform === 'APP') {
                await db.query("UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone_number = $2", [tx.amount, phone]);
            }
            res.json({ success: true, message: "Cancelled." });
        } else {
            res.status(400).json({ success: false, message: "Cannot cancel this transaction." });
        }
    } catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});

// 10. ADMIN: GET ALL ACTIVE DISPUTES (REPORTED STATUS)
app.get('/api/admin/disputes', async (req, res) => {
    try {
        const disputes = await db.query(
            "SELECT * FROM transactions WHERE status = 'REPORTED' ORDER BY created_at DESC"
        );
        res.json(disputes.rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to load disputes" });
    }
});

// 11. ADMIN: RESOLVE DISPUTE (MARK AS SUCCESS)
app.post('/api/admin/resolve-dispute', async (req, res) => {
    try {
        const { transaction_id } = req.body;
        // Update the status back to SUCCESS
        await db.query(
            "UPDATE transactions SET status = 'SUCCESS' WHERE id = $1", 
            [transaction_id]
        );
        console.log(`✅ DISPUTE RESOLVED: Transaction ID ${transaction_id} marked as SUCCESS.`);
        res.json({ success: true, message: "Dispute marked as resolved." });
    } catch (err) {
        res.status(500).json({ error: "Failed to resolve dispute" });
    }
});

// ==========================================
//        4. WHATSAPP BOT LOGIC
// ==========================================

const client = new Client({
    authStrategy: new LocalAuth({ clientId: "amg-bot-live" }),
    // Force a stable version that works on Linux servers
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version-checker/master/remote/2.3000.1018903107-alpha.html',
    },
    puppeteer: {
        headless: true, // MUST be true on Oracle
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // Saves RAM on Oracle's free tier
            '--disable-gpu'
        ],
    }
});

client.on('qr', (qr) => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('✅ AMG Bot is online and stable!'));

// --- BOT MESSAGES ---
client.on('message', async (msg) => {
    const userMessage = msg.body.trim();
    const sender = msg.from;
    const senderClean = sender.split('@')[0];

    if (userMessage === '0' || userMessage.toLowerCase() === 'reset' || userMessage.toLowerCase() === 'menu') delete userStates[sender];

    if (!userStates[sender]) {
        userStates[sender] = { step: 'MAIN_MENU' };
        return client.sendMessage(sender, `🌟 *Welcome to AMG Affordable Data* 🌟\n\n1. 🛒 Buy Data\n2. 💰 Wallet Top-up\n3. 📖 Instructions\n4. 📞 Support\n\n*Reply with a number:*`);
    }

    if (userStates[sender].step === 'MAIN_MENU') {
        if (userMessage === '1') {
            const plans = await db.query('SELECT * FROM data_plans WHERE is_active = true');
            let planMenu = `📊 *Select Data Bundle*\n\n`;
            plans.rows.forEach((p, i) => planMenu += `*${i + 1}* - ${p.network_name} ${p.plan_name} (GHS ${p.selling_price})\n`);
            userStates[sender] = { step: 'CHOOSING_PLAN' };
            return client.sendMessage(sender, planMenu + `\n*0. Back*`);
        } else if (userMessage === '2') {
            const user = await getOrCreateUser(senderClean); 
            delete userStates[sender];
            return client.sendMessage(sender, `💰 *AMG Wallet*\nBalance: *GHS ${user.wallet_balance}*\nTop up via our Mobile App!\n\n*0. Menu*`);
        } else if (userMessage === '3') {
            delete userStates[sender];
            return client.sendMessage(sender, `📖 *How to Buy Data*\n1. Select Buy Data\n2. Choose bundle\n3. Enter numbers\n4. Approve MoMo.\n\n*0. Menu*`);
        } else if (userMessage === '4') {
            delete userStates[sender];
            return client.sendMessage(sender, "📞 *Support*\nCall 024XXXXXXX.\n\n*0. Menu*");
        } else {
            return client.sendMessage(sender, "❌ Invalid selection.");
        }
    }

    if (userStates[sender]?.step === 'CHOOSING_PLAN') {
        const choice = parseInt(userMessage) - 1;
        const plans = await db.query('SELECT * FROM data_plans WHERE is_active = true');
        if (plans.rows[choice]) {
            userStates[sender] = { step: 'ENTERING_RECIPIENT', plan: plans.rows[choice] };
            return client.sendMessage(sender, `✅ Selected: *${plans.rows[choice].plan_name}*\n\nWhich number should *RECEIVE* the data?\n*1.* My number (${senderClean})\n*OR* Type 10-digit number:`);
        } else {
            return client.sendMessage(sender, "❌ Invalid choice.");
        }
    }

    if (userStates[sender]?.step === 'ENTERING_RECIPIENT') {
        let recipient = userMessage === '1' ? senderClean : userMessage;
        if (recipient.startsWith('233')) recipient = '0' + recipient.slice(3);
        if (recipient.length >= 10) {
            userStates[sender].recipient = recipient;
            userStates[sender].step = 'ENTERING_PAYER';
            return client.sendMessage(sender, `📱 Data for: *${recipient}*\n\nWhich number is *PAYING*?\n*1.* Same as recipient\n*OR* Type MoMo number:`);
        } else {
            return client.sendMessage(sender, "❌ Invalid number.");
        }
    }

    if (userStates[sender]?.step === 'ENTERING_PAYER') {
        let payer = userMessage === '1' ? userStates[sender].recipient : userMessage;
        if (payer.startsWith('233')) payer = '0' + payer.slice(3);
        if (payer.length >= 10) {
            const plan = userStates[sender].plan;
            const user = await getOrCreateUser(senderClean);
            const balance = parseFloat(user.wallet_balance);
            const price = parseFloat(plan.selling_price);

            userStates[sender].payer = payer;
            userStates[sender].step = 'CONFIRMING_ORDER';
            userStates[sender].hasEnoughBalance = (balance >= price);

            let summary = `📝 *Summary*\n📦 ${plan.network_name} ${plan.plan_name}\n📱 Recipient: ${userStates[sender].recipient}\n💰 Cost: GHS ${price}\n🏦 Wallet: GHS ${balance}\n\n`;
            if (userStates[sender].hasEnoughBalance) summary += `*1.* ✅ Pay with AMG Wallet\n*2.* 💳 Pay with MoMo\n`;
            else summary += `*1.* 💳 Pay with MoMo (Low Balance)\n`;
            return client.sendMessage(sender, summary + `*0.* Cancel`);
        } else {
            return client.sendMessage(sender, "❌ Invalid number.");
        }
    }

    if (userStates[sender]?.step === 'CONFIRMING_ORDER') {
        const state = userStates[sender];
        const plan = state.plan;

        if (userMessage === '1') {
            if (state.hasEnoughBalance) {
                await client.sendMessage(sender, `⏳ Deducting from AMG Wallet...`);
                await db.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE phone_number = $2', [plan.selling_price, senderClean]);
                const result = await sendDataRoundRobin(plan.network_name.toLowerCase(), state.recipient, plan.idata_plan_id);
                if (result.success) {
                    client.sendMessage(sender, `✅ *Success!* Data sent to ${state.recipient}.`);
                } else {
                    await db.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone_number = $2', [plan.selling_price, senderClean]);
                    client.sendMessage(sender, `⚠️ Delivery failed. Your GHS ${plan.selling_price} has been refunded to your wallet.`);
                }
                delete userStates[sender];
            } else {
                await triggerMoMoFlow(sender, state);
            }
        } else if (userMessage === '2' && state.hasEnoughBalance) {
            await triggerMoMoFlow(sender, state);
        }
    }
});

// ==========================================
//        5. ADMIN & SYSTEM ROUTES
// ==========================================

app.post('/api/admin/update-price', async (req, res) => {
    try {
        const { plan_id, new_price } = req.body;
        await db.query('UPDATE data_plans SET selling_price = $1 WHERE id = $2', [new_price, plan_id]);
        res.json({ success: true, message: "Price updated successfully!" });
    } catch (err) { res.status(500).json({ error: "Failed to update price" }); }
});

app.get('/api/admin/stats', async (req, res) => {
    try {
        // 1. Get local sales stats
        const localStats = await db.query(`
            SELECT COALESCE(SUM(amount), 0) as total_sales, COUNT(*) as total_count 
            FROM transactions 
            WHERE created_at >= CURRENT_DATE AND (status = 'SUCCESS' OR status = 'TOPUP')
        `);

        let idataBalance = "0.00";
        try {
            // FIXED: Added a strict 3-second timeout so our API never hangs!
            const providerRes = await axios.get('https://idatagh.com/wp-json/custom/v1/wallet-balance', {
                headers: { 'Authorization': `Bearer ${process.env.IDATA_API_KEY}`, 'Content-Type': 'application/json' },
                timeout: 3000 // 3 seconds timeout
            });
            idataBalance = providerRes.data.balance;
        } catch (providerErr) { 
            console.error("⚠️ idata balance timed out or offline:", providerErr.message); 
            idataBalance = "Offline"; 
        }

        res.json({ 
            success: true, 
            total_income: localStats.rows[0].total_sales, 
            total_orders: localStats.rows[0].total_count, 
            provider_balance: idataBalance 
        });
    } catch (err) { 
        console.error("🔴 Stats Error:", err.message);
        res.status(500).json({ error: "Failed to load stats" }); 
    }
});

// --- 🔄 BACKGROUND SYNC (CRON JOB) ---
cron.schedule('*/30 * * * *', async () => {
    try {
        const pending = await db.query("SELECT * FROM transactions WHERE status = 'PROCESSING'");
        console.log(`\n🔄 Cron Job: Syncing ${pending.rows.length} pending orders...`);
        
        for (let tx of pending.rows) {
            const orderAgeInMinutes = (new Date() - new Date(tx.created_at)) / 1000 / 60;
            
            // --- SECURE TIMEOUT LOGIC ---
            if (orderAgeInMinutes > 15) {
                if (tx.platform === 'APP') {
                    // WALLET TRANSACTION: Already paid, safe to auto-complete
                    await db.query("UPDATE transactions SET status = 'SUCCESS', reference = 'AUTO_COMPLETE' WHERE id = $1", [tx.id]);
                    console.log(`⚠️ Sync Timeout: Wallet Transaction ${tx.id} was stuck. Auto-marked as SUCCESS.`);
                } else {
                    // MOMO TRANSACTION: Unpaid, mark as FAILED because they abandoned it [1.2.6]
                    await db.query("UPDATE transactions SET status = 'FAILED' WHERE id = $1", [tx.id]);
                    console.log(`❌ Sync Timeout: Unpaid MoMo Transaction ${tx.id} was abandoned. Marked as FAILED.`);
                }
                continue;
            }

            if (!tx.provider_order_id) continue; 

            try {
                const statusRes = await axios.get(`https://idatagh.com/wp-json/custom/v1/order-status?order_id=${tx.provider_order_id}`, {
                    headers: { 'Authorization': `Bearer ${process.env.IDATA_API_KEY}`, 'Content-Type': 'application/json' }
                });

                if (statusRes.data.status === 'success') {
                    const orderStatus = statusRes.data.order_status; 
                    console.log(`Order ${tx.provider_order_id} status: ${orderStatus}`);

                    if (orderStatus === 'Completed') {
                        await db.query("UPDATE transactions SET status = 'SUCCESS' WHERE id = $1", [tx.id]);
                        console.log(`✅ Sync: Transaction ${tx.id} marked as SUCCESS.`);
                    } else if (orderStatus === 'Failed') {
                        await db.query("UPDATE transactions SET status = 'FAILED' WHERE id = $1", [tx.id]);
                        
                        // Only refund if they used the App Wallet [1.2.6]
                        if (tx.platform === 'APP') {
                            await db.query("UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone_number = $2", [tx.amount, tx.user_phone]);
                            console.log(`❌ Sync: Wallet refunded GHS ${tx.amount} to ${tx.user_phone}.`);
                        }
                    }
                }
            } catch (err) { 
                console.error(`Error syncing transaction ${tx.id}:`, err.message); 
            }
        }
    } catch (err) { 
        console.error("Cron Database Error:", err.message); 
    }
});

// TEST A SPECIFIC PROVIDER INDEPENDENTLY
app.get('/api/admin/test-provider', async (req, res) => {
    try {
        const { provider, network, phone, plan_id } = req.query;
        const { sendDataToProvider } = require('./providers'); // Make sure you export this in providers.js

        console.log(`🧪 Testing Provider: ${provider} for ${phone}`);
        const result = await sendDataToProvider(provider, network, phone, plan_id);

        res.json({
            success: result.success,
            provider: provider,
            response: result.data || result.error
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
//        6. START THE SERVER & BOT
// ==========================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Senior Dev: Server is running on port ${PORT}`);
});

console.log("🚀 Initializing WhatsApp...");
client.initialize(); // ONLY CALLED ONCE AT THE VERY END!