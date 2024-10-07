const path = require('path');
const dotenv = require('dotenv');
const os = require('os');

// Load .env from home directory
dotenv.config({ path: path.join(os.homedir(), '.env') });

const api = require('@actual-app/api');
const { Akahu } = require('akahu');

async function importAkahuTransactions() {
    // Validate environment variables
    const requiredEnvVars = ['ACTUAL_SERVER_URL', 'ACTUAL_PASSWORD', 'ACTUAL_SYNC_ID', 'AKAHU_APP_TOKEN', 'AKAHU_USER_TOKEN'];
    for (const envVar of requiredEnvVars) {
        if (!process.env[envVar]) {
            throw new Error(`Missing required environment variable: ${envVar}`);
        }
    }

    console.log('Environment variables loaded successfully');

    const akahu = new Akahu({
        appToken: process.env.AKAHU_APP_TOKEN,
        userToken: process.env.AKAHU_USER_TOKEN,
    });

    try {
        // Initialize Actual Budget API
        await api.init({
            dataDir: '/tmp/actual-data',
            serverURL: process.env.ACTUAL_SERVER_URL,
            password: process.env.ACTUAL_PASSWORD,
            budgetId: process.env.ACTUAL_SYNC_ID
        });

        console.log('Actual Budget API initialized');

        // Download and load the budget
        await api.downloadBudget(process.env.ACTUAL_SYNC_ID);
        console.log('Budget downloaded');

        // Fetch Akahu transactions (last 30 days as an example)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const akahuTransactions = await akahu.transactions.list({
            start: thirtyDaysAgo.toISOString(),
            end: new Date().toISOString()
        });

        console.log(`Fetched ${akahuTransactions.length} transactions from Akahu`);

        // Map Akahu transactions to Actual Budget format
        const formattedTransactions = akahuTransactions.map(transaction => ({
            date: transaction.date,
            amount: Math.round(transaction.amount * 100), // Convert to cents
            payee_name: transaction.description,
            notes: `Akahu transaction: ${transaction.description}`,
            imported_id: transaction.id // Use Akahu's transaction ID as the imported_id
        }));

        // Fetch Actual Budget accounts
        const accounts = await api.getAccounts();
        console.log(`Found ${accounts.length} accounts in Actual Budget`);

        // Find an open, on-budget account (you might want to adjust this logic)
        const account = accounts.find(acc => !acc.closed && !acc.offbudget);

        if (!account) {
            throw new Error('No open, on-budget account found in Actual Budget');
        }

        console.log(`Using Actual Budget account: ${account.name} (${account.id})`);

        // Import transactions into Actual Budget
        const result = await api.importTransactions(account.id, formattedTransactions);
        console.log('Import result:', result);

        // Close the Actual Budget API connection
        await api.shutdown();
    } catch (error) {
        console.error('Error:', error.message);
        if (error.meta) {
            console.error('Error metadata:', error.meta);
        }
    }
}

importAkahuTransactions().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
});