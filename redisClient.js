// redisClient.js
const { createClient } = require('redis');
const client = createClient(); // Add { url: 'redis://...' } if needed

client.on('error', (err) => console.error('Redis Client Error', err));
client.connect();

const setState = async (key, value) => {
    // Stores state for 30 minutes, then auto-deletes
    await client.setEx(`state:${key}`, 1800, JSON.stringify(value));
};

const getState = async (key) => {
    const data = await client.get(`state:${key}`);
    return data ? JSON.parse(data) : null;
};

const clearState = async (key) => {
    await client.del(`state:${key}`);
};

module.exports = { setState, getState, clearState };