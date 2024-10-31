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
from actual.queries import create_transaction, get_account
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
    'AKAHU_PUBLIC_KEY',
    "YNAB_BEARER_TOKEN",
]

# Load environment variables into a dictionary for validation
ENVs = {key: os.getenv(key) for key in required_envs}
SYNC_TO_YNAB = True
SYNC_TO_AB = True

# Validate that all environment variables are loaded
for key, value in ENVs.items():
    if value is None:
        logging.error(f"Environment variable {key} is missing.")
        raise EnvironmentError(f"Missing required environment variable: {key}")

# YNAB API setup
ynab_endpoint = "https://api.ynab.com/v1/"
ynab_headers = {"Authorization": "Bearer " + ENVs["YNAB_BEARER_TOKEN"]}

# Akahu API setup
akahu_endpoint = "https://api.akahu.io/v1/"
akahu_headers = {
    "Authorization": "Bearer " + ENVs['AKAHU_USER_TOKEN'],
    "X-Akahu-ID": ENVs['AKAHU_APP_TOKEN']
}

# Load existing mapping from a JSON file
mapping_file = "akahu_to_budget_mapping.json"

def load_existing_mapping():
    """Load the mapping of Akahu accounts to Actual accounts from a JSON file."""
    if pathlib.Path(mapping_file).exists():
        with open(mapping_file, "r") as f:
            data = json.load(f)
            akahu_accounts = data.get('akahu_accounts', [])
            actual_accounts = data.get('actual_accounts', [])
            ynab_accounts = data.get('ynab_accounts', [])
            mapping = {entry['akahu_id']: entry for entry in data.get('mapping', [])}
            logging.info(f"Mapping loaded successfully from {mapping_file}")
            return akahu_accounts, actual_accounts, ynab_accounts, mapping
    else:
        logging.warning(f"Mapping file {mapping_file} not found. Returning empty mappings.")
    return [], [], [], []

# Load mapping at the start
g_akahu_accounts, g_actual_accounts, g_ynab_accounts, g_mapping_list = load_existing_mapping()

# Fetch all transactions from Akahu with pagination
def get_all_akahu(akahu_account_id, last_reconciled_at=None):
    """Fetch all transactions from Akahu for a given account, supporting pagination."""
    query_params = {}
    res = None
    total_txn = 0

    # If `last_reconciled_at` is provided, use it, otherwise use a default of the "start of time"
    if last_reconciled_at:
        query_params['start'] = last_reconciled_at
    else:
        start_of_time = "2024-01-01T00:00:00Z"  # Adjust this default as needed
        query_params['start'] = start_of_time

    next_cursor = 'first time'
    while next_cursor is not None:
        if next_cursor != 'first time':
            query_params['cursor'] = next_cursor

        try:
            # Actual API request to Akahu
            response = requests.get(
                f"{akahu_endpoint}/accounts/{akahu_account_id}/transactions",
                params=query_params,
                headers=akahu_headers
            )
            response.raise_for_status()
            akahu_txn_json = response.json()
        except requests.exceptions.RequestException as e:
            logging.error(f"Error occurred during Akahu API request: {str(e)}")
            break

        # Convert transactions to DataFrame
        akahu_txn = pd.DataFrame(akahu_txn_json.get('items', []))
        if res is None:
            res = akahu_txn.copy()
        else:
            res = pd.concat([res, akahu_txn])

        # Count the number of transactions fetched
        num_txn = akahu_txn.shape[0]
        total_txn += num_txn
        logging.info(f"Fetched {num_txn} transactions from Akahu.")

        # Handle pagination
        if num_txn == 0 or 'cursor' not in akahu_txn_json or 'next' not in akahu_txn_json['cursor']:
            next_cursor = None
        else:
            next_cursor = akahu_txn_json['cursor']['next']

    logging.info(f"Finished reading {total_txn} transactions from Akahu.")
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
        with actual.session() as session:
            # Fetch the account object using the session
            account = get_account(session, actual_account_id)
            if account is None:
                logging.error(f"Account '{actual_account_id}' not found.")
                return None

            # Access the balance_current property
            balance = account.balance_current
            logging.info(f"Balance fetched for Actual account '{actual_account_id}': {balance}")
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
        actual_balance = get_actual_balance(actual, actual_account_id)

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
    """Save the mapping of Akahu accounts, Actual accounts, and YNAB accounts to a JSON file."""
    with open("akahu_to_budget_mapping.json", "w") as f:
        json.dump({
            "akahu_accounts": g_akahu_accounts,
            "actual_accounts": g_actual_accounts,
            "ynab_accounts": g_ynab_accounts,
            "mapping": list(g_mapping_list.values())  # Convert the dictionary back to a list for saving
        }, f, indent=4)
        logging.info(f"Mapping updated and saved to akahu_to_budget_mapping.json")

