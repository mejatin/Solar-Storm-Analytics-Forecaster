"""
CS661 - FIXED Data Pipeline v4  (FINAL)
========================================
COLUMN_NAMES verified against actual data row from omni_clean/omni_chunk_2001.txt
Key indices confirmed:
  [16] imf_mag_scalar_nT
  [17] by_gsm_nT
  [18] bz_gsm_nT
  [24] flow_speed_kms      <- bulk scalar speed ~372 km/s
  [28] proton_density_ncc
  [29] proton_temp_K
  [30] flow_pressure_nPa
  [31] electric_field_mVm
  [40] ae_index_nT
  [44] sym_h_nT
"""

import os, json, requests
import numpy as np
import pandas as pd

RAW_DIR     = "omni_clean"
OUTPUT_DIR  = "output"
OUT_PARQUET = os.path.join(OUTPUT_DIR, "omni_processed.parquet")
OUT_CSV     = os.path.join(OUTPUT_DIR, "omni_processed.csv")
OUT_STORMS  = os.path.join(OUTPUT_DIR, "storms.json")
OUT_KP_RAW  = os.path.join(OUTPUT_DIR, "kp_raw.csv")
os.makedirs(OUTPUT_DIR, exist_ok=True)

MP_KG  = 1.6726e-27
CM3_M3 = 1e6

FILL_EXACT = {
    999.9, 9999.0, 99999.0, 9999.99, 99999.9, 9999999.0,
    999.99, 99.99, 9999, 99999, 99999.99, 9999999,
    99.9, 9.9, 999, 9999.9, 999999.0, 999999,
}

# VERIFIED 47-column layout from actual data
COLUMN_NAMES = [
    "year", "day", "hour", "minute",   # 0-3
    "col4", "col5", "col6",            # 4-6  extra metadata
    "n_fine_imf", "n_fine_plasma",     # 7-8
    "pct_interpolated",                # 9
    "col10",                           # 10
    "timeshift_sec",                   # 11
    "time_btwn_obs_sec",               # 12
    "col13", "col14", "col15",         # 13-15
    "imf_mag_scalar_nT",               # 16
    "by_gsm_nT",                       # 17
    "bz_gsm_nT",                       # 18
    "col19", "col20", "col21",         # 19-21  sigma fields
    "col22", "col23",                  # 22-23
    "flow_speed_kms",                  # 24  <- bulk speed ✅
    "vx_gse_kms",                      # 25
    "vy_gse_kms",                      # 26
    "vz_gse_kms",                      # 27
    "proton_density_ncc",              # 28
    "proton_temp_K",                   # 29
    "flow_pressure_nPa",               # 30
    "electric_field_mVm",              # 31
    "col32", "col33", "col34",         # 32-34
    "col35", "col36", "col37",         # 35-37
    "col38", "col39",                  # 38-39
    "ae_index_nT",                     # 40
    "al_index_nT",                     # 41
    "au_index_nT",                     # 42
    "sym_d_nT",                        # 43
    "sym_h_nT",                        # 44  ✅
    "asy_d_nT",                        # 45
    "asy_h_nT",                        # 46
]

KEEP_COLS = [
    "imf_mag_scalar_nT", "bz_gsm_nT", "by_gsm_nT",
    "flow_speed_kms", "proton_density_ncc", "proton_temp_K",
    "flow_pressure_nPa", "electric_field_mVm",
    "ae_index_nT", "sym_h_nT",
]

COL_MAX = {
    "imf_mag_scalar_nT":  200,
    "bz_gsm_nT":          200,
    "by_gsm_nT":          200,
    "flow_speed_kms":     2000,
    "proton_density_ncc": 500,
    "proton_temp_K":      1e8,
    "flow_pressure_nPa":  500,
    "electric_field_mVm": 500,
    "ae_index_nT":        5000,
    "sym_h_nT":           200,
}

COL_MIN = {
    "flow_speed_kms":      100,
    "proton_density_ncc":  0,
    "proton_temp_K":       100,
    "imf_mag_scalar_nT":   0,
    "ae_index_nT":         0,
    "sym_h_nT":           -600,
}


