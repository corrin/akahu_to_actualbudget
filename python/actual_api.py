from actual import Actual


class ActualAPI:
    def __init__(self, server_url, password):
        self.server_url = server_url
        self.password = password
        self.actual = None

    def initialize(self):
        print(f"Initializing API with server URL: {self.server_url}")
        self.actual = Actual(base_url=self.server_url, password=self.password)

    def set_file(self):
        if not self.actual:
            raise RuntimeError("Actual API is not initialized.")
        user_files = self.actual.list_user_files()
        if user_files.data:
            self.actual.set_file(user_files.data[0])
            print(f"File set to: {user_files.data[0]['name']}")
        else:
            raise RuntimeError("No user files available to set.")

    def download_budget(self, encryption_key):
        if not self.actual:
            raise RuntimeError("Actual API is not initialized.")
        if not encryption_key:
            raise ValueError("Encryption key is required to download the budget.")
        try:
            self.actual.download_budget(self.actual.file, password=encryption_key)
            print("Budget downloaded successfully.")
        except Exception as e:
            raise RuntimeError(f"Error downloading budget: {e}")

    def get_accounts(self):
        if not self.actual:
            raise RuntimeError("Actual API is not initialized.")
        try:
            accounts = self.actual.get_accounts()
            open_accounts = [acc for acc in accounts if not acc.closed]
            print(f"Fetched {len(open_accounts)} open Actual accounts.")
            return open_accounts
        except Exception as e:
            raise RuntimeError(f"Error fetching accounts: {e}")

    def get_account_balance(self, account_id):
        if not self.actual:
            raise RuntimeError("Actual API is not initialized.")
        try:
            accounts = self.get_accounts()
            for account in accounts:
                if account['id'] == account_id:
                    return account['balance']
            raise ValueError(f"Account with ID {account_id} not found.")
        except Exception as e:
            raise RuntimeError(f"Error fetching balance for account {account_id}: {e}")

    def import_transactions(self, account_id, transactions):
        if not self.actual:
            raise RuntimeError("Actual API is not initialized.")
        try:
            result = self.actual.import_transactions(account_id, transactions)
            print(f"Imported {len(transactions)} transactions for account {account_id}.")
            return result
        except Exception as e:
            raise RuntimeError(f"Error importing transactions for account {account_id}: {e}")
