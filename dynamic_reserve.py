import requests
import json
import uuid
import hmac
import hashlib
import time
import getpass
from datetime import date, datetime, timedelta
import urllib3
import os

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

class MealAutomator:
    WEBETU_BASE = "https://api-webetu.mesrs.dz"
    ONOU_BASE = "https://gs-api.onou.dz"
    HMAC_SECRET = "pUzHUW2WX54uCzhO8JC2eQ6g1Ol21upw"
    
    def __init__(self, username, password):
        self.username = username
        self.password = password
        self.session = requests.Session()
        self.session.verify = False
        
        self.uuid = None
        self.token = None           # WebEtu Token
        self.onou_token = None    # ONOU Bearer token
        self.wilaya = None
        self.residence = None
        self.id_depot = None
        self.id_individu = None
        self.id_dia = None

    def sign_request(self, body=""):
        timestamp = str(int(datetime.now().timestamp()))
        nonce = str(uuid.uuid4())
        signing_string = f"{timestamp}|{nonce}|{body}"
        sig = hmac.new(self.HMAC_SECRET.encode('utf-8'), signing_string.encode('utf-8'), hashlib.sha256).hexdigest()
        return timestamp, nonce, sig

    def get_webetu_headers(self, token=None, body="", include_dia_ind_headers=False):
        ts, nonce, sig = self.sign_request(body)
        headers = {
            "Content-Type": "application/json", 
            "X-Timestamp": ts, 
            "X-Nonce": nonce, 
            "X-Signature": sig,
            "User-Agent": "okhttp/4.9.2"
        }
        if token: 
            headers["authorization"] = token
            
        if include_dia_ind_headers:
            if self.id_dia:
                headers["X-DIA-ID"] = self.id_dia
            if self.id_individu:
                headers["X-IND-ID"] = self.id_individu
                
        return headers

    def get_onou_headers(self, body=""):
        ts, nonce, sig = self.sign_request(body)
        headers = {
            "Content-Type": "application/json", 
            "X-Timestamp": ts, 
            "X-Nonce": nonce, 
            "X-Signature": sig,
            "User-Agent": "okhttp/4.9.2"
        }
        if self.onou_token:
            headers["authorization"] = f"Bearer {self.onou_token}"
        return headers

    def run_full_process(self, dates, meal_types=[1, 2, 3]):
        print(f"Starting process for {self.username}")
        self.login()
        if not self.token: return
        
        # Hardcoding as per the reference script
        self.wilaya = "22"
        self.residence = "0"
        self.id_depot = 269
        print(f"  [+] Wilaya: {self.wilaya}, Residence: {self.residence}, Depot: {self.id_depot}")
        
        self.get_onou_exchange_token()
        if not self.onou_token: return
        
        # Skip dynamic fetch since it's hardcoded
        # self.get_depot()
        if not self.id_depot: return
        
        self.reserve_meals(dates, meal_types)
        self.get_reservations()

    def login(self):
        print("[*] 1. Logging into WebEtu...")
        login_body = json.dumps({"username": self.username, "password": self.password})
        url = f"{self.WEBETU_BASE}/api/authentication/v1/"
        
        res = self.session.post(url, headers=self.get_webetu_headers(body=login_body), data=login_body)
        if not res.ok:
            print(f"  [!] WebEtu login failed: {res.status_code}\n{res.text}")
            return
            
        data = res.json()
        self.uuid = data.get("uuid")
        self.token = data.get("token")
        self.id_individu = str(data.get("idIndividu") or data.get("data", {}).get("idIndividu") or "")
        print(f"  [+] Success! UUID: {self.uuid}, IndivId: {self.id_individu}")


    def get_onou_exchange_token(self):
        print("[*] 3. Exchanging token with ONOU...")
        onou_params = {
            "uuid": self.uuid, 
            "wilaya": self.wilaya, 
            "residence": self.residence, 
            "token": self.token
        }
        
        url = f"{self.ONOU_BASE}/api/loginpwebetu"
        res = self.session.post(url, params=onou_params, headers=self.get_webetu_headers(token=self.token, include_dia_ind_headers=True))
        
        if res.ok:
            self.onou_token = res.json().get("token") or res.json().get("access_token") or res.json().get("data", {}).get("access_token")
            print("  [+] ONOU Token successfully acquired!")
        else:
            print(f"  [!] ONOU Token Exchange Failed: {res.status_code}\n{res.text}")

    def get_depot(self):
        print("[*] 4. Fetching Depot ID...")
        url = f"{self.ONOU_BASE}/api/getdepotres"
        params = {"uuid": self.uuid, "wilaya": self.wilaya, "residence": self.residence, "token": self.onou_token}
        res = self.session.get(url, params=params, headers=self.get_onou_headers(body=""))
        
        if res.ok:
            data = res.json()
            if isinstance(data, list) and data:
                self.id_depot = data[0].get("idDepot") or data[0].get("depotId") or data[0].get("id")
            elif isinstance(data, dict):
                self.id_depot = data.get("depots", [{}])[0].get("idDepot") or data.get("depots", [{}])[0].get("id") or data.get("idDepot")
            
        if self.id_depot:
            print(f"  [+] Depot loaded: {self.id_depot}")
        else:
            print("  [-] Depot lookup failed.")

    def reserve_meals(self, dates, meal_types):
        print(f"[*] 5. Making reservations for {dates}...")
        details = []
        for d in dates:
            for m_type in meal_types:
                meal_detail = {
                    "date_reserve": d,
                    "menu_type": m_type,
                    "idDepot": self.id_depot
                }
                details.append(json.dumps(meal_detail, separators=(",", ":")))
            
        payload = {
            "uuid": self.uuid, 
            "wilaya": self.wilaya, 
            "residence": self.residence, 
            "token": self.onou_token,
            "details": details
        }
        
        payload_json = json.dumps(payload, separators=(",", ":"))
        
        url = f"{self.ONOU_BASE}/api/reservemeal"
        
        res = self.session.post(url, headers=self.get_onou_headers(body=payload_json), data=payload_json)
        if res.ok:
            print(f"  [+] Successfully submitted reservations!")
        else:
            print(f"  [!] Failed reservation: HTTP {res.status_code}\n{res.text}")

    def get_reservations(self):
        print("[*] 6. Viewing active reservations...")
        url = f"{self.ONOU_BASE}/api/meal-reservations/student"
        params = {"uuid": self.uuid, "wilaya": self.wilaya, "residence": self.residence, "token": self.onou_token}
        res = self.session.get(url, params=params, headers=self.get_onou_headers(body=""))
        
        if res.ok:
            data = res.json().get("data", [])
            print(f"  [+] Found {len(data)} Current Reservations:")
            for item in data:
                date_res = item.get("date_reserve")
                meal = item.get("mealtype_fr")
                depot = item.get("depot_fr", "").strip()
                can_cancel = "Yes" if item.get("candelete") else "No"
                print(f"      - {date_res} | {meal:<15} | {depot} | Cancelable: {can_cancel}")
        else:
            print(f"  [!] Failed to fetch reservations: HTTP {res.status_code}")

if __name__ == "__main__":
    print("=== Meal Reservation Automator ===")
    USERNAME = input("Enter WebEtu Student ID: ").strip()
    PASSWORD = getpass.getpass("Enter WebEtu Password: ").strip()
    
    if not USERNAME or not PASSWORD:
        print("[!] Username and Password are required. Exiting...")
        exit(1)
    
    # Calculate the next 3 days starting from tomorrow
    today = date.today()
    dates_to_reserve = [(today + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(1, 4)]
    
    automator = MealAutomator(USERNAME, PASSWORD)
    automator.run_full_process(dates_to_reserve, meal_types=[1, 2, 3])
