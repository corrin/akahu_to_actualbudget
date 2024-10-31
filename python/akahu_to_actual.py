import base64
import datetime
import decimal
import json
import logging
import os
import pandas as pd
import pathlib
import requests

from actual import Actual
from actual.queries import create_transaction
from actual.queries import reconcile_transaction
from dotenv import load_dotenv
from flask import Flask, request, jsonify
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives import serialization
from cryptography.exceptions import InvalidSignature
from threading import Thread

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler("app.log"),
        logging.StreamHandler()
    ]
)

# Load environment variables from .env file
load_dotenv()

# Define required environment variables
required_envs = [
    'ACTUAL_SERVER_URL',
    'ACTUAL_PASSWORD',
    'ACTUAL_ENCRYPTION_KEY',
    'ACTUAL_SYNC_ID',
    'AKAHU_USER_TOKEN',
    'AKAHU_APP_TOKEN',
    'AKAHU_PUBLIC_KEY'
]

# Load environment variables into a dictionary for validation
ENVs = {key: os.getenv(key) for key in required_envs}
SYNC_TO_YNAB = False
SYNC_TO_AB = True

# Validate that all environment variables are loaded
for key, value in ENVs.items():
    if value is None:
        logging.error(f"Environment variable {key} is missing.")
        raise EnvironmentError(f"Missing required environment variable: {key}")

# Akahu API setup
akahu_endpoint = "https://api.akahu.io/v1/"
akahu_headers = {
    "Authorization": "Bearer " + ENVs['AKAHU_USER_TOKEN'],
    "X-Akahu-ID": ENVs['AKAHU_APP_TOKEN']
}

# Run webhook server flag
RUN_WEBHOOKS = False

# Load existing mapping from a JSON file
mapping_file = "akahu_to_budget_mapping.json"

def load_existing_mapping():
    """Load the mapping of Akahu accounts to Actual accounts from a JSON file."""
    if pathlib.Path(mapping_file).exists():
        with open(mapping_file, "r") as f:
            data = json.load(f)
            akahu_accounts = data.get('akahu_accounts', [])
            actual_accounts = data.get('actual_accounts', [])
            mapping = {entry['akahu_id']: entry for entry in data.get('mapping', [])}
            logging.info(f"Mapping loaded successfully from {mapping_file}")
            return akahu_accounts, actual_accounts, mapping
        logging.warning(f"Mapping file {mapping_file} not found. Returning empty mappings.")
    return [], [], []

# Load mapping at the start
g_akahu_accounts, g_actual_accounts, g_mapping_list = load_existing_mapping()

