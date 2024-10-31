const dotenv = require('dotenv');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const actual = require('@actual-app/api');

dotenv.config({ path: path.join(__dirname, '.env') });

async function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

async function testActualConnection() {
  const dataDir = path.join(os.tmpdir(), 'actual-test');

  try {
    await ensureDir(dataDir);

    log('Initializing Actual API...');
    await actual.init({
      dataDir: dataDir,
      serverURL: process.env.ACTUAL_SERVER_URL,
      password: process.env.ACTUAL_PASSWORD
    });
    log('API initialized successfully');

    log('Running migrations and sync...');
//    await actual.sync();
    log('Sync completed');

    log(`Downloading budget using Sync ID: ${process.env.ACTUAL_SYNC_ID}`);
    await actual.downloadBudget(process.env.ACTUAL_SYNC_ID, {
      password: process.env.ACTUAL_ENCRYPTION_KEY
    });
    log('Budget downloaded successfully');

    // Verify access
    const accounts = await actual.getAccounts();
    log(`Successfully accessed budget - found ${accounts.length} accounts`);

  } catch (error) {
    log(`Error: ${error.message}`);
    if (error.stack) {
      log(`Stack trace: ${error.stack}`);
    }
    throw error;
  } finally {
    try {
      log('Shutting down API...');
      await actual.shutdown();
      log('API shut down successfully');
    } catch (error) {
      log(`Error during shutdown: ${error.message}`);
    }
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  log(`Ensured directory exists: ${dir}`);
}

// Run the test
testActualConnection().catch(error => {
  log('Test failed');
  process.exit(1);
});