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
const { db, getOrCreateUser } = require('./helpers');
const { setState, getState, clearState, setRecipientCooldown } = require('./redisClient');

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
// const db = new Pool({
//     connectionString: process.env.DATABASE_URL,
// });

// db.connect((err) => {
//     if (err) console.error('Database connection error!', err.stack);
//     else console.log('Successfully connected to the Database!');
// });

// ==========================================
//        2. HELPER FUNCTIONS
// ==========================================

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

const triggerMoMoFlow = async (sender, state) => {
    const plan = state.plan;
    await client.sendMessage(sender, `⏳ Requesting GHS ${plan.selling_price} from *${state.payer}*...`);
    
    const metadata = { 
        type: 'DIRECT_PURCHASE', 
        customer_phone: state.recipient, 
        payer_phone: state.payer, 
        plan_id: plan.idata_plan_id, 
        network_id: plan.network_name.toLowerCase() 
    };
    
    const pay = await startPaystackPayment('customer@amgdata.com', plan.selling_price, metadata);

    if (pay && pay.status) {
        // --- 🧾 FIXED: WE NOW SAVE THE PROCESSING ROW FROM WHATSAPP ---
        await db.query(
            'INSERT INTO transactions (user_phone, amount, network, data_volume, status, platform, reference, checkout_url, plan_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [state.payer, plan.selling_price, plan.network_name, plan.plan_name, 'PROCESSING', 'WHATSAPP', pay.data.reference, pay.data.authorization_url, plan.id]
        );

        await client.sendMessage(sender, `🔔 *Payment Instructions*\n1. Authorize on your phone.\n2. *MTN:* Dial *170# -> 6 -> 10 if no prompt.\n3. Or pay here: ${pay.data.authorization_url}`);
    } else {
        await client.sendMessage(sender, "❌ Payment system down. Try later.");
    }
    await clearState(sender);
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
        let phone = req.params.phone.trim();
        if (phone.startsWith('233')) phone = '0' + phone.slice(3);
        
        console.log(`📡 Fetching history for: ${phone}`);

        const history = await db.query(`
            SELECT 
                id,
                user_phone,
                recipient_phone,
                amount,
                network,
                data_volume,
                status,
                platform,
                reference,
                plan_id,
                TO_CHAR(created_at, 'DD Mon, hh:mi AM') as formatted_date
            FROM transactions 
            WHERE user_phone = $1 
            ORDER BY created_at DESC 
            LIMIT 20
        `, [phone]);

        res.json(history.rows);
    } catch (err) { 
        console.error("🔴 History API Error:", err);
        res.status(500).json({ error: "Failed to fetch history" }); 
    }
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

        // 🛡️ NEW: TELCO SPAM PROTECTION FOR APP
        const canProceed = await setRecipientCooldown(recipient, 5);
        if (!canProceed) {
            return res.status(400).json({ 
                success: false, 
                message: "Spam Protection: Please wait 5 minutes before sending data to this specific number again to prevent network failure." 
            });
        }

        const planRes = await db.query('SELECT * FROM data_plans WHERE idata_plan_id = $1', [plan_id]);
        if (planRes.rows.length === 0) return res.status(404).json({ success: false, message: "Plan not found" });
        
        const plan = planRes.rows[0];
        const user = await getOrCreateUser(phone);
        cost = parseFloat(plan.selling_price);

        if (parseFloat(user.wallet_balance) < cost) return res.status(400).json({ success: false, message: "Insufficient balance" });

        // 1. Deduct from wallet immediately
        await db.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE phone_number = $2', [cost, phone]);
        
        // 2. Fulfill using rotating provider
        const result = await sendDataRoundRobin(
            plan.network_name.toLowerCase(), 
            recipient, 
            plan.idata_plan_id, 
            plan.size_mb,
            plan.swiftdata_plan_id
        );

        if (result.success) {
            await db.query(
                'INSERT INTO transactions (user_phone, recipient_phone, amount, network, data_volume, status, platform, provider, provider_order_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
                [phone, recipient, cost, plan.network_name, plan.plan_name, 'PROCESSING', 'APP', result.provider, result.order_id]
            );
            return res.json({ success: true, message: "Order placed! Processing..." });
        
        } else {
            // 🛡️ SMART ERROR MASKING FOR APP
            let apiError = result.error || result.message || "Provider failed";
            if (apiError.toLowerCase().includes('balance') || apiError.toLowerCase().includes('fund')) {
                apiError = "Network nodes are currently busy.";
                console.error("🚨 ADMIN ALERT: Your iData API Balance is too low!");
            }
            throw new Error(apiError); // This triggers the catch block to refund and send the error to the App
        }
    } catch (err) {
        if (cost > 0 && phone !== '') {
            await db.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone_number = $2', [cost, phone]);
        }
        res.status(500).json({ success: false, message: err.message || "Transaction failed. Wallet refunded." });
    }
});

