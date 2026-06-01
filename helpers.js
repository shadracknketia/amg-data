// helpers.js
require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');

const db = new Pool({ connectionString: process.env.DATABASE_URL });

// Shared Database Helper
async function getOrCreateUser(phone) {
    let cleanPhone = phone.trim();
    if (cleanPhone.startsWith('233')) cleanPhone = '0' + cleanPhone.slice(3);

    // Ensure we select the balance explicitly
    const { rows } = await db.query('SELECT phone_number, wallet_balance, pin FROM users WHERE phone_number = $1', [cleanPhone]);
    
    if (rows.length > 0) return rows[0];

    // If new user, set balance to 0.00
    const newUser = await db.query(
        'INSERT INTO users (phone_number, wallet_balance) VALUES ($1, $2) RETURNING phone_number, wallet_balance, pin', 
        [cleanPhone, 0.00]
    );
    return newUser.rows[0];
}

// Shared Paystack Wrapper
const paystack = axios.create({
    baseURL: 'https://api.paystack.co',
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' }
});

const startPaystackPayment = async (amount, metadata) => {
    try {
        const response = await paystack.post('/transaction/initialize', {
            email: "customer@amgdata.com",
            amount: Math.round(amount * 100),
            currency: "GHS",
            metadata: metadata,
            channels: ['mobile_money', 'card']
        });
        return response.data;
    } catch (err) {
        console.error("Paystack Error:", err.response?.data || err.message);
        return null;
    }
};

module.exports = { db, getOrCreateUser, startPaystackPayment, paystack };