# Fetch all transactions from Akahu with pagination
def get_all_akahu(akahu_account_id, last_reconciled_at=None):
    """Fetch all transactions from Akahu for a given account, supporting pagination."""
    query_params = {}
    res = None
    total_txn = 0

    # If `last_reconciled_at` is None, use a default of the "start of time"
    if last_reconciled_at is None:
        start_of_time = "2024-01-01T00:00:00Z"  # Adjust this default as needed
        last_reconciled_at = start_of_time

    try:
        # Attempt to parse `last_reconciled_at`
        date_obj = datetime.datetime.strptime(last_reconciled_at, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        # Handle the scenario if parsing fails, fallback to a defined "start of time"
        logging.warning(f"Unable to parse `last_reconciled_at`. Using default start date: {start_of_time}")
        date_obj = datetime.datetime.strptime(start_of_time, "%Y-%m-%dT%H:%M:%SZ")

    # Subtract one week from the parsed date
    week_before_date_obj = date_obj - datetime.timedelta(days=7)
    week_before_date_str = week_before_date_obj.strftime("%Y-%m-%dT%H:%M:%SZ")
    query_params['start'] = week_before_date_str

    next_cursor = 'first_time'
    while next_cursor is not None:
        if next_cursor != 'first_time':
            query_params['cursor'] = next_cursor
        try:
            response = requests.get(f"{akahu_endpoint}/accounts/{akahu_account_id}/transactions", params=query_params, headers=akahu_headers)
            if response.status_code != 200:
                logging.error(f"Failed to fetch transactions for account {akahu_account_id}. Status code: {response.status_code}, Response: {response.text}")
                return None
            akahu_txn_json = response.json()
            akahu_txn = pd.DataFrame(akahu_txn_json['items'])
            if res is None:
                res = akahu_txn.copy()
            else:
                res = pd.concat([res, akahu_txn], ignore_index=True)
            num_txn = akahu_txn.shape[0]
            total_txn += num_txn
            next_cursor = akahu_txn_json['cursor']['next'] if 'cursor' in akahu_txn_json and 'next' in akahu_txn_json['cursor'] else None
        except Exception as e:
            logging.error(f"Error fetching transactions for account {akahu_account_id}: {e}")
            return None

    logging.info(f"Finished reading {total_txn} transactions from Akahu for account {akahu_account_id}")
    return res

# Fetch balance from Akahu
def get_akahu_balance(akahu_account_id):
    """Fetch the balance for an Akahu account."""
    try:
        response = requests.get(f"{akahu_endpoint}/accounts/{akahu_account_id}", headers=akahu_headers)
        if response.status_code != 200:
            logging.error(f"Failed to fetch balance for account {akahu_account_id}. Status code: {response.status_code}, Response: {response.text}")
            return None
        account_data = response.json()
        return account_data.get('balance')
    except Exception as e:
        logging.error(f"Error fetching balance for account {akahu_account_id}: {e}")
        return None

def get_actual_balance(actual, actual_account_id):
    """Fetch the balance for an Actual Budget account.

    Arguments:
    actual -- The initialized Actual Budget instance
    actual_account_id -- The ID of the Actual Budget account to fetch balance for
    """
    try:
        balance = actual.get_balance(actual_account_id)  # Assuming `get_balance` is a method in the Actual class
        logging.info(f"Balance fetched for Actual account ID {actual_account_id}: {balance}")
        return balance
    except Exception as e:
        logging.error(f"Failed to fetch balance for Actual account ID {actual_account_id}: {e}")
        return None





def load_transactions_into_actual(transactions, mapping_entry, actual):
    """Load transactions into Actual Budget using the mapping information."""
    if transactions is None or transactions.empty:
        logging.info("No transactions to load into Actual.")
        return

    # Use mapping_entry directly for required account information
    actual_account_id = mapping_entry['actual_account_id']

    # Initialize an empty list to track reconciled transactions
    imported_transactions = []

    # Iterate through transactions and reconcile them with Actual Budget
    for _, txn in transactions.iterrows():
        # Construct the transaction payload for reconciliation
        transaction_date = txn.get("date")
        payee_name = txn.get("description")
        notes = f"Akahu transaction: {txn.get('description')}"
        amount = decimal.Decimal(txn.get("amount") * -1)  # Convert to the required format (negative/positive)
        imported_id = txn.get("_id")
        cleared = True  # Assume all transactions are cleared; adjust if necessary

        # Use reconcile_transaction to reconcile or create the transaction in Actual
        try:
            reconciled_transaction = reconcile_transaction(
                actual.session(),  # Session from the Actual instance
                date=datetime.datetime.strptime(transaction_date, "%Y-%m-%d").date(),  # Convert to date object
                account=actual_account_id,
                payee=payee_name,
                notes=notes,
                amount=amount,
                imported_id=imported_id,
                cleared=cleared,
                imported_payee=payee_name,
                already_matched=imported_transactions
            )

            # Add the reconciled transaction to the imported_transactions list if it changed
            if reconciled_transaction.changed():
                imported_transactions.append(reconciled_transaction)

            # Log successful reconciliation
            logging.info(f"Successfully reconciled transaction: {imported_id}")

        except Exception as e:
            logging.error(f"Failed to reconcile transaction {imported_id} into Actual: {str(e)}")

    # Update the last synced datetime after processing all transactions
    mapping_entry['actual_synced_datetime'] = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def handle_tracking_account_actual(mapping_entry, actual):
    """
    Handle tracking accounts by checking and adjusting balances.

    Arguments:
    - mapping: The account mapping containing both Akahu and Actual account details.
    - actual: The initialized Actual instance (synchronous).
    """
    akahu_account_id = mapping_entry['akahu_id']
    actual_account_id = mapping_entry['actual_account_id']
    akahu_account_name = mapping_entry['akahu_name']
    actual_account_name = mapping_entry['actual_account_name']

    try:
        logging.info(f"Handling tracking account: {akahu_account_name} (Akahu ID: {akahu_account_id})")

        # Fetch Akahu balance
        akahu_balance = round(mapping_entry['akahu_balance'] * 100)  # Assume `akahu_balance` was pre-populated before this step

        # Fetch Actual balance using get_account_balance
        actual_balance = actual.get_account_balance(actual_account_id)

        # If the balances don't match, create an adjustment transaction
        if akahu_balance != actual_balance:
            adjustment_amount = decimal.Decimal(akahu_balance - actual_balance) / 100  # Convert to dollars
            transaction_date = datetime.datetime.utcnow().date()
            payee_name = "Balance Adjustment"
            notes = f"Adjusted from {actual_balance / 100} to {akahu_balance / 100} to reconcile tracking account."

            # Use create_transaction to create an adjustment in Actual
            create_transaction(
                actual.session(),
                date=transaction_date,
                account=actual_account_id,
                payee=payee_name,
                notes=notes,
                amount=adjustment_amount,
                imported_id=f"adjustment_{datetime.datetime.utcnow().isoformat()}",
                cleared=True,
                imported_payee=payee_name
            )

            logging.info(f"Created balance adjustment transaction for {akahu_account_name} with adjustment amount: {adjustment_amount}")

        else:
            logging.info(f"No balance adjustment needed for {akahu_account_name} (Akahu ID: {akahu_account_id})")

    except Exception as e:
        logging.error(f"Error handling tracking account {akahu_account_name} (Akahu ID: {akahu_account_id}): {str(e)}")

# Save updated mapping - basically just the date last synced
def save_updated_mapping():
    with open("akahu_to_budget_mapping.json", "w") as f:
        json.dump({"mapping": g_mapping_list}, f, indent=4)
        logging.info(f"Mapping updated and saved to akahu_to_actual_mapping.json")

# Main loop to process each budget and account
def main_loop(actual):
    """Main loop to process each Akahu account and load transactions into Actual Budget."""
    for mapping_entry in g_mapping_list:
        akahu_account_id = mapping_entry['akahu_id']
        actual_account_id = mapping_entry['actual_account_id']
        account_type = mapping_entry.get('account_type', 'On Budget')
        logging.info(f"Processing Akahu account: {akahu_account_id} linked to Actual account: {actual_account_id}")

        if account_type == 'Tracking':
            # Handle the tracking account balance adjustment using the `handle_tracking_account()` function
            handle_tracking_account_actual(mapping_entry, actual)
        elif account_type == 'On Budget':
            # Handle On-Budget account transactions
            last_reconciled_at = mapping_entry.get('actual_synced_datetime', '2024-01-01T00:00:00Z')
            akahu_df = get_all_akahu(akahu_account_id, last_reconciled_at)

            if akahu_df is not None and not akahu_df.empty:
                if SYNC_TO_AB:
                    # Sync to Actual Budget
                    load_transactions_into_actual(akahu_df, mapping_entry)
                if SYNC_TO_YNAB:
                    # Sync to YNAB
                    load_transactions_into_ynab(akahu_df, mapping_entry)
            else:
                logging.info(f"No new transactions found for Akahu account: {akahu_account_id}")

                # Update the last synced datetime after processing
                mapping_entry['actual_synced_datetime'] = datetime.datetime.utcnow().isoformat()
            else:
                logging.info(f"No new transactions found for Akahu account: {akahu_account_id}")
        else:
            logging.error(f"Unknown account type for Akahu account: {akahu_account_id}")

    # Save updated mapping after processing all accounts
    save_updated_mapping()

# Verify the signature of the incoming request
def verify_signature(public_key: str, signature: str, request_body: bytes) -> None:
    """Verify that the request body has been signed by Akahu.

    Arguments:
    public_key -- The PEM formatted public key retrieved from the Akahu API
    signature -- The base64 encoded value from the "X-Akahu-Signature" header
    request_body -- The raw bytes of the body sent by Akahu
    """
    try:
        public_key = serialization.load_pem_public_key(public_key.encode('utf-8'))
        public_key.verify(
            base64.b64decode(signature),
            request_body,
            padding.PKCS1v15(),
            hashes.SHA256()
        )
        logging.info("Webhook verification succeeded. This webhook is from Akahu!")
    except InvalidSignature:
        logging.error("Invalid webhook caller. Verification failed!")
        raise InvalidSignature("Invalid signature for webhook request")

# Flask app to handle webhook and sync events
app = Flask(__name__)

@app.route('/sync', methods=['GET'])
def run_full_sync():
    """Endpoint to run a full sync of all accounts."""
    with Actual(
            base_url=ENVs['ACTUAL_SERVER_URL'],
            password=ENVs['ACTUAL_PASSWORD'],
            file=ENVs['ACTUAL_SYNC_ID'],
            encryption_password=ENVs['ACTUAL_ENCRYPTION_KEY']
    ) as actual:
        logging.info("API initialized successfully for full sync.")
        actual.download_budget()
        logging.info("Budget downloaded successfully for full sync.")
        main_loop(actual)
    return jsonify({"status": "full sync complete"}), 200

@app.route('/status', methods=['GET'])
def status():
    """Endpoint to check if the webhook server is running."""
    return jsonify({"status": "Webhook server is running"}), 200

@app.route('/receive-transaction', methods=['POST'])
def receive_transaction():
    """Handle incoming webhook events from Akahu."""
    signature = request.headers.get("X-Akahu-Signature")
    public_key = ENVs['AKAHU_PUBLIC_KEY']
    request_body = request.data
    try:
        verify_signature(public_key, signature, request_body)
    except InvalidSignature:
        return jsonify({"status": "invalid signature"}), 400

    data = request.get_json()
    if data and "type" in data and data["type"] == "TRANSACTION_CREATED":
        transactions = data.get("item", [])
        with Actual(
                base_url=ENVs['ACTUAL_SERVER_URL'],
                password=ENVs['ACTUAL_PASSWORD'],
                file=ENVs['ACTUAL_SYNC_ID'],
                encryption_password=ENVs['ACTUAL_ENCRYPTION_KEY']
        ) as actual:
            logging.info("API initialized successfully for webhook event.")
            actual.download_budget()
            logging.info("Budget downloaded successfully for webhook event.")
            load_transactions_into_actual(pd.DataFrame([transactions]), g_mapping_list, mapping, actual)
        return jsonify({"status": "success"}), 200
    logging.info("/receive-transaction endpoint ignored as it is not a TRANSACTION_CREATED event.")
    return jsonify({"status": "ignored"}), 200

if __name__ == "__main__":
    if os.getenv('FLASK_ENV') == 'development':
        # Run the Flask app directly for development purposes
        app.run(host="0.0.0.0", port=5000, debug=True)
    else:
        # Production setup: Start Flask in a separate thread
        flask_thread = Thread(target=lambda: app.run(host="0.0.0.0", port=5000))
        flask_thread.daemon = True
        flask_thread.start()
        logging.info("Webhook server started and running.")
