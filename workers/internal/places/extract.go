package places

import (
	"context"
	_ "embed"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

//go:embed overture_extract.sql
var extractSQL string

// Box is a lon/lat bounding box.
type Box struct{ MinLng, MinLat, MaxLng, MaxLat float64 }

var safeRelease = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+$`)

// RenderExtract fills in overture_extract.sql. Only numbers, a validated release
// name, and our own temp path are substituted, so there's nothing to inject.
func RenderExtract(b Box, release, out string) (string, error) {
	if !safeRelease.MatchString(release) {
		return "", fmt.Errorf("bad Overture release %q", release)
	}
	f := func(x float64) string { return strconv.FormatFloat(x, 'f', 7, 64) }
	return strings.NewReplacer(
		"${release}", release, "${out}", strings.ReplaceAll(out, "'", "''"),
		"${xmin}", f(b.MinLng), "${xmax}", f(b.MaxLng),
		"${ymin}", f(b.MinLat), "${ymax}", f(b.MaxLat),
	).Replace(extractSQL), nil
}

// Extract runs the query with the DuckDB CLI (DuckDB's Go binding needs cgo; the
// CLI keeps the worker binary static and the query identical to the Python path).
func Extract(ctx context.Context, b Box, release, out string, memoryLimit string, threads int) error {
	q, err := RenderExtract(b, release, out)
	if err != nil {
		return err
	}
	script := fmt.Sprintf(
		"LOAD httpfs; LOAD spatial; SET s3_region='us-west-2'; SET memory_limit='%s'; SET threads=%d;\n%s;",
		memoryLimit, threads, q)
	cmd := exec.CommandContext(ctx, "duckdb", "-batch", "-c", script)
	if outp, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("duckdb: %w: %s", err, strings.TrimSpace(string(outp)))
	}
	return nil
}
