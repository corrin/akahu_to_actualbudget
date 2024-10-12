import os
from dotenv import load_dotenv
from akahu_api import AkahuAPI

def test_akahu_fetch_transactions():
    # Load environment variables from .env file
    load_dotenv()

    # Fetch Akahu credentials from environment variables
    AKAHU_APP_TOKEN = os.getenv("AKAHU_APP_TOKEN")
    AKAHU_USER_TOKEN = os.getenv("AKAHU_USER_TOKEN")
    AKAHU_ACCOUNT_ID = os.getenv("AKAHU_ACCOUNT_ID")

    # Ensure required environment variables are set
    if not all([AKAHU_APP_TOKEN, AKAHU_USER_TOKEN, AKAHU_ACCOUNT_ID]):
        print("Error: Missing one or more required environment variables for Akahu API.")
        return

    # Initialize Akahu API
    akahu_api = AkahuAPI(AKAHU_APP_TOKEN, AKAHU_USER_TOKEN)

    # Fetch transactions for a specific account
    try:
        transactions = akahu_api.get_transactions(AKAHU_ACCOUNT_ID)
        print(f"Fetched {len(transactions.get('items', []))} transactions for account ID {AKAHU_ACCOUNT_ID}.")
        for transaction in transactions.get('items', []):
            print(transaction)
    except RuntimeError as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    test_akahu_fetch_transactions()