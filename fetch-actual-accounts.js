const dotenv = require('dotenv');
const path = require('path');
const os = require('os');

// Load .env from home directory
dotenv.config({ path: path.join(os.homedir(), '.env') });

const api = require('@actual-app/api');

async function fetchActualAccounts() {
    console.log('Fetching Actual Budget accounts...');
    console.log('Server URL:', process.env.ACTUAL_SERVER_URL);
    console.log('Sync ID:', process.env.ACTUAL_SYNC_ID);

    try {
        // Initialize the API
        console.log('Initializing API...');
        await api.init({
            dataDir: '/tmp/actual-data',
            serverURL: process.env.ACTUAL_SERVER_URL,
            password: process.env.ACTUAL_PASSWORD,
            budgetId: process.env.ACTUAL_SYNC_ID,
        });

        console.log('API initialized successfully');

        // Download and load the budget
        console.log('Attempting to download budget...');
        await api.downloadBudget(process.env.ACTUAL_SYNC_ID);
        console.log('Budget downloaded successfully');

        // Fetch accounts
        console.log('Fetching accounts...');
        const accounts = await api.getAccounts();
        
        console.log(`Retrieved ${accounts.length} accounts:`);
        accounts.forEach(account => {
            console.log(`- Name: ${account.name}`);
            console.log(`  ID: ${account.id}`);
            console.log(`  Type: ${account.offbudget ? 'Off Budget' : 'On Budget'}`);
            console.log(`  Account Number: ${account.account_id || 'N/A'}`);
            console.log('---');
        });

        // Close the connection
        await api.shutdown();
    } catch (error) {
        console.error('An error occurred:', error.message);
        if (error.meta) {
            console.error('Error metadata:', error.meta);
        }
        if (error.stack) {
            console.error('Error stack:', error.stack);
        }
    }
}

fetchActualAccounts().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
});