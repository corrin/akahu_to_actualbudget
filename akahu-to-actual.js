const { AkahuClient } = require('akahu');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const api = require('@actual-app/api');

// dotenv.config({ path: path.join(process.env.HOME, '.env') });
dotenv.config({ path: path.join(__dirname, '.env') });


const SYNC_TIMESTAMPS_FILE = 'akahu_sync_timestamps.json';
const DEFAULT_START_DATE = '2024-08-01T00:00:00.000Z';

function log(message) {
    const timestamp = new Date().toISOString();
    const truncatedMessage = message.length > 2000
        ? message.substring(0, 2000) + '... (truncated)'
        : message;
    process.stdout.write(`[${timestamp}] ${truncatedMessage}\n`);
}

const requiredEnvVars = [
    'ACTUAL_SERVER_URL',
    'ACTUAL_PASSWORD',
    'ACTUAL_SYNC_ID',
    'ACTUAL_ENCRYPTION_KEY',
    'AKAHU_APP_TOKEN',
    'AKAHU_USER_TOKEN'
];

// Function to verify required environment variables are set
function checkRequiredEnvVars() {
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

    if (missingVars.length > 0) {
        log(`Missing required environment variables: ${missingVars.join(', ')}`);
        throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    } else {
        log('All required environment variables are set.');
    }
}

// Call the check function
checkRequiredEnvVars();


async function loadMapping() {
    const mappingFileName = 'akahu_to_actual_mapping.json';
    try {
        const mappingData = await fs.readFile(mappingFileName, 'utf8');
        return JSON.parse(mappingData);
    } catch (error) {
        log(`Error loading mapping file (${mappingFileName}): ${error.message}`);
        throw error;  // Halting execution as this file is critical
    }
}

async function fetchAkahuAccounts(client, userToken) {
    log('Starting to fetch Akahu accounts');
    const startTime = Date.now();
    try {
        const accounts = await client.accounts.list(userToken);
        log(`Fetched ${accounts.length} Akahu accounts in ${Date.now() - startTime}ms`);
        log('Akahu accounts:');
        accounts.forEach(account => {
            log(`  ${account.name} (Akahu ID: ${account._id})`);
        });
        return new Map(accounts.map(account => [account._id, account]));
    } catch (error) {
        log(`Error fetching Akahu accounts: ${error.message}`);
        throw error;
    }
}

async function fetchAkahuTransactions(client, userToken, startDate, accountId) {
    log(`Starting to fetch transactions for account ${accountId} from ${startDate}`);

    try {
        const response = await client.transactions.list(userToken, {
            start: startDate,
            end: new Date().toISOString(),
            account: accountId,
        });

        if (typeof response !== 'object' || !response.items || !Array.isArray(response.items)) {
            log(`Error: Unexpected response structure for account ${accountId}`);
            throw new Error('Unexpected response format from Akahu API');
        }

        const transactions = response.items;
        log(`Fetched ${transactions.length} transactions for account ${accountId}`);

        // Log a sample raw transaction
        if (transactions.length > 0) {
            log(`Sample raw Akahu transaction for account ${accountId}:`);
            log(JSON.stringify(transactions[0], null, 2));
        }

        return transactions;
    } catch (error) {
        log(`Error fetching Akahu transactions for account ${accountId}: ${error.message}`);
        throw error;
    }
}