def process_raw_chunk(filepath):
    rows = []
    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) >= 4 and parts[0].isdigit() and len(parts[0]) == 4:
                rows.append(parts)
    if not rows:
        return None

    n_cols = len(rows[0])
    cols = COLUMN_NAMES[:n_cols]
    if n_cols > len(COLUMN_NAMES):
        cols = cols + [f"extra_{i}" for i in range(n_cols - len(COLUMN_NAMES))]

    df = pd.DataFrame(rows, columns=cols)
    df = df.apply(pd.to_numeric, errors="coerce")

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
    df.drop(columns=["year","day","hour","minute"], inplace=True, errors="ignore")

    # Remove fill values BEFORE resampling
    for fv in FILL_EXACT:
        df.replace(fv, np.nan, inplace=True)

    for col, maxval in COL_MAX.items():
        if col in df.columns:
            df.loc[df[col] > maxval, col] = np.nan
    for col, minval in COL_MIN.items():
        if col in df.columns:
            df.loc[df[col] < minval, col] = np.nan

    keep = [c for c in KEEP_COLS if c in df.columns]
    df = df[keep]

    return df.resample("1h").mean()


def download_kp():
    print("\n[STEP 2] Downloading Kp index ...")
    if os.path.exists(OUT_KP_RAW):
        print(f"  [SKIP] Using cached {OUT_KP_RAW}")
        return pd.read_csv(OUT_KP_RAW, parse_dates=["datetime"], index_col="datetime")

    url = "https://omniweb.gsfc.nasa.gov/cgi/nx1.cgi"
    post_data = (
        "activity=retrieve&res=hour&spacecraft=omni2"
        "&start_date=19950101&end_date=20260601"
        "&scale=Linear&ymin=&ymax=&view=0&charsize=&xstyle=0"
        "&ystyle=0&symbol=0&symsize=&linestyle=solid&table=0"
        "&imagex=640&imagey=480&color=&back=&vars=38&vars=40"
    )
    try:
        resp = requests.post(url, data=post_data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=180)
        resp.raise_for_status()
        rows = []
        for line in resp.text.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) >= 5 and parts[0].isdigit() and len(parts[0]) == 4:
                rows.append(parts)
        if not rows:
            print("  [WARNING] No Kp data returned.")
            return None

        df_kp = pd.DataFrame(rows, columns=["year","day","hour","kp_raw","dst_omni"])
        df_kp = df_kp.apply(pd.to_numeric, errors="coerce")
        df_kp["kp"] = df_kp["kp_raw"] / 10.0
        df_kp.loc[df_kp["kp"] > 9, "kp"] = np.nan
        df_kp.loc[df_kp["dst_omni"].abs() > 500, "dst_omni"] = np.nan
        df_kp["datetime"] = (
            pd.to_datetime(
                df_kp["year"].astype(int).astype(str) +
                df_kp["day"].astype(int).astype(str).str.zfill(3),
                format="%Y%j"
            ) + pd.to_timedelta(df_kp["hour"], unit="h")
        )
        df_kp = df_kp.set_index("datetime")[["kp","dst_omni"]]
        df_kp.to_csv(OUT_KP_RAW)
        print(f"  Downloaded {len(df_kp):,} hourly Kp rows.")
        return df_kp
    except Exception as e:
        print(f"  [ERROR] Kp download failed: {e}")
        return None


def compute_derived(df):
    print("\n[STEP 3] Computing derived quantities ...")
    n = df["proton_density_ncc"] * CM3_M3
    v = df["flow_speed_kms"] * 1e3
    df["pdyn_computed_nPa"] = 0.5 * MP_KG * n * v**2 * 1e9
    corr = df["pdyn_computed_nPa"].corr(df["flow_pressure_nPa"])
    print(f"  Pdyn corr with NASA value: {corr:.4f}  {'✅' if corr > 0.95 else '⚠️ Check'}")
    df["bz_southward"] = (df["bz_gsm_nT"] < 0).astype("Int64")
    return df

