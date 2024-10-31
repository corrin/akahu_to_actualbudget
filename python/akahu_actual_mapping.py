import os
import pathlib
import logging
import json
from datetime import datetime

import requests
from dotenv import load_dotenv
from actual import Actual
from actual.queries import (
    get_account,
    get_accounts,
    get_ruleset,
    get_transactions,
    reconcile_transaction,
)
from fuzzywuzzy import fuzz
from fuzzywuzzy import process

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
akahu_user_token = os.getenv("AKAHU_USER_TOKEN")
akahu_app_token = os.getenv("AKAHU_APP_TOKEN")

# Verify the required environment variables are set
if not server_url or not password or not encryption_key or not actual_sync_id or not akahu_user_token or not akahu_app_token:
    logging.error(
        "Missing one or more required environment variables: ACTUAL_SERVER_URL, ACTUAL_PASSWORD, ACTUAL_ENCRYPTION_KEY, ACTUAL_SYNC_ID, AKAHU_USER_TOKEN, AKAHU_APP_TOKEN")
    raise ValueError("Missing required environment variables")

# Akahu API setup
akahu_endpoint = "https://api.akahu.io/v1/"
akahu_headers = {
    "Authorization": "Bearer " + akahu_user_token,
    "X-Akahu-ID": akahu_app_token
}


# Load existing mapping from a JSON file
def load_existing_mapping(mapping_file="akahu_to_budget_mapping.json"):
    if pathlib.Path(mapping_file).exists():
        with open(mapping_file, "r") as f:
            data = json.load(f)
            akahu_accounts = data.get('akahu_accounts', [])
            actual_accounts = data.get('actual_accounts', [])
            mapping = {entry['akahu_id']: entry for entry in data.get('mapping', [])}
            return akahu_accounts, actual_accounts, mapping
    return [], [], {}


# Validate the existing mapping
def merge_and_update_mapping(existing_mapping, latest_akahu_accounts, latest_actual_accounts, existing_akahu_accounts, existing_actual_accounts):
    # This function is designed to validate the mapping (removing old/redundant entries).
    # For now i've taken some shortcuts and it ignores the old values
    # It also converts the Akahu and Actual accounts to dictionaries if they are Pydantic models.   That allows me to add in date_first_loaded

    # Convert Akahu and Actual accounts to dictionaries if they are Pydantic models
    latest_akahu_accounts = [acc.dict() if hasattr(acc, 'dict') else acc for acc in latest_akahu_accounts]
    latest_actual_accounts = [actual.model_dump() if hasattr(actual, 'dict') else actual for actual in latest_actual_accounts]

    # Ensure every Akahu account has 'date_first_loaded'
    for akahu in latest_akahu_accounts:
        if 'date_first_loaded' not in akahu:
            akahu['date_first_loaded'] = datetime.now().isoformat()

    # Ensure every Actual account has 'date_first_loaded'
    for actual in latest_actual_accounts:
        if 'date_first_loaded' not in actual:
            actual['date_first_loaded'] = datetime.now().isoformat()

    # Validate Akahu accounts in the existing mapping
    akahu_accounts_to_remove = []
    for akahu_id in existing_mapping.keys():
        if akahu_id not in [acc['id'] for acc in latest_akahu_accounts]:
            logging.warning(f"Warning: Removing Akahu account '{akahu_id}' from mapping as it no longer exists in the latest Akahu accounts.")
            akahu_accounts_to_remove.append(akahu_id)
    for akahu_id in akahu_accounts_to_remove:
        del existing_mapping[akahu_id]

    # Validate Actual accounts in the existing mapping
    actual_accounts_to_remove = []
    for akahu_id, mapping_entry in existing_mapping.items():
        actual_account_id = mapping_entry["actual_account_id"]
        if actual_account_id not in [acc['id'] for acc in latest_actual_accounts]:
            logging.warning(f"Warning: Removing Actual account '{actual_account_id}' from mapping as it no longer exists in the latest Actual accounts.")
            actual_accounts_to_remove.append(akahu_id)
    for akahu_id in actual_accounts_to_remove:
        del existing_mapping[akahu_id]

    # Filter out any outdated Akahu or Actual accounts that should no longer be considered
    updated_akahu_accounts = [acc for acc in latest_akahu_accounts if acc['id'] not in akahu_accounts_to_remove]
    updated_actual_accounts = [acc for acc in latest_actual_accounts if acc['id'] not in actual_accounts_to_remove]

    return existing_mapping, updated_akahu_accounts, updated_actual_accounts



# Fetch Akahu accounts using the Akahu API
def fetch_akahu_accounts():
    logging.info("Fetching Akahu accounts...")
    response = requests.get(f"{akahu_endpoint}/accounts", headers=akahu_headers)
    if response.status_code != 200:
        logging.error(f"Failed to fetch Akahu accounts: {response.status_code} {response.text}")
        raise RuntimeError(f"Failed to fetch Akahu accounts: {response.status_code}")

    accounts_data = response.json().get("items", [])
    akahu_accounts = [{"id": acc["_id"], "name": acc["name"],
                       "connection": acc.get("connection", {}).get("name", "Unknown Connection")} for acc in
                      accounts_data]
    logging.info(f"Fetched {len(akahu_accounts)} Akahu accounts.")
    return akahu_accounts


# Interactive matching of accounts
from fuzzywuzzy import process

