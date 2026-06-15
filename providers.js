// providers.js
const axios = require('axios');
const { db } = require('./helpers');

// --- TESTING OVERRIDE ---
// Set to 'swiftdata', 'hubnet', or 'idata' to force testing a specific provider.
// Leave as null for normal Load Balancing.
const FORCE_PROVIDER = null; 

// --- PROVIDERS LIST ---
const providers = [
    { 
        name: 'idata', 
        url: 'https://idatagh.com/wp-json/custom/v1/place-order', 
        key: process.env.IDATA_API_KEY 
    },
    { 
        name: 'hubnet', 
        base_url: 'https://console.hubnet.app/live/api/context/business/transaction/',
        key: process.env.HUBNET_API_KEY 
    },
    {
        name: 'swiftdata',
        url: 'https://lsocdjpflecduumopijn.supabase.co/functions/v1/developer-api/payment/data',
        key: process.env.SWIFTDATA_API_KEY
    }
];

// Main Router (Round Robin)
let currentIndex = 0;

async function sendDataRoundRobin(network, phone, plan_id, plan_volume_mb, swiftdata_plan_id) {
    let provider = FORCE_PROVIDER ? providers.find(p => p.name === FORCE_PROVIDER) : providers[currentIndex];
    if (!FORCE_PROVIDER) currentIndex = (currentIndex + 1) % providers.length;

    console.log(`🚀 Primary Provider Assigned: ${provider.name}`);

    try {
        let result = await executeProviderCall(provider, network, phone, plan_id, plan_volume_mb, swiftdata_plan_id);
        
        if (result && result.success) return result;

        console.warn(`⚠️ ${provider.name} returned logical failure. Initiating failover...`);
        return await tryFallback(network, phone, plan_id, plan_volume_mb, provider.name);
    } catch (err) {
        console.error(`🔴 ${provider.name} crashed. Initiating failover...`);
        return await tryFallback(network, phone, plan_id, plan_volume_mb, provider.name);
    }
}

// --- MULTI-PROVIDER FAILOVER LOOP ---
async function tryFallback(network, phone, plan_id, plan_volume_mb, swiftdata_plan_id, failedProviderName) {
    const backupProviders = providers.filter(p => p.name !== failedProviderName);
    for (let backup of backupProviders) {
        try {
            let result = await executeProviderCall(backup, network, phone, plan_id, plan_volume_mb, swiftdata_plan_id);
            if (result && result.success) return result;
            
            console.warn(`⚠️ Backup ${backup.name} failed too. Trying next...`);
        } catch (e) {
            console.error(`🔴 Backup ${backup.name} crashed.`);
        }
    }
    
    return { success: false, error: "All providers failed (iData, Hubnet, & SwiftData offline)." };
}

// --- CORE API EXECUTION LOGIC ---
async function executeProviderCall(provider, network, phone, plan_id, plan_volume_mb, swiftdata_plan_id) {
    if (provider.name === 'hubnet') {
        const netMap = { 'mtn': 'mtn', 'telecel': 'telecel', 'at': 'at' };
        const url = `${provider.base_url}${netMap[network.toLowerCase()] || 'mtn'}-new-transaction`;
        
        try {
            const res = await axios.post(url, {
                phone: phone, 
                volume: plan_volume_mb.toString(), 
                reference: 'TCX-' + Date.now() 
            }, { headers: { 'token': `Bearer ${provider.key}`, 'Content-Type': 'application/json' } });
            
            return { success: res.data.message === '0000', provider: 'hubnet', order_id: res.data.transaction_id };
        } catch (err) {
            console.error(`[HUBNET ERROR]`, err.response?.data || err.message);
            throw err;
        }

    } else if (provider.name === 'swiftdata') {
        const idempotencyKey = 'SD-' + Date.now() + Math.floor(Math.random() * 1000);
        
        try {
            const res = await axios.post(provider.url, {
                // Use the new SwiftData ID. If it's null in DB, fallback to normal plan_id just in case
                package_id: swiftdata_plan_id || plan_id.toString(), 
                phone: phone,
                request_id: idempotencyKey
            }, { 
                headers: { 
                    'Authorization': `Bearer ${provider.key}`,
                    'X-Idempotency-Key': idempotencyKey,
                    'Content-Type': 'application/json'
                } 
            });
            
            return { success: res.data.success === true, provider: 'swiftdata', order_id: res.data.order_id };
        } catch (err) {
            console.error(`[SWIFTDATA ERROR]`, err.response?.data || err.message);
            throw err;
        }

    } else {
        // iData Logic
        try {
            let net = network.toLowerCase();
            if (net === 'at') net = 'airteltigo'; // iData specific network name formatting
            
            const res = await axios.post(provider.url, {
                "network": net,
                "beneficiary": phone,
                "pa_data-bundle-packages": plan_id.toString(),
                "webhook": "https://amg-data-api.duckdns.org/payment/webhook" 
            }, { headers: { 'Authorization': `Bearer ${provider.key}` } });
            
            return { success: res.data.status === 'success', provider: 'idata', order_id: res.data.order_id };
        } catch (err) {
            console.error(`[IDATA ERROR]`, err.response?.data || err.message);
            throw err;
        }
    }
}

module.exports = { sendDataRoundRobin };