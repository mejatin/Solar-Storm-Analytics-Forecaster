from flask import Flask, jsonify, request
from flask_cors import CORS
import pandas as pd
import numpy as np
import os
import json

import joblib

from storm_features import FEATURE_COLS, build_features

app = Flask(__name__)
CORS(app)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
df = pd.read_csv(os.path.join(BASE_DIR, 'omni_processed.csv'), parse_dates=['datetime'])
df = df.sort_values('datetime').reset_index(drop=True)

# --- Storm risk model (see train_storm_model.py) --------------------------
# Loaded lazily / defensively: the model isn't committed to the repo (it's
# trained locally, see server/README or the main README), so the server
# must still boot and serve every other panel if it's missing.
MODELS_PATH = os.path.join(BASE_DIR, 'models', 'storm_models.joblib')
METRICS_PATH = os.path.join(BASE_DIR, 'models', 'metrics.json')
_model_bundle = None
_model_metrics = None
if os.path.exists(MODELS_PATH):
    _model_bundle = joblib.load(MODELS_PATH)
if os.path.exists(METRICS_PATH):
    with open(METRICS_PATH) as f:
        _model_metrics = json.load(f)

# Features (lags, rolling windows) computed once for the whole dataset so
# /api/predict and /api/predict/range are just row lookups, not recomputation.
FEATS = build_features(df)

COLS = [
    'datetime', 'flow_speed_kms', 'proton_density_ncc', 'bz_gsm_nT',
    'pdyn_computed_nPa', 'dst_omni', 'kp', 'storm_flag', 'imf_mag_scalar_nT',
    'ae_index_nT', 'sym_h_nT', 'proton_temp_K', 'sw_type',
    'bz_norm', 'speed_norm', 'density_norm', 'ae_norm', 'pdyn_norm', 'imf_norm',
]


@app.route('/api/data')
def get_data():
    start = request.args.get('start', '2003-10-25')
    end   = request.args.get('end',   '2003-11-10')
    mask  = (df['datetime'] >= start) & (df['datetime'] <= end)
    subset = df.loc[mask, COLS].copy()
    subset['datetime'] = subset['datetime'].dt.strftime('%Y-%m-%dT%H:%M:%S')
    return jsonify(subset.replace({np.nan: None}).to_dict('records'))


@app.route('/api/storms')
def get_storms():
    sdf = df[df['storm_flag'] == 1].copy()
    sdf['group'] = (sdf.index.to_series().diff().fillna(1) > 1).cumsum()
    events = []
    for _, g in sdf.groupby('group'):
        events.append({
            'start':   g['datetime'].min().strftime('%Y-%m-%dT%H:%M:%S'),
            'end':     g['datetime'].max().strftime('%Y-%m-%dT%H:%M:%S'),
            'min_dst': float(g['dst_omni'].min()),
            'max_kp':  float(g['kp'].max()),
        })
    return jsonify(events)


# Storm catalog, computed at startup
def _round(x, nd):
    return None if pd.isna(x) else round(float(x), nd)


def build_storm_catalog():
    # Contiguous hourly runs of SYM-H < -50 nT lasting >= 3 h
    below = df['sym_h_nT'] < -50
    run_id = (below != below.shift()).cumsum()
    storms = []
    for _, run in df[below].groupby(run_id[below]):
        if len(run) < 3:
            continue
        peak = run.loc[run['sym_h_nT'].idxmin()]
        peak_dst = float(run['sym_h_nT'].min())
        storms.append({
            'id':             len(storms) + 1,
            'start':          run['datetime'].iloc[0].strftime('%Y-%m-%dT%H:%M:%SZ'),
            'end':            run['datetime'].iloc[-1].strftime('%Y-%m-%dT%H:%M:%SZ'),
            'peak_time':      peak['datetime'].strftime('%Y-%m-%dT%H:%M:%SZ'),
            'peak_dst_nT':    round(peak_dst, 1),
            'duration_hrs':   int(len(run)),
            'intensity':      'severe' if peak_dst <= -200 else 'intense' if peak_dst <= -100 else 'moderate',
            'peak_kp':        _round(peak['kp'], 1),
            'peak_speed_kms': None if pd.isna(peak['flow_speed_kms']) else float(peak['flow_speed_kms']),
            'sw_type':        None if pd.isna(peak['sw_type']) else peak['sw_type'],
        })
    return storms


ORBITAL_STORMS = build_storm_catalog()


@app.route('/api/orbital/storms')
def get_orbital_storms():
    return jsonify(ORBITAL_STORMS)


# Mean Kp/AE/electric-field by calendar month (Russell-McPherron effect)
def build_seasonal(start=None, end=None):
    sub_df = df
    if start is not None:
        sub_df = sub_df[sub_df['datetime'] >= start]
    if end is not None:
        sub_df = sub_df[sub_df['datetime'] <= end]
    out = []
    for m in range(1, 13):
        sub = sub_df[sub_df['datetime'].dt.month == m]
        out.append({
            'month': m,
            'meanKp': _round(sub['kp'].mean(), 2),
            'meanAE': _round(sub['ae_index_nT'].mean(), 1),
            'meanElectricField': _round(sub['electric_field_mVm'].mean(), 3),
            'n': int(len(sub)),
        })
    return out