app.post('/api/purchase-direct', async (req, res) => {
    try {
        const { payer, recipient, plan_id, network, method } = req.body;
        
        // 🛡️ 1. ADDED: SPAM PROTECTION
        const canProceed = await setRecipientCooldown(recipient, 5);
        if (!canProceed) {
            return res.status(400).json({ success: false, message: "Please wait 5 minutes before sending data to this number again." });
        }
        
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
        let reference = '';

        if (method === 'MOMO_WEB') {
            const payment = await startPaystackPayment('customer@amgdata.com', plan.selling_price, metadata);
            checkoutUrl = payment?.status ? payment.data.authorization_url : null;
            reference = payment?.status ? payment.data.reference : 'WEB_BUY';
        } else {
            const charge = await chargeMoMoDirect(payer, plan.selling_price, network, metadata);
            if (!charge || !charge.status) {
                return res.status(400).json({ success: false, message: "MoMo prompt failed." });
            }
            reference = charge.data.reference;
        }

        // 🧾 2. FIXED: INSERT ONLY ONCE. 
        // Whether it's Web or STK Push, we insert the PROCESSING record here.
        await db.query(
            'INSERT INTO transactions (user_phone, recipient_phone, amount, network, data_volume, status, platform, reference, checkout_url, plan_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
            [payer, recipient, plan.selling_price, plan.network_name, plan.plan_name, 'PROCESSING', 'MOMO', reference, checkoutUrl, plan_id]
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
            
            try {
                // Fetch the full plan details from the database so we have size_mb and swiftdata_plan_id
                const planRes = await db.query('SELECT * FROM data_plans WHERE idata_plan_id = $1', [metadata.plan_id]);
                
                if (planRes.rows.length > 0) {
                    const plan = planRes.rows[0];
                    
                    // Fulfill the order with ALL 5 parameters
                    const result = await sendDataRoundRobin(
                        metadata.network_id.toLowerCase(), 
                        phone, 
                        metadata.plan_id,
                        plan.size_mb,
                        plan.swiftdata_plan_id
                    );
                    
                    if (result.success) {
                        await db.query(
                            'UPDATE transactions SET status = $1, provider = $2, provider_order_id = $3 WHERE reference = $4',
                            ['SUCCESS', result.provider, result.order_id, reference]
                        );
                        console.log(`✅ Webhook: Updated Transaction Reference ${reference} to SUCCESS!`);
                    } else {
                        console.log("❌ Data delivery failed. Updating status to FAILED.");
                        await db.query('UPDATE transactions SET status = $1 WHERE reference = $2', ['FAILED', reference]);
                    }
                }
            } catch (err) {
                console.error("Webhook Fulfillment Error:", err);
            }
        }
    }
    res.sendStatus(200);
});

