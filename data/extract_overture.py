"""Extract Overture Maps places for a bounding box into a local parquet file.

Usage:
    python data/extract_overture.py --out data/nyc.parquet            # NYC (default bbox)
    python data/extract_overture.py --bbox -74.01 40.70 -73.97 40.74 --out data/lower_mn.parquet

Reads the public Overture release straight from S3 (anonymous, no AWS account needed),
using the bbox struct columns so DuckDB only downloads row groups that overlap.
Only open places are kept; everything else in the output is CDLA-Permissive data we may store.
"""
import argparse
import duckdb

RELEASE = "2026-09-23.1"
NYC_BBOX = (-74.26, 40.49, -73.70, 40.92)  # xmin, ymin, xmax, ymax: the five boroughs


def extract(bbox, out, release=RELEASE):
    xmin, ymin, xmax, ymax = bbox
    src = f"s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*.parquet"
    con = duckdb.connect()
    con.sql("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
    con.execute(
        f"""
        COPY (
          SELECT id                      AS overture_id,
                 names."primary"         AS name,
                 ST_X(geometry)          AS lng,
                 ST_Y(geometry)          AS lat,
                 confidence,
                 basic_category,
                 taxonomy.hierarchy      AS hierarchy,
                 taxonomy.alternates     AS alternates,
                 brand.names."primary"   AS brand,
                 brand.wikidata          AS brand_wikidata,
                 -- Contact links for the quest card. Overture mixes social profiles into
                 -- websites, so pick them apart here.
                 list_filter(coalesce(websites, []),
                   x -> NOT regexp_matches(x, '(facebook|instagram)[.]com', 'i'))[1] AS website,
                 list_filter(coalesce(socials, []) || coalesce(websites, []),
                   x -> regexp_matches(x, 'instagram[.]com/[^/?#]+', 'i'))[1]   AS instagram,
                 phones[1]               AS phone
          FROM read_parquet('{src}')
          WHERE bbox.xmin BETWEEN ? AND ? AND bbox.ymin BETWEEN ? AND ?
            AND coalesce(operating_status, 'open') = 'open'
            AND names."primary" IS NOT NULL
        ) TO '{out}' (FORMAT parquet, COMPRESSION zstd)
        """,
        [xmin, xmax, ymin, ymax],
    )
    n = con.execute(f"SELECT count(*) FROM '{out}'").fetchone()[0]
    print(f"wrote {n} places to {out}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--bbox", nargs=4, type=float, metavar=("XMIN", "YMIN", "XMAX", "YMAX"), default=NYC_BBOX)
    p.add_argument("--out", required=True)
    p.add_argument("--release", default=RELEASE)
    a = p.parse_args()
    extract(a.bbox, a.out, a.release)
