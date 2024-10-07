const fs = require('fs').promises;
const dotenv = require('dotenv');
const path = require('path');
const os = require('os');
const { AkahuClient } = require('akahu');
const api = require('@actual-app/api');

// Load environment variables from .env file
dotenv.config({ path: path.join(os.homedir(), '.env') });

function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}

async function readMappingFile() {
    try {
        const data = await fs.readFile('akahu_to_actual_mapping.json', 'utf8');
        return JSON.parse(data);
    } catch (error) {
        throw new Error(`Error reading mapping file: ${error.message}`);
    }
}

async function fetchAkahuAccounts() {
    try {
        const client = new AkahuClient({
            appToken: process.env.AKAHU_APP_TOKEN,
        });
        const accounts = await client.accounts.list(process.env.AKAHU_USER_TOKEN);
        log(`Fetched ${accounts.length} Akahu accounts successfully.`);
        return new Map(accounts.map(account => [account._id, account]));
    } catch (error) {
        throw new Error(`Error fetching Akahu accounts: ${error.message}`);
    }
}

async function fetchActualAccounts() {
    try {
        await api.init({
            dataDir: '/tmp/actual-data',
            serverURL: process.env.ACTUAL_SERVER_URL,
            password: process.env.ACTUAL_PASSWORD,
            budgetId: process.env.ACTUAL_SYNC_ID,
        });
        await api.downloadBudget(process.env.ACTUAL_SYNC_ID);
        const accounts = await api.getAccounts();
        log(`Fetched ${accounts.length} Actual accounts successfully.`);
        await api.shutdown();
        return new Map(accounts.map(account => [account.id, account]));
    } catch (error) {
        throw new Error(`Error fetching Actual accounts: ${error.message}`);
    }
}

function validateMapping(mapping, akahuAccounts, actualAccounts) {
    const errors = [];

    mapping.forEach((entry, index) => {
        if (entry.akahu_id && entry.akahu_id !== "SKIP") {
            if (!akahuAccounts.has(entry.akahu_id)) {
                errors.push(`Entry ${index + 1}: Akahu ID ${entry.akahu_id} not found in Akahu accounts`);
            } else if (akahuAccounts.get(entry.akahu_id).name !== entry.akahu_name) {
                errors.push(`Entry ${index + 1}: Akahu name mismatch. Mapping: ${entry.akahu_name}, Actual: ${akahuAccounts.get(entry.akahu_id).name}`);
            }
        }

        if (entry.actual_account_id && entry.actual_account_id !== "") {
            if (!actualAccounts.has(entry.actual_account_id)) {
                errors.push(`Entry ${index + 1}: Actual ID ${entry.actual_account_id} not found in Actual accounts`);
            } else if (actualAccounts.get(entry.actual_account_id).name !== entry.actual_account_name) {
                errors.push(`Entry ${index + 1}: Actual account name mismatch. Mapping: ${entry.actual_account_name}, Actual: ${actualAccounts.get(entry.actual_account_id).name}`);
            }
        }
    });

    return errors;
}

async function main() {
    try {
        log('Starting validation process...');

        const mapping = await readMappingFile();
        log('Mapping file read successfully.');

        const akahuAccounts = await fetchAkahuAccounts();
        const actualAccounts = await fetchActualAccounts();

        const validationResults = validateMapping(mapping, akahuAccounts, actualAccounts);

        const errors = validationResults.filter(result => !result.startsWith('Warning:'));
        const warnings = validationResults.filter(result => result.startsWith('Warning:'));

        if (errors.length === 0) {
            log('Validation completed. No errors found.');
        } else {
            log('Validation completed. Errors found:');
            errors.forEach(error => log(error));
        }

        if (warnings.length > 0) {
            log('Warnings:');
            warnings.forEach(warning => log(warning));
        }

    } catch (error) {
        console.error('Error:', error.message);
    }
}

main();