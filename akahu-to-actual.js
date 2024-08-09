const { AkahuClient } = require('akahu');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs').promises;
const api = require('@actual-app/api');

dotenv.config({ path: path.join(process.env.HOME, '.env') });

const SYNC_TIMESTAMPS_FILE = 'akahu_sync_timestamps.json';
const DEFAULT_START_DATE = '2024-08-01T00:00:00.000Z';

function log(message) {
    const timestamp = new Date().toISOString();
    process.stdout.write(`[${timestamp}] ${message}\n`);
}

async function loadMapping() {
    try {
        const mappingData = await fs.readFile('akahu_to_actual_mapping.json', 'utf8');
        return JSON.parse(mappingData);
    } catch (error) {
        log(`Error loading mapping file: ${error.message}`);
        throw error;
    }
}

async function fetchAkahuAccounts(client, userToken) {
    log('Starting to fetch Akahu accounts');
    const startTime = Date.now();
    try {
        const accounts = await client.accounts.list(userToken);
        log(`Fetched ${accounts.length} Akahu accounts in ${Date.now() - startTime}ms`);
        log(`Akahu accounts: ${JSON.stringify(accounts, null, 2)}`);
        return new Map(accounts.map(account => [account._id, account]));
    } catch (error) {
        log(`Error fetching Akahu accounts: ${error.message}`);
        throw error;
    }
}

async function fetchAkahuTransactions(client, userToken, startDate, accountId) {
    log(`Starting to fetch transactions for account ${accountId} from ${startDate}`);

    try {
        const transactions = await client.transactions.list(userToken, {
            start: startDate,
            end: new Date().toISOString(),
            account: accountId,
        });
        log(`Raw Akahu response for account ${accountId}: ${JSON.stringify(transactions, null, 2)}`);
        if (!Array.isArray(transactions)) {
            log(`Error: Expected an array of transactions but got ${typeof transactions}`);
            throw new Error('Unexpected response format from Akahu API');
        }
        log(`Fetched ${transactions.length} transactions for account ${accountId}`);
        return transactions;
    } catch (error) {
        log(`Error fetching Akahu transactions for account ${accountId}: ${error.message}`);
        throw error;
    }
}

async function getSyncTimestamps() {
    try {
        const data = await fs.readFile(SYNC_TIMESTAMPS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            log(`${SYNC_TIMESTAMPS_FILE} not found, creating new file`);
            return {};
        } else {
            log(`Error reading sync timestamps: ${error.message}`);
            throw error;
        }
    }
}

async function updateSyncTimestamp(accountId, timestamp) {
    try {
        const timestamps = await getSyncTimestamps();
        timestamps[accountId] = timestamp;
        await fs.writeFile(SYNC_TIMESTAMPS_FILE, JSON.stringify(timestamps, null, 2));
    } catch (error) {
        log(`Error updating sync timestamp: ${error.message}`);
    }
}

async function initializeActualAPI() {
    try {
        await api.init({
            dataDir: '/tmp/actual-data',
            serverURL: process.env.ACTUAL_SERVER_URL,
            password: process.env.ACTUAL_PASSWORD,
            budgetId: process.env.ACTUAL_SYNC_ID,
        });
        log('Actual API initialized successfully');
    } catch (error) {
        log(`Error during Actual API initialization: ${error.message}`);
        throw error;
    }
}

async function ensureBudgetLoaded() {
    try {
        await api.downloadBudget(process.env.ACTUAL_SYNC_ID);
        log('Budget downloaded successfully');
    } catch (error) {
        log(`Error downloading budget: ${error.message}`);
        throw error;
    }
}

async function fetchActualAccounts() {
    try {
        log('Fetching Actual accounts...');
        const accounts = await api.getAccounts();
        log(`Fetched ${accounts.length} Actual accounts: ${JSON.stringify(accounts, null, 2)}`);
        return accounts;
    } catch (error) {
        log(`Error fetching Actual accounts: ${error.message}`);
        throw error;
    }
}

async function getActualAccountBalance(accountId) {
    try {
        const balance = await api.getAccountBalance(accountId);
        log(`Fetched balance for account ${accountId}: ${balance}`);
        return balance;
    } catch (error) {
        log(`Error fetching balance for account ${accountId}: ${error.message}`);
        throw error;
    }
}

