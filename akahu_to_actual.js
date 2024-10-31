const { AkahuClient } = require('akahu');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const api = require('@actual-app/api');

dotenv.config({ path: path.join(__dirname, '.env') });

const SYNC_TIMESTAMPS_FILE = 'akahu_sync_timestamps.json';
const DEFAULT_START_DATE = '2024-08-01T00:00:00.000Z';

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

const requiredEnvVars = [
    'ACTUAL_SERVER_URL',
    'ACTUAL_PASSWORD',
    'ACTUAL_SYNC_ID',
    'ACTUAL_ENCRYPTION_KEY',
    'AKAHU_APP_TOKEN',
    'AKAHU_USER_TOKEN'
];

function checkRequiredEnvVars() {
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    if (missingVars.length > 0) {
        throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }
    log('All required environment variables are set.');
}

async function loadMapping() {
    const mappingFileName = 'akahu_to_actual_mapping.json';
    try {
        const mappingData = await fs.readFile(mappingFileName, 'utf8');
        return JSON.parse(mappingData);
    } catch (error) {
        logError(`Error loading mapping file (${mappingFileName})`, error);
        throw error;
    }
}

// Akahu-related functions
async function fetchAkahuAccounts(client, userToken) {
    log('Starting to fetch Akahu accounts');
    const startTime = Date.now();
    try {
        const accounts = await client.accounts.list(userToken);
        log(`Fetched ${accounts.length} Akahu accounts in ${Date.now() - startTime}ms`);
        accounts.forEach(account => {
            log(`  ${account.name} (Akahu ID: ${account._id})`);
        });
        return new Map(accounts.map(account => [account._id, account]));
    } catch (error) {
        logError('Error fetching Akahu accounts', error);
        throw error;
    }
}

async function fetchAkahuTransactions(client, userToken, accountId, startDate) {
    log(`Fetching transactions for account ${accountId} from ${startDate}`);
    try {
        let allTransactions = [];
        let nextCursor = undefined;
        do {
            const response = await client.accounts.listTransactions(userToken, accountId, {
                start: startDate,
                cursor: nextCursor,
            });
            if (!response.items || !Array.isArray(response.items)) {
                throw new Error('Unexpected response format from Akahu API');
            }
            allTransactions = allTransactions.concat(response.items);
            nextCursor = response.cursor ? response.cursor.next : null;
            log(`Fetched ${response.items.length} transactions, total so far: ${allTransactions.length}`);
        } while (nextCursor !== null);
        log(`Fetched ${allTransactions.length} transactions in total for account ${accountId}`);
        return allTransactions;
    } catch (error) {
        logError(`Error fetching Akahu transactions for account ${accountId}`, error);
        throw error;
    }
}

// Actual-related functions
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
        return api;
    } catch (error) {
        logError('Error during Actual API initialization', error);
        throw error;
    }
}

async function ensureBudgetLoaded() {
    try {
        const encryptionKey = process.env.ACTUAL_ENCRYPTION_KEY;
        if (!encryptionKey) {
            throw new Error("Encryption key not provided");
        }
        await api.downloadBudget(process.env.ACTUAL_SYNC_ID, { password: encryptionKey });
        log('Budget downloaded successfully');
    } catch (error) {
        logError('Error downloading budget', error);
        throw error;
    }
}

async function fetchActualAccounts() {
    try {
        log('Fetching Actual accounts...');
        const allAccounts = await api.getAccounts();
        const openAccounts = allAccounts.filter(account => !account.closed);
        log(`Fetched ${openAccounts.length} open Actual accounts`);
        openAccounts.forEach(account => {
            log(`  ${account.name} (Actual ID: ${account.id})`);
        });
        return openAccounts;
    } catch (error) {
        logError('Error fetching Actual accounts', error);
        throw error;
    }
}

async function getActualAccountBalance(actualAccountID) {
    try {
        return await api.getAccountBalance(actualAccountID);
    } catch (error) {
        logError(`Error fetching balance for account ${actualAccountID}`, error);
        throw error;
    }
}

// Utility functions
async function getSyncTimestamps() {
    try {
        const data = await fs.readFile(SYNC_TIMESTAMPS_FILE, 'utf8');
        if (!data.trim()) {
            log(`Sync timestamps file (${SYNC_TIMESTAMPS_FILE}) is empty.`);
            return {};
        }
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            log(`${SYNC_TIMESTAMPS_FILE} not found, creating new file.`);
            return {};
        }
        logError(`Error reading sync timestamps (${SYNC_TIMESTAMPS_FILE})`, error);
        throw error;
    }
}

async function updateSyncTimestamp(akahuAccountID, timestamp) {
    try {
        const timestamps = await getSyncTimestamps();
        timestamps[akahuAccountID] = timestamp;
        await fs.writeFile(SYNC_TIMESTAMPS_FILE, JSON.stringify(timestamps, null, 2));
    } catch (error) {
        logError('Error updating sync timestamp', error);
    }
}

