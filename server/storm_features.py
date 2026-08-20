"""
Feature engineering for the storm-risk models — shared by train_storm_model.py
(offline training) and app.py (serving), so the columns a model was trained
on always match the columns it's fed at prediction time.
"""
import pandas as pd

# Raw columns used as model inputs (all already in omni_processed.csv)
BASE_FEATURES = [
    'bz_gsm_nT', 'by_gsm_nT', 'flow_speed_kms', 'proton_density_ncc',
    'pdyn_computed_nPa', 'imf_mag_scalar_nT', 'ae_index_nT', 'bz_southward',
]


def build_features(df):
    """df must be sorted by datetime ascending, with columns in BASE_FEATURES
    plus 'datetime', 'sym_h_nT', 'storm_flag'. Returns a DataFrame of model
    inputs (one row per input row) plus 'datetime' and 'storm_flag' passthrough."""
    feats = pd.DataFrame(index=df.index)

    for col in BASE_FEATURES:
        feats[col] = df[col]

    # Recent history: what the driver looked like 1h and 3h ago, plus how
    # persistent southward IMF (the main storm trigger) has been.
    for col in ['bz_gsm_nT', 'flow_speed_kms', 'proton_density_ncc', 'pdyn_computed_nPa']:
        feats[f'{col}_lag1'] = df[col].shift(1)
        feats[f'{col}_lag3'] = df[col].shift(3)

    feats['bz_mean_3h'] = df['bz_gsm_nT'].rolling(3, min_periods=1).mean()
    feats['bz_southward_hours_3h'] = df['bz_southward'].rolling(3, min_periods=1).sum()
    feats['flow_speed_max_3h'] = df['flow_speed_kms'].rolling(3, min_periods=1).max()
    feats['sym_h_now'] = df['sym_h_nT']  # current storm intensity is itself predictive of near-term persistence

    feats['datetime'] = df['datetime']
    feats['storm_flag'] = df['storm_flag']
    return feats


def make_target(storm_flag, horizon):
    """1 if a storm occurs anywhere in the next `horizon` hours, else 0.
    NaN for the tail rows where the future window runs off the end of data."""
    shifted = pd.concat([storm_flag.shift(-k) for k in range(1, horizon + 1)], axis=1)
    return shifted.max(axis=1)


FEATURE_COLS = (
    BASE_FEATURES
    + [f'{c}_lag1' for c in ['bz_gsm_nT', 'flow_speed_kms', 'proton_density_ncc', 'pdyn_computed_nPa']]
    + [f'{c}_lag3' for c in ['bz_gsm_nT', 'flow_speed_kms', 'proton_density_ncc', 'pdyn_computed_nPa']]
    + ['bz_mean_3h', 'bz_southward_hours_3h', 'flow_speed_max_3h', 'sym_h_now']
)
