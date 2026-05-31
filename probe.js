// probe.js
const axios = require('axios');
require('dotenv').config();

async function probe() {
    const KEY = process.env.IDATA_API_KEY;
    const URL = 'https://idatagh.com/wp-json/custom/v1/place-order';
    
    // We send a hardcoded request to see if it works
    const payload = {
        "network": "mtn",
        "beneficiary": "0241963319",
        "pa_data-bundle-packages": 10497
    };

    console.log("SENDING TO:", URL);
    console.log("PAYLOAD:", JSON.stringify(payload));

    try {
        const response = await axios.post(URL, payload, {
            headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' }
        });
        console.log("SUCCESS:", response.data);
    } catch (err) {
        console.error("FULL ERROR:", JSON.stringify(err.response?.data, null, 2));
    }
}
probe();