const { AkahuClient } = require('akahu');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const axios = require('axios');
const actualAPI = require('@actual-app/api');

dotenv.config({ path: path.join(__dirname, '.env') });

// Verify all required environment variables are set
const requiredEnvVars = [
    'ACTUAL_SERVER_URL',
    'ACTUAL_PASSWORD',
    'ACTUAL_ENCRYPTION_KEY',
    'ACTUAL_SYNC_ID',
    'AKAHU_APP_TOKEN',
    'AKAHU_USER_TOKEN',
    'OPENAI_API_KEY'
];

requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    console.error(`Missing required environment variable: ${varName}`);
    process.exit(1);
  }
});

async function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

async function syncDatabase(api) {
  try {
    log('Attempting database sync using low-level API...');

    await api.sendMessage('sync-full', {
      serverURL: process.env.ACTUAL_SERVER_URL,
      skipInitialDownload: false,
      mode: 'full'
    });

    const result = await api.db.all('SELECT * FROM migrations ORDER BY timestamp DESC LIMIT 1');
    log('Current migration status:', result);

    return true;
  } catch (error) {
    log('Error during sync', error);
    throw error;
  }
}

async function initializeActualAPI() {
  try {
    const dataDir = path.join(os.tmpdir(), 'actual-data');
    await fs.mkdir(dataDir, { recursive: true });

    await actualAPI.init({
      dataDir: dataDir,
      serverURL: process.env.ACTUAL_SERVER_URL,
      password: process.env.ACTUAL_PASSWORD,
      budgetId: process.env.AKAHU_BUDGET,
    });
    log('Actual API initialized successfully');



    return;
  } catch (error) {
    log(`Error during Actual API initialization: ${error.message}`);
    log('Complete Error Stack:', error.stack);
    throw error;
  }
}

async function fetchAkahuAccounts(akahuClient, akahuUserToken) {
  try {
    const accounts = await akahuClient.accounts.list(akahuUserToken);
    log(`Fetched ${accounts.length} Akahu accounts.`);
    return accounts;
  } catch (error) {
    log(`Error fetching Akahu accounts: ${error.message}`);
    throw error;
  }
}

async function fetchActualAccounts() {
  try {
    const accounts = await actualAPI.getAccounts();
    log(`Fetched ${accounts.length} Actual Budget accounts.`);
    return accounts;
  } catch (error) {
    log(`Error fetching Actual accounts: ${error.message}`);
    throw error;
  }
}

// [Rest of your existing helper functions remain the same]

async function runMappingProcess() {
  try {
    const akahuClient = new AkahuClient({
      appToken: process.env.AKAHU_APP_TOKEN,
    });


    // Initialize API once and use it throughout
    await initializeActualAPI();
    log('Initial API import:', Object.getOwnPropertyNames(actualAPI));
    log('Available API methods:', Object.keys(actualAPI));
    log('Actual API object:', actualAPI);

    // Load budget
    await actualAPI.downloadBudget(process.env.ACTUAL_SYNC_ID, {
      password: process.env.ACTUAL_ENCRYPTION_KEY
    });
    log('Budget loaded successfully');

    // Step 0: Load existing mapping and validate
    const existingMapping = await loadMapping();
    if (existingMapping.length > 0) {
      const actualAccounts = await fetchActualAccounts(api);
      const akahuAccounts = await fetchAkahuAccounts(akahuClient, process.env.AKAHU_USER_TOKEN);
      await checkExistingMapping(existingMapping, akahuAccounts, actualAccounts);
      log('Existing mapping is valid.');
      return;
    }

    // Step 1: Fetch Akahu accounts
    const akahuAccounts = await fetchAkahuAccounts(akahuClient, process.env.AKAHU_USER_TOKEN);

    // Step 2: Fetch Actual Budget accounts using the api instance
    const actualAccounts = await fetchActualAccounts(api);

    // Step 3: Match accounts using OpenAI
    const newMapping = await matchAccountsWithOpenAI(akahuAccounts, actualAccounts);

    // Step 4: Output proposed mapping
    await promptUserToSaveMapping(newMapping);

  } catch (error) {
    log(`Error: ${error.message}`);
  }
}

// Main execution
(async () => {
  try {
    await runMappingProcess();
  } catch (error) {
    console.error('Error running the script:', error.message);
    process.exit(1);
  }
})();