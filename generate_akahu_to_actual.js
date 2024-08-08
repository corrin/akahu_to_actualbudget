const dotenv = require('dotenv');
const path = require('path');
const os = require('os');
const { AkahuClient } = require('akahu');
const api = require('@actual-app/api');

// Load environment variables from .env file
dotenv.config({ path: path.join(os.homedir(), '.env') });

// Helper function for verbose logging
function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}

async function listAkahuAccounts() {
    try {
        if (!process.env.AKAHU_APP_TOKEN || !process.env.AKAHU_USER_TOKEN) {
            throw new Error('Akahu API credentials are missing in the environment variables.');
        }

        log('Initializing Akahu Client...');
        const client = new AkahuClient({
            appToken: process.env.AKAHU_APP_TOKEN,
        });

        log('Fetching Akahu accounts...');
        const response = await client.accounts.list(process.env.AKAHU_USER_TOKEN);

        if (!response || !response.items) {
            throw new Error('Invalid response received from Akahu API.');
        }

        log(`Retrieved ${response.items.length} Akahu account(s).`);
        return response.items;
    } catch (error) {
        console.error('Error fetching Akahu accounts:', error.message);
        return [];
    }
}

async function fetchActualAccounts() {
    try {
        const requiredEnvVars = ['ACTUAL_SERVER_URL', 'ACTUAL_PASSWORD', 'ACTUAL_SYNC_ID'];
        for (const varName of requiredEnvVars) {
            if (!process.env[varName]) {
                throw new Error(`Environment variable ${varName} is missing.`);
            }
        }

        log('Initializing Actual API...');
        await api.init({
            dataDir: '/tmp/actual-data',
            serverURL: process.env.ACTUAL_SERVER_URL,
            password: process.env.ACTUAL_PASSWORD,
            budgetId: process.env.ACTUAL_SYNC_ID,
        });

        log('Downloading Actual budget...');
        await api.downloadBudget(process.env.ACTUAL_SYNC_ID);

        log('Fetching Actual accounts...');
        const accounts = await api.getAccounts();

        if (!Array.isArray(accounts)) {
            throw new Error('Invalid accounts data received from Actual API.');
        }

        log(`Retrieved ${accounts.length} Actual account(s).`);

        await api.shutdown();
        return accounts;
    } catch (error) {
        console.error('Error fetching Actual accounts:', error.message);
        return [];
    }
}

function mapAccounts(akahuAccounts, actualAccounts) {
    const mappedAccounts = [];
    const akahuAccountNames = akahuAccounts.map(acc => acc.name);
    const actualAccountNames = actualAccounts.map(acc => acc.name);

    // Mapping Akahu accounts
    for (const akahuAccount of akahuAccounts) {
        const matchingActualAccount = actualAccounts.find(
            actualAccount => actualAccount.name === akahuAccount.name
        );

        if (matchingActualAccount) {
            mappedAccounts.push({
                actual_budget_name: matchingActualAccount.budget_name || null,
                actual_account_name: matchingActualAccount.name,
                account_type: matchingActualAccount.offbudget ? 'Tracking' : 'On Budget',
                akahu_name: akahuAccount.name,
                akahu_id: akahuAccount._id,
                actual_budget_id: matchingActualAccount.budget_id || null,
                actual_account_id: matchingActualAccount.id,
                note: null
            });
        } else {
            mappedAccounts.push({
                akahu_name: akahuAccount.name,
                akahu_id: akahuAccount._id,
                note: 'No matching Actual account found.'
            });
        }
    }

    // Mapping Actual accounts without matching Akahu accounts
    for (const actualAccount of actualAccounts) {
        if (!akahuAccountNames.includes(actualAccount.name)) {
            mappedAccounts.push({
                actual_budget_name: actualAccount.budget_name || null,
                actual_account_name: actualAccount.name,
                account_type: actualAccount.offbudget ? 'Tracking' : 'On Budget',
                actual_budget_id: actualAccount.budget_id || null,
                actual_account_id: actualAccount.id,
                note: 'No matching Akahu account found.'
            });
        }
    }

    return mappedAccounts;
}

(async () => {
    try {
        log('Starting account mapping process...');

        const akahuAccounts = await listAkahuAccounts();
        const actualAccounts = await fetchActualAccounts();

        if (akahuAccounts.length === 0 && actualAccounts.length === 0) {
            throw new Error('No accounts retrieved from either Akahu or Actual APIs.');
        }

        const mappedAccounts = mapAccounts(akahuAccounts, actualAccounts);

        log('Account mapping completed. Outputting JSON:');
        console.log(JSON.stringify(mappedAccounts, null, 2));
    } catch (error) {
        console.error('Fatal error:', error.message);
        process.exit(1);
    }
})();
