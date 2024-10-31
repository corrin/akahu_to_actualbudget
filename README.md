# akahu_to_actualbudget

This script (Node.js) downloads all your recent transactions using the Open Banking data aggregator Akahu, and posts them to Actual Budget.  If you live in NZ and use Actual Budget, then this should give you automatic transaction importing.
Akahu acts as an aggregator in NZ, providing data from all the major banks, and quite a few other financial institutions.  That way this script works as `^(Westpac|Kiwibank|BNZ|ANZ|Simplicity|IRD|ASB)+$` to Actual Budget.

I wrote it for myself and there's bound to be a couple assumptions I made that are me-specific, so please let me know if you spot any.  

You'll need to sign up for a developer account at Akahu (https://my.akahu.nz/apps).  If there's enough interest then I can convert what I've written to use OAuth rather than secret keys.

I'm sure you could tweak this if you had different goals.  My first incantation mapped Akahu to YNAB.

To make it work you will need to 
1. Get an Akahu API key and secret
2. Host your Actual Budget somewhere accessible from this script
3. Get an Actual Budget API key
4. Write akahu_to_actual_mapping.json 
5. Schedule this script using Cron


** Getting an Akahu API Key

1. Go to https://my.akahu.nz/apps
2. Sign up
3. Create a new app
4. Copy the API key and secret

* Host your Actual Budget somewhere accessible from this script

Just listed this explicitly to make it obvious.  PikaPods is the easiest.

** Getting an Actual Budget API Key

Easiest way is to go to PikaPods and spin up an instance of Actual Budget.  
You can then get the API key from the settings page (under advanced)

** Write akahu_to_actual_mapping.json

I've written a script to help here.  Run akahu_actual_mapping.js.
You still need to write the .env file first, but it is designed to have better error messages if you get it wrong.

It uses ChatGPT to help with the mapping.

Here's a snippet from mine

  {
    "actual_budget_name": "Household Budget" // Not really used.  The friendly name of your budget",
    "actual_account_name": "Main Account" // Not really used.  The friendly name of your account in AB",
    "account_type": "On Budget", // or Tracking.  
    "akahu_name": "Budgeted spending", // The name of the account in Akahu. Not used
    "akahu_id": "acc_abcdeabaceabcde", // Get this from my.akahu.nz
    "actual_budget_id": "12345-1234-1234-1234-123456789012", // Get this from your AB instance
    "actual_account_id": "12345-1234-1234-1234-123456789012", // Get this from your AB instance
    "note": "Freetext reference just to yourself"
  },