def compute_derived(df):
    print("\n[STEP 3] Computing derived quantities ...")

    # Standard solar-wind dynamic pressure (NASA OMNI convention):
    # Pdyn (nPa) = 2.0e-6 * n(cm^-3) * v(km/s)^2
    # Old formula used only proton mass, no alpha-particle correction -
    # understated pressure by a fixed ~58% (ratio ~0.42 vs NASA's flow_pressure_nPa)
    n = df["proton_density_ncc"]
    v = df["flow_speed_kms"]
    df["pdyn_computed_nPa"] = 2.0e-6 * n * (v ** 2)

    ratio = (df["pdyn_computed_nPa"] / df["flow_pressure_nPa"]).dropna()
    corr = df["pdyn_computed_nPa"].corr(df["flow_pressure_nPa"])
    ratio_median = ratio.median()

    print(f"  Pdyn corr with NASA value   : {corr:.4f}")
    print(f"  Pdyn/NASA ratio (median)    : {ratio_median:.4f}")

    corr_ok = corr > 0.95
    ratio_ok = 0.85 < ratio_median < 1.15

    if corr_ok and ratio_ok:
        print("  Pdyn check: ✅ matches NASA value (shape + magnitude)")
    elif corr_ok and not ratio_ok:
        print(f"  Pdyn check: ⚠️ correlation OK but magnitude is OFF "
              f"(ratio={ratio_median:.3f}, expected ~1.0) - check formula/units")
    else:
        print("  Pdyn check: ⚠️ correlation too low - check column alignment")

    df["bz_southward"] = (df["bz_gsm_nT"] < 0).astype("Int64")
    return df


def detect_storms(df):
    print("\n[STEP 4] Detecting storms (sym_h < -50 nT, >= 3 hrs) ...")
    storms, in_storm, start, consec = [], False, None, 0
    for dt, val in df["sym_h_nT"].items():
        if pd.isna(val):
            if in_storm and consec >= 3:
                _save_storm(df, storms, start, dt, consec)
            in_storm, consec = False, 0
            continue
        if val < -50:
            if not in_storm:
                start, in_storm, consec = dt, True, 1
            else:
                consec += 1
        else:
            if in_storm and consec >= 3:
                _save_storm(df, storms, start, dt, consec)
            in_storm, consec = False, 0

    df["storm_flag"] = 0
    for s in storms:
        df.loc[s["start"]:s["end"], "storm_flag"] = 1

    print(f"  Storms detected: {len(storms)}")
    c = {"moderate":0,"intense":0,"severe":0}
    for s in storms:
        c[s["intensity"]] += 1
    print(f"  Moderate: {c['moderate']}  Intense: {c['intense']}  Severe: {c['severe']}")
    return df, storms


def _save_storm(df, storms, start, end, consec):
    sl = df.loc[start:end, "sym_h_nT"]
    peak_dst = float(sl.min())
    intensity = ("severe"  if peak_dst <= -200 else
                 "intense" if peak_dst <= -100 else "moderate")
    storms.append({
        "id": len(storms)+1,
        "start": start.isoformat(), "end": end.isoformat(),
        "peak_time": sl.idxmin().isoformat(),
        "peak_dst_nT": peak_dst,
        "duration_hrs": consec+1,
        "intensity": intensity,
    })


def classify_sw(df):
    print("\n[STEP 5] Classifying solar wind types ...")
    cond = [
        df["flow_speed_kms"] < 450,
        (df["flow_speed_kms"] >= 450) & (df["imf_mag_scalar_nT"] < 15),
        (df["flow_speed_kms"] >= 450) & (df["imf_mag_scalar_nT"] >= 15),
    ]
    df["sw_type"]      = np.select(cond, ["slow_stream","fast_stream","cme_ejecta"], "unknown")
    df["sw_type_code"] = np.select(cond, [0, 1, 2], -1)
    print(df["sw_type"].value_counts().to_string())
    return df