SEASONAL = build_seasonal()


@app.route('/api/seasonal')
def get_seasonal():
    # No params = precomputed full-dataset default
    start = request.args.get('start')
    end = request.args.get('end')
    if start is None and end is None:
        return jsonify(SEASONAL)
    return jsonify(build_seasonal(start, end))


# Every hour classified by driver type, Bz direction, and storm outcome
def build_escalation_flow(start=None, end=None):
    sub_df = df
    if start is not None:
        sub_df = sub_df[sub_df['datetime'] >= start]
    if end is not None:
        sub_df = sub_df[sub_df['datetime'] <= end]
    rows = []
    g = sub_df.groupby(['sw_type', 'bz_southward', 'storm_flag']).size()
    for (t, south, storm), count in g.items():
        rows.append({
            'sw_type': t,
            'bz_southward': bool(south),
            'storm_flag': bool(storm),
            'count': int(count),
        })
    return rows


ESCALATION_FLOW = build_escalation_flow()


@app.route('/api/escalation_flow')
def get_escalation_flow():
    # No params = precomputed full-dataset default
    start = request.args.get('start')
    end = request.args.get('end')
    if start is None and end is None:
        return jsonify(ESCALATION_FLOW)
    return jsonify(build_escalation_flow(start, end))


@app.route('/api/range')
def get_range():
    return jsonify({
        'min': df['datetime'].min().strftime('%Y-%m-%dT%H:%M:%S'),
        'max': df['datetime'].max().strftime('%Y-%m-%dT%H:%M:%S'),
    })


def _risk_label(p):
    if p < 0.15:
        return 'low'
    if p < 0.4:
        return 'elevated'
    return 'high'


@app.route('/api/model/info')
def model_info():
    if _model_bundle is None:
        return jsonify({'trained': False,
                         'message': 'Model not trained yet — run server/train_storm_model.py'})
    return jsonify({
        'trained': True,
        'horizons': _model_bundle['horizons'],
        'feature_cols': _model_bundle['feature_cols'],
        'metrics': _model_metrics,
    })


@app.route('/api/predict')
def predict():
    """Storm risk at a single timestamp, for each trained horizon.
    ?datetime=YYYY-MM-DDTHH:00:00 — defaults to the latest available hour."""
    if _model_bundle is None:
        return jsonify({'error': 'Model not trained yet — run server/train_storm_model.py'}), 503

    dt_param = request.args.get('datetime')
    if dt_param:
        target_dt = pd.to_datetime(dt_param)
        matches = FEATS.index[FEATS['datetime'] == target_dt]
        if len(matches) == 0:
            return jsonify({'error': f'No data at {dt_param}. Use /api/range for valid bounds.'}), 404
        idx = matches[0]
    else:
        idx = FEATS.index[-1]

    row = FEATS.loc[idx]
    if row[FEATURE_COLS].isna().any():
        return jsonify({'error': 'Missing solar wind readings around this timestamp (data gap) — pick a nearby hour.'}), 422

    X = row[FEATURE_COLS].values.reshape(1, -1)
    predictions = {}
    for h in _model_bundle['horizons']:
        proba = float(_model_bundle['models'][h].predict_proba(X)[0, 1])
        predictions[f'{h}h'] = {'probability': round(proba, 4), 'risk': _risk_label(proba)}

    return jsonify({
        'datetime': row['datetime'].strftime('%Y-%m-%dT%H:%M:%S'),
        'inputs': {c: _round(row[c], 3) for c in [
            'bz_gsm_nT', 'flow_speed_kms', 'proton_density_ncc', 'pdyn_computed_nPa', 'sym_h_now',
        ]},
        'predictions': predictions,
    })


@app.route('/api/predict/range')
def predict_range():
    """Predicted risk (for one horizon) alongside actual storm_flag across a
    date range — lets the ML tab plot the model against a known storm to
    sanity-check it, the same way the dashboard panels use /api/data."""
    if _model_bundle is None:
        return jsonify({'error': 'Model not trained yet — run server/train_storm_model.py'}), 503

    start = request.args.get('start', '2003-10-25')
    end = request.args.get('end', '2003-11-10')
    horizon = int(request.args.get('horizon', 3))
    if horizon not in _model_bundle['horizons']:
        return jsonify({'error': f'horizon must be one of {_model_bundle["horizons"]}'}), 400

    mask = (FEATS['datetime'] >= start) & (FEATS['datetime'] <= end)
    sub = FEATS.loc[mask].dropna(subset=FEATURE_COLS)
    if sub.empty:
        return jsonify([])

    proba = _model_bundle['models'][horizon].predict_proba(sub[FEATURE_COLS].values)[:, 1]
    out = pd.DataFrame({
        'datetime': sub['datetime'].dt.strftime('%Y-%m-%dT%H:%M:%S'),
        'risk': np.round(proba, 4),
        'storm_flag': sub['storm_flag'].astype(int),
    })
    return jsonify(out.to_dict('records'))


if __name__ == '__main__':
    app.run(debug=True, port=5000)
