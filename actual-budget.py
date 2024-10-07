import requests
from bs4 import BeautifulSoup
import json

class ActualBudgetWebScraper:
    def __init__(self, server_url, password):
        self.server_url = server_url
        self.password = password
        self.session = requests.Session()

    def login(self):
        login_url = f"{self.server_url}/login"
        data = {
            "password": self.password
        }
        response = self.session.post(login_url, data=data)
        print(f"Login status code: {response.status_code}")
        return response.status_code == 200

    def get_budget_data(self):
        budget_url = f"{self.server_url}/budget"
        response = self.session.get(budget_url)
        print(f"Budget page status code: {response.status_code}")
        
        if response.status_code == 200:
            soup = BeautifulSoup(response.text, 'html.parser')
            script_tags = soup.find_all('script')
            
            for script in script_tags:
                if script.string and 'window.__INITIAL_STATE__' in script.string:
                    state_json = script.string.split('window.__INITIAL_STATE__ = ')[1].split(';</script>')[0]
                    return json.loads(state_json)
        
        return None

def main():
    scraper = ActualBudgetWebScraper(
        server_url="https://certain-myna.pikapod.net",
        password="rqh!vrw9TAB"
    )

    if scraper.login():
        print("Login successful")
        budget_data = scraper.get_budget_data()
        if budget_data:
            print("Budget data extracted successfully")
            print(json.dumps(budget_data, indent=2))
        else:
            print("Failed to extract budget data")
    else:
        print("Login failed")

if __name__ == "__main__":
    main()