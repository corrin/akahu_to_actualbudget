const { AkahuClient } = require('akahu');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables from .env file
dotenv.config({ path: path.join(process.env.HOME, '.env') });

async function listAkahuAccounts() {
    try {
        // Log the tokens (last 4 characters only for security)
        console.log(`Using User Token: ...${process.env.AKAHU_USER_TOKEN.slice(-4)}`);
        console.log(`Using App Token: ...${process.env.AKAHU_APP_TOKEN.slice(-4)}`);

        const client = new AkahuClient({
            appToken: process.env.AKAHU_APP_TOKEN,
        });

        const response = await client.accounts.list(process.env.AKAHU_USER_TOKEN);

        console.log('Raw Akahu API Response:');
        console.log(JSON.stringify(response, null, 2));
    } catch (error) {
        console.error('Error fetching Akahu accounts:', error);
        if (error.response) {
            console.error('Response data:', JSON.stringify(error.response.data, null, 2));
            console.error('Response status:', error.response.status);
        }
    }
}

listAkahuAccounts();