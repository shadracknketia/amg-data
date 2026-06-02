// redisClient.js
const { createClient } = require('redis');
const client = createClient(); 

client.on('error', (err) => console.error('Redis Client Error', err));
client.connect();

const setState = async (key, value) => {
    await client.setEx(`state:${key}`, 1800, JSON.stringify(value));
};

const getState = async (key) => {
    const data = await client.get(`state:${key}`);
    return data ? JSON.parse(data) : null;
};

const clearState = async (key) => {
    await client.del(`state:${key}`);
};

// --- NEW: SPAM & DOUBLE-SPEND PROTECTION ---
const setLock = async (key, ttl_seconds = 15) => {
    // Tries to set a lock. If it already exists (user is spamming), it returns false.
    const result = await client.set(`lock:${key}`, 'locked', {
        EX: ttl_seconds,
        NX: true
    });
    return result === 'OK';
};

const releaseLock = async (key) => {
    await client.del(`lock:${key}`);
};

// --- NEW: RECIPIENT COOLDOWN ---
// Locks a specific phone number for a few minutes to prevent Telco Spam
const setRecipientCooldown = async (recipientPhone, minutes = 5) => {
    const result = await client.set(`cooldown:${recipientPhone}`, 'active', {
        EX: minutes * 60, // Convert minutes to seconds
        NX: true          // Only set if it doesn't already exist
    });
    return result === 'OK'; // Returns true if safe to proceed, false if cooling down
};

module.exports = { setState, getState, clearState, setLock, releaseLock, setRecipientCooldown };