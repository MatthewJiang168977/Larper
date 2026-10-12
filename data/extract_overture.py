"""Extract Overture Maps places for a bounding box into a local parquet file.

Usage:
    python data/extract_overture.py --out data/nyc.parquet            # NYC (default bbox)
    python data/extract_overture.py --bbox -74.01 40.70 -73.97 40.74 --out data/lower_mn.parquet

Reads the public Overture release straight from S3 (anonymous, no AWS account needed).
The query lives in workers/internal/places/overture_extract.sql, shared with the
ingest-worker that loads single areas on demand, so both produce identical rows.
"""
import argparse
import pathlib
import re
import duckdb

RELEASE = "2026-09-23.1"
NYC_BBOX = (-74.26, 40.49, -73.70, 40.92)  # xmin, ymin, xmax, ymax: the five boroughs
SQL = pathlib.Path(__file__).resolve().parent.parent / "workers/internal/places/overture_extract.sql"


def render(bbox, release, out):
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}\.\d+", release):
        raise ValueError(f"bad Overture release {release!r}")
    xmin, ymin, xmax, ymax = (f"{float(v):.7f}" for v in bbox)
    subs = {"release": release, "out": out.replace("'", "''"),
            "xmin": xmin, "xmax": xmax, "ymin": ymin, "ymax": ymax}
    return re.sub(r"\$\{(\w+)\}", lambda m: subs[m.group(1)], SQL.read_text(encoding="utf-8"))


def extract(bbox, out, release=RELEASE):
    con = duckdb.connect()
    con.sql("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
    con.execute(render(bbox, release, out))
    n = con.execute(f"SELECT count(*) FROM '{out}'").fetchone()[0]
    print(f"wrote {n} places to {out}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--bbox", nargs=4, type=float, metavar=("XMIN", "YMIN", "XMAX", "YMAX"), default=NYC_BBOX)
    p.add_argument("--out", required=True)
    p.add_argument("--release", default=RELEASE)
    a = p.parse_args()
    extract(a.bbox, a.out, a.release)
