const dotenv = require('dotenv');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const api = require('@actual-app/api');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

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
        console.log('Actual API initialized successfully');
    } catch (error) {
        console.error(`Error during Actual API initialization: ${error.message}`);
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