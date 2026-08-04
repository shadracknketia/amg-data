// providers.js
const axios = require('axios');
const { db } = require('./helpers');

// --- TESTING OVERRIDE ---
const FORCE_PROVIDER = null; // Keep this as swiftdata to test the new API

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
        // 🔄 NEW: SwiftData Buy Endpoint
        url: 'https://ihrvvniomtoofrjkmalb.supabase.co/functions/v1/api/v1/buy-data',
        key: process.env.SWIFTDATA_API_KEY
    }
];

let currentIndex = 0;

async function sendDataRoundRobin(network, phone, plan_id, plan_volume_mb, swiftdata_plan_id) {
    let provider = FORCE_PROVIDER ? providers.find(p => p.name === FORCE_PROVIDER) : providers[currentIndex];
    if (!FORCE_PROVIDER) currentIndex = (currentIndex + 1) % providers.length;

    console.log(`🚀 Primary Provider Assigned: ${provider.name}`);

    try {
        let result = await executeProviderCall(provider, network, phone, plan_id, plan_volume_mb, swiftdata_plan_id);
        if (result && result.success) return result;

        console.warn(`⚠️ ${provider.name} returned logical failure. Initiating failover...`);
        return await tryFallback(network, phone, plan_id, plan_volume_mb, swiftdata_plan_id, provider.name);
    } catch (err) {
        console.error(`🔴 ${provider.name} crashed. Initiating failover...`);
        return await tryFallback(network, phone, plan_id, plan_volume_mb, swiftdata_plan_id, provider.name);
    }
}

async function tryFallback(network, phone, plan_id, plan_volume_mb, swiftdata_plan_id, failedProviderName) {
    const backupProviders = providers.filter(p => p.name !== failedProviderName);
    for (let backup of backupProviders) {
        console.log(`🔄 Failover to: ${backup.name}`);
        try {
            let result = await executeProviderCall(backup, network, phone, plan_id, plan_volume_mb, swiftdata_plan_id);
            if (result && result.success) return result;
        } catch (e) {
            console.error(`🔴 Backup ${backup.name} crashed.`);
        }
    }
    return { success: false, error: "All providers failed." };
}

async function executeProviderCall(provider, network, phone, plan_id, plan_volume_mb, swiftdata_plan_id) {
    if (provider.name === 'hubnet') {
        const netMap = { 'mtn': 'mtn', 'telecel': 'telecel', 'at': 'at' };
        const url = `${provider.base_url}${netMap[network.toLowerCase()] || 'mtn'}-new-transaction`;
        try {
            const res = await axios.post(url, {
                phone: phone, volume: (plan_volume_mb || 1000).toString(), reference: 'TCX-' + Date.now() 
            }, { headers: { 'token': `Bearer ${provider.key}`, 'Content-Type': 'application/json' } });
            return { success: res.data.message === '0000', provider: 'hubnet', order_id: res.data.transaction_id };
        } catch (err) { throw err; }

    } else if (provider.name === 'swiftdata') {
        // 🔄 NEW: SwiftData Logic
        // 1. Map Network
        let swiftNet = 'yello'; // Default to MTN
        const netLower = network.toLowerCase();
        if (netLower.includes('telecel') || netLower.includes('vod')) swiftNet = 'telecel';
        if (netLower.includes('at') || netLower.includes('airtel')) swiftNet = 'at_ishare';
        
        // 2. Convert MB to GB (e.g., 1000 MB -> 1 GB, 500 MB -> 0.5 GB)
        const sizeGb = (plan_volume_mb || 1000) / 1000;

        try {
            const res = await axios.post(provider.url, {
                phone: phone,
                network: swiftNet,
                size_gb: sizeGb,
                reference: 'SD-' + Date.now()
            }, { 
                headers: { 
                    'Authorization': `Bearer ${provider.key}`,
                    'Content-Type': 'application/json'
                } 
            });
            
            return { 
                success: res.data.success === true, 
                provider: 'swiftdata', 
                order_id: res.data.order?.reference 
            };
        } catch (err) {
            console.error(`[SWIFTDATA ERROR]`, err.response?.data || err.message);
            throw err;
        }

    } else {
        // iData
        try {
            let net = network.toLowerCase();
            if (net === 'at') net = 'airteltigo'; 
            const res = await axios.post(provider.url, {
                "network": net, "beneficiary": phone, "pa_data-bundle-packages": plan_id.toString(), "webhook": "https://amg-data-api.duckdns.org/api/idata-webhook" 
            }, { headers: { 'Authorization': `Bearer ${provider.key}` } });
            return { success: res.data.status === 'success', provider: 'idata', order_id: res.data.order_id };
        } catch (err) { throw err; }
    }
}

module.exports = { sendDataRoundRobin };