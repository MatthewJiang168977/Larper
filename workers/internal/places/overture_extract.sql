-- Open Overture places inside a bounding box, flattened to the columns places.Load
-- reads. Shared by data/extract_overture.py (bulk) and the ingest-worker (one
-- geohash5 area per job), so both produce identical rows. The dollar-brace names are
-- filled in by the caller: numbers only, plus the release and output path.
-- The bbox struct columns let DuckDB skip row groups that can't overlap. The box is
-- half-open (min inclusive, max exclusive) so a place on a shared edge belongs to
-- exactly one geohash cell, never to two adjacent ingest jobs.
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
  FROM read_parquet('s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*.parquet')
  WHERE bbox.xmin >= ${xmin} AND bbox.xmin < ${xmax}
    AND bbox.ymin >= ${ymin} AND bbox.ymin < ${ymax}
    AND coalesce(operating_status, 'open') = 'open'
    AND names."primary" IS NOT NULL
) TO '${out}' (FORMAT parquet, COMPRESSION zstd)