def match_accounts(existing_mapping, akahu_accounts, actual_accounts):
    logging.info("Matching Akahu accounts with Actual accounts using user input...")
    mapping = existing_mapping.copy()  # Start with the existing mapping

    actual_account_names = {actual['id']: actual['name'] for actual in actual_accounts}
    actual_account_types = {actual['id']: "Tracking" if actual['offbudget'] else "On Budget" for actual in actual_accounts}
    sorted_actual_accounts = sorted(actual_account_names.items(), key=lambda x: x[1])

    for akahu in akahu_accounts:
        akahu_id = akahu["id"]

        # Skip matching if the Akahu account is already mapped
        if akahu_id in mapping:
            mapped_actual_id = mapping[akahu_id]['actual_account_id']
            logging.info(f"Akahu account '{akahu['name']}' is already mapped to Actual account '{actual_account_names.get(mapped_actual_id, 'unknown')}'. Skipping.")
            continue

        combined_akahu_name = f"{akahu['connection']} {akahu['name']}"
        print(f"""Akahu Connection: {akahu['connection']} Account: {akahu['name']} (Account No: {akahu.get('account_number', 'N/A')})""")
        print("Available Actual accounts:")

        # Display all Actual accounts, indicating if already mapped
        for idx, (actual_id, actual_name) in enumerate(sorted_actual_accounts, start=1):
            if actual_id in [entry['actual_account_id'] for entry in mapping.values()]:
                mapped_akahu = [entry for entry in mapping.values() if entry['actual_account_id'] == actual_id][0]
                mapped_status = f"(already mapped to Akahu account '{mapped_akahu['akahu_name']}')"
            else:
                mapped_status = ""
            print(f"{idx}. {actual_name} {mapped_status}")

        # Suggest the closest match using fuzzy matching if score is above threshold and the account is not already mapped
        unmapped_actual_account_names = [actual_name for actual_id, actual_name in sorted_actual_accounts if actual_id not in [entry['actual_account_id'] for entry in mapping.values()]]
        if unmapped_actual_account_names:
            suggested_match, score = process.extractOne(combined_akahu_name, unmapped_actual_account_names)
            if score > 60:  # Only suggest if the score is above 60
                suggested_index = next((idx for idx, (actual_id, actual_name) in enumerate(sorted_actual_accounts, start=1) if actual_name == suggested_match), None)
                if suggested_index is not None:
                    print(f"Suggestion - {suggested_index}. {suggested_match}")

        # Prompt user for input
        user_choice = input("Enter the number of the matching Actual account (or press Enter to skip): ")
        if user_choice.isdigit() and 1 <= int(user_choice) <= len(sorted_actual_accounts):
            selected_index = int(user_choice) - 1
            selected_actual_id, selected_actual_name = sorted_actual_accounts[selected_index]
            if selected_actual_id not in [entry['actual_account_id'] for entry in mapping.values()]:
                account_type = actual_account_types[selected_actual_id]
                mapping[akahu_id] = {
                    "actual_budget_name": "Household Budget",  # Placeholder, modify accordingly
                    "actual_account_name": selected_actual_name,
                    "account_type": account_type,
                    "akahu_name": akahu["name"],
                    "akahu_id": akahu_id,
                    "actual_budget_id": os.getenv("ACTUAL_SYNC_ID"),  # Use ACTUAL_SYNC_ID from environment
                    "actual_account_id": selected_actual_id,
                    "note": None,  # Set note to None to match expected output format
                    "matched_date": datetime.now().isoformat()  # Add the date it was matched
                }
                logging.info(f"User matched Akahu account '{akahu['name']}' with Actual account '{selected_actual_name}'")
            else:
                logging.warning(
                    f"User attempted to match Akahu account '{akahu['name']}' with already mapped Actual account '{selected_actual_name}', which is not allowed.")
        elif user_choice == '':
            logging.info(f"User chose not to match Akahu account '{akahu['name']}'")
        else:
            logging.warning(f"Invalid input for Akahu account '{akahu['name']}'. No match made.")

    return mapping


def save_mapping(existing_mapping, akahu_accounts, actual_accounts, mapping_file="akahu_to_budget_mapping.json"):
    data = {
        "akahu_accounts": akahu_accounts,
        "actual_accounts": actual_accounts,
        "mapping": list(existing_mapping.values())
    }
    with open(mapping_file, "w") as f:
        json.dump(data, f, indent=4)
    logging.info("New mapping saved successfully.")


# Initialize and use the Actual class directly
def main():
    logging.info("Starting Actual API integration script.")

    try:
        # Initialize Actual API with all necessary details
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

            # Step 0: Load existing mapping and validate
            (existing_akahu_accounts, existing_actual_accounts, existing_mapping) = load_existing_mapping()

            # Step 1: Fetch Akahu accounts
            latest_akahu_accounts = fetch_akahu_accounts()

            # Step 2: Fetch Actual Budget accounts using the API instance
            latest_actual_accounts = get_accounts(actual.session)
            open_actual_accounts = [acc for acc in latest_actual_accounts if not acc.closed]
            logging.info(f"Fetched {len(open_actual_accounts)} open Actual accounts retrieved.")

            # Step 3: Validate and update existing mapping
            (existing_mapping, akahu_accounts, actual_accounts) = merge_and_update_mapping(
                existing_mapping,
                latest_akahu_accounts,
                open_actual_accounts,
                existing_akahu_accounts,
                existing_actual_accounts
            )
            # Step 4: Match accounts interactively
            new_mapping = match_accounts(existing_mapping, akahu_accounts, actual_accounts)

            # Step 5: Output proposed mapping and save
            save_mapping(new_mapping, akahu_accounts, actual_accounts)

    except Exception as e:
        logging.exception("An unexpected error occurred during script execution.")


if __name__ == "__main__":
    main()