// --- 📡 IDATA REAL-TIME WEBHOOK ---
app.post('/api/idata-webhook', async (req, res) => {
    try {
        const data = req.body;
        console.log("--- 📡 WEBHOOK RECEIVED FROM iDATA ---");
        console.log(`iData Order ${data.order_id} is now: ${data.status}`);

        // We only care if it's completely finished or permanently failed
        if (data.status === 'completed' || data.status === 'successful') {
            await db.query(
                "UPDATE transactions SET status = 'SUCCESS' WHERE provider_order_id = $1", 
                [data.order_id.toString()]
            );
            console.log(`✅ iData Webhook: Transaction ${data.order_id} marked as SUCCESS.`);
            
        } else if (data.status === 'failed' || data.status === 'cancelled') {
            // Update to failed and fetch the transaction details
            const txRes = await db.query(
                "UPDATE transactions SET status = 'FAILED' WHERE provider_order_id = $1 RETURNING *", 
                [data.order_id.toString()]
            );
            
            // Auto-Refund the user if it was an App or Bot Wallet purchase
            if (txRes.rows.length > 0) {
                const tx = txRes.rows[0];
                if (tx.platform === 'APP' || tx.platform === 'WHATSAPP') {
                    await db.query(
                        "UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone_number = $2", 
                        [tx.amount, tx.user_phone]
                    );
                    console.log(`❌ iData Webhook: Transaction ${tx.id} failed. Refunded GHS ${tx.amount} to ${tx.user_phone}.`);
                }
            }
        }
        
        res.sendStatus(200); // Tell iData we received it successfully
    } catch (err) {
        console.error("🔴 iData Webhook Error:", err.message);
        res.sendStatus(500);
    }
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

// 9. SECURED CANCEL / REFUND A TRANSACTION
app.post('/api/cancel-transaction', async (req, res) => {
    try {
        const { transaction_id, phone } = req.body;
        
        const txRes = await db.query('SELECT * FROM transactions WHERE id = $1 AND user_phone = $2', [transaction_id, phone]);
        if (txRes.rows.length === 0) return res.status(404).json({ success: false, message: "Not found" });
        
        const tx = txRes.rows[0];

        if (tx.status === 'PROCESSING') {
            // 🛡️ CRITICAL FIX: Prevent users from cancelling orders already sent to iData
            if (tx.provider_order_id) {
                return res.status(400).json({ 
                    success: false, 
                    message: "Order is already with the network provider. It cannot be cancelled. Please wait for sync." 
                });
            }

            // Only allow cancellation if it hasn't been sent to a provider (e.g. failed MoMo prompt)
            await db.query("UPDATE transactions SET status = 'FAILED' WHERE id = $1", [transaction_id]);
            
            if (tx.platform === 'APP') {
                await db.query("UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone_number = $2", [tx.amount, phone]);
            }
            res.json({ success: true, message: "Transaction Cancelled & Refunded." });
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

app.post('/api/user/update-pin', async (req, res) => {
    const { phone, old_pin, new_pin } = req.body;
    try {
        // 1. Verify old PIN first
        const userRes = await db.query('SELECT pin FROM users WHERE phone_number = $1', [phone]);
        if (userRes.rows.length === 0 || userRes.rows[0].pin !== old_pin) {
            return res.status(401).json({ success: false, message: "Incorrect current PIN" });
        }

        // 2. Update to new PIN
        await db.query('UPDATE users SET pin = $1 WHERE phone_number = $2', [new_pin, phone]);
        res.json({ success: true, message: "PIN updated successfully!" });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ==========================================
//    13. BRANDED WHATSAPP BOT LANDING PAGE
// ==========================================
app.get('/chat', (req, res) => {
    // Replace this with your exact live WhatsApp Bot number (must start with 233 and have NO '+')
    const botNumber = "233542034820"; 
    
    // Pre-fill the word 'Hi' so the user only has to click send [1]
    const prefilledMessage = encodeURIComponent("Hi"); 
    const whatsappUrl = `https://wa.me/${botNumber}?text=${prefilledMessage}`;
    
    console.log(`📣 Marketing Link Clicked! Displaying WhatsApp Bot Landing Page...`);

    // Return a beautiful, responsive marketing landing page [1]
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>AMG Affordable Data - WhatsApp Bot</title>
            <style>
                body {
                    margin: 0; padding: 0;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                    background-color: #f8f9fa;
                    display: flex; justify-content: center; align-items: center;
                    height: 100vh;
                }
                .card {
                    background: white;
                    padding: 40px 30px;
                    border-radius: 24px;
                    box-shadow: 0 10px 30px rgba(0,0,0,0.04);
                    text-align: center;
                    max-width: 330px;
                    width: 100%;
                    border: 1.5px solid #ffe8cc;
                }
                .logo {
                    font-size: 60px;
                    color: orange;
                    margin-bottom: 20px;
                    animation: pulse 1.2s infinite ease-in-out;
                }
                h2 {
                    margin: 0 0 10px 0;
                    color: #212529;
                    font-size: 24px;
                    font-weight: 800;
                }
                p {
                    color: #6c757d;
                    font-size: 14px;
                    margin-bottom: 30px;
                    line-height: 1.6;
                }
                .btn {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    width: 100%;
                    height: 55px;
                    background-color: #25D366; /* Official WhatsApp Green */
                    color: white;
                    text-decoration: none;
                    border-radius: 15px;
                    font-weight: bold;
                    font-size: 16px;
                    box-shadow: 0 8px 20px rgba(37, 211, 102, 0.3);
                    transition: all 0.2s ease;
                }
                .btn:active {
                    transform: scale(0.98);
                    box-shadow: 0 4px 10px rgba(37, 211, 102, 0.2);
                }
                .loader-text {
                    font-size: 12px;
                    color: #adb5bd;
                    margin-top: 20px;
                }
                @keyframes pulse {
                    0% { transform: scale(0.9); opacity: 0.8; }
                    50% { transform: scale(1.05); opacity: 1; }
                    100% { transform: scale(0.9); opacity: 0.8; }
                }
            </style>
            <script>
                // Automatically open WhatsApp after 2 seconds [1]
                setTimeout(function() {
                    window.location.href = "${whatsappUrl}";
                }, 2000);
            </script>
        </head>
        <body>
            <div class="card">
                <div class="logo">⚡</div>
                <h2>AMG Affordable Data</h2>
                <p>We are opening WhatsApp to start your automated data purchase.<br><br><strong>Tip:</strong> Simply tap <strong>"Send"</strong> on the pre-filled message "Hi" when your chat opens! [1]</p>
                
                <a href="${whatsappUrl}" class="btn">
                    🟢 OPEN WHATSAPP CHAT
                </a>
                
                <div class="loader-text">Redirecting automatically in 2s...</div>
            </div>
        </body>
        </html>
    `);
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

// 14. ADMIN: EXPLORE PROVIDER PACKAGE IDs
app.get('/api/admin/fetch-packages', async (req, res) => {
    try {
        const { network } = req.query; // This captures ?network=mtn, ?network=telecel, etc.
        console.log(`📡 Fetching real-time packages from idata for: ${network}`);

        const response = await axios.get(`https://idatagh.com/wp-json/custom/v1/packages?network=${network}`, {
            headers: {
                'Authorization': `Bearer ${process.env.IDATA_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        res.json(response.data);
    } catch (err) {
        console.error("Failed to fetch packages:", err.response?.data || err.message);
        res.status(500).json({ error: "Failed to fetch packages", details: err.response?.data || err.message });
    }
});

// --- 🔄 BACKGROUND SYNC (CRON JOB) ---
cron.schedule('*/30 * * * *', async () => {
    try {
        // 1. Fetch pending orders from ONLY the last 24 hours
        const pending = await db.query(`
            SELECT * FROM transactions 
            WHERE status = 'PROCESSING' 
            AND created_at >= NOW() - INTERVAL '24 HOURS'
        `);
        
        console.log(`🔄 Cron Job: Syncing ${pending.rows.length} pending orders from the last 24 hours...`);
        
        for (let tx of pending.rows) {
            if (!tx.provider_order_id) continue; 

            try {
                // 🛡️ IDATA SYNC
                if (tx.provider === 'idata') {
                    const statusRes = await axios.get(`https://idatagh.com/wp-json/custom/v1/order-status?order_id=${tx.provider_order_id}`, {
                        headers: { 'Authorization': `Bearer ${process.env.IDATA_API_KEY}` }, timeout: 5000 
                    });

                    if (statusRes.data.status === 'success') {
                        const orderStatus = statusRes.data.order_status;
                        if (orderStatus === 'Completed' || orderStatus === 'Successful') {
                            await db.query("UPDATE transactions SET status = 'SUCCESS' WHERE id = $1", [tx.id]);
                            console.log(`✅ Sync: iData Transaction ${tx.id} marked as SUCCESS.`);
                        } else if (orderStatus === 'Failed' || orderStatus === 'Cancelled') {
                            await db.query("UPDATE transactions SET status = 'FAILED' WHERE id = $1", [tx.id]);
                            if (tx.platform === 'APP' || tx.platform === 'WHATSAPP') {
                                await db.query("UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone_number = $2", [tx.amount, tx.user_phone]);
                                console.log(`❌ Sync: iData Transaction ${tx.id} failed. Refunded GHS ${tx.amount}.`);
                            }
                        }
                    }
                } 
                // 🛡️ NEW: SWIFTDATA SYNC
                else if (tx.provider === 'swiftdata') {
                    const statusRes = await axios.get(`https://ihrvvniomtoofrjkmalb.supabase.co/functions/v1/api/v1/orders/${tx.provider_order_id}`, {
                        headers: { 'Authorization': `Bearer ${process.env.SWIFTDATA_API_KEY}` }, timeout: 5000 
                    });

                    if (statusRes.data.success) {
                        const orderStatus = statusRes.data.order?.status; // 'pending', 'processing', 'completed', 'failed'
                        if (orderStatus === 'completed') {
                            await db.query("UPDATE transactions SET status = 'SUCCESS' WHERE id = $1", [tx.id]);
                            console.log(`✅ Sync: SwiftData Transaction ${tx.id} marked as SUCCESS.`);
                        } else if (orderStatus === 'failed') {
                            await db.query("UPDATE transactions SET status = 'FAILED' WHERE id = $1", [tx.id]);
                            if (tx.platform === 'APP' || tx.platform === 'WHATSAPP') {
                                await db.query("UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone_number = $2", [tx.amount, tx.user_phone]);
                                console.log(`❌ Sync: SwiftData Transaction ${tx.id} failed. Refunded GHS ${tx.amount}.`);
                            }
                        }
                    }
                }

            } catch (err) { 
                console.error(`⚠️ Error syncing transaction ${tx.id} (${tx.provider}):`, err.message); 
            }
        }

        // 2. AUTO-CLEANUP: Fail and refund orders stuck in processing for MORE than 24 hours
        const cleanup = await db.query(`
            UPDATE transactions 
            SET status = 'FAILED' 
            WHERE status = 'PROCESSING' 
            AND created_at < NOW() - INTERVAL '24 HOURS'
            RETURNING id, user_phone, amount, platform
        `);

        if (cleanup.rows.length > 0) {
            console.log(`🧹 Auto-Cleanup: Found ${cleanup.rows.length} expired processing transactions.`);
            for (let expiredTx of cleanup.rows) {
                // Only refund wallet payments
                if (expiredTx.platform === 'APP' || expiredTx.platform === 'WHATSAPP') {
                    await db.query("UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone_number = $2", [expiredTx.amount, expiredTx.user_phone]);
                    console.log(`🕒 Expired: Transaction ${expiredTx.id} automatically refunded (GHS ${expiredTx.amount}).`);
                }
            }
        }

    } catch (err) { 
        console.error("🔴 Cron Database Error:", err.message); 
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
