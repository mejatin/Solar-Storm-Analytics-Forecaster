"""
NASA OMNI High Resolution Data Downloader
==========================================
Downloads ALL years (1995-2026) of New HRO OMNI data
in 1-year chunks to respect the 600,000 record limit.
Saves each chunk as a .txt file and merges into one CSV + Parquet.
"""

import requests
import pandas as pd
import time
import os

# ─────────────────────────────────────────────
# CONFIGURATION
# ─────────────────────────────────────────────

OUTPUT_DIR    = "omni_data"
FINAL_CSV     = "omni_all_years.csv"
FINAL_PARQUET = "omni_all_years.parquet"

# All variable numbers for New HRO OMNI (definitive/modified version)
ALL_VARS = [
    1,   # IMF Spacecraft ID
    2,   # Plasma Spacecraft ID
    3,   # # Fine Scale Points in IMF Avgs
    4,   # # Fine Scale Points in Plasma Avgs
    5,   # Percent interpolated
    6,   # Timeshift, sec
    7,   # Sigma Timeshift
    8,   # Sigma Min_var_vector
    9,   # Time btwn observations, sec
    10,  # IMF Magnitude Avg (Scalar), nT   ← |B|
    11,  # Bx, GSE/GSM, nT
    12,  # By, GSE, nT
    13,  # Bz, GSE, nT
    14,  # By, GSM, nT
    15,  # Bz, GSM, nT                      ← KEY: southward IMF
    16,  # Sigma in IMF Magnitude Avg
    17,  # Sigma in IMF Vector Avg
    18,  # Flow Speed, km/sec               ← solar wind speed
    19,  # Vx Velocity, GSE, km/s
    20,  # Vy Velocity, GSE, km/s
    21,  # Vz Velocity, GSE, km/s
    22,  # Proton Density, n/cc             ← density
    23,  # Proton Temperature, K            ← temperature
    24,  # Flow Pressure, nPa               ← dynamic pressure
    25,  # Electric Field, mV/m
    26,  # Plasma Beta
    27,  # Alfven Mach Number
    28,  # Magnetosonic Mach Number
    29,  # Spacecraft X, GSE, Re
    30,  # Spacecraft Y, GSE, Re
    31,  # Spacecraft Z, GSE, Re
    32,  # BSN location X, GSE, Re
    33,  # BSN location Y, GSE, Re
    34,  # BSN location Z, GSE, Re
    35,  # AE Index, nT
    36,  # AL Index, nT
    37,  # AU Index, nT
    38,  # SYM/D, nT
    39,  # SYM/H, nT                        ← Dst proxy
    40,  # ASY/D, nT
    41,  # ASY/H, nT
    42,  # Polar Cap (PC) index
    43,  # Na/Np Ratio
]

# Column names: 4 time cols + 43 variable cols = 47 total (matches file!)
COLUMN_NAMES = [
    "year", "day", "hour", "minute",      # always first 4
    "imf_spacecraft_id",
    "plasma_spacecraft_id",
    "n_fine_imf",
    "n_fine_plasma",
    "pct_interpolated",
    "timeshift_sec",
    "sigma_timeshift",
    "sigma_min_var",
    "time_btwn_obs_sec",
    "imf_mag_scalar_nT",
    "bx_gse_gsm_nT",
    "by_gse_nT",
    "bz_gse_nT",
    "by_gsm_nT",
    "bz_gsm_nT",                          # KEY southward IMF
    "sigma_imf_mag",
    "sigma_imf_vec",
    "flow_speed_kms",
    "vx_gse_kms",
    "vy_gse_kms",
    "vz_gse_kms",
    "proton_density_ncc",
    "proton_temp_K",
    "flow_pressure_nPa",
    "electric_field_mVm",
    "plasma_beta",
    "alfven_mach",
    "magnetosonic_mach",
    "sc_x_gse_Re",
    "sc_y_gse_Re",
    "sc_z_gse_Re",
    "bsn_x_gse_Re",
    "bsn_y_gse_Re",
    "bsn_z_gse_Re",
    "ae_index_nT",
    "al_index_nT",
    "au_index_nT",
    "sym_d_nT",
    "sym_h_nT",
    "asy_d_nT",
    "asy_h_nT",
    "pc_index",
    "na_np_ratio",
]
# Total = 4 + 43 = 47 columns ✓