# Main loop to process each budget and account
def load_transactions_into_ynab(akahu_txn, ynab_budget_id, ynab_account_id):
    """Save transactions from Akahu to YNAB."""
    uri = f"{ynab_endpoint}budgets/{ynab_budget_id}/transactions"
    transactions_list = akahu_txn.to_dict(orient='records')

    # Prepare the YNAB API payload
    ynab_api_payload = {
        "transactions": transactions_list
    }
    try:
        response = requests.post(uri, headers=ynab_headers, json=ynab_api_payload)

        # Check if the request was successful (status code 2xx)
        response.raise_for_status()

        # Parse the JSON response
        ynab_response = response.json()
        if 'duplicate_import_ids' in ynab_response['data'] and len(
                ynab_response['data']['duplicate_import_ids']) > 0:
            dup_str = f"Skipped {len(ynab_response['data']['duplicate_import_ids'])} duplicates"
        else:
            dup_str = "No duplicates"

        if len(ynab_response['data']['transactions']) == 0:
            logging.info(f"No new transactions loaded to YNAB - {dup_str}")
        else:
            logging.info(
                f"Successfully loaded {len(ynab_response['data']['transactions'])} transactions to YNAB - {dup_str}")

        return ynab_response

    except requests.exceptions.RequestException as e:
        # Handle request errors
        logging.error(f"Error making the API request to YNAB: {e}")
        if response is not None:
            logging.error(f"API response content: {response.text}")
        return None


def get_payee_name(row):
    """Extract the payee name from the given row, prioritizing the merchant name if available."""
    try:
        res = None
        if "merchant" in row and not pd.isna(row["merchant"]):
            if "name" in row["merchant"]:
                res = row['merchant']['name']
        if res is None:
            res = row['description']
    except (TypeError, ValueError) as e:
        logging.error(f"Error extracting payee name from row: {e}, row: {row}")
        res = "Unknown"
    return res


def convert_to_nzt(date_str):
    """Convert a given date string to New Zealand Time (NZT)."""
    try:
        if date_str is None:
            logging.warning("Input date string is None.")
            return None
        utc_time = datetime.datetime.strptime(date_str, "%Y-%m-%dT%H:%M:%SZ")
        nzt_time = utc_time + datetime.timedelta(hours=13)  # Assuming NZT is UTC+13; adjust for daylight saving if needed
        return nzt_time.strftime("%Y-%m-%d")
    except ValueError as e:
        logging.error(f"Error converting date string to NZT: {e}, date_str: {date_str}")
        return None


def clean_txn_for_ynab(akahu_txn, ynab_account_id):
    """Clean and transform Akahu transactions to prepare them for YNAB import."""
    # Extract payee names
    akahu_txn['payee_name'] = akahu_txn.apply(get_payee_name, axis=1)
    # Add memo field from the description
    akahu_txn['memo'] = akahu_txn['description']
    # Select and rename fields for YNAB compatibility
    akahu_txn_useful = akahu_txn[['_id', 'date', 'amount', 'memo', 'payee_name']].rename(columns={'_id': 'id'}, errors='ignore')
    # Format amount for YNAB (in thousandths of a unit)
    akahu_txn_useful['amount'] = akahu_txn_useful['amount'].apply(lambda x: str(int(x * 1000)))
    # Set all transactions as cleared
    akahu_txn_useful['cleared'] = 'cleared'
    # Convert dates to NZT
    akahu_txn_useful['date'] = akahu_txn_useful.apply(lambda row: convert_to_nzt(row['date']), axis=1)
    # Set import ID for YNAB to ensure transactions are unique
    akahu_txn_useful['import_id'] = akahu_txn_useful['id']
    # Optional: Add flag color to transactions for visibility
    akahu_txn_useful['flag_color'] = 'red'
    # Add the YNAB account ID
    akahu_txn_useful['account_id'] = ynab_account_id

    return akahu_txn_useful


def create_adjustment_txn_ynab(ynab_budget_id, ynab_account_id, akahu_balance, ynab_balance):
    """Create an adjustment transaction in YNAB to reconcile the balance between Akahu and YNAB."""
    try:
        balance_difference = akahu_balance - ynab_balance
        if balance_difference == 0:
            logging.info("No adjustment needed; balances are already in sync.")
            return
        uri = f"{ynab_endpoint}budgets/{ynab_budget_id}/transactions"
        transaction = {
            "transaction": {
                "account_id": ynab_account_id,
                "date": datetime.datetime.now().strftime("%Y-%m-%d"),
                "amount": balance_difference,
                "payee_name": "Balance Adjustment",
                "memo": f"Adjusted from ${ynab_balance/1000:.2f} to ${akahu_balance/1000:.2f} based on retrieved balance",
                "cleared": "cleared",
                "approved": True
            }
        }
        response = requests.post(uri, headers=ynab_headers, json=transaction)
        response.raise_for_status()
        logging.info(f"Created balance adjustment transaction for {balance_difference}")
    except requests.exceptions.RequestException as e:
        logging.error(f"Failed to create balance adjustment transaction: {e}")


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
                # Sync to Actual Budget if configured and relevant IDs are present
                if SYNC_TO_AB:
                    if mapping_entry.get('actual_budget_id') and mapping_entry.get('actual_account_id'):
                        # Sync to Actual Budget
                        load_transactions_into_actual(akahu_df, mapping_entry)
                    else:
                        logging.warning(
                            f"Skipping sync to Actual Budget for Akahu account {akahu_account_id}: Missing Actual Budget IDs.")

                # Sync to YNAB if configured and relevant IDs are present
                if SYNC_TO_YNAB:
                    if mapping_entry.get('ynab_budget_id') and mapping_entry.get('ynab_account_id'):
                        # Sync to YNAB
                        load_transactions_into_ynab(akahu_df, mapping_entry['ynab_budget_id'], mapping_entry['ynab_account_id'])
                    else:
                        logging.warning(
                            f"Skipping sync to YNAB for Akahu account {akahu_account_id}: Missing YNAB IDs.")
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