async function getSyncTimestamps() {
    const syncTimestampsFileName = SYNC_TIMESTAMPS_FILE;
    try {
        const data = await fs.readFile(syncTimestampsFileName, 'utf8');

        // Check if file is empty or malformed
        if (!data.trim()) {
            log(`Error: Sync timestamps file (${syncTimestampsFileName}) is empty.`);
            return {};  // Proceed as if the file doesn't exist
        }

        // Attempt to parse the JSON
        try {
            return JSON.parse(data);
        } catch (parseError) {
            log(`Error parsing sync timestamps file (${syncTimestampsFileName}): ${parseError.message}`);
            throw new Error(`Invalid JSON format in ${syncTimestampsFileName}`);
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            log(`${syncTimestampsFileName} not found, creating new file.`);
            return {};  // Proceed as if the file didn't exist
        } else {
            log(`Error reading sync timestamps (${syncTimestampsFileName}): ${error.message}`);
            throw error;  // Rethrow for any unexpected error
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
        const dataDir = path.join(os.tmpdir(), 'actual-data');
        await fs.mkdir(dataDir, { recursive: true });
        await api.init({
            dataDir: dataDir,
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
        const encryptionKey = process.env.ACTUAL_ENCRYPTION_KEY;
        if (!encryptionKey) {
            throw new Error("Encryption key not provided");
        }

        await api.downloadBudget(process.env.ACTUAL_SYNC_ID, { password: encryptionKey });
        log('Budget downloaded successfully');
    } catch (error) {
        log(`Error downloading budget: ${error.message}`);
        throw error;
    }
}

async function fetchActualAccounts() {
    try {
        log('Fetching Actual accounts...');
        const allAccounts = await api.getAccounts();
        const openAccounts = allAccounts.filter(account => !account.closed);
        log(`Fetched ${openAccounts.length} open Actual accounts`);
        log('Open Actual accounts:');
        openAccounts.forEach(account => {
            log(`  ${account.name} (Actual ID: ${account.id})`);
        });
        return openAccounts;
    } catch (error) {
        log(`Error fetching Actual accounts: ${error.message}`);
        throw error;
    }
}

async function getActualAccountBalance(accountId) {
    try {
        const balance = await api.getAccountBalance(accountId);
        return balance;
    } catch (error) {
        log(`Error fetching balance for account ${accountId}: ${error.message}`);
        throw error;
    }
}

async function handleTrackingAccount(account, akahuAccounts, actualAccounts) {
    log(`Handling tracking account: ${account.akahu_name} (Akahu ID: ${account.akahu_id})`);
    try {
        const akahuAccount = akahuAccounts.get(account.akahu_id);
        if (!akahuAccount) {
            log(`Error: Unable to find Akahu account info for ${account.akahu_name} (Akahu ID: ${account.akahu_id})`);
            return;
        }

        const akahuBalance = Math.round(akahuAccount.balance.current * 100); // Convert to cents
        const actualAccount = actualAccounts.find(a => a.id === account.actual_account_id);

        if (!actualAccount) {
            log(`Error: Unable to find Actual account for ID: ${account.actual_account_id}`);
            return;
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
        } else {
            log(`No balance adjustment needed for ${account.akahu_name} (Akahu ID: ${account.akahu_id})`);
        }
    } catch (error) {
        log(`Error handling tracking account ${account.akahu_name} (Akahu ID: ${account.akahu_id}): ${error.message}`);
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

async function importTransactions() {
    const overallStartTime = Date.now();
    const transactionSummary = {};

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
            log(`Processing tracking account: ${account.akahu_name} (Akahu ID: ${account.akahu_id}, Actual ID: ${account.actual_account_id}, Actual Name: ${actualAccount.name})`);
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
            log(`Processing on-budget account: ${account.akahu_name} (Akahu ID: ${account.akahu_id}, Actual ID: ${account.actual_account_id}, Actual Name: ${actualAccount.name})`);

            const lastSyncDate = new Date(syncTimestamps[account.akahu_id] || DEFAULT_START_DATE);
            const startDate = new Date(lastSyncDate.getTime() - 7 * 24 * 60 * 60 * 1000); // Subtract 7 days
            log(`Fetching transactions from ${isoToShortDate(startDate.toISOString())}`);

            try {
                // Log Akahu account details before fetching transactions
                const akahuAccount = akahuAccounts.get(account.akahu_id);
                if (akahuAccount) {
                    log(`Akahu account details for ${account.akahu_name}:`);
                    log(JSON.stringify(akahuAccount, null, 2));
                } else {
                    log(`Warning: Akahu account not found for ID: ${account.akahu_id}`);
                }

                const akahuTransactions = await fetchAkahuTransactions(client, process.env.AKAHU_USER_TOKEN, startDate.toISOString(), account.akahu_id);

                log(`Mapping ${akahuTransactions.length} transactions for ${account.akahu_name} (Akahu ID: ${account.akahu_id})`);
                const mappedTransactions = akahuTransactions.map(t => {
                    const mappedTransaction = {
                        date: isoToShortDate(t.date),
                        account: account.actual_account_id,
                        amount: Math.round(t.amount * -100), // Convert to cents and invert sign
                        payee_name: t.description,
                        notes: `Akahu transaction: ${t.description}`,
                        imported_id: t._id,
                    };
                    log(`Mapped transaction for ${account.akahu_name} (Akahu ID: ${account.akahu_id}):`);
                    log(JSON.stringify(mappedTransaction, null, 2));
                    return mappedTransaction;
                });

                transactionSummary[account.akahu_id] = mappedTransactions;

                if (mappedTransactions.length > 0) {
                    log(`Calling api.importTransactions for account ${account.akahu_name} (Akahu ID: ${account.akahu_id}, Actual ID: ${account.actual_account_id})`);
                    log(`Importing ${mappedTransactions.length} transactions`);
                    const importResult = await api.importTransactions(account.actual_account_id, mappedTransactions);
                    log(`Import result:`);
                    log(JSON.stringify(importResult, null, 2));

                    log(`Updating sync timestamp for ${account.akahu_name} (Akahu ID: ${account.akahu_id})`);
                    await updateSyncTimestamp(account.akahu_id, new Date().toISOString());
                } else {
                    log(`No new transactions for ${account.akahu_name} (Akahu ID: ${account.akahu_id})`);
                }
            } catch (error) {
                log(`Error importing transactions for account ${account.akahu_name} (Akahu ID: ${account.akahu_id}): ${error.message}`);
                if (error.stack) {
                    log(`Error stack: ${error.stack}`);
                }
            }
        }

        // Generate and log summary
        const summary = generateSummary([...trackingAccounts, ...onBudgetAccounts], transactionSummary);
        log("Import Summary:");
        summary.forEach(account => {
            log(`${account.name} (Akahu ID: ${account.akahu_id}): ${account.transactionCount} transactions, total amount: $${(account.totalAmount / 100).toFixed(2)}`);
        });

    } catch (error) {
        log(`An error occurred: ${error.message}`);
        if (error.stack) {
            log(`Error stack: ${error.stack}`);
        }
    } finally {
        if (api) {
            try {
                log('Shutting down Actual API');
                await api.shutdown();
                log('Actual API shutdown successfully');
            } catch (shutdownError) {
                log(`Error during API shutdown: ${shutdownError.message}`);
            }
        }
    }
    log(`Total execution time: ${(Date.now() - overallStartTime) / 1000} seconds`);
}

importTransactions().catch(error => {
    log(`Unhandled error occurred: ${error.message}`);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    log('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});