# OMNI fill/missing value markers → replaced with NaN
FILL_VALUES = [999.9, 9999.0, 99999.0, 9999.99, 99999.9,
               9999999.0, 999.99, 99.99, 9999, 99999]


# ─────────────────────────────────────────────
# CHUNK GENERATOR: 1 year per chunk
# ─────────────────────────────────────────────

def generate_chunks(start_year=1995, end_year=2026):
    chunks = []
    for year in range(start_year, end_year + 1):
        if year < end_year:
            chunks.append((f"{year}0101", f"{year}1231",
                           f"omni_chunk_{year}.txt"))
        else:
            chunks.append((f"{year}0101", "20260601",
                           f"omni_chunk_{year}.txt"))
    return chunks


# ─────────────────────────────────────────────
# DOWNLOAD ONE CHUNK
# ─────────────────────────────────────────────

def download_chunk(start_date, end_date, filename, retries=3):
    filepath = os.path.join(OUTPUT_DIR, filename)

    # Skip already-downloaded files
    if os.path.exists(filepath) and os.path.getsize(filepath) > 10000:
        print(f"  [SKIP] {filename} already exists "
              f"({os.path.getsize(filepath)//1024} KB)")
        return filepath

    url = "https://omniweb.gsfc.nasa.gov/cgi/nx1.cgi"

    # NASA requires POST with repeated vars params
    post_data = (
        "activity=retrieve"
        "&res=min"
        "&spacecraft=omni_min_def"
        f"&start_date={start_date}"
        f"&end_date={end_date}"
        "&scale=Linear&ymin=&ymax=&view=0&charsize=&xstyle=0"
        "&ystyle=0&symbol=0&symsize=&linestyle=solid&table=0"
        "&imagex=640&imagey=480&color=&back="
    )
    for v in ALL_VARS:
        post_data += f"&vars={v}"

    for attempt in range(1, retries + 1):
        try:
            print(f"  Downloading {filename} ({start_date}→{end_date}) "
                  f"[attempt {attempt}]...")
            resp = requests.post(
                url,
                data=post_data,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=180
            )
            resp.raise_for_status()

            if "Error" in resp.text[:300] or "No data" in resp.text[:300]:
                print(f"  [WARNING] NASA error: {resp.text[:200]}")
                return None

            with open(filepath, "w", encoding="utf-8") as f:
                f.write(resp.text)

            size_kb = os.path.getsize(filepath) / 1024
            print(f"  [OK] Saved {filename} ({size_kb:.1f} KB)")
            return filepath

        except Exception as e:
            print(f"  [ERROR] Attempt {attempt}: {e}")
            time.sleep(5 * attempt)

    print(f"  [FAILED] {filename} after {retries} attempts.")
    return None


# ─────────────────────────────────────────────
# PARSE ONE CHUNK FILE INTO DATAFRAME
# ─────────────────────────────────────────────

def parse_chunk(filepath):
    rows = []
    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            # Data lines: first token is 4-digit year
            if len(parts) >= 4 and parts[0].isdigit() and len(parts[0]) == 4:
                rows.append(parts)

    if not rows:
        print(f"  [WARNING] No data rows in {filepath}")
        return None

    n_cols = len(rows[0])
    print(f"  Parsing: {len(rows):,} rows × {n_cols} columns")

    # Match column names to actual column count
    if n_cols <= len(COLUMN_NAMES):
        cols = COLUMN_NAMES[:n_cols]
    else:
        cols = COLUMN_NAMES + [f"extra_{i}" for i in range(n_cols - len(COLUMN_NAMES))]

    df = pd.DataFrame(rows, columns=cols)
    df = df.apply(pd.to_numeric, errors="coerce")

    # Build datetime index
    df["datetime"] = (
        pd.to_datetime(
            df["year"].astype(int).astype(str) +
            df["day"].astype(int).astype(str).str.zfill(3),
            format="%Y%j"
        )
        + pd.to_timedelta(df["hour"],   unit="h")
        + pd.to_timedelta(df["minute"], unit="m")
    )

    df = df.set_index("datetime")
    df.drop(columns=["year", "day", "hour", "minute"], inplace=True, errors="ignore")

    # Replace OMNI fill values with NaN
    for fv in FILL_VALUES:
        df.replace(fv, pd.NA, inplace=True)

    return df


# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    chunks = generate_chunks(start_year=1995, end_year=2026)
    total  = len(chunks)

    print(f"\n{'='*60}")
    print(f"NASA OMNI HRO Full Download")
    print(f"Total chunks to download: {total} (1-year intervals)")
    print(f"Output folder: {OUTPUT_DIR}/")
    print(f"{'='*60}\n")

    failed       = []
    chunk_parquets = []   # list of per-year parquet paths

    for i, (start, end, fname) in enumerate(chunks, 1):
        print(f"[{i}/{total}] Chunk: {start} → {end}")

        # Per-chunk parquet path (stores hourly data for this year)
        chunk_parquet = os.path.join(OUTPUT_DIR,
                                     fname.replace(".txt", "_hourly.parquet"))

        # If this year's parquet already exists, skip entirely
        if os.path.exists(chunk_parquet):
            print(f"  [SKIP] {chunk_parquet} already processed.")
            chunk_parquets.append(chunk_parquet)
            continue

        filepath = download_chunk(start, end, fname)

        if filepath and os.path.exists(filepath):
            df = parse_chunk(filepath)
            if df is not None and len(df) > 0:
                # ── Resample to hourly IMMEDIATELY ──────────
                # This keeps RAM usage tiny (525k → ~8k rows per chunk)
                df_hourly = df.resample("1h").mean()
                df_hourly.to_parquet(chunk_parquet)
                chunk_parquets.append(chunk_parquet)
                print(f"  Resampled to {len(df_hourly):,} hourly rows → "
                      f"{chunk_parquet}")
                del df, df_hourly   # free RAM immediately
            else:
                failed.append(fname)
        else:
            failed.append(fname)

        # Be polite to NASA servers
        time.sleep(2)

    # ── Merge all per-year hourly parquets ───────────────────
    if not chunk_parquets:
        print("\n[ERROR] No data processed.")
        return

    print(f"\nMerging {len(chunk_parquets)} yearly parquets...")
    df_all = pd.concat([pd.read_parquet(p) for p in chunk_parquets])
    df_all.sort_index(inplace=True)
    df_all = df_all[~df_all.index.duplicated(keep="first")]

    print(f"Total hourly rows: {len(df_all):,}")
    print(f"Date range       : {df_all.index.min()} → {df_all.index.max()}")

    # ── Save final merged Parquet ─────────────────────────────
    parquet_path = os.path.join(OUTPUT_DIR, FINAL_PARQUET)
    df_all.to_parquet(parquet_path)
    print(f"Saved Parquet    : {parquet_path}  "
          f"({os.path.getsize(parquet_path)/1e6:.1f} MB)")

    # ── Save final CSV (optional but useful) ─────────────────
    csv_path = os.path.join(OUTPUT_DIR, FINAL_CSV)
    df_all.to_csv(csv_path)
    print(f"Saved CSV        : {csv_path}  "
          f"({os.path.getsize(csv_path)/1e6:.1f} MB)")

    # ── Summary ──────────────────────────────────────────────
    print(f"\n{'='*60}")
    print("DOWNLOAD COMPLETE")
    print(f"  Hourly Parquet   : {parquet_path}")
    print(f"  Hourly CSV       : {csv_path}")
    if failed:
        print(f"  Failed chunks    : {failed}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()