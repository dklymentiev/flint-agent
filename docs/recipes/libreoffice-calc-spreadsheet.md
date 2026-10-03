# Recipe: Create spreadsheet in LibreOffice Calc

## Strategy: Clipboard paste (fast, reliable)

GUI navigation is unreliable. Use clipboard paste instead of cell-by-cell typing.

### Steps

1. **Prepare data as TSV (tab-separated values)**
   ```
   desktop_shell: printf "Header1\tHeader2\tHeader3\nVal1\tVal2\tVal3\n..." | xclip -selection clipboard
   ```

2. **Launch LibreOffice Calc**
   ```
   desktop_shell: DISPLAY=:99 soffice --calc &
   ```
   Wait 3-5 seconds for it to load.

3. **Dismiss dialogs**
   - "Tip of the Day" → press Return
   - "Recovery" → press Escape
   - Take screenshot to verify Calc is open and ready

4. **Paste data**
   ```
   desktop_key: ctrl+v
   ```
   If Text Import dialog appears → press Return (Tab separator is default, correct)

5. **Add formulas**
   - Click target cell (use look → click workflow)
   - Type formula: `=SUM(C2:C11)` then Return
   - OR: paste formula via clipboard

6. **Save as xlsx**
   ```
   desktop_key: ctrl+shift+s
   ```
   - Type filename in Name field (Ctrl+A first to select existing text)
   - Tab to File type dropdown, select "Excel 2007-365 (.xlsx)"
   - Navigate to Desktop folder
   - Press Enter to save
   - If format confirmation → Alt+Y (Use Excel Format)

7. **Verify**
   - `desktop_shell: ls -la ~/Desktop/filename.xlsx`
   - Take screenshot and use desktop_look on the SUM cell

## Alternative: Python script (no GUI needed)

```
desktop_shell: cat > /tmp/create_spreadsheet.py << 'PYEOF'
import subprocess
subprocess.run(["pip3", "install", "openpyxl"], capture_output=True)
from openpyxl import Workbook
wb = Workbook()
ws = wb.active
ws.append(["Date", "Category", "Amount"])
data = [
    ["2026-03-01", "Groceries", 85.50],
    ["2026-03-02", "Rent", 1200.00],
    # ... more rows
]
for row in data:
    ws.append(row)
last_row = len(data) + 1
ws.append(["", "TOTAL", f"=SUM(C2:C{last_row})"])
wb.save("/home/screenbox/Desktop/expenses.xlsx")
print("Saved!")
PYEOF
python3 /tmp/create_spreadsheet.py
```

## Common pitfalls

- LibreOffice binary name: `soffice --calc`, not `libreoffice --calc`
- Always set DISPLAY=:99 for GUI apps
- No sudo — use desktop_manage(install) for packages
- Save As dialog: keyboard navigation (Tab, Enter) more reliable than clicking
- After paste, verify data landed in correct cells — take screenshot
