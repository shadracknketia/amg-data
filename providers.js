// providers.js
const axios = require('axios');

// 1. LIST YOUR PROVIDERS HERE
const providerList =[
    { name: 'idata', url: 'https://idatagh.com/wp-json/custom/v1/place-order', key: process.env.IDATA_API_KEY },
    { name: 'datamart', url: 'https://api.datamartgh.shop/v1/purchase', key: process.env.DATAMART_API_KEY },
    // You can add more here later
];

let currentIndex = 0; // The "pointer" to rotate providers

async function sendDataRoundRobin(network, phone, plan_id) {
    // 2. ROTATE: Move to the next provider for every request
    const provider = providerList[currentIndex];
    currentIndex = (currentIndex + 1) % providerList.length; // Flips 0, 1, 0, 1...

    console.log(`🚀 Routing request to provider: ${provider.name}`);

    try {
        const response = await axios.post(provider.url, 
            { "network": network, "beneficiary": phone, "pa_data-bundle-packages": plan_id },
            { headers: { 'Authorization': `Bearer ${provider.key}` } }
        );
        if (response.data.status === 'success') {
            return { success: true, order_id: response.data.order_id, provider: provider.name };
        }
    } catch (err) {
        console.error(`🔴 Provider ${provider.name} failed!`);
        
        // 3. FAILOVER: If the chosen one fails, try the OTHERS immediately
        return await tryFallback(providerList, network, phone, plan_id);
    }
}

async function tryFallback(list, network, phone, plan_id) {
    for (let p of list) {
        try {
            console.log(`🔄 Attempting failover to: ${p.name}`);
            const response = await axios.post(p.url, { 
                "network": network, 
                "beneficiary": phone, 
                "pa_data-bundle-packages": plan_id 
            }, { headers: { 'Authorization': `Bearer ${p.key}` } });
            
            // Return success with provider name!
            return { success: true, order_id: response.data.order_id, provider: p.name };
        } catch (e) { 
            console.error(`🔴 Fallback ${p.name} failed too.`);
            continue; 
        }
    }
    return { success: false, error: "All providers exhausted." };
}

module.exports = { sendDataRoundRobin };