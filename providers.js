// providers.js
const axios = require('axios');

const providers = [
    { 
        name: 'idata', 
        url: 'https://idatagh.com/wp-json/custom/v1/place-order', 
        key: process.env.IDATA_API_KEY 
    },
    { 
        name: 'hubnet', 
        // Hubnet URL is dynamic, we will handle the network part in formatPayload or dynamically
        base_url: 'https://console.hubnet.app/live/api/context/business/transaction/',
        key: process.env.HUBNET_API_KEY 
    }
];

// Helper to format the payload correctly
function formatPayload(providerName, network, phone, plan_id, plan_volume_mb) {
    let net = network.toLowerCase();
    
    if (providerName === 'idata') {
        if (net === 'at') net = 'airteltigo';
        return {
            "network": net,
            "beneficiary": phone,
            "pa_data-bundle-packages": plan_id.toString(), 
            "webhook": "https://amg-data-api.duckdns.org/payment/webhook" 
        };
    } 
    
    if (providerName === 'hubnet') {
        // Hubnet requires volume in MB (e.g., 2000 for 2GB)
        return {
            "phone": phone,
            "volume": plan_volume_mb.toString(),
            "reference": 'TCX-' + Math.random().toString(36).substring(2, 15).toUpperCase()
        };
    }
    return {};
}

// Main Router (Round Robin)
let currentIndex = 0;

async function sendDataRoundRobin(network, phone, plan_id, plan_volume_mb) {
    // 1. ALWAYS rotate, regardless of success or failure
    const provider = providers[currentIndex];
    currentIndex = (currentIndex + 1) % providers.length; 

    console.log(`🚀 Primary Provider Assigned: ${provider.name}`);

    try {
        let result = await executeProviderCall(provider, network, phone, plan_id, plan_volume_mb);

        if (result.success) {
            return result; 
        } else {
            console.warn(`⚠️ ${provider.name} failed. Attempting backup...`);
            // If the "assigned" provider fails, we try the other one immediately
            return await tryFallback(network, phone, plan_id, plan_volume_mb, provider.name);
        }
    } catch (err) {
        console.error(`🔴 ${provider.name} crashed. Attempting backup...`);
        return await tryFallback(network, phone, plan_id, plan_volume_mb, provider.name);
    }
}

async function executeProviderCall(provider, network, phone, plan_id, plan_volume_mb) {
    if (provider.name === 'hubnet') {
        const netMap = { 'mtn': 'mtn', 'telecel': 'telecel', 'at': 'at' };
        const url = `${provider.base_url}${netMap[network.toLowerCase()] || 'mtn'}-new-transaction`;
        const res = await axios.post(url, {
            phone: phone, 
            volume: plan_volume_mb.toString(), 
            reference: 'TCX-' + Date.now() 
        }, { headers: { 'token': `Bearer ${provider.key}` } });
        return { success: res.data.message === '0000', provider: 'hubnet', order_id: res.data.transaction_id };
    } else {
        // iData Logic
        const res = await axios.post(provider.url, {
            "network": network,
            "beneficiary": phone,
            "pa_data-bundle-packages": plan_id.toString()
        }, { headers: { 'Authorization': `Bearer ${provider.key}` } });
        return { success: res.data.status === 'success', provider: 'idata', order_id: res.data.order_id };
    }
}

// Fallback loop
async function tryFallback(list, network, phone, plan_id, plan_volume_mb, failedProviderName) {
    for (let p of list) {
        if (p.name === failedProviderName) continue;
        
        try {
            let url = p.url || `${p.base_url}${network.toLowerCase()}-new-transaction`;
            const payload = formatPayload(p.name, network, phone, plan_id, plan_volume_mb);

            const response = await axios.post(url, payload, {
                headers: { 'Authorization': `Bearer ${p.key}`, 'token': `Bearer ${p.key}`, 'Content-Type': 'application/json' }
            });

            if (response.data && (response.data.status === 'success' || response.data.code === '0000' || response.data.message === '0000')) {
                return { success: true, order_id: response.data.order_id || response.data.transaction_id, provider: p.name };
            }
        } catch (e) { continue; }
    }
    return { success: false, error: "All providers failed." };
}

module.exports = { sendDataRoundRobin };