const { AkahuClient } = require('akahu');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '.env') });

// Akahu API credentials
const appToken = process.env.AKAHU_APP_TOKEN;
const userToken = process.env.AKAHU_USER_TOKEN;

// Akahu account ID to fetch transactions for
const accountId = 'acc_clp77cei7000308l4ed6be3i9';

// Initialize Akahu client
const akahuClient = new AkahuClient({
    appToken: appToken,
});

async function fetchTransactionsForAccount(accountId) {
    try {
        console.log(`Fetching transactions for account: ${accountId}`);

        // Fetch transactions for the specific account using listTransactions
        const response = await akahuClient.accounts.listTransactions(userToken, accountId);

        console.log(`Fetched ${response.items.length} transactions for account: ${accountId}`);
        response.items.forEach((transaction, index) => {
            console.log(`${index + 1}: ${transaction.date} - ${transaction.description} - $${transaction.amount}`);
        });
    } catch (error) {
        console.error('Error fetching transactions:', error.message);
    }
}

// Call the function to fetch transactions
fetchTransactionsForAccount(accountId);
