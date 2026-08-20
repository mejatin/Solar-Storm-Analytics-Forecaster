"""
parse_html_omni.py
Extracts numeric data lines from the HTML OMNIWeb response files
and saves clean txt files ready for the main pipeline.
"""

import os, re

RAW_DIR   = "omni_data"
CLEAN_DIR = "omni_clean"
os.makedirs(CLEAN_DIR, exist_ok=True)

files = sorted([f for f in os.listdir(RAW_DIR)
                if f.startswith("omni_chunk_") and f.endswith(".txt")])

print(f"Found {len(files)} HTML files\n")

for fname in files:
    src  = os.path.join(RAW_DIR, fname)
    dst  = os.path.join(CLEAN_DIR, fname)
    year = fname.replace("omni_chunk_","").replace(".txt","")

    data_lines = []
    in_pre = False

    with open(src, encoding="utf-8", errors="ignore") as f:
        for line in f:
            # enter/exit <pre> block
            if "<pre>" in line.lower():
                in_pre = True
                continue
            if "</pre>" in line.lower():
                in_pre = False
                continue

            if not in_pre:
                continue

            line = line.rstrip("\n")

            # skip blank lines and header/label lines
            if not line.strip():
                continue

            # data lines start with a 4-digit year
            parts = line.split()
            if parts and re.match(r"^\d{4}$", parts[0]):
                data_lines.append(line)

    with open(dst, "w", encoding="utf-8") as f:
        f.write("\n".join(data_lines))

    print(f"{year}: {len(data_lines):,} lines → {dst}")

print("\nDone. Now point your pipeline RAW_DIR to 'omni_clean'.")