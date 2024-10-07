const api = require('@actual-app/api');

// Configuration
const config = {
  dataDir: '/tmp/actual-data',
  serverURL: 'https://certain-myna.pikapod.net',
  password: 'rqh!vrw9TAB',
  budgetId: 'Household-Budget-cb80c24',  // This is the Budget ID
  syncId: 'cff531ad-18a0-42fb-a533-1196bfc61e37'  // This is the Sync ID
};

async function main() {
  try {
    console.log('Config:', JSON.stringify({...config, password: '[REDACTED]'}, null, 2));
    console.log('Initializing API...');
    await api.init(config);
    console.log('API initialized successfully');

    console.log('Listing available budgets...');
    const budgets = await api.getBudgets();
    console.log('Available budgets:', budgets);

    console.log('Downloading budget...');
    await api.downloadBudget(config.syncId);  // Use syncId for downloading

    console.log('Fetching budget month...');
    const budget = await api.getBudgetMonth('2023-08');
    console.log('Budget data:', JSON.stringify(budget, null, 2));

    console.log('Shutting down API...');
    await api.shutdown();
  } catch (error) {
    console.error('An error occurred:', error.message);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
  }
}

main();