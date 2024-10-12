const dotenv = require('dotenv');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const api = require('@actual-app/api');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

function log(message) {
    const timestamp = new Date().toISOString();
    const truncatedMessage = message.length > 2000
        ? message.substring(0, 2000) + '... (truncated)'
        : message;
    console.log(`[${timestamp}] ${truncatedMessage}`);
}

function logError(message, error) {
    log(`${message}: ${error.message}`);
    if (error.stack) {
        log(`Error stack: ${error.stack}`);
    }
}
// Function to initialize Actual API
async function initializeActualAPI() {
    try {
        const dataDir = path.join(os.tmpdir(), 'actual-data');
        await fs.mkdir(dataDir, { recursive: true });
        await api.init({
            dataDir: dataDir,
            serverURL: process.env.ACTUAL_SERVER_URL,
            password: process.env.ACTUAL_PASSWORD,
            budgetId: process.env.ACTUAL_SYNC_ID,
        });
        log('Actual API initialized successfully');

        // Attempt to sync the budget
        log('Syncing budget...');
        try {
            await api.sync();
            log('Budget synced successfully');
        } catch (syncError) {
            if (syncError.message.includes('Database is out of sync with migrations')) {
                log('Database is out of sync. This might require manual intervention.');
                log('Please ensure your local Actual app and API are up to date.');
                log('If the problem persists, you might need to create a new budget on the server.');
                throw syncError;
            } else {
                throw syncError;
            }
        }

        // Load the budget after successful sync
        await api.loadBudget(process.env.ACTUAL_SYNC_ID);
        log('Budget loaded successfully');

    } catch (error) {
        logError('Error during Actual API initialization, sync, or budget loading', error);
        throw error;
    }
}
// Function to ensure budget is loaded
async function ensureBudgetLoaded() {
    try {
        const encryptionKey = process.env.ACTUAL_ENCRYPTION_KEY;
        if (!encryptionKey) {
            throw new Error("Encryption key not provided");
        }

        await api.downloadBudget(process.env.ACTUAL_SYNC_ID, { password: encryptionKey });
        console.log('Budget downloaded successfully');
    } catch (error) {
        console.error(`Error downloading budget: ${error.message}`);
        throw error;
    }
}

// Function to fetch Actual accounts
async function fetchActualAccounts() {
    try {
        console.log('Fetching Actual accounts...');
        const allAccounts = await api.getAccounts();
        const openAccounts = allAccounts.filter(account => !account.closed);
        console.log(`Fetched ${openAccounts.length} open Actual accounts`);
        openAccounts.forEach(account => {
            console.log(`  ${account.name} (Actual ID: ${account.id})`);
        });
        return openAccounts;
    } catch (error) {
        console.error(`Error fetching Actual accounts: ${error.message}`);
        throw error;
    }
}

// Main function to run the test
async function testActualAPI() {
    try {
        await initializeActualAPI();
        await ensureBudgetLoaded();
        const accounts = await fetchActualAccounts();
        console.log('Test completed successfully');
    } catch (error) {
        console.error('Test failed:', error.message);
    } finally {
        if (api) {
            try {
                console.log('Shutting down Actual API');
                await api.shutdown();
                console.log('Actual API shutdown successfully');
            } catch (shutdownError) {
                console.error(`Error during API shutdown: ${shutdownError.message}`);
            }
        }
    }
}

// Run the test
testActualAPI();