import os
import requests

class AkahuAPI:
    def __init__(self, app_token, user_token):
        self.app_token = app_token
        self.user_token = user_token
        self.base_url = os.getenv("ACTUAL_SERVER_URL")  # Updated to the real Akahu API base URL

    def get_transactions(self, account_id, start_date=None):
        url = f"{self.base_url}/v1/accounts/{account_id}/transactions"
        headers = {
            "accept": "application/json",
            "Authorization": f"Bearer {self.app_token}"
        }
        params = {}
        if start_date:
            params['start'] = start_date
        try:
            response = requests.get(url, headers=headers, params=params)
            response.raise_for_status()
            return response.json()
        except requests.RequestException as e:
            raise RuntimeError(f"Error fetching transactions: {e}")

    def fetch_accounts(self):
        url = f"{self.base_url}/v1/accounts"
        headers = {
            "accept": "application/json",
            "Authorization": f"Bearer {self.app_token}"
        }
        try:
            response = requests.get(url, headers=headers)
            response.raise_for_status()
            accounts = response.json().get('items', [])
            print(f"Fetched {len(accounts)} Akahu accounts.")
            return accounts
        except requests.RequestException as e:
            raise RuntimeError(f"Error fetching Akahu accounts: {e}")

    def fetch_transactions_paginated(self, account_id, start_date):
        all_transactions = []
        next_cursor = None

        try:
            while True:
                url = f"{self.base_url}/v1/accounts/{account_id}/transactions"
                headers = {
                    "accept": "application/json",
                    "Authorization": f"Bearer {self.app_token}"
                }
                params = {
                    "start": start_date,
                    "cursor": next_cursor
                }
                response = requests.get(url, headers=headers, params=params)
                response.raise_for_status()
                data = response.json()

                transactions = data.get('items', [])
                all_transactions.extend(transactions)
                next_cursor = data.get('cursor', {}).get('next')

                if not next_cursor:
                    break

            print(f"Fetched {len(all_transactions)} transactions for account {account_id}.")
            return all_transactions
        except requests.RequestException as e:
            raise RuntimeError(f"Error fetching paginated transactions for account {account_id}: {e}")