def normalize(df):
    print("\n[STEP 6] Normalizing ...")
    spec = {
        "bz_gsm_nT":          "bz_norm",
        "flow_speed_kms":     "speed_norm",
        "proton_density_ncc": "density_norm",
        "ae_index_nT":        "ae_norm",
        "pdyn_computed_nPa":  "pdyn_norm",
        "imf_mag_scalar_nT":  "imf_norm",
    }
    for src, dst in spec.items():
        if src in df.columns:
            lo, hi = df[src].quantile(0.01), df[src].quantile(0.99)
            if hi > lo:
                df[dst] = ((df[src] - lo) / (hi - lo)).clip(0, 1)
            else:
                df[dst] = np.nan
    return df


def export(df, storms):
    print("\n[STEP 7] Exporting ...")
    df.to_parquet(OUT_PARQUET)
    df.to_csv(OUT_CSV)
    print(f"  Parquet : {OUT_PARQUET}  ({os.path.getsize(OUT_PARQUET)/1e6:.1f} MB)")
    print(f"  CSV     : {OUT_CSV}  ({os.path.getsize(OUT_CSV)/1e6:.1f} MB)")

    with open(OUT_STORMS, "w") as f:
        json.dump({"total": len(storms), "storms": storms}, f, indent=2)
    print(f"  Storms  : {OUT_STORMS}  ({len(storms)} events)")

    summary = {
        "date_range": {"start": df.index.min().isoformat(),
                       "end":   df.index.max().isoformat()},
        "total_hours": len(df),
        "columns": list(df.columns),
        "sw_type_counts": df["sw_type"].value_counts().to_dict(),
        "storm_counts": {
            "total":    len(storms),
            "moderate": sum(1 for s in storms if s["intensity"]=="moderate"),
            "intense":  sum(1 for s in storms if s["intensity"]=="intense"),
            "severe":   sum(1 for s in storms if s["intensity"]=="severe"),
        }
    }
    with open(os.path.join(OUTPUT_DIR, "dataset_summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
    print(f"  Summary saved.")


def main():
    print("="*60)
    print("CS661 FIXED Data Pipeline v4 (FINAL)")
    print("="*60)

    print(f"\n[STEP 1] Processing {RAW_DIR}/ ...")
    txt_files = sorted([
        os.path.join(RAW_DIR, f)
        for f in os.listdir(RAW_DIR)
        if f.startswith("omni_chunk_") and f.endswith(".txt")
    ])
    print(f"  Found {len(txt_files)} files.")

    all_dfs = []
    for fpath in txt_files:
        year = os.path.basename(fpath).replace("omni_chunk_","").replace(".txt","")
        df_h = process_raw_chunk(fpath)
        if df_h is not None and len(df_h) > 0:
            all_dfs.append(df_h)
            spd = df_h["flow_speed_kms"].notna().sum() if "flow_speed_kms" in df_h else 0
            syh = df_h["sym_h_nT"].notna().sum()       if "sym_h_nT"       in df_h else 0
            print(f"  {year}: {len(df_h):,} rows | speed={spd} | symh={syh}")

    df = pd.concat(all_dfs).sort_index()
    df = df[~df.index.duplicated(keep="first")]
    print(f"\n  Total: {len(df):,} rows")
    print(f"  flow_speed valid : {df['flow_speed_kms'].notna().sum():,}")
    print(f"  sym_h mean       : {df['sym_h_nT'].mean():.2f} nT")
    print(f"  sym_h min        : {df['sym_h_nT'].min():.2f} nT")

    df_kp = download_kp()
    if df_kp is not None:
        df = df.join(df_kp, how="left")
    else:
        df["kp"] = np.nan
        df["dst_omni"] = np.nan

    df = compute_derived(df)
    df, storms = detect_storms(df)
    df = classify_sw(df)
    df = normalize(df)
    export(df, storms)

    print("\n" + "="*60)
    print("PIPELINE COMPLETE ✅")
    print(f"  Rows: {len(df):,}  Storms: {len(storms)}")
    print("="*60)


if __name__ == "__main__":
    main()