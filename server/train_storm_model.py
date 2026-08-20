"""
Storm risk forecaster — trains one binary classifier per forecast horizon
(1h, 3h, 6h) that predicts whether a geomagnetic storm (sym_h_nT < -50,
same definition used by build_storm_catalog() in app.py) will occur at any
point in the next H hours, given the current + recent solar wind state.

This is deliberately a plain, explainable model on tabular lag features
rather than a sequence model: solar wind driving of the magnetosphere is
strongly persistent hour-to-hour, so a few lags carry most of the signal,
and Random Forests handle the class imbalance (~3% storm hours) and
nonlinear thresholds (e.g. bz southward) well without much tuning.

Takes a few minutes on a laptop CPU (a single-core sandbox timed out
trying to run this, which is why it's meant to run on your own machine).

Run:  cd server && python train_storm_model.py
Output: server/models/storm_models.joblib, server/models/metrics.json
"""
import json
import os

import joblib
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import average_precision_score, precision_score, recall_score, roc_auc_score

from storm_features import FEATURE_COLS, build_features, make_target

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(BASE_DIR, 'models')
os.makedirs(MODELS_DIR, exist_ok=True)

HORIZONS = [1, 3, 6]  # hours ahead


def main():
    df = pd.read_csv(os.path.join(BASE_DIR, 'omni_processed.csv'), parse_dates=['datetime'])
    df = df.sort_values('datetime').reset_index(drop=True)
    feats = build_features(df)

    models = {}
    metrics = {}

    for h in HORIZONS:
        target = make_target(feats['storm_flag'], h)
        work = feats.copy()
        work['target'] = target
        work = work.dropna(subset=FEATURE_COLS + ['target'])

        X = work[FEATURE_COLS].values
        y = work['target'].astype(int).values

        # Chronological split (last 15% of the timeline held out) — a random
        # split would leak neighbouring hours of the same storm into both
        # train and test and overstate accuracy.
        split = int(len(work) * 0.85)
        X_train, X_test = X[:split], X[split:]
        y_train, y_test = y[:split], y[split:]

        clf = RandomForestClassifier(
            n_estimators=300,
            max_depth=12,
            min_samples_leaf=5,
            class_weight='balanced',
            n_jobs=-1,
            random_state=42,
        )
        clf.fit(X_train, y_train)

        proba = clf.predict_proba(X_test)[:, 1]
        pred = (proba >= 0.5).astype(int)

        metrics[f'{h}h'] = {
            'roc_auc': round(float(roc_auc_score(y_test, proba)), 4),
            'avg_precision': round(float(average_precision_score(y_test, proba)), 4),
            'precision_at_0.5': round(float(precision_score(y_test, pred, zero_division=0)), 4),
            'recall_at_0.5': round(float(recall_score(y_test, pred, zero_division=0)), 4),
            'test_positive_rate': round(float(y_test.mean()), 4),
            'n_train': int(len(y_train)),
            'n_test': int(len(y_test)),
        }
        models[h] = clf
        print(f'[{h}h horizon] AUC={metrics[f"{h}h"]["roc_auc"]}  '
              f'AP={metrics[f"{h}h"]["avg_precision"]}  '
              f'P={metrics[f"{h}h"]["precision_at_0.5"]}  R={metrics[f"{h}h"]["recall_at_0.5"]}')

    joblib.dump({'models': models, 'feature_cols': FEATURE_COLS, 'horizons': HORIZONS},
                os.path.join(MODELS_DIR, 'storm_models.joblib'))
    with open(os.path.join(MODELS_DIR, 'metrics.json'), 'w') as f:
        json.dump(metrics, f, indent=2)

    print(f'\nSaved models to {MODELS_DIR}/storm_models.joblib')


if __name__ == '__main__':
    main()
