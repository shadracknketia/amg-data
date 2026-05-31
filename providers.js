// providers.js
const axios = require('axios');

const providers = [
    { 
        name: 'idata', 
        url: 'https://idatagh.com/wp-json/custom/v1/place-order', 
        key: process.env.IDATA_API_KEY 
    },
    { 
        name: 'datamart', 
        url: 'https://api.datamartgh.shop/v1/purchase', // Ensure this is their live endpoint
        key: process.env.DATAMART_API_KEY 
    }
];

// Helper to format the payload correctly for each provider's unique API structure
function formatPayload(providerName, network, phone, plan_id) {
    let net = network.toLowerCase();
    if (providerName === 'idata') {
        if (net === 'at') net = 'airteltigo';
        return {
            "network": net,
            "beneficiary": phone,
            "pa_data-bundle-packages": plan_id
        };
    } else if (providerName === 'datamart') {
        return {
            "network": net,
            "phone": phone,
            "plan": plan_id
        };
    }
    return {};
}

// Main Router (Round Robin)
let currentIndex = 0;

async function sendDataRoundRobin(network, phone, plan_id) {
    const provider = providers[currentIndex];
    currentIndex = (currentIndex + 1) % providers.length; // Rotate index

    console.log(`🚀 Round Robin: Selected primary provider -> ${provider.name}`);

    try {
        const payload = formatPayload(provider.name, network, phone, plan_id);
        
        const response = await axios.post(provider.url, payload, {
            headers: { 
                'Authorization': `Bearer ${provider.key}`,
                'Content-Type': 'application/json'
            }
        });

        // STRICT CHECK: Only return success if status is explicitly 'success' [1.2.6]
        if (response.data && (response.data.status === 'success' || response.data.code === '0000')) {
            return { success: true, order_id: response.data.order_id, provider: provider.name };
        } else {
            console.warn(`⚠️ Primary ${provider.name} returned logical error:`, response.data.message || "Unknown");
            return await tryFallback(providers, network, phone, plan_id, provider.name);
        }
    } catch (err) {
        console.error(`🔴 Primary ${provider.name} failed physically:`, err.message);
        return await tryFallback(providers, network, phone, plan_id, provider.name);
    }
}

// Fallback loop (Skips the one that just failed)
async function tryFallback(list, network, phone, plan_id, failedProviderName) {
    for (let p of list) {
        if (p.name === failedProviderName) continue; // Skip the failed one

        try {
            console.log(`🔄 Failover: Attempting backup provider -> ${p.name}`);
            const payload = formatPayload(p.name, network, phone, plan_id);

            const response = await axios.post(p.url, payload, {
                headers: { 
                    'Authorization': `Bearer ${p.key}`,
                    'Content-Type': 'application/json'
                }
            });

            // STRICT CHECK IN FALLBACK [1.2.6]
            if (response.data && (response.data.status === 'success' || response.data.code === '0000')) {
                return { success: true, order_id: response.data.order_id, provider: p.name };
            } else {
                console.warn(`⚠️ Backup ${p.name} returned logical error:`, response.data.message || "Unknown");
            }
        } catch (e) { 
            console.error(`🔴 Backup ${p.name} failed physically:`, e.message);
            continue; 
        }
    }
    return { success: false, error: "All data providers failed." };
}

module.exports = { sendDataRoundRobin };