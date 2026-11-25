import csv
import sqlite3
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

DB_PATH = Path("dummy_dataapp.db")
OUT_DIR = Path("dummy_excels")
OUT_DIR.mkdir(exist_ok=True)

def get_conn():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn

def main():
    conn = get_conn()
    cur = conn.cursor()
    
    # --- Setup Database for Blocked Scenario ---
    # Find 2 'Used' records and artificially set them to have 3 uses this month
    cur.execute("SELECT id, email, author_name, journal_name FROM data_scraping WHERE email_status = 'Used' LIMIT 3")
    blocked_records = cur.fetchall()
    
    today = date.today()
    # Create 3 timestamps for this month
    ts1 = datetime(today.year, today.month, 1, 10, 0, tzinfo=timezone.utc).isoformat()
    ts2 = datetime(today.year, today.month, 5, 11, 0, tzinfo=timezone.utc).isoformat()
    ts3 = datetime(today.year, today.month, 10, 12, 0, tzinfo=timezone.utc).isoformat()
    history_json = f'["{ts1}", "{ts2}", "{ts3}"]'
    
    for r in blocked_records:
        cur.execute(
            "UPDATE data_scraping SET used_at_history = ?, used_at = ? WHERE id = ?", 
            (history_json, ts3, r["id"])
        )
    conn.commit()
    
    # --- Fetch some existing data for Duplicates and Updatables ---
    cur.execute("SELECT email, author_name, journal_name, keyword, website, affiliation, date FROM data_scraping LIMIT 10")
    existing = cur.fetchall()
    
    headers = ["Email", "Author Name", "Article Title", "Journal Name", "Website", "Keyword", "Date", "Affiliation"]
    
    # --- Scenario 1: All New Data ---
    with open(OUT_DIR / "scenario1_all_new.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        for i in range(1, 11):
            writer.writerow([
                f"new_author_{i}@demo.com",
                f"Dr. New Author {i}",
                f"A novel study on Topic {i}",
                "Journal of Future Sciences",
                "scholar.google.com",
                "future tech",
                today.isoformat(),
                "University of Demo"
            ])
            
    # --- Scenario 2: Duplicates and Updatables ---
    with open(OUT_DIR / "scenario2_mixed.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        
        # 3 Exact Duplicates (same email, journal, keyword)
        for i in range(3):
            r = existing[i]
            writer.writerow([
                r["email"], r["author_name"], "Exact Duplicate Article Title", 
                r["journal_name"], r["website"], r["keyword"], r["date"], r["affiliation"]
            ])
            
        # 3 Updatables (same email, NEW journal and keyword)
        for i in range(3, 6):
            r = existing[i]
            writer.writerow([
                r["email"], r["author_name"], "New Research by Existing Author", 
                "A Completely New Journal", r["website"], "new keyword", today.isoformat(), r["affiliation"]
            ])
            
        # 3 Brand New
        for i in range(11, 14):
             writer.writerow([
                f"new_author_{i}@demo.com", f"Dr. New Author {i}", f"Topic {i}", 
                "Journal of Future Sciences", "scholar.google.com", "future tech", today.isoformat(), "University of Demo"
            ])
            
    # --- Scenario 3: Blocked Cases ---
    with open(OUT_DIR / "scenario3_blocked.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        
        # 2 Blocked Records (limit reached this month)
        for i in range(2):
            r = blocked_records[i]
            writer.writerow([
                r["email"], r["author_name"], "Another Paper Submission", 
                r["journal_name"], "pubmed.ncbi.nlm.nih.gov", "clinical trials", today.isoformat(), "Blocked University"
            ])
            
        # 3 Brand New
        for i in range(14, 17):
             writer.writerow([
                f"new_author_{i}@demo.com", f"Dr. New Author {i}", f"Topic {i}", 
                "Journal of Future Sciences", "scholar.google.com", "future tech", today.isoformat(), "University of Demo"
            ])

    print("Successfully generated 3 CSV files in dummy_excels/ directory!")

if __name__ == "__main__":
    main()
