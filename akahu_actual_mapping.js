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

async function initializeActualAPI() {
  try {
    const dataDir = path.join(os.tmpdir(), 'actual-data');
    await fs.mkdir(dataDir, { recursive: true });
    actualApiInstance = await actualAPI.init({
      dataDir: dataDir,
      serverURL: process.env.ACTUAL_SERVER_URL,
      password: process.env.ACTUAL_PASSWORD,
      budgetId: process.env.AKAHU_BUDGET,
    });
    console.log('Actual API initialized successfully');
    await actualAPI.downloadBudget(process.env.ACTUAL_SYNC_ID, { password: process.env.ACTUAL_ENCRYPTION_KEY });

    console.log('Budget loaded successfully');
  } catch (error) {
    console.error('Error during Actual API initialization:', error.message);
    throw error;
  }
}

async function loadMapping() {
  try {
    const data = await fs.readFile('akahu_to_actual_mapping.json', 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      log('akahu_to_actual_mapping.json not found. Proceeding to create new mappings.');
      return [];
    }
    log(`Error reading akahu_to_actual_mapping.json: ${error.message}`);
    throw error;
  }
}

async function saveMapping(mapping) {
  try {
    await fs.writeFile('akahu_to_actual_mapping.json', JSON.stringify(mapping, null, 2));
    log('Mapping file akahu_to_actual_mapping.json saved successfully.');
  } catch (error) {
    log(`Error saving mapping: ${error.message}`);
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

async function checkExistingMapping(mapping, akahuAccounts, actualAccounts) {
  const akahuAccountIds = new Set(akahuAccounts.map(account => account._id));
  const actualAccountIds = new Set(actualAccounts.map(account => account.id));
  const errors = [];

  mapping.forEach(entry => {
    if (entry.actual_account_id && !actualAccountIds.has(entry.actual_account_id)) {
      errors.push(`Actual account not found for entry: ${entry.akahu_name}`);
    }
    if (entry.akahu_id && !akahuAccountIds.has(entry.akahu_id)) {
      errors.push(`Akahu account not found for entry: ${entry.akahu_name}`);
    }
  });

  if (errors.length > 0) {
    throw new Error(`Mapping validation failed:\n${errors.join('\n')}`);
  }
}

async function matchAccountsWithOpenAI(akahuAccounts, actualAccounts) {
  const mappings = [];
  const prompts = akahuAccounts.map(account => {
    return `Match the following Akahu account to an Actual Budget account: "${account.name}". Provide the closest match.`;
  });

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/completions',
      {
        model: 'text-davinci-003',
        prompt: prompts.join('\n'),
        max_tokens: 150,
        temperature: 0.7,
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
      }
    );

    response.data.choices.forEach((choice, index) => {
      const akahuAccount = akahuAccounts[index];
      const actualMatch = actualAccounts.find(account => choice.text.includes(account.name));

      if (actualMatch) {
        mappings.push({
          akahu_name: akahuAccount.name,
          akahu_id: akahuAccount._id,
          actual_account_name: actualMatch.name,
          actual_account_id: actualMatch.id,
          account_type: actualMatch.closed ? 'Archived' : 'Tracking',
          note: null,
        });
      } else {
        mappings.push({
          akahu_name: akahuAccount.name,
          akahu_id: akahuAccount._id,
          actual_account_id: '',
          note: 'Skipped Akahu account',
        });
      }
    });
  } catch (error) {
    log(`Error calling OpenAI API: ${error.message}`);
    throw error;
  }

  return mappings;
}

async function promptUserToSaveMapping(mapping) {
  console.log('Proposed Mapping:');
  mapping.forEach(entry => {
    console.log(`${entry.akahu_name} -> ${entry.actual_account_name || 'No Match'}`);
  });
  console.log('Press Y to save this mapping to akahu_to_actual_mapping.json, or any other key to cancel.');
  const userInput = await new Promise(resolve => {
    process.stdin.once('data', data => resolve(data.toString().trim()));
  });

  if (userInput.toLowerCase() === 'y') {
    await saveMapping(mapping);
  } else {
    log('Mapping was not saved.');
  }
}

async function runMappingProcess() {
  try {
    const akahuClient = new AkahuClient({
      appToken: process.env.AKAHU_APP_TOKEN,
    });

    // Step 0: Load existing mapping and validate
    const existingMapping = await loadMapping();
    if (existingMapping.length > 0) {
      const akahuAccounts = await fetchAkahuAccounts(akahuClient, process.env.AKAHU_USER_TOKEN);
      await initializeActualAPI();
      const actualAccounts = await fetchActualAccounts();
      await checkExistingMapping(existingMapping, akahuAccounts, actualAccounts);
      log('Existing mapping is valid.');
      return;
    }

    // Step 1: Fetch Akahu accounts
    const akahuAccounts = await fetchAkahuAccounts(akahuClient, process.env.AKAHU_USER_TOKEN);

    // Step 2: Fetch Actual Budget accounts
    await initializeActualAPI();
    const actualAccounts = await fetchActualAccounts();

    // Step 3: Match accounts using OpenAI
    const newMapping = await matchAccountsWithOpenAI(akahuAccounts, actualAccounts);

    // Step 4: Output proposed mapping
    await promptUserToSaveMapping(newMapping);

  } catch (error) {
    log(`Error: ${error.message}`);
  }
}




(async () => {
  try {
    await runMappingProcess();
  } catch (error) {
    console.error('Error running the script:', error.message);
  }
})();
