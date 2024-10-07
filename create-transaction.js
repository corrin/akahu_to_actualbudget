const path = require('path');
const dotenv = require('dotenv');
const os = require('os');

// Load .env from home directory
dotenv.config({ path: path.join(os.homedir(), '.env') });

const api = require('@actual-app/api');

async function importDummyTransactions() {
    // Validate environment variables
    const requiredEnvVars = ['ACTUAL_SERVER_URL', 'ACTUAL_PASSWORD', 'ACTUAL_SYNC_ID'];
    for (const envVar of requiredEnvVars) {
        if (!process.env[envVar]) {
            throw new Error(`Missing required environment variable: ${envVar}`);
        }
    }

    console.log('Environment variables loaded successfully');

    try {
        // Initialize the API
        await api.init({
            dataDir: '/tmp/actual-data',
            serverURL: process.env.ACTUAL_SERVER_URL,
            password: process.env.ACTUAL_PASSWORD,
            budgetId: process.env.ACTUAL_SYNC_ID
        });

        console.log('API initialized');

        // Download and load the budget
        await api.downloadBudget(process.env.ACTUAL_SYNC_ID);
        console.log('Budget downloaded');

        // Fetch accounts
        const accounts = await api.getAccounts();
        console.log(`Found ${accounts.length} accounts`);

        // Find an open, on-budget account
        const account = accounts.find(acc => !acc.closed && !acc.offbudget);

        if (!account) {
            throw new Error('No open, on-budget account found');
        }

        console.log(`Using account: ${account.name} (${account.id})`);

        // Create dummy transactions
        const dummyTransactions = [
            {
                date: '2023-08-15',
                amount: -5000,  // Amount in cents, negative for expense
                payee_name: 'Dummy Expense',
                notes: 'Test transaction 1 created via API',
                imported_id: 'dummy1'  // Unique identifier to prevent duplicates
            },
            {
                date: '2023-08-16',
                amount: 10000,  // Amount in cents, positive for income
                payee_name: 'Dummy Income',
                notes: 'Test transaction 2 created via API',
                imported_id: 'dummy2'  // Unique identifier to prevent duplicates
            }
        ];

        console.log('Attempting to import transactions:', dummyTransactions);

        const result = await api.importTransactions(account.id, dummyTransactions);
        console.log('Import result:', result);

        // Close the connection
        await api.shutdown();
    } catch (error) {
        console.error('Error:', error.message);
        if (error.meta) {
            console.error('Error metadata:', error.meta);
        }
    }
}

importDummyTransactions().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
});