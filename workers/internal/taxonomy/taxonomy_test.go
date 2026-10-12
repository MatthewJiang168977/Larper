package taxonomy

import (
	"math"
	"slices"
	"testing"
)

func mustDefault(t *testing.T) *Taxonomy {
	t.Helper()
	tx, err := Default()
	if err != nil {
		t.Fatal(err)
	}
	return tx
}

func TestEmbeddedTaxonomyParses(t *testing.T) {
	tx := mustDefault(t)
	if tx.Dims != 160 {
		t.Fatalf("dims = %d, want 160 (changing it needs a DB migration)", tx.Dims)
	}
}

func TestCategoryMatchesAnyHierarchyLevel(t *testing.T) {
	r := mustDefault(t).Tag(Place{
		Name:      "Some Spot",
		Hierarchy: []string{"food_and_drink", "alcoholic_beverage_venue", "bar", "speakeasy"},
	})
	if !slices.Contains(r.Tags, "speakeasy") {
		t.Fatalf("tags = %v, want speakeasy", r.Tags)
	}
}

func TestKeywordsAreWholeWord(t *testing.T) {
	tx := mustDefault(t)
	cafe := []string{"food_and_drink", "non_alcoholic_beverage_venue", "cafe"}

	r := tx.Tag(Place{Name: "Kettl Hojicha & Matcha Bar", Hierarchy: cafe})
	for _, want := range []string{"hojicha", "matcha", "cafe"} {
		if !slices.Contains(r.Tags, want) {
			t.Errorf("tags = %v, missing %s", r.Tags, want)
		}
	}
	// "ube" must not fire inside "Cuban" or "tube".
	r = tx.Tag(Place{Name: "Cuban Tube Cafe", Hierarchy: cafe})
	if slices.Contains(r.Tags, "ube") {
		t.Errorf("tags = %v, ube matched inside another word", r.Tags)
	}
	// Punctuation splits words: "Hi-Fi" matches the "hi-fi" keyword.
	r = tx.Tag(Place{Name: "Brooklyn Hi-Fi", Hierarchy: []string{"food_and_drink", "bar"}})
	if !slices.Contains(r.Tags, "listening-bar") {
		t.Errorf("tags = %v, want listening-bar", r.Tags)
	}
}

func TestKeywordsIgnoredOutsideRoots(t *testing.T) {
	r := mustDefault(t).Tag(Place{Name: "Matcha Dental", Hierarchy: []string{"health_care", "dental_clinic"}})
	if r.Vec != nil {
		t.Fatalf("dentist got tags %v", r.Tags)
	}
}

func TestVectorIsUnitLengthAndWeighted(t *testing.T) {
	tx := mustDefault(t)
	r := tx.Tag(Place{Name: "Matcha Cafe", Hierarchy: []string{"food_and_drink", "cafe"}})
	var sum float64
	for _, x := range r.Vec {
		sum += float64(x) * float64(x)
	}
	if math.Abs(sum-1) > 1e-5 {
		t.Fatalf("|vec|^2 = %v, want 1", sum)
	}
	// matcha (weight 1.5) should outweigh the generic cafe tag (0.6).
	if r.Vec[0] <= r.Vec[6] {
		t.Fatalf("matcha slot %v <= cafe slot %v", r.Vec[0], r.Vec[6])
	}
}

func TestNoTagsMeansNoVector(t *testing.T) {
	r := mustDefault(t).Tag(Place{Name: "Generic Restaurant", Hierarchy: []string{"food_and_drink", "restaurant"}})
	if r.Vec != nil || r.Tags != nil {
		t.Fatalf("got %v", r)
	}
}

func TestChainKey(t *testing.T) {
	cases := []struct{ name, brand, want string }{
		{"Dunkin' Donuts", "Dunkin'", "dunkin"},
		{"Dunkin'", "", "dunkin"}, // same chain whether or not Overture filled brand
		{"Starbucks #123", "", "starbucks"},
		{"Joe's  Pizza!", "", "joe s pizza"},
		{"7-Eleven", "", "eleven"}, // lossy, but every 7-Eleven gets the same key
		{"Pier 17", "", "pier"},
	}
	for _, c := range cases {
		if got := ChainKey(c.name, c.brand); got != c.want {
			t.Errorf("ChainKey(%q,%q) = %q, want %q", c.name, c.brand, got, c.want)
		}
	}
}

func TestParseVectorRoundTrip(t *testing.T) {
	in := []float32{0, 0.25, -1, 0.333333}
	out, err := ParseVector(VectorLiteral(in))
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(in, out) {
		t.Fatalf("round trip: %v -> %v", in, out)
	}
	if _, err := ParseVector("0.1,0.2"); err == nil {
		t.Fatal("accepted a string without brackets")
	}
}

func TestVectorLiteral(t *testing.T) {
	if got := VectorLiteral([]float32{0, 0.5, 1}); got != "[0,0.5,1]" {
		t.Fatalf("got %s", got)
	}
}