async function handleTrackingAccount(account, akahuAccounts, actualAccounts) {
    log(`Handling tracking account: ${account.akahu_name}`);
    try {
        const akahuAccount = akahuAccounts.get(account.akahu_id);
        if (!akahuAccount) {
            log(`Error: Unable to find Akahu account info for ${account.akahu_name}`);
            return;
        }

        const akahuBalance = Math.round(akahuAccount.balance.current * 100); // Convert to cents
        log(`Current Akahu balance for ${account.akahu_name}: ${akahuBalance / 100}`);

        const actualAccount = actualAccounts.find(a => a.id === account.actual_account_id);
        
        if (!actualAccount) {
            log(`Error: Unable to find Actual account for ID: ${account.actual_account_id}`);
            log(`Account name expected: ${account.actual_account_name}`);
            log(`Available accounts: ${JSON.stringify(actualAccounts.filter(a => !a.closed), null, 2)}`); // Skip closed accounts in the log
            return;
        }

        if (actualAccount.closed) {
            log(`Skipping closed account: ${actualAccount.name}`);
            return;
        }

        log(`Found matching Actual account: ${actualAccount.name} (ID: ${actualAccount.id})`);

        const actualBalance = await getActualAccountBalance(actualAccount.id);

        log(`Actual balance before reconciliation for ${account.akahu_name}: ${actualBalance / 100}`);
        log(`Akahu balance before reconciliation for ${account.akahu_name}: ${akahuBalance / 100}`);

        if (akahuBalance !== actualBalance) {
            const adjustmentAmount = akahuBalance - actualBalance;
            log(`Adjustment amount for ${account.akahu_name}: ${adjustmentAmount / 100}`);

            if (adjustmentAmount === null || isNaN(adjustmentAmount)) {
                throw new Error(`Invalid adjustment amount for ${account.akahu_name}: ${adjustmentAmount}`);
            }

            const transaction = [{
                date: new Date().toISOString().split('T')[0],
                account: account.actual_account_id,
                amount: adjustmentAmount,
                payee_name: 'Balance Adjustment',
                notes: `Adjusted from ${actualBalance / 100} to ${akahuBalance / 100} based on retrieved balance`,
                cleared: true,
            }];

            await api.importTransactions(account.actual_account_id, transaction);
            log(`Created balance adjustment transaction for ${account.akahu_name}: ${adjustmentAmount / 100}`);
        } else {
            log(`No balance adjustment needed for ${account.akahu_name}`);
        }
    } catch (error) {
        log(`Error handling tracking account ${account.akahu_name}: ${error.message}`);
    }
}

async function importTransactions() {
    const overallStartTime = Date.now();
    try {
        const mapping = await loadMapping();
        const syncTimestamps = await getSyncTimestamps();

        const client = new AkahuClient({
            appToken: process.env.AKAHU_APP_TOKEN,
        });

        await initializeActualAPI();
        await ensureBudgetLoaded();

        const akahuAccounts = await fetchAkahuAccounts(client, process.env.AKAHU_USER_TOKEN);
        const actualAccounts = await fetchActualAccounts();

        const trackingAccounts = mapping.filter(m => m.actual_budget_id !== 'SKIP' && m.actual_budget_id !== '' && m.account_type === 'Tracking');
        const onBudgetAccounts = mapping.filter(m => m.actual_budget_id !== 'SKIP' && m.actual_budget_id !== '' && m.account_type === 'On Budget');

        log(`Tracking accounts to process: ${JSON.stringify(trackingAccounts.map(a => a.akahu_name))}`);
        log(`On Budget accounts to fetch: ${JSON.stringify(onBudgetAccounts.map(a => a.akahu_name))}`);

        // Calculate and log account balances for all accounts
        for (const account of [...trackingAccounts, ...onBudgetAccounts]) {
            const actualAccount = actualAccounts.find(a => a.id === account.actual_account_id);
            if (actualAccount && !actualAccount.closed) {
                const balance = await getActualAccountBalance(actualAccount.id);
                log(`Account balance for ${account.akahu_name} (${actualAccount.name}): ${balance / 100}`);
            }
        }

        for (const account of trackingAccounts) {
            log(`Processing tracking account: ${account.akahu_name}`);
            await handleTrackingAccount(account, akahuAccounts, actualAccounts);
        }

        for (const account of onBudgetAccounts) {
            const startDate = new Date(syncTimestamps[account.akahu_id] || DEFAULT_START_DATE);
            log(`Processing on-budget account ${account.actual_account_id} (${account.akahu_name}) from ${startDate.toISOString()}`);

            try {
                const akahuTransactions = await fetchAkahuTransactions(client, process.env.AKAHU_USER_TOKEN, startDate.toISOString(), account.akahu_id);

                if (!Array.isArray(akahuTransactions)) {
                    log(`Error: Received invalid transaction data for ${account.akahu_name}`);
                    continue;
                }

                const mappedTransactions = akahuTransactions.map(t => ({
                    date: t.date,
                    account: account.actual_account_id,
                    amount: Math.round(t.amount * -100), // Convert to cents and invert sign
                    payee_name: t.description,
                    notes: `Akahu transaction: ${t.description}`,
                    imported_id: t._id,
                }));
                log(`Mapped ${mappedTransactions.length} transactions for account ${account.akahu_name}`);

                if (mappedTransactions.length > 0) {
                    await api.importTransactions(account.actual_account_id, mappedTransactions);
                    log(`Imported ${mappedTransactions.length} transactions for account ${account.akahu_name}`);
                    await updateSyncTimestamp(account.akahu_id, new Date().toISOString());
                }
            } catch (error) {
                log(`Error importing transactions for account ${account.akahu_name}: ${error.message}`);
            }
        }
    } catch (error) {
        log(`An error occurred: ${error.message}`);
    } finally {
        if (api) {
            try {
                await api.shutdown();
                log('Actual API shutdown successfully');
            } catch (shutdownError) {
                log(`Error during API shutdown: ${shutdownError.message}`);
            }
        }
    }
    log(`Total execution time: ${Date.now() - overallStartTime}ms`);
}

importTransactions().catch(error => {
    log(`Unhandled error occurred: ${error.message}`);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    log('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});