function isoToShortDate(isoDate) {
    const date = new Date(isoDate);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function generateSummary(accounts, transactions) {
    return accounts.map(account => ({
        name: account.akahu_name,
        akahu_id: account.akahu_id,
        transactionCount: transactions[account.akahu_id] ? transactions[account.akahu_id].length : 0,
        totalAmount: transactions[account.akahu_id]
            ? transactions[account.akahu_id].reduce((sum, t) => sum + t.amount, 0)
            : 0
    }));
}

async function handleAccountBalanceComparison(account, akahuAccounts, actualAccounts) {
    try {
        const akahuAccount = akahuAccounts.get(account.akahu_id);
        if (!akahuAccount) {
            throw new Error(`Unable to find Akahu account info for ${account.akahu_name} (Akahu ID: ${account.akahu_id})`);
        }

        const akahuBalance = Math.round(akahuAccount.balance.current * 100);
        const actualAccount = actualAccounts.find(a => a.id === account.actual_account_id);

        if (!actualAccount) {
            throw new Error(`Unable to find Actual account for ID: ${account.actual_account_id}`);
        }

        const actualBalance = await getActualAccountBalance(actualAccount.id);

        log(`After processing Akahu balance: ${akahuBalance / 100}, Actual balance: ${actualBalance / 100}`);

        if (akahuBalance !== actualBalance) {
            log(`Balance mismatch for account ${account.akahu_name}: Akahu balance is ${akahuBalance / 100}, but Actual balance is ${actualBalance / 100}`);
        }
    } catch (error) {
        logError(`Error comparing balances for account ${account.akahu_name} (Akahu ID: ${account.akahu_id})`, error);
    }
}

async function handleTrackingAccount(account, akahuAccounts, actualAccounts) {
    log(`Handling tracking account: ${account.akahu_name} (Akahu ID: ${account.akahu_id})`);
    try {
        const akahuAccount = akahuAccounts.get(account.akahu_id);
        if (!akahuAccount) {
            throw new Error(`Unable to find Akahu account info for ${account.akahu_name} (Akahu ID: ${account.akahu_id})`);
        }

        const akahuBalance = Math.round(akahuAccount.balance.current * 100);
        const actualAccount = actualAccounts.find(a => a.id === account.actual_account_id);

        if (!actualAccount) {
            throw new Error(`Unable to find Actual account for ID: ${account.actual_account_id}`);
        }

        const actualBalance = await getActualAccountBalance(actualAccount.id);

        log(`Akahu balance: ${akahuBalance / 100}, Actual balance: ${actualBalance / 100}`);

        if (akahuBalance !== actualBalance) {
            const adjustmentAmount = akahuBalance - actualBalance;
            const transaction = [{
                date: isoToShortDate(new Date().toISOString()),
                account: account.actual_account_id,
                amount: adjustmentAmount,
                payee_name: 'Balance Adjustment',
                notes: `Adjusted from ${actualBalance / 100} to ${akahuBalance / 100} based on retrieved balance`,
                cleared: true,
            }];

            await api.importTransactions(account.actual_account_id, transaction);
            log(`Created balance adjustment transaction for ${account.akahu_name} (Akahu ID: ${account.akahu_id}): ${adjustmentAmount / 100}`);
            await handleAccountBalanceComparison(account, akahuAccounts, actualAccounts);
        } else {
            log(`No balance adjustment needed for ${account.akahu_name} (Akahu ID: ${account.akahu_id})`);
        }
    } catch (error) {
        logError(`Error handling tracking account ${account.akahu_name} (Akahu ID: ${account.akahu_id})`, error);
    }
}

async function handleOnBudgetAccount(account, akahuAccounts, actualAccounts, client, syncTimestamps) {
    log(`Processing on-budget account: ${account.akahu_name} (Akahu ID: ${account.akahu_id}, Actual ID: ${account.actual_account_id})`);

    const lastSyncDate = new Date(syncTimestamps[account.akahu_id] || DEFAULT_START_DATE);
    const startDate = new Date(lastSyncDate.getTime() - 7 * 24 * 60 * 60 * 1000);
    log(`Fetching transactions from ${isoToShortDate(startDate.toISOString())}`);

    try {
        const akahuAccount = akahuAccounts.get(account.akahu_id);
        if (akahuAccount) {
            log(`Akahu account details for ${account.akahu_name}:`);
            log(JSON.stringify(akahuAccount, null, 2));
        } else {
            log(`Warning: Akahu account not found for ID: ${account.akahu_id}`);
        }

        const akahuTransactions = await fetchAkahuTransactions(client, process.env.AKAHU_USER_TOKEN, account.akahu_id, startDate.toISOString());

        log(`Mapping ${akahuTransactions.length} transactions for ${account.akahu_name} (Akahu ID: ${account.akahu_id})`);
        const mappedTransactions = akahuTransactions.map(t => ({
            date: isoToShortDate(t.date),
            account: account.actual_account_id,
            amount: Math.round(t.amount * -100),
            payee_name: t.description,
            notes: `Akahu transaction: ${t.description}`,
            imported_id: t._id,
        }));

        if (mappedTransactions.length > 0) {
            log(`Importing ${mappedTransactions.length} transactions for account ${account.akahu_name} (Akahu ID: ${account.akahu_id}, Actual ID: ${account.actual_account_id})`);
            const importResult = await api.importTransactions(account.actual_account_id, mappedTransactions);
            log(`Import result: ${JSON.stringify(importResult, null, 2)}`);
            await handleAccountBalanceComparison(account, akahuAccounts, actualAccounts);

            log(`Updating sync timestamp for ${account.akahu_name} (Akahu ID: ${account.akahu_id})`);
            await updateSyncTimestamp(account.akahu_id, new Date().toISOString());
        } else {
            log(`No new transactions for ${account.akahu_name} (Akahu ID: ${account.akahu_id})`);
        }

        return mappedTransactions;
    } catch (error) {
        logError(`Error processing on-budget account ${account.akahu_name} (Akahu ID: ${account.akahu_id})`, error);
        return [];
    }
}

async function importTransactions() {
    const overallStartTime = Date.now();
    const transactionSummary = {};

    try {
        checkRequiredEnvVars();
        const mapping = await loadMapping();
        const syncTimestamps = await getSyncTimestamps();

        const client = new AkahuClient({
            appToken: process.env.AKAHU_APP_TOKEN,
        });

        const actualAPI = await initializeActualAPI();
        if (!actualAPI) {
            throw new Error('Failed to initialize Actual API');
        }
        log("Actual API initialized successfully");
        console.log('Available API methods:', Object.keys(actualAPI));

        await actualAPI.runMigrations();
        log('Migrations completed successfully');

        // Sync with server
        log('Syncing with server...');
        await actualAPI.sync({
          serverURL: process.env.ACTUAL_SERVER_URL,
          skipInitialDownload: false,
          mode: 'balanced'
        });
        log('Server sync completed');
        await ensureBudgetLoaded();
        log("Budget is loaded");

        const akahuAccounts = await fetchAkahuAccounts(client, process.env.AKAHU_USER_TOKEN);
        const actualAccounts = await fetchActualAccounts();

        const trackingAccounts = mapping.filter(m => m.actual_budget_id !== 'SKIP' && m.actual_budget_id !== '' && m.account_type === 'Tracking');
        const onBudgetAccounts = mapping.filter(m => m.actual_budget_id !== 'SKIP' && m.actual_budget_id !== '' && m.account_type === 'On Budget');

        log('Mapping details:');
        mapping.forEach(m => {
            log(`Akahu: ${m.akahu_name} (ID: ${m.akahu_id}), Actual ID: ${m.actual_account_id}, Type: ${m.account_type}`);
        });

        for (const account of trackingAccounts) {
            const actualAccount = actualAccounts.find(a => a.id === account.actual_account_id);
            if (!actualAccount) {
                log(`Skipping closed or non-existent tracking account: ${account.akahu_name} (Akahu ID: ${account.akahu_id}, Actual ID: ${account.actual_account_id})`);
                continue;
            }
            await handleTrackingAccount(account, akahuAccounts, actualAccounts);
        }

        for (const account of onBudgetAccounts) {
            const actualAccount = actualAccounts.find(a => a.id === account.actual_account_id);
            if (!actualAccount) {
                log(`Skipping on-budget account: ${account.akahu_name} (Akahu ID: ${account.akahu_id}, Actual ID: ${account.actual_account_id})`);
                log(`Reason: Account not found in list of open Actual accounts`);
                log(`Available Actual account IDs: ${actualAccounts.map(a => a.id).join(', ')}`);
                continue;
            }
            const transactions = await handleOnBudgetAccount(account, akahuAccounts, actualAccounts, client, syncTimestamps);
            transactionSummary[account.akahu_id] = transactions;
        }

        // Generate and log summary
        const summary = generateSummary([...trackingAccounts, ...onBudgetAccounts], transactionSummary);
        log("Import Summary:");
        summary.forEach(account => {
            log(`${account.name} (Akahu ID: ${account.akahu_id}): ${account.transactionCount} transactions, total amount: $${(account.totalAmount / 100).toFixed(2)}`);
        });

    } catch (error) {
        logError(`An error occurred during import`, error);
    } finally {
        if (api) {
            try {
                log('Shutting down Actual API');
                await api.shutdown();
                log('Actual API shutdown successfully');
            } catch (shutdownError) {
                logError(`Error during API shutdown`, shutdownError);
            }
        }
    }
    log(`Total execution time: ${(Date.now() - overallStartTime) / 1000} seconds`);
}

importTransactions().catch(error => {
    logError(`Unhandled error occurred`, error);
    process.exit(1);
});