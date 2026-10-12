package places

import (
	"strings"
	"testing"
)

func TestRenderExtract(t *testing.T) {
	q, err := RenderExtract(Box{MinLng: -74.0, MinLat: 40.7, MaxLng: -73.95, MaxLat: 40.75}, "2026-09-23.1", "/tmp/a.parquet")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"release/2026-09-23.1/theme=places",
		"bbox.xmin >= -74.0000000 AND bbox.xmin < -73.9500000",
		"bbox.ymin >= 40.7000000 AND bbox.ymin < 40.7500000",
		"TO '/tmp/a.parquet'",
	} {
		if !strings.Contains(q, want) {
			t.Errorf("rendered query missing %q", want)
		}
	}
	if strings.Contains(q, "${") {
		t.Error("unsubstituted placeholder left in query")
	}
}

func TestRenderExtractRejectsOddReleases(t *testing.T) {
	if _, err := RenderExtract(Box{}, "2026-09-23.1'; DROP TABLE x; --", "/tmp/a"); err == nil {
		t.Fatal("accepted an injected release name")
	}
}
