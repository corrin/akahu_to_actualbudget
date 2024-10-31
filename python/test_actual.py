import os
import pathlib
import logging
from dotenv import load_dotenv
from actual import Actual
from actual.queries import (
    get_account,
    get_accounts,
    get_ruleset,
    get_transactions,
    reconcile_transaction,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler("app.log"),
        logging.StreamHandler()
    ]
)

# Load environment variables from the parent directory's .env file
load_dotenv(dotenv_path=pathlib.Path(__file__).parent.parent / '.env')

# Fetch environment variables
server_url = os.getenv("ACTUAL_SERVER_URL")
password = os.getenv("ACTUAL_PASSWORD")
encryption_key = os.getenv("ACTUAL_ENCRYPTION_KEY")
actual_sync_id = os.getenv("ACTUAL_SYNC_ID")

# Verify the required environment variables are set
if not server_url or not password or not encryption_key or not actual_sync_id:
    logging.error(
        "Missing one or more required environment variables: ACTUAL_SERVER_URL, ACTUAL_PASSWORD, ACTUAL_ENCRYPTION_KEY, ACTUAL_SYNC_ID")
    raise ValueError("Missing required environment variables")


# Initialize and use the Actual class directly
def main():
    logging.info("Starting Actual API integration script.")

    try:
        # Use Actual as a context manager to ensure session management
        with Actual(
                base_url=server_url,
                password=password,
                file=actual_sync_id,
                encryption_password=encryption_key
        ) as actual:
            logging.info("API initialized successfully with file set.")

            # Download the budget
            actual.download_budget()
            logging.info("Budget downloaded successfully.")

            # Fetch accounts
            accounts = get_accounts(actual.session)
            open_accounts = [acc for acc in accounts if not acc.closed]
            logging.info(f"Fetched accounts: {len(open_accounts)} open accounts retrieved.")

            # Example: Get balance of the first account
            if open_accounts:
                account_id = open_accounts[0].id  # Access using dot notation
                balance = open_accounts[0].balance_current  # Access using dot notation
                logging.info(f"Balance of account {account_id}: {balance}")

    except Exception as e:
        logging.exception("An unexpected error occurred during script execution.")


if __name__ == "__main__":
    main()
