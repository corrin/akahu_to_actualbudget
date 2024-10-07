const dotenv = require('dotenv');
const path = require('path');
const os = require('os');

// Load .env from home directory
dotenv.config({ path: path.join(os.homedir(), '.env') });

const { AkahuClient } = require('akahu');

async function testAkahuConnection() {
    console.log('Starting Akahu connection test...');

    // Check if Akahu tokens are available
    if (!process.env.AKAHU_APP_TOKEN || !process.env.AKAHU_USER_TOKEN) {
        console.error('Error: Akahu tokens not found in environment variables.');
        return;
    }

    console.log('Akahu tokens found in environment variables.');

    const akahu = new AkahuClient({
        appToken: process.env.AKAHU_APP_TOKEN,
    });

    // Replace with an OAuth user access token
    const userToken = process.env.AKAHU_USER_TOKEN;

    try {
        // Fetch accounts
        console.log('Fetching accounts...');
        const accounts = await akahu.accounts.list(userToken);
        console.log(`Retrieved ${accounts.length} accounts:`);
        accounts.forEach(account => {
            console.log(`- ${account.name} (${account.type}): ${account.formatted_account}`);
        });

        // Fetch transactions
        console.log('\nFetching transactions...');
        const query = {
            start: "2024-08-01T00:00:00.000Z",  // Start from August 1, 2024
            end: new Date().toISOString(),  // Up to current date
        };

        const transactions = [];

        do {
            // Transactions are returned one page at a time
            const page = await akahu.transactions.list(userToken, query);
            // Store the returned transaction `items` from each page
            transactions.push(...page.items);
            // Update the cursor to point to the next page
            query.cursor = page.cursor.next;
            // Continue until the server returns a null cursor
        } while (query.cursor !== null);

        console.log(`Retrieved ${transactions.length} transactions since August 1, 2024.`);
        console.log('First 5 transactions:');
        transactions.slice(0, 5).forEach(transaction => {
            console.log(`- ${transaction.date}: ${transaction.description} - $${transaction.amount}`);
        });

    } catch (error) {
        console.error('An error occurred:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
    }

    console.log('Akahu connection test completed.');
}

testAkahuConnection().